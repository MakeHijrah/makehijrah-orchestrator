import { supabaseAdmin } from "../../lib/supabase.js";
import type { CreateDraftConsultationInput } from "./draft.schema.js";

type CreateDraftRepositoryInput = {
  clientProfileId: string;
  scheduledEndAt: string;
  /*
   * The consultant the SERVER resolved.
   *
   * Passed explicitly rather than read from draft.consultant_id,
   * because for a direct booking the request carries no id at all
   * — the consultant is whoever the slug's published page belongs
   * to. Taking it from the body here would reintroduce exactly the
   * browser-supplied identifier the route refuses to trust.
   */
  consultantId: string;
  /*
   * Snapshot values resolved by the caller: the platform price
   * from app_settings for a standard booking, or the EFFECTIVE
   * direct price for a direct booking.
   *
   * Passed in rather than read here so a single request resolves
   * settings once, and so the price written to the consultation is
   * demonstrably the one the route loaded and the one the page
   * displayed. Never supplied by the client: the draft request
   * body carries no price or currency field and none is accepted.
   */
  priceCents: number;
  currency: string;
  /*
   * Also the server's, and for the same reason. booking_source
   * decides which commission rules apply to the money, so a
   * request that could set it could choose its own split.
   */
  bookingSource:
    | "standard"
    | "direct_booking";
  draft: CreateDraftConsultationInput;
};

export type CreatedDraftConsultation = {
  consultationId: string;
  status: "draft";
  holdExpiresAt: string;
  priceCents: number;
  currency: string;
};

export type CreateDraftRepositoryResult =
  | {
      ok: true;
      draft: CreatedDraftConsultation;
    }
  | {
      ok: false;
      code: "SLOT_TAKEN" | "INTERNAL_ERROR";
      message: string;
    };

type DraftRpcRow = {
  consultation_id: string;
  consultation_status: "draft";
  hold_expires_at: string;
  consultation_price_cents: number;
  consultation_currency: string;
};

export const createDraftConsultationRecord = async ({
  clientProfileId,
  scheduledEndAt,
  consultantId,
  priceCents,
  currency,
  bookingSource,
  draft,
}: CreateDraftRepositoryInput): Promise<CreateDraftRepositoryResult> => {
  const { data, error } = await supabaseAdmin.rpc(
    "create_draft_consultation",
    {
      p_client_profile_id: clientProfileId,
      p_consultant_id: consultantId,
      p_country_id: draft.country_id,
      p_scheduled_start_at: draft.start_at,
      p_scheduled_end_at: scheduledEndAt,
      p_client_timezone: draft.client_timezone,
      p_price_cents: priceCents,
      p_currency: currency,
      p_full_name: draft.intake.full_name,
      p_email: draft.intake.email,
      p_phone_whatsapp:
        draft.intake.phone_whatsapp,
      p_answers_jsonb: draft.intake.answers,
      p_booking_source: bookingSource,
    },
  );

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        code: "SLOT_TAKEN",
        message:
          "The selected consultation time is no longer available.",
      };
    }

    console.error(
      "Draft consultation RPC failed",
      {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        consultantId,
        clientProfileId,
        startAt: draft.start_at,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be created.",
    };
  }

  const rows = data as DraftRpcRow[] | null;
  const row = rows?.[0];

  if (!row) {
    console.error(
      "Draft consultation RPC returned no row",
      {
        consultantId,
        clientProfileId,
        startAt: draft.start_at,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be created.",
    };
  }

  return {
    ok: true,
    draft: {
      consultationId: row.consultation_id,
      status: row.consultation_status,
      holdExpiresAt: row.hold_expires_at,
      priceCents:
        row.consultation_price_cents,
      currency: row.consultation_currency,
    },
  };
};
