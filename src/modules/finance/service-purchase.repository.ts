import {
  callFinanceRpc,
  type FinanceRpcResult,
} from "./finance.repository.js";

/*
 * Service purchase finance boundary (migration 040).
 *
 * Three RPC wrappers and one read. As with the rest of the
 * finance layer this file does no arithmetic and makes no
 * decision: the split, the attribution and the availability rules
 * all live inside the database, which is what lets two concurrent
 * webhook deliveries be safe.
 *
 * Note what recordServicePurchase does NOT accept. There is no
 * consultant and no commission rate, because the RPC re-derives
 * both from service_recommendations every time it is called. A
 * consultant id that somehow reached Stripe metadata cannot be
 * passed on from here, because there is no parameter to put it
 * in.
 */

export type ServicePurchaseRow = {
  purchase_id: string;
  created: boolean;
  service_id: string;
  client_profile_id: string | null;
  service_request_id: string | null;
  consultation_id: string | null;
  attributed_consultant_id: string | null;
  gross_amount_minor: number;
  currency: string;
  billing_type: string;
  recurring_interval: string | null;
  billing_period_sequence: number;
  status: string;
  entry_id: string | null;
  earning_created: boolean;
  consultant_amount_minor: number | null;
  platform_amount_minor: number | null;
  commission_bps: number | null;
};

export const recordServicePurchase = async ({
  grossAmountMinor,
  currency,
  stripeMode,
  serviceId,
  clientProfileId,
  stripePaymentLinkId,
  stripeCheckoutSessionId,
  stripePaymentIntentId,
  stripeInvoiceId,
  stripeSubscriptionId,
  stripePriceId,
}: {
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
}): Promise<
  FinanceRpcResult<ServicePurchaseRow>
> =>
  callFinanceRpc<ServicePurchaseRow>(
    "record_service_purchase",
    {
      p_gross_amount_minor: grossAmountMinor,
      p_currency: currency,
      p_stripe_mode: stripeMode,
      p_service_id: serviceId ?? null,
      p_client_profile_id: clientProfileId ?? null,
      p_stripe_payment_link_id:
        stripePaymentLinkId ?? null,
      p_stripe_checkout_session_id:
        stripeCheckoutSessionId ?? null,
      p_stripe_payment_intent_id:
        stripePaymentIntentId ?? null,
      p_stripe_invoice_id: stripeInvoiceId ?? null,
      p_stripe_subscription_id:
        stripeSubscriptionId ?? null,
      p_stripe_price_id: stripePriceId ?? null,
    },
  );

export type ServiceFulfillmentRow = {
  purchase_id: string;
  status: string;
  fulfilled_at: string | null;
  released: boolean;
  reason:
    | "released"
    | "already_available"
    | "already_fulfilled"
    | "no_entry";
  entry_id: string | null;
  available_at: string | null;
};

export const fulfillServicePurchase = async ({
  purchaseId,
  adminProfileId,
}: {
  purchaseId: string;
  adminProfileId: string;
}): Promise<
  FinanceRpcResult<ServiceFulfillmentRow>
> =>
  callFinanceRpc<ServiceFulfillmentRow>(
    "fulfill_service_purchase",
    {
      p_purchase_id: purchaseId,
      p_admin_profile_id: adminProfileId,
    },
  );

export type ServiceReversalRow = {
  purchase_id: string;
  reversed: boolean;
  reason: "reversed" | "no_entry" | "already_refunded";
  entry_id: string | null;
  reversal_entry_id: string | null;
  refunded_amount_minor: number;
  status: string;
  consultant_amount_minor: number | null;
};

export const reverseServicePurchaseEarning =
  async ({
    purchaseId,
    reason,
    grossAmountMinor,
  }: {
    purchaseId: string;
    reason: string;
    grossAmountMinor?: number | null;
  }): Promise<
    FinanceRpcResult<ServiceReversalRow>
  > =>
    callFinanceRpc<ServiceReversalRow>(
      "reverse_service_purchase_earning",
      {
        p_purchase_id: purchaseId,
        p_reason: reason,
        p_gross_amount_minor:
          grossAmountMinor ?? null,
      },
    );

export type ServiceReversalLookupRow =
  ServiceReversalRow & {
    reason:
      | "reversed"
      | "no_entry"
      | "already_refunded"
      | "not_a_service_purchase";
  };

/*
 * Reverse a service purchase's earning, named by the Stripe
 * PaymentIntent behind the refunded charge.
 *
 * The lookup lives in the database, not here. Amendment 004
 * section 10.3.3 holds the webhook path to RPC calls only, and
 * the webhook test enforces it by making any direct table access
 * from that path throw. reverse_consultation_earning exists for
 * exactly the same reason.
 *
 * A PaymentIntent belonging to no service purchase comes back as
 * 'not_a_service_purchase' rather than an error, which is the
 * signal that this was a consultation refund and the other path
 * should handle it.
 */
export const reverseServicePurchaseForPaymentIntentRpc =
  async ({
    paymentIntentId,
    reason,
    grossAmountMinor,
  }: {
    paymentIntentId: string;
    reason: string;
    grossAmountMinor?: number | null;
  }): Promise<
    FinanceRpcResult<ServiceReversalLookupRow>
  > =>
    callFinanceRpc<ServiceReversalLookupRow>(
      "reverse_service_purchase_for_payment_intent",
      {
        p_stripe_payment_intent_id: paymentIntentId,
        p_reason: reason,
        p_gross_amount_minor:
          grossAmountMinor ?? null,
      },
    );
