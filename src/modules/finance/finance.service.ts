import {
  createLedgerAdjustment,
  recordConsultationEarning,
  recordDirectBookingEarning,
  releaseConsultationEarning,
  releaseDirectBookingEarning,
  reverseConsultationEarningRpc,
  reverseDirectBookingEarningRpc,
  type AdjustmentRow,
  type FinanceMarker,
} from "./finance.repository.js";

/*
 * Consultation earnings and admin adjustments.
 *
 * The two consultation entry points here are deliberately
 * forgiving. They are called as a side effect of work that has
 * already succeeded — a captured payment, a completed
 * consultation, a processed refund — and none of them may turn a
 * finance problem into a failure of that work. A Stripe webhook
 * that returned non-2xx because a ledger row could not be written
 * would be redelivered, and redelivery re-runs the payment
 * transition, which is a far worse outcome than a missing entry
 * that the next call recreates.
 *
 * So both report their outcome and never throw. Nothing here
 * decides an amount: that is settled inside the RPC.
 */

export type EarningSyncOutcome = {
  recorded: boolean;
  released: boolean;
  entryId: string | null;
  reason: string;
};

/*
 * Bring the ledger in line with a consultation's current state.
 *
 * Called from both sides of the race that the locked rules
 * create: capture may happen before or after completion, and the
 * earning becomes available only once both have. Whichever call
 * runs second does the release; the first is a no-op. Neither
 * call site has to know which one it is.
 */
/*
 * HOW A CONSULTATION FINDS ITS FINANCE PATH.
 *
 * There are two, and which one applies depends on
 * consultations.booking_source. The webhook may not read that
 * column: Amendment 004 section 10.3.3 holds the Stripe path to
 * RPC calls only, and the webhook tests enforce it.
 *
 * So the DATABASE decides, through one uniform rule: try the
 * DIRECT RPC first, and fall back to the standard one when it
 * answers FINANCE_NOT_DIRECT_BOOKING. All three direct RPCs raise
 * that marker for a standard consultation, so the rule is the same
 * for record, release and reverse.
 *
 * Deciding this way rather than by a lookup means the answer is
 * read under the same row lock as the write it authorises. A
 * separate read could be stale by the time the write happens; this
 * cannot be.
 *
 * The reverse direction is guarded too: migration 045 gives
 * record_consultation_earning a matching booking_source check, so
 * a direct booking cannot be recorded through the standard path
 * even by a caller that skipped this dispatch. Two earnings for
 * one payment is the failure both guards exist to prevent.
 */
const isNotDirectBooking = (
  marker: FinanceMarker | null,
): boolean =>
  marker === "FINANCE_NOT_DIRECT_BOOKING";

/*
 * A direct booking's two components, recorded and then released.
 *
 * Reported through the same EarningSyncOutcome the standard path
 * uses, with the STANDARD component's entry id: callers use it for
 * logging and correlation, and a direct booking has no single
 * entry to name. The full breakdown lives in the ledger, which is
 * the only place it should be read from anyway.
 */
const syncDirectBookingEarning = async ({
  consultationId,
  recordResult,
}: {
  consultationId: string;
  /*
   * The record call the dispatcher already made. Passed in rather
   * than repeated: recording is idempotent, but a second call is
   * a second row lock on the consultation for no new information.
   */
  recordResult: Awaited<
    ReturnType<
      typeof recordDirectBookingEarning
    >
  >;
}): Promise<EarningSyncOutcome> => {
  if (!recordResult.ok) {
    if (
      recordResult.marker ===
      "FINANCE_CONSULTATION_NOT_CAPTURED"
    ) {
      return {
        recorded: false,
        released: false,
        entryId: null,
        reason: "not_captured",
      };
    }

    console.error(
      "Direct booking earning could not be recorded",
      {
        consultationId,
        marker: recordResult.marker,
      },
    );

    return {
      recorded: false,
      released: false,
      entryId: null,
      reason:
        recordResult.marker ??
        "record_failed",
    };
  }

  const releaseResult =
    await releaseDirectBookingEarning(
      consultationId,
    );

  if (!releaseResult.ok) {
    console.error(
      "Direct booking earning could not be released",
      {
        consultationId,
        marker: releaseResult.marker,
      },
    );

    return {
      recorded: recordResult.row.created,
      released: false,
      entryId:
        recordResult.row
          .standard_entry_id,
      reason:
        releaseResult.marker ??
        "release_failed",
    };
  }

  return {
    recorded: recordResult.row.created,
    released: releaseResult.row.released,
    entryId:
      recordResult.row.standard_entry_id,
    reason: releaseResult.row.reason,
  };
};

export const syncConsultationEarning =
  async (
    consultationId: string,
  ): Promise<EarningSyncOutcome> => {
    const directResult =
      await recordDirectBookingEarning(
        consultationId,
      );

    if (
      directResult.ok ||
      !isNotDirectBooking(
        directResult.marker,
      )
    ) {
      /*
       * Either it IS a direct booking, or it failed for a reason
       * that has nothing to do with which path applies — not yet
       * captured, no price, settings missing. Both belong to the
       * direct path, which reports them properly.
       */
      return syncDirectBookingEarning({
        consultationId,
        recordResult: directResult,
      });
    }

    const recordResult =
      await recordConsultationEarning(
        consultationId,
      );

    if (!recordResult.ok) {
      /*
       * Not yet captured is the ordinary case when a
       * consultation is completed before its payment settles.
       * It is an outcome, not a fault.
       */
      if (
        recordResult.marker ===
        "FINANCE_CONSULTATION_NOT_CAPTURED"
      ) {
        return {
          recorded: false,
          released: false,
          entryId: null,
          reason: "not_captured",
        };
      }

      console.error(
        "Consultation earning could not be recorded",
        {
          consultationId,
          marker: recordResult.marker,
        },
      );

      return {
        recorded: false,
        released: false,
        entryId: null,
        reason:
          recordResult.marker ??
          "record_failed",
      };
    }

    const releaseResult =
      await releaseConsultationEarning(
        consultationId,
      );

    if (!releaseResult.ok) {
      console.error(
        "Consultation earning could not be released",
        {
          consultationId,
          marker: releaseResult.marker,
        },
      );

      return {
        recorded: recordResult.row.created,
        released: false,
        entryId: recordResult.row.entry_id,
        reason:
          releaseResult.marker ??
          "release_failed",
      };
    }

    return {
      recorded: recordResult.row.created,
      released: releaseResult.row.released,
      entryId: recordResult.row.entry_id,
      reason: releaseResult.row.reason,
    };
  };

