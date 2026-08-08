import {
  recordServicePurchase,
  reverseServicePurchaseForPaymentIntentRpc,
  type ServicePurchaseRow,
} from "./service-purchase.repository.js";

/*
 * Service purchase finance, called from the Stripe webhook.
 *
 * Forgiving on purpose, exactly like the consultation earning
 * entry points in finance.service.ts and for the same reason: a
 * webhook that returns non-2xx is redelivered, and redelivery
 * re-runs everything. A missing ledger row that the next delivery
 * recreates is a far better outcome than a payment processed
 * twice, so nothing here throws.
 *
 * Nothing here decides an amount, a rate or an attribution
 * either. All three are settled inside the RPC.
 */

export type ServicePurchaseOutcome = {
  recorded: boolean;
  purchaseId: string | null;
  entryId: string | null;
  attributed: boolean;
  reason:
    | "recorded"
    | "already_recorded"
    | "unattributed"
    | "failed";
};

/*
 * Record a paid service purchase.
 *
 * `attributed` is reported separately from `recorded` because the
 * two really are different outcomes: an unattributed purchase is
 * a success — the revenue is in the database and visible to an
 * admin — it simply earns nobody a commission. Silently treating
 * it as a failure is how revenue goes missing.
 */
export const recordPaidServicePurchase =
  async (input: {
    grossAmountMinor: number;
    currency: string;
    stripeMode: "test" | "live";
    serviceId?: string | null;
    clientProfileId?: string | null;
    stripePaymentLinkId?: string | null;
    stripeCheckoutSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    stripeInvoiceId?: string | null;
    stripeSubscriptionId?: string | null;
    stripePriceId?: string | null;
  }): Promise<ServicePurchaseOutcome> => {
    const result =
      await recordServicePurchase(input);

    if (!result.ok) {
      console.error(
        "Service purchase could not be recorded",
        {
          marker: result.marker,
          checkoutSession:
            input.stripeCheckoutSessionId ?? null,
          invoice: input.stripeInvoiceId ?? null,
        },
      );

      return {
        recorded: false,
        purchaseId: null,
        entryId: null,
        attributed: false,
        reason: "failed",
      };
    }

    const row: ServicePurchaseRow = result.row;

    if (!row.attributed_consultant_id) {
      /*
       * Deliberately a warning rather than an error. Revenue with
       * nobody to credit is an operational question for an admin,
       * not a fault in this code path, and the purchase row is
       * already written and readable in admin finance.
       */
      console.warn(
        "Service purchase recorded without consultant attribution",
        {
          purchaseId: row.purchase_id,
          serviceId: row.service_id,
          clientProfileId: row.client_profile_id,
        },
      );
    }

    return {
      recorded: row.created,
      purchaseId: row.purchase_id,
      entryId: row.entry_id,
      attributed: Boolean(
        row.attributed_consultant_id,
      ),
      reason: row.created
        ? row.attributed_consultant_id
          ? "recorded"
          : "unattributed"
        : "already_recorded",
    };
  };

export type ServiceRefundOutcome = {
  reversed: boolean;
  purchaseId: string | null;
  reason:
    | "reversed"
    | "no_entry"
    | "already_refunded"
    | "not_a_service_purchase"
    | "failed";
};

/*
 * Reverse whatever a service purchase earned, found from the
 * PaymentIntent behind the refunded charge.
 *
 * A charge that resolves to no service purchase is the ordinary
 * case — it is almost certainly a consultation refund, which the
 * consultation branch of the webhook has already handled — so it
 * is reported, not logged as a failure.
 */
export const reverseServicePurchaseForPaymentIntent =
  async ({
    paymentIntentId,
    reason,
    grossAmountMinor,
  }: {
    paymentIntentId: string;
    reason: string;
    grossAmountMinor?: number | null;
  }): Promise<ServiceRefundOutcome> => {
    const result =
      await reverseServicePurchaseForPaymentIntentRpc({
        paymentIntentId,
        reason,
        grossAmountMinor,
      });

    if (!result.ok) {
      console.error(
        "Service purchase refund could not be recorded",
        {
          paymentIntentId,
          marker: result.marker,
        },
      );

      /*
       * Reported as a failure, NOT as "not a service purchase".
       * The distinction matters: the caller falls through to the
       * consultation refund path on the latter, and a database
       * error must never be mistaken for "this was a consultation
       * refund all along".
       */
      return {
        reversed: false,
        purchaseId: null,
        reason: "failed",
      };
    }

    return {
      reversed: result.row.reversed,
      purchaseId: result.row.purchase_id,
      reason: result.row.reason,
    };
  };
