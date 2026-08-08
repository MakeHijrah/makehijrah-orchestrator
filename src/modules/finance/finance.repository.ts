import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Finance RPC boundary (migration 035).
 *
 * Every financial write is one RPC call. This layer does no
 * arithmetic and makes no decision: it forwards arguments, reads
 * the single returned row, and turns a raised marker into a
 * typed value. The database is the referee for all of it, which
 * is what lets two concurrent payout requests be safe.
 *
 * Raw PostgreSQL text never leaves this file.
 */

export type FinanceMarker =
  | "FINANCE_CONSULTATION_NOT_FOUND"
  | "FINANCE_CONSULTATION_NOT_CAPTURED"
  | "FINANCE_CONSULTATION_AMOUNT_INVALID"
  | "FINANCE_SETTINGS_MISSING"
  | "FINANCE_ENTRY_NOT_FOUND"
  | "FINANCE_ENTRY_NOT_REVERSIBLE"
  | "FINANCE_REVERSAL_EXCEEDS_ORIGINAL"
  | "FINANCE_REVERSAL_AMOUNT_INVALID"
  | "FINANCE_REASON_REQUIRED"
  | "FINANCE_ADJUSTMENT_AMOUNT_INVALID"
  | "FINANCE_CURRENCY_INVALID"
  | "FINANCE_CONSULTANT_NOT_FOUND"
  | "FINANCE_ADMIN_REQUIRED"
  | "FINANCE_PAYOUT_ALREADY_OPEN"
  | "FINANCE_PAYOUT_METHOD_MISSING"
  | "FINANCE_NO_AVAILABLE_EARNINGS"
  | "FINANCE_BALANCE_NOT_POSITIVE"
  | "FINANCE_PAYOUT_NOT_FOUND"
  | "FINANCE_PAYOUT_ALREADY_PAID"
  | "FINANCE_PAYOUT_NOT_OPEN"
  | "FINANCE_PAYOUT_NOT_APPROVED"
  | "FINANCE_DECISION_INVALID"
  | "FINANCE_PAID_AMOUNT_INVALID"
  | "FINANCE_REFERENCE_REQUIRED"
  /* Migration 040: service purchase finance. */
  | "FINANCE_PURCHASE_AMOUNT_INVALID"
  | "FINANCE_STRIPE_MODE_INVALID"
  | "FINANCE_STRIPE_REFERENCE_REQUIRED"
  | "FINANCE_SERVICE_NOT_FOUND"
  | "FINANCE_PURCHASE_CONFLICT"
  | "FINANCE_PURCHASE_NOT_FOUND"
  | "FINANCE_PURCHASE_NOT_FULFILLABLE"
  | "FINANCE_REFUND_EXCEEDS_PURCHASE";

const FINANCE_MARKERS: FinanceMarker[] = [
  "FINANCE_CONSULTATION_NOT_FOUND",
  "FINANCE_CONSULTATION_NOT_CAPTURED",
  "FINANCE_CONSULTATION_AMOUNT_INVALID",
  "FINANCE_SETTINGS_MISSING",
  "FINANCE_ENTRY_NOT_FOUND",
  "FINANCE_ENTRY_NOT_REVERSIBLE",
  "FINANCE_REVERSAL_EXCEEDS_ORIGINAL",
  "FINANCE_REVERSAL_AMOUNT_INVALID",
  "FINANCE_REASON_REQUIRED",
  "FINANCE_ADJUSTMENT_AMOUNT_INVALID",
  "FINANCE_CURRENCY_INVALID",
  "FINANCE_CONSULTANT_NOT_FOUND",
  "FINANCE_ADMIN_REQUIRED",
  "FINANCE_PAYOUT_ALREADY_OPEN",
  "FINANCE_PAYOUT_METHOD_MISSING",
  "FINANCE_NO_AVAILABLE_EARNINGS",
  "FINANCE_BALANCE_NOT_POSITIVE",
  "FINANCE_PAYOUT_NOT_FOUND",
  "FINANCE_PAYOUT_ALREADY_PAID",
  "FINANCE_PAYOUT_NOT_OPEN",
  "FINANCE_PAYOUT_NOT_APPROVED",
  "FINANCE_DECISION_INVALID",
  "FINANCE_PAID_AMOUNT_INVALID",
  "FINANCE_REFERENCE_REQUIRED",
  "FINANCE_PURCHASE_AMOUNT_INVALID",
  "FINANCE_STRIPE_MODE_INVALID",
  "FINANCE_STRIPE_REFERENCE_REQUIRED",
  "FINANCE_SERVICE_NOT_FOUND",
  "FINANCE_PURCHASE_CONFLICT",
  "FINANCE_PURCHASE_NOT_FOUND",
  "FINANCE_PURCHASE_NOT_FULFILLABLE",
  "FINANCE_REFUND_EXCEEDS_PURCHASE",
];

