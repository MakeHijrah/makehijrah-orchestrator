import {
  decidePayout,
  loadConsultantIdForProfile,
  markPayoutPaid,
  requestConsultantPayout,
  type PayoutDecisionRow,
  type PayoutPaidRow,
  type PayoutRequestRow,
} from "./finance.repository.js";

/*
 * Payout request and payout decisions.
 *
 * The consultant side takes no amount and no consultant id. Both
 * are derived: the consultant from the authenticated profile, the
 * amount from the ledger inside the RPC. A client-supplied
 * balance is therefore not merely rejected, it has nowhere to be
 * supplied — which is the only version of "do not trust a
 * client-supplied balance" that cannot be undone by a later edit
 * to a validation schema.
 *
 * A request reserves the WHOLE available balance in one currency.
 * Partial withdrawal is not supported; see migration 035 part E
 * for why that is the simplest safe choice.
 */

export type PayoutRequestResult =
  | {
      ok: true;
      payout: PayoutRequestRow;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "VALIDATION_ERROR"
        | "CONFLICT"
        | "PAYOUT_METHOD_MISSING"
        | "INTERNAL_ERROR";
      message: string;
    };

export const requestPayoutForProfile =
  async ({
    profileId,
    currency,
  }: {
    profileId: string;
    currency: string;
  }): Promise<PayoutRequestResult> => {
    const consultantResult =
      await loadConsultantIdForProfile(
        profileId,
      );

    if (!consultantResult.ok) {
      return consultantResult.code ===
        "NOT_FOUND"
        ? {
            ok: false,
            code: "NOT_FOUND",
            message:
              "The consultant account was not found.",
          }
        : {
            ok: false,
            code: "INTERNAL_ERROR",
            message:
              "The consultant account could not be loaded.",
          };
    }

    const result =
      await requestConsultantPayout({
        consultantId:
          consultantResult.consultantId,
        currency,
      });

    if (result.ok) {
      return { ok: true, payout: result.row };
    }

    switch (result.marker) {
      case "FINANCE_CONSULTANT_NOT_FOUND":
        return {
          ok: false,
          code: "NOT_FOUND",
          message:
            "The consultant account was not found.",
        };

      case "FINANCE_CURRENCY_INVALID":
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message:
            "The currency is not a three-letter code.",
        };

      case "FINANCE_PAYOUT_ALREADY_OPEN":
        return {
          ok: false,
          code: "CONFLICT",
          message:
            "You already have an open payout request in this currency.",
        };

      /*
       * Migration 039. Its own code rather than a plain CONFLICT,
       * because this is the one payout refusal the consultant can
       * fix themselves and the message has somewhere specific to
       * send them. The dialog disables the button before it gets
       * here; this is the backstop for a stale page.
       */
      case "FINANCE_PAYOUT_METHOD_MISSING":
        return {
          ok: false,
          code: "PAYOUT_METHOD_MISSING",
          message:
            "Add your payout method and payout email in Consultant Profile before requesting a payout.",
        };

      case "FINANCE_NO_AVAILABLE_EARNINGS":
        return {
          ok: false,
          code: "CONFLICT",
          message:
            "There are no available earnings to pay out in this currency.",
        };

      case "FINANCE_BALANCE_NOT_POSITIVE":
        return {
          ok: false,
          code: "CONFLICT",
          message:
            "Your available balance in this currency is not positive.",
        };

      default:
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The payout request could not be created.",
        };
    }
  };

export type PayoutDecisionResult =
  | {
      ok: true;
      payout: PayoutDecisionRow;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "CONFLICT"
        | "VALIDATION_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

/*
 * approve, reject or cancel.
 *
 * Approving leaves the allocations exactly where they are, so an
 * approved payout stays reserved. Rejecting and cancelling
 * release them, and the earnings become available again. A paid
 * payout refuses every one of the three.
 */
export const decidePayoutAsAdmin = async ({
  payoutId,
  decision,
  adminProfileId,
  note,
}: {
  payoutId: string;
  decision: "approve" | "reject" | "cancel";
  adminProfileId: string;
  note: string | null;
}): Promise<PayoutDecisionResult> => {
  const result = await decidePayout({
    payoutId,
    decision,
    adminProfileId,
    note,
  });

  if (result.ok) {
    return { ok: true, payout: result.row };
  }

  switch (result.marker) {
    case "FINANCE_PAYOUT_NOT_FOUND":
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "The payout was not found.",
      };

    case "FINANCE_ADMIN_REQUIRED":
      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          "Only an admin may decide a payout.",
      };

    case "FINANCE_PAYOUT_ALREADY_PAID":
      return {
        ok: false,
        code: "CONFLICT",
        message:
          "The payout is already paid and cannot change status.",
      };

    case "FINANCE_PAYOUT_NOT_OPEN":
      return {
        ok: false,
        code: "CONFLICT",
        message:
          "The payout is not open for this decision.",
      };

    case "FINANCE_DECISION_INVALID":
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "The decision is invalid.",
      };

    default:
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The payout decision could not be recorded.",
      };
  }
};

export type PayoutPaidResult =
  | {
      ok: true;
      payout: PayoutPaidRow;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "CONFLICT"
        | "VALIDATION_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

/*
 * Settle an approved payout that an admin has paid by hand.
 *
 * The external reference is required because it is the only link
 * between this row and the transfer that actually happened: V1
 * has no Stripe Connect and no bank integration to reconcile
 * against.
 */
export const markPayoutPaidAsAdmin =
  async ({
    payoutId,
    paidAmountMinor,
    externalReference,
    adminProfileId,
    paidAt,
    note,
  }: {
    payoutId: string;
    paidAmountMinor: number;
    externalReference: string;
    adminProfileId: string;
    paidAt: string | null;
    note: string | null;
  }): Promise<PayoutPaidResult> => {
    const result = await markPayoutPaid({
      payoutId,
      paidAmountMinor,
      externalReference,
      adminProfileId,
      paidAt,
      note,
    });

    if (result.ok) {
      return { ok: true, payout: result.row };
    }

    switch (result.marker) {
      case "FINANCE_PAYOUT_NOT_FOUND":
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "The payout was not found.",
        };

      case "FINANCE_ADMIN_REQUIRED":
        return {
          ok: false,
          code: "FORBIDDEN",
          message:
            "Only an admin may mark a payout paid.",
        };

      case "FINANCE_PAYOUT_ALREADY_PAID":
        return {
          ok: false,
          code: "CONFLICT",
          message:
            "The payout is already paid.",
        };

      case "FINANCE_PAYOUT_NOT_APPROVED":
        return {
          ok: false,
          code: "CONFLICT",
          message:
            "Only an approved payout may be marked paid.",
        };

      case "FINANCE_PAID_AMOUNT_INVALID":
      case "FINANCE_REFERENCE_REQUIRED":
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message:
            result.marker ===
            "FINANCE_PAID_AMOUNT_INVALID"
              ? "A paid payout must record a positive amount."
              : "A paid payout must record an external reference.",
        };

      default:
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The payout could not be marked paid.",
        };
    }
  };
