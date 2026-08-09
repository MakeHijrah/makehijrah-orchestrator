import { createCheckoutCapability } from "./checkout-capability.service.js";
import {
  abandonDraftConsultation,
  createDraftConsultationRecord,
  type CreatedDraftConsultation,
} from "./draft.repository.js";
import {
  releaseSupersededDraft,
  type SupersedeClaim,
} from "./draft-supersede.service.js";
import type { CreateDraftConsultationInput } from "./draft.schema.js";

/*
 * Creating a bookable draft, releasing the slot when that fails,
 * and releasing the PREVIOUS draft when it succeeds.
 *
 * The first two live together because they are one operation that
 * cannot be one transaction. The consultation row is in
 * PostgreSQL; the checkout capability is a key in Redis. Nothing
 * can make them atomic, so there is a window in which the row
 * exists and the booking cannot proceed — and a row in 'draft'
 * reserves its slot through unique_reserved_consultant_slot.
 *
 * Between migrations 045 and 046 that window swallowed every
 * booking: the draft RPC stopped returning hold_expires_at, the
 * capability step failed for all of them, and each retry consumed
 * another slot until the consultant had none left. So the
 * compensation is not an afterthought bolted onto the failure
 * branch; it is half of what this function is for.
 *
 * The third — releasing a superseded draft — is here for the same
 * reason and not a different one. Its correctness is entirely a
 * matter of ORDERING relative to the other two, and an ordering
 * rule split across two files is a rule nobody can check.
 *
 * Migration 047's expiry worker is the backstop under all of it: a
 * draft that survives every path here is cancelled within thirty
 * minutes rather than holding its slot indefinitely.
 */

export type PrepareDraftInput = {
  clientProfileId: string;
  scheduledEndAt: string;
  consultantId: string;
  priceCents: number;
  currency: string;
  bookingSource: "standard" | "direct_booking";
  draft: CreateDraftConsultationInput;
  /*
   * The draft this one replaces, already resolved and verified by
   * the caller. Released ONLY once the replacement is fully
   * prepared - see the note on the success path below.
   */
  supersedes?: SupersedeClaim | null;
};

export type SupersedeOutcome = {
  attempted: boolean;
  released: boolean;
  consultationId: string | null;
  reason: string | null;
};

const NO_SUPERSEDE: SupersedeOutcome = {
  attempted: false,
  released: false,
  consultationId: null,
  reason: null,
};

export type DraftCleanupOutcome = {
  attempted: boolean;
  released: boolean;
  consultationId: string | null;
  reason: string | null;
};

export type PrepareDraftResult =
  | {
      ok: true;
      draft: CreatedDraftConsultation;
      checkoutToken: string;
      /*
       * What happened to the draft this one replaced. Reported for
       * logging; it never affects the result, because the
       * replacement succeeded and that is what the visitor is
       * told.
       */
      supersede: SupersedeOutcome;
    }
  | {
      ok: false;
      code: "SLOT_TAKEN" | "INTERNAL_ERROR";
      message: string;
      /*
       * What happened to the slot, for the caller to log. It never
       * affects the response: the client is told about the failure
       * that stopped their booking, not about the cleanup of it.
       */
      cleanup: DraftCleanupOutcome;
      cause:
        | "draft_slot_taken"
        | "draft_creation_failed"
        | "draft_contract_mismatch"
        | "checkout_capability_failed";
    };

const NO_CLEANUP: DraftCleanupOutcome = {
  attempted: false,
  released: false,
  consultationId: null,
  reason: null,
};

/*
 * Release a slot held by a draft this request created.
 *
 * The RPC matches on id AND status = 'draft', so it cannot cancel
 * a consultation that has advanced past draft — a booking whose
 * payment preparation actually succeeded is untouchable by
 * construction, not by a check that could be forgotten. It never
 * throws.
 */
const releaseHeldSlot = async (
  consultationId: string,
): Promise<DraftCleanupOutcome> => {
  const cleanup =
    await abandonDraftConsultation(
      consultationId,
    );

  return {
    attempted: true,
    released: cleanup.cancelled,
    consultationId,
    reason: cleanup.reason,
  };
};

export const prepareDraftConsultation =
  async (
    input: PrepareDraftInput,
  ): Promise<PrepareDraftResult> => {
    const creationResult =
      await createDraftConsultationRecord(
        input,
      );

    if (!creationResult.ok) {
      if (
        creationResult.code === "SLOT_TAKEN"
      ) {
        /*
         * The unique index refused the insert, so no row exists
         * and there is nothing to release. Cleaning up here would
         * mean cancelling somebody else's booking — the one that
         * legitimately holds the slot.
         */
        return {
          ok: false,
          code: "SLOT_TAKEN",
          message: creationResult.message,
          cleanup: NO_CLEANUP,
          cause: "draft_slot_taken",
        };
      }

      /*
       * Set only when the row WAS created and then found unusable,
       * which today means the RPC returned a shape the
       * orchestrator cannot consume. Absent when the insert itself
       * failed.
       */
      if (
        creationResult.orphanedConsultationId
      ) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message: creationResult.message,
          cleanup: await releaseHeldSlot(
            creationResult.orphanedConsultationId,
          ),
          cause:
            "draft_contract_mismatch",
        };
      }

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message: creationResult.message,
        cleanup: NO_CLEANUP,
        cause: "draft_creation_failed",
      };
    }

    const capabilityResult =
      await createCheckoutCapability({
        consultationId:
          creationResult.draft
            .consultationId,
        holdExpiresAt:
          creationResult.draft
            .holdExpiresAt,
      });

    if (!capabilityResult.ok) {
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The booking could not be prepared for payment.",
        cleanup: await releaseHeldSlot(
          creationResult.draft
            .consultationId,
        ),
        cause:
          "checkout_capability_failed",
      };
    }

    /*
     * Success. No cleanup runs on this path at all — the draft is
     * a live booking with a valid checkout token, and the client
     * is on their way to Stripe.
     *
     * ONLY NOW is the superseded draft released, and the ordering
     * is the entire point. Releasing it earlier — before the
     * insert, or in parallel with it — would mean a request that
     * then failed left the visitor with no booking at all, having
     * given up a slot somebody else may take in the interval.
     * Holding both for a moment costs nothing; losing the only one
     * costs the booking.
     *
     * Every failure path above returns before reaching this line,
     * so a replacement that did not happen cannot release
     * anything. That is why this lives here rather than in the
     * route: the ordering is a property of this function and is
     * checked as one.
     *
     * A release failure does not change the result. The old draft
     * keeps its slot until the expiry worker reclaims it within
     * thirty minutes, which is the backstop that lets this path
     * fail safely.
     */
    let supersede = NO_SUPERSEDE;

    if (input.supersedes) {
      const release =
        await releaseSupersededDraft(
          input.supersedes,
        );

      supersede = {
        attempted: true,
        released: release.released,
        consultationId:
          input.supersedes.consultationId,
        reason: release.reason,
      };
    }

    return {
      ok: true,
      draft: creationResult.draft,
      checkoutToken: capabilityResult.token,
      supersede,
    };
  };