export const readFinanceMarker = (
  message: string | null | undefined,
): FinanceMarker | null => {
  if (!message) {
    return null;
  }

  return (
    FINANCE_MARKERS.find((marker) =>
      message.includes(marker),
    ) ?? null
  );
};

export type FinanceRpcResult<T> =
  | {
      ok: true;
      row: T;
    }
  | {
      ok: false;
      marker: FinanceMarker | null;
    };

/*
 * One place where every finance RPC is called, so the logging,
 * the empty-result handling and the marker extraction cannot
 * drift between the seven of them.
 */
export const callFinanceRpc = async <T>(
  name: string,
  args: Record<string, unknown>,
): Promise<FinanceRpcResult<T>> => {
  const { data, error } =
    await supabaseAdmin.rpc(name, args);

  if (error) {
    const marker = readFinanceMarker(
      error.message,
    );

    /*
     * A recognised marker is an expected rejection, not a
     * fault: it is logged at a lower volume and without the
     * PostgreSQL detail, because the caller will turn it into a
     * precise response.
     */
    if (marker) {
      console.warn(
        "Finance RPC rejected the request",
        {
          rpc: name,
          marker,
        },
      );

      return { ok: false, marker };
    }

    console.error("Finance RPC failed", {
      rpc: name,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    return { ok: false, marker: null };
  }

  const row = (
    data as unknown as T[] | null
  )?.[0];

  if (!row) {
    console.error(
      "Finance RPC returned no row",
      { rpc: name },
    );

    return { ok: false, marker: null };
  }

  return { ok: true, row };
};

export type ConsultationEarningRow = {
  entry_id: string;
  created: boolean;
  gross_amount_minor: number;
  consultant_amount_minor: number;
  platform_amount_minor: number;
  commission_bps: number;
  currency: string;
  available_at: string | null;
};

export const recordConsultationEarning =
  async (
    consultationId: string,
  ): Promise<
    FinanceRpcResult<ConsultationEarningRow>
  > =>
    callFinanceRpc<ConsultationEarningRow>(
      "record_consultation_earning",
      { p_consultation_id: consultationId },
    );

export type ReleaseEarningRow = {
  entry_id: string | null;
  released: boolean;
  reason:
    | "released"
    | "already_available"
    | "no_entry"
    | "not_captured"
    | "not_completed";
  available_at: string | null;
};

export const releaseConsultationEarning =
  async (
    consultationId: string,
  ): Promise<
    FinanceRpcResult<ReleaseEarningRow>
  > =>
    callFinanceRpc<ReleaseEarningRow>(
      "release_consultation_earning",
      { p_consultation_id: consultationId },
    );

export type ReversalRow = {
  entry_id: string;
  reverses_entry_id: string;
  gross_amount_minor: number;
  consultant_amount_minor: number;
  platform_amount_minor: number;
  currency: string;
  available_at: string | null;
};

export const reverseLedgerEntry = async ({
  entryId,
  reason,
  grossAmountMinor,
}: {
  entryId: string;
  reason: string;
  grossAmountMinor?: number | null;
}): Promise<
  FinanceRpcResult<ReversalRow>
> =>
  callFinanceRpc<ReversalRow>(
    "reverse_ledger_entry",
    {
      p_entry_id: entryId,
      p_reason: reason,
      p_gross_amount_minor:
        grossAmountMinor ?? null,
    },
  );

export type AdjustmentRow = {
  entry_id: string;
  /* Migration 037: ADJ-YYYY-NNNNNN, generated by the database. */
  adjustment_reference: string;
  consultant_id: string;
  consultant_amount_minor: number;
  currency: string;
  memo: string;
  available_at: string;
  created_at: string;
};

export const createLedgerAdjustment =
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
  }): Promise<
    FinanceRpcResult<AdjustmentRow>
  > =>
    callFinanceRpc<AdjustmentRow>(
      "create_ledger_adjustment",
      {
        p_consultant_id: consultantId,
        p_amount_minor: amountMinor,
        p_currency: currency,
        p_memo: memo,
        p_admin_profile_id: adminProfileId,
      },
    );

