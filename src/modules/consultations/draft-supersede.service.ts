import { supabaseAdmin } from "../../lib/supabase.js";
import {
  consumeCheckoutCapability,
  validateCheckoutCapability,
} from "./checkout-capability.service.js";
import { abandonDraftConsultation } from "./draft.repository.js";
import {
  calculateHoldExpiration,
  isHoldExpired,
} from "./draft-hold.js";

/*
 * Superseding a draft.
 *
 * A visitor reaches the payment step, goes back, and picks a
 * different time. Draft A is now dead but the server has never been
 * told, and a draft IS the slot hold — so A keeps that time
 * reserved. Repeat it a few times and one visitor has quietly
 * consumed a consultant's whole day.
 *
 * The replacement request carries A's identifier AND A's checkout
 * capability token, and the token is the authorisation. It is
 * already a bearer capability scoped to exactly one consultation:
 * thirty-two random bytes, stored only as a sha256 digest, bound to
 * a consultation id, and expiring with the hold. So the browser
 * cannot release a draft it was not given, cannot release someone
 * else's draft, and cannot release a booking that has advanced past
 * draft — abandon_draft_consultation matches status = 'draft' in
 * the database, which is the guarantee that does not depend on this
 * file being right.
 *
 * An id alone authorises nothing. That is the whole design.
 */

export type SupersedeClaim = {
  consultationId: string;
  checkoutToken: string;
};

export type HeldDraft = {
  consultationId: string;
  consultantId: string;
  scheduledStartAt: string;
  status: string;
  priceCents: number;
  currency: string;
  createdAt: string;
  holdExpiresAt: string;
};

export type ResolveSupersededResult =
  | {
      ok: true;
      draft: HeldDraft;
    }
  | {
      ok: false;
      /*
       * Every one of these means "carry on as an ordinary
       * booking". None is an error the visitor should see: a claim
       * that cannot be honoured must never block a booking that is
       * otherwise valid, and must never be reported in a way that
       * tells a caller whether some consultation id exists.
       */
      reason:
        | "token_invalid"
        | "not_found"
        | "not_draft"
        | "hold_expired"
        | "lookup_failed";
    };

type HeldDraftRow = {
  id: string;
  consultant_id: string;
  scheduled_start_at: string;
  status: string;
  price_cents: number;
  currency: string;
  created_at: string;
};

/*
 * Resolve a supersedes claim to the draft it names.
 *
 * Validates but does NOT consume the capability. Consuming here
 * would release A's token before B exists, and a request that then
 * failed would leave the visitor holding a booking they could no
 * longer pay for. The token is consumed only once B is fully
 * prepared, or — for a same-slot reselection — not at all.
 */
export const resolveSupersededDraft =
  async (
    claim: SupersedeClaim,
  ): Promise<ResolveSupersededResult> => {
    /*
     * The token first, before any lookup. A caller who guesses a
     * consultation id learns nothing about whether it exists,
     * because an unbound token and an unknown id both stop here.
     */
    const capability =
      await validateCheckoutCapability({
        consultationId:
          claim.consultationId,
        token: claim.checkoutToken,
      });

    if (!capability.ok) {
      return {
        ok: false,
        reason: "token_invalid",
      };
    }

    const { data, error } =
      await supabaseAdmin
        .from("consultations")
        .select(
          "id, consultant_id, scheduled_start_at, status, price_cents, currency, created_at",
        )
        .eq("id", claim.consultationId)
        .maybeSingle();

    if (error) {
      console.error(
        "Superseded draft lookup failed",
        {
          consultationId:
            claim.consultationId,
          code: error.code,
          message: error.message,
        },
      );

      return {
        ok: false,
        reason: "lookup_failed",
      };
    }

    const row =
      data as HeldDraftRow | null;

    if (!row) {
      return { ok: false, reason: "not_found" };
    }

    /*
     * Only a draft can be superseded. A consultation that has
     * advanced is a real booking, and the fact that its token
     * happens to still be in Redis does not make it disposable.
     */
    if (row.status !== "draft") {
      return { ok: false, reason: "not_draft" };
    }

    if (isHoldExpired(row.created_at)) {
      return {
        ok: false,
        reason: "hold_expired",
      };
    }

    const holdExpiresAt =
      calculateHoldExpiration(
        row.created_at,
      );

    if (!holdExpiresAt) {
      return {
        ok: false,
        reason: "hold_expired",
      };
    }

    return {
      ok: true,
      draft: {
        consultationId: row.id,
        consultantId: row.consultant_id,
        scheduledStartAt:
          row.scheduled_start_at,
        status: row.status,
        priceCents: row.price_cents,
        currency: row.currency,
        createdAt: row.created_at,
        holdExpiresAt,
      },
    };
  };

/*
 * Is this replacement request asking for the slot it already holds?
 *
 * The visitor went back and picked the same time again. Creating a
 * second draft would collide with the first on
 * unique_reserved_consultant_slot and answer 409 — the visitor
 * refused their own booking. Compared as instants rather than
 * strings, because the request carries an ISO timestamp and the
 * database returns its own rendering of the same moment.
 */
export const isSameSlot = ({
  draft,
  consultantId,
  startAt,
}: {
  draft: HeldDraft;
  consultantId: string;
  startAt: string;
}): boolean => {
  if (draft.consultantId !== consultantId) {
    return false;
  }

  const held = Date.parse(
    draft.scheduledStartAt,
  );

  const requested = Date.parse(startAt);

  return (
    Number.isFinite(held) &&
    Number.isFinite(requested) &&
    held === requested
  );
};

export type ReleaseSupersededOutcome = {
  released: boolean;
  reason: string;
};

/*
 * Release A, once B is safely in hand.
 *
 * Two steps, in this order: consume the capability, then cancel the
 * draft. Consuming first means the token cannot be replayed even if
 * the cancel then fails — and if it does fail, the draft is left
 * for the expiry worker rather than left with a live token.
 *
 * Never throws. This runs after B has already succeeded, and a
 * problem releasing A must not turn a completed booking into an
 * error.
 */
export const releaseSupersededDraft =
  async (
    claim: SupersedeClaim,
  ): Promise<ReleaseSupersededOutcome> => {
    const consumed =
      await consumeCheckoutCapability({
        consultationId:
          claim.consultationId,
        token: claim.checkoutToken,
      });

    if (!consumed.ok) {
      /*
       * The token went between resolution and here — another
       * request used it, or it expired. The draft may still be
       * holding its slot, so say so and let the worker take it.
       */
      return {
        released: false,
        reason: consumed.code,
      };
    }

    const cleanup =
      await abandonDraftConsultation(
        claim.consultationId,
      );

    return {
      released: cleanup.cancelled,
      reason: cleanup.reason,
    };
  };