export type ReversalOutcome = {
  reversed: boolean;
  entryId: string | null;
  reason: string;
};

/*
 * Reverse a consultation's earning after a refund or chargeback.
 *
 * The original is never touched; the RPC inserts a negative
 * entry against it. If the earning was already paid out the
 * consultant's balance goes negative, which is the intended
 * behaviour: the debt rides forward and future earnings offset it.
 *
 * A consultation with no earning — refunded before it was ever
 * captured — is a no-op, not an error.
 */
export const reverseConsultationEarning =
  async ({
    consultationId,
    reason,
    grossAmountMinor,
    refundedTotalMinor,
  }: {
    consultationId: string;
    reason: string;
    grossAmountMinor?: number | null;
    /*
     * The CUMULATIVE refunded total from Stripe, used only by the
     * direct booking path. Omitted, a direct booking is reversed
     * in full — the right answer for a cancellation, and the wrong
     * one for a partial refund, which is why the webhook passes
     * charge.amount_refunded.
     */
    refundedTotalMinor?: number | null;
  }): Promise<ReversalOutcome> => {
    /*
     * Direct first, exactly as the earning path does. A standard
     * consultation answers FINANCE_NOT_DIRECT_BOOKING and falls
     * through.
     */
    const directResult =
      await reverseDirectBookingEarningRpc({
        consultationId,
        reason,
        refundedTotalMinor:
          refundedTotalMinor ?? null,
      });

    if (directResult.ok) {
      return {
        reversed:
          directResult.row.reversed,
        entryId: null,
        reason: directResult.row.reason,
      };
    }

    if (
      !isNotDirectBooking(
        directResult.marker,
      )
    ) {
      console.error(
        "Direct booking earning could not be reversed",
        {
          consultationId,
          marker: directResult.marker,
        },
      );

      return {
        reversed: false,
        entryId: null,
        reason:
          directResult.marker ??
          "reversal_failed",
      };
    }

    const result =
      await reverseConsultationEarningRpc({
        consultationId,
        reason,
        ...(grossAmountMinor === undefined
          ? {}
          : { grossAmountMinor }),
      });

    if (!result.ok) {
      console.error(
        "Consultation earning could not be reversed",
        {
          consultationId,
          marker: result.marker,
        },
      );

      return {
        reversed: false,
        entryId: null,
        reason:
          result.marker ?? "reversal_failed",
      };
    }

    return {
      reversed: result.row.reversed,
      entryId: result.row.entry_id,
      reason: result.row.reason,
    };
  };

export type AdjustmentResult =
  | {
      ok: true;
      adjustment: AdjustmentRow;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "VALIDATION_ERROR"
        | "FORBIDDEN"
        | "INTERNAL_ERROR";
      message: string;
    };

const ADJUSTMENT_MESSAGES: Partial<
  Record<FinanceMarker, string>
> = {
  FINANCE_CONSULTANT_NOT_FOUND:
    "The consultant was not found.",
  FINANCE_ADMIN_REQUIRED:
    "Only an admin may record a financial adjustment.",
  FINANCE_REASON_REQUIRED:
    "A reason is required for every adjustment.",
  FINANCE_ADJUSTMENT_AMOUNT_INVALID:
    "An adjustment must be a non-zero amount.",
  FINANCE_CURRENCY_INVALID:
    "The currency is not a three-letter code.",
};

/*
 * An admin credit or debit. It is a ledger entry like any other
 * — no balance is written, and the balance follows from the row.
 */
export const recordAdminAdjustment =
  async ({
    consultantId,
    amountMinor,
    currency,
    memo,
    adminProfileId,
  }: {
    consultantId: string;
    amountMinor: number;
    currency: string;
    memo: string;
    adminProfileId: string;
  }): Promise<AdjustmentResult> => {
    const result =
      await createLedgerAdjustment({
        consultantId,
        amountMinor,
        currency,
        memo,
        adminProfileId,
      });

    if (result.ok) {
      return {
        ok: true,
        adjustment: result.row,
      };
    }

    switch (result.marker) {
      case "FINANCE_CONSULTANT_NOT_FOUND":
        return {
          ok: false,
          code: "NOT_FOUND",
          message:
            ADJUSTMENT_MESSAGES[
              result.marker
            ]!,
        };

      case "FINANCE_ADMIN_REQUIRED":
        return {
          ok: false,
          code: "FORBIDDEN",
          message:
            ADJUSTMENT_MESSAGES[
              result.marker
            ]!,
        };

      case "FINANCE_REASON_REQUIRED":
      case "FINANCE_ADJUSTMENT_AMOUNT_INVALID":
      case "FINANCE_CURRENCY_INVALID":
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message:
            ADJUSTMENT_MESSAGES[
              result.marker
            ]!,
        };

      default:
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The adjustment could not be recorded.",
        };
    }
  };