export type PayoutRequestRow = {
  payout_id: string;
  /* Migration 037: PAY-YYYY-NNNNNN, generated by the database. */
  payout_reference: string;
  status: string;
  currency: string;
  requested_amount_minor: number;
  entry_count: number;
  requested_at: string;
  /*
   * Migration 039: "PayPal | email" or "Wise | email", built by
   * the database from the consultant's saved payout setting and
   * snapshotted onto the payout row. Returned so the consultant
   * sees where the money is going in the same response that
   * confirms the request.
   */
  destination_note: string;
};

/*
 * Migration 039 removed p_destination_note from this RPC.
 *
 * The destination is no longer something a caller can pass — it
 * is read from consultant_payout_settings inside the function and
 * snapshotted onto the payout, exactly as the amount is summed
 * from the ledger rather than accepted. There is therefore no
 * argument here through which a wrong or forged destination could
 * be supplied, and a consultant with no payout method configured
 * is refused with FINANCE_PAYOUT_METHOD_MISSING.
 */
export const requestConsultantPayout =
  async ({
    consultantId,
    currency,
  }: {
    consultantId: string;
    currency: string;
  }): Promise<
    FinanceRpcResult<PayoutRequestRow>
  > =>
    callFinanceRpc<PayoutRequestRow>(
      "request_consultant_payout",
      {
        p_consultant_id: consultantId,
        p_currency: currency,
      },
    );

export type PayoutDecisionRow = {
  payout_id: string;
  payout_reference: string;
  status: string;
  currency: string;
  requested_amount_minor: number;
  released_entry_count: number;
  approved_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
};

export const decidePayout = async ({
  payoutId,
  decision,
  adminProfileId,
  note,
}: {
  payoutId: string;
  decision: "approve" | "reject" | "cancel";
  adminProfileId: string;
  note: string | null;
}): Promise<
  FinanceRpcResult<PayoutDecisionRow>
> =>
  callFinanceRpc<PayoutDecisionRow>(
    "decide_payout",
    {
      p_payout_id: payoutId,
      p_decision: decision,
      p_admin_profile_id: adminProfileId,
      p_note: note,
    },
  );

export type PayoutPaidRow = {
  payout_id: string;
  payout_reference: string;
  status: string;
  currency: string;
  requested_amount_minor: number;
  paid_amount_minor: number;
  paid_at: string;
  external_reference: string;
};

export const markPayoutPaid = async ({
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
}): Promise<
  FinanceRpcResult<PayoutPaidRow>
> =>
  callFinanceRpc<PayoutPaidRow>(
    "mark_payout_paid",
    {
      p_payout_id: payoutId,
      p_paid_amount_minor: paidAmountMinor,
      p_external_reference: externalReference,
      p_admin_profile_id: adminProfileId,
      p_paid_at: paidAt,
      p_note: note,
    },
  );

/*
 * The consultant behind an authenticated profile. A payout is
 * always requested for this value and never for one supplied by
 * the caller, which is what makes requesting somebody else's
 * payout unrepresentable rather than merely forbidden.
 */
export const loadConsultantIdForProfile =
  async (
    profileId: string,
  ): Promise<
    | { ok: true; consultantId: string }
    | {
        ok: false;
        code: "NOT_FOUND" | "INTERNAL_ERROR";
      }
  > => {
    const { data, error } =
      await supabaseAdmin
        .from("consultants")
        .select("id")
        .eq("profile_id", profileId)
        .maybeSingle();

    if (error) {
      console.error(
        "Finance consultant lookup failed",
        {
          profileId,
          code: error.code,
          message: error.message,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
      };
    }

    if (!data) {
      return { ok: false, code: "NOT_FOUND" };
    }

    return {
      ok: true,
      consultantId: (
        data as unknown as { id: string }
      ).id,
    };
  };

export type ConsultationReversalRow = {
  entry_id: string | null;
  reversed: boolean;
  reason: "reversed" | "no_entry" | "already_reversed";
  consultant_amount_minor: number | null;
};

/*
 * Reverse a consultation's earning, named by the consultation.
 *
 * The lookup lives in the database so the Stripe webhook never
 * reads a table directly: Amendment 004 section 10.3.3 holds that
 * path to RPC calls only, and the webhook tests enforce it.
 */
export const reverseConsultationEarningRpc =
  async ({
    consultationId,
    reason,
    grossAmountMinor,
  }: {
    consultationId: string;
    reason: string;
    grossAmountMinor?: number | null;
  }): Promise<
    FinanceRpcResult<ConsultationReversalRow>
  > =>
    callFinanceRpc<ConsultationReversalRow>(
      "reverse_consultation_earning",
      {
        p_consultation_id: consultationId,
        p_reason: reason,
        p_gross_amount_minor:
          grossAmountMinor ?? null,
      },
    );
