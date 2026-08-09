import { createCheckoutCapability } from "./checkout-capability.service.js";
import {
  abandonDraftConsultation,
  createDraftConsultationRecord,
  type CreatedDraftConsultation,
} from "./draft.repository.js";
import type { CreateDraftConsultationInput } from "./draft.schema.js";

/*
 * Creating a bookable draft, and releasing the slot when that
 * fails.
 *
 * These two steps live together because they are one operation
 * that cannot be one transaction. The consultation row is in
 * PostgreSQL; the checkout capability is a key in Redis. Nothing
 * can make them atomic, so there is a window in which the row
 * exists and the booking cannot proceed — and a row in 'draft'
 * reserves its slot through unique_reserved_consultant_slot.
 *
 * NOTHING ELSE RECLAIMS THAT SLOT. The expire-drafts job named in
 * API_CONTRACT section 5 has never been implemented, so an
 * abandoned draft holds its slot until an admin intervenes.
 * Between migrations 045 and 046 that is exactly what happened:
 * the draft RPC stopped returning hold_expires_at, every booking
 * failed at the capability step, and each retry consumed another
 * slot until the consultant had none left.
 *
 * So the compensation is not an afterthought bolted onto the
 * failure branch; it is half of what this function is for, which
 * is why it is here rather than inline in the route.
 */

export type PrepareDraftInput = {
  clientProfileId: string;
  scheduledEndAt: string;
  consultantId: string;
  priceCents: number;
  currency: string;
  bookingSource: "standard" | "direct_booking";
  draft: CreateDraftConsultationInput;
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
     */
    return {
      ok: true,
      draft: creationResult.draft,
      checkoutToken: capabilityResult.token,
    };
  };
