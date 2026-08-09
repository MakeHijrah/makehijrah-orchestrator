import { supabaseAdmin } from "../../lib/supabase.js";
import type { CreateDraftConsultationInput } from "./draft.schema.js";
import type { HeldDraft } from "./draft-supersede.service.js";

/*
 * Refreshing a held draft's intake.
 *
 * A visitor who goes back and re-picks the time they already hold
 * gets that draft returned rather than being refused by their own
 * booking. That is right about the SLOT — and it was wrong about
 * everything else on the form.
 *
 * They may not have gone back only to the Time step. They may have
 * gone back to Details, corrected a typo in their email, fixed
 * their name, cleared a WhatsApp number, rewritten what they want
 * to discuss, and then re-picked the same time. Returning the draft
 * unchanged discarded every one of those edits silently, and the
 * consultant received the version the visitor had already decided
 * was wrong.
 *
 * consultation_intake.email is not a dead snapshot. It is the
 * address the decline, authorization timeout, admin cancellation,
 * recommendation and message notifications are actually sent to. A
 * discarded correction there means mail to an address the visitor
 * already knows is wrong.
 */

export type RefreshDraftIntakeResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_draft"
        | "refresh_failed";
    };

type RefreshRpcRow = {
  consultation_id: string;
  refreshed: boolean;
  reason: "refreshed" | "not_draft" | "not_found";
};

/*
 * Whether the visitor changed the address the draft was created
 * with.
 *
 * Compared the way resolveBookingClient normalises it, so a
 * difference in case or surrounding space is not a change and does
 * not cost an account lookup.
 */
export const hasEmailChanged = ({
  heldEmail,
  submittedEmail,
}: {
  heldEmail: string | null;
  submittedEmail: string;
}): boolean => {
  const normalize = (value: string): string =>
    value.trim().toLowerCase();

  if (heldEmail === null) {
    return true;
  }

  return (
    normalize(heldEmail) !==
    normalize(submittedEmail)
  );
};

/*
 * Rewrite the visitor-editable half of a draft.
 *
 * Every value comes from the request the caller already parsed and
 * validated through the ordinary draft schema, so a refreshed draft
 * holds exactly what a freshly created one would have. Nothing is
 * normalised twice and nothing new is invented.
 *
 * `clientProfileId` is passed only when the email actually changed.
 * The profile is DERIVED from that address — resolveBookingClient
 * turns it into a provisioned client profile under Amendment 002 —
 * so refreshing the email while leaving the profile behind would
 * send notifications to the corrected address while dashboard
 * access stayed under the old one. Null means leave it alone.
 *
 * The consultant, the schedule, the price, the currency, the
 * booking source and every payment field are not parameters of the
 * RPC at all, so no caller can ask for them and no check has to
 * refuse them.
 */
export const refreshDraftIntake = async ({
  consultationId,
  draft,
  clientProfileId,
}: {
  consultationId: string;
  draft: CreateDraftConsultationInput;
  clientProfileId: string | null;
}): Promise<RefreshDraftIntakeResult> => {
  const { data, error } =
    await supabaseAdmin.rpc(
      "refresh_draft_consultation_intake",
      {
        p_consultation_id: consultationId,
        p_full_name: draft.intake.full_name,
        p_email: draft.intake.email,
        p_phone_whatsapp:
          draft.intake.phone_whatsapp,
        p_answers_jsonb: draft.intake.answers,
        p_client_timezone:
          draft.client_timezone,
        p_country_id: draft.country_id,
        p_client_profile_id: clientProfileId,
      },
    );

  if (error) {
    console.error(
      "Draft intake refresh failed",
      {
        consultationId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      reason: "refresh_failed",
    };
  }

  const row = (
    data as RefreshRpcRow[] | null
  )?.[0];

  if (!row) {
    console.error(
      "Draft intake refresh returned no row",
      { consultationId },
    );

    return {
      ok: false,
      reason: "refresh_failed",
    };
  }

  if (!row.refreshed) {
    /*
     * The draft moved on between resolution and here — expired by
     * the worker, or cancelled. Reported rather than swallowed:
     * the visitor's edits did not land, and pretending otherwise
     * is the failure this whole module exists to prevent.
     */
    return {
      ok: false,
      reason:
        row.reason === "not_found"
          ? "not_found"
          : "not_draft",
    };
  }

  return { ok: true };
};

/*
 * The draft to return after a same-slot refresh.
 *
 * Identity is entirely unchanged: the same consultation, the same
 * hold, the same price and currency, and the same checkout token
 * the request arrived with. No second consultation, no second
 * capability. Only what the visitor typed has moved.
 */
export const toRefreshedDraftResponse = ({
  draft,
  checkoutToken,
}: {
  draft: HeldDraft;
  checkoutToken: string;
}): {
  consultation_id: string;
  status: "draft";
  hold_expires_at: string;
  price_cents: number;
  currency: string;
  checkout_token: string;
} => ({
  consultation_id: draft.consultationId,
  status: "draft",
  hold_expires_at: draft.holdExpiresAt,
  price_cents: draft.priceCents,
  currency: draft.currency,
  checkout_token: checkoutToken,
});
