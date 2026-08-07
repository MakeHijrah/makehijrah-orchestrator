import {
  createLedgerAdjustment,
  recordConsultationEarning,
  releaseConsultationEarning,
  reverseConsultationEarningRpc,
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
export const syncConsultationEarning =
  async (
    consultationId: string,
  ): Promise<EarningSyncOutcome> => {
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
  }: {
    consultationId: string;
    reason: string;
    grossAmountMinor?: number | null;
  }): Promise<ReversalOutcome> => {
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
