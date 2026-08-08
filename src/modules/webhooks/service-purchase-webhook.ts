import type Stripe from "stripe";

import {
  recordPaidServicePurchase,
  reverseServicePurchaseForPaymentIntent,
} from "../finance/service-purchase.service.js";

/*
 * The service purchase half of the Stripe webhook.
 *
 * Kept in its own file, and called before the consultation
 * normaliser, so that the consultation payment path — manual
 * capture, the three payment_intent events, the payments table,
 * process_stripe_webhook_event — is untouched by any of this. A
 * service event returns from here and never reaches it; anything
 * that is not a service event returns null and the existing flow
 * continues exactly as it did.
 *
 * WHICH EVENT IS AUTHORITATIVE FOR WHAT, and why the others are
 * deliberately refused:
 *
 *   checkout.session.completed   ONE-TIME purchases only, and
 *     only when payment_status is 'paid'. A subscription-mode
 *     session is explicitly NOT a purchase creator: its first
 *     invoice arrives as invoice.paid, and creating from both
 *     would produce two financial records for one payment.
 *
 *   invoice.paid                 RECURRING purchases, both the
 *     first period and every renewal. One event type for both,
 *     which is what makes "no duplicate financial record" a
 *     property of the design rather than a rule to remember.
 *
 *   invoice.payment_failed       Nothing. Logged and ignored: no
 *     purchase, no earning. A failed payment is not revenue.
 *
 *   charge.refunded              Reversal, if the charge belongs
 *     to a service purchase. If it does not, this returns null
 *     and the consultation refund path handles it as before.
 *
 *   payment_intent.succeeded     Deliberately NOT handled here. A
 *     one-time service payment produces both it and
 *     checkout.session.completed, and it continues to fall
 *     through to the existing 'non_consultation_event' ignore
 *     path, which is precisely what stops a duplicate purchase.
 */

export type ServiceWebhookOutcome = {
  handled: true;
  action:
    | "purchase_recorded"
    | "purchase_already_recorded"
    | "purchase_unattributed"
    | "purchase_failed"
    | "refund_reversed"
    | "refund_noop"
    | "ignored";
  purchaseId: string | null;
  reason: string;
};

const readId = (
  value: string | { id: string } | null | undefined,
): string | null => {
  if (!value) {
    return null;
  }

  return typeof value === "string"
    ? value
    : value.id;
};

const readMetadataValue = (
  metadata: Stripe.Metadata | null | undefined,
  key: string,
): string | null => {
  const value = metadata?.[key]?.trim();

  return value || null;
};

/*
 * The PaymentIntent behind an invoice, when the payload carries
 * one. Read defensively: `payments` is an expandable list and may
 * be absent. The invoice id is the idempotency anchor regardless,
 * so a missing PaymentIntent costs nothing at record time — it
 * only means a later refund of that invoice has to be matched by
 * an admin rather than automatically.
 */
const readInvoicePaymentIntent = (
  invoice: Stripe.Invoice,
): string | null => {
  const payments = (
    invoice as unknown as {
      payments?: {
        data?: Array<{
          payment?: {
            payment_intent?:
              | string
              | { id: string }
              | null;
          };
        }>;
      };
    }
  ).payments;

  for (const entry of payments?.data ?? []) {
    const paymentIntent = readId(
      entry.payment?.payment_intent,
    );

    if (paymentIntent) {
      return paymentIntent;
    }
  }

  return null;
};

const readSubscriptionDetails = (
  invoice: Stripe.Invoice,
): {
  subscriptionId: string | null;
  metadata: Stripe.Metadata | null;
} => {
  const details = (
    invoice as unknown as {
      parent?: {
        subscription_details?: {
          subscription?:
            | string
            | { id: string }
            | null;
          metadata?: Stripe.Metadata | null;
        } | null;
      } | null;
    }
  ).parent?.subscription_details;

  return {
    subscriptionId: readId(
      details?.subscription,
    ),
    metadata: details?.metadata ?? null,
  };
};

const ignored = (
  reason: string,
): ServiceWebhookOutcome => ({
  handled: true,
  action: "ignored",
  purchaseId: null,
  reason,
});

/*
 * A one-time purchase through either route: a Session this
 * orchestrator created, or a static Payment Link.
 *
 * Service resolution never reads Payment Link metadata. It uses
 * our own metadata when we set it, and otherwise passes the
 * payment link id to the RPC, which resolves it against
 * services.stripe_payment_link_id — a value we wrote and can rely
 * on, unlike metadata propagation we do not control.
 */
const handleCheckoutSession = async (
  session: Stripe.Checkout.Session,
  verifiedMode: "test" | "live",
): Promise<ServiceWebhookOutcome | null> => {
  const serviceId = readMetadataValue(
    session.metadata,
    "makehijrah_service_id",
  );

  const paymentLinkId = readId(
    session.payment_link,
  );

  /*
   * Nothing identifies this as one of our services. Returned as
   * null rather than as a handled-but-ignored outcome, so the
   * event falls through to the existing 'unsupported_event_type'
   * path exactly as it did before this migration. Claiming an
   * event we cannot explain would be a worse answer than not
   * claiming it.
   */
  if (!serviceId && !paymentLinkId) {
    return null;
  }

  if (session.mode === "subscription") {
    return ignored(
      "subscription_checkout_deferred_to_invoice",
    );
  }

  if (session.mode !== "payment") {
    return ignored("unsupported_checkout_mode");
  }

  if (session.payment_status !== "paid") {
    return ignored("checkout_not_paid");
  }

  if (
    !session.amount_total ||
    !session.currency
  ) {
    return ignored("checkout_has_no_amount");
  }

  /*
   * Both client candidates are hints, not authority. The RPC
   * validates whichever arrives against profiles, and an
   * unresolvable one produces an unattributed purchase.
   */
  const clientProfileId =
    readMetadataValue(
      session.metadata,
      "makehijrah_client_profile_id",
    ) ?? session.client_reference_id;

  const outcome =
    await recordPaidServicePurchase({
      grossAmountMinor: session.amount_total,
      currency: session.currency,
      stripeMode: verifiedMode,
      serviceId,
      clientProfileId,
      stripePaymentLinkId: paymentLinkId,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: readId(
        session.payment_intent,
      ),
    });

  return {
    handled: true,
    action:
      outcome.reason === "failed"
        ? "purchase_failed"
        : outcome.reason === "already_recorded"
          ? "purchase_already_recorded"
          : outcome.reason === "unattributed"
            ? "purchase_unattributed"
            : "purchase_recorded",
    purchaseId: outcome.purchaseId,
    reason: outcome.reason,
  };
};

/*
 * The first invoice of a subscription and every renewal.
 *
 * Context is resolved through a chain that degrades rather than
 * fails, and whose first step deliberately does not involve
 * Stripe at all:
 *
 *   1. a purchase already exists for this subscription -> inherit
 *      its service and client. This is the renewal case, and it
 *      is a database fact rather than metadata that must have
 *      survived a year of billing cycles.
 *   2. the subscription metadata snapshot this orchestrator set
 *      at checkout -> the first invoice of a Session we created.
 *   3. the line item's price -> resolved against
 *      services.stripe_price_id. Identifies the service but
 *      nobody's client, so the purchase is recorded unattributed.
 *
 * Revenue is recorded at every step. Only attribution degrades.
 */
const handleInvoicePaid = async (
  invoice: Stripe.Invoice,
  verifiedMode: "test" | "live",
): Promise<ServiceWebhookOutcome> => {
  const billingReason = invoice.billing_reason;

  if (
    billingReason !== "subscription_create" &&
    billingReason !== "subscription_cycle"
  ) {
    return ignored(
      `invoice_billing_reason_${billingReason ?? "unknown"}`,
    );
  }

  const { subscriptionId, metadata } =
    readSubscriptionDetails(invoice);

  if (!subscriptionId) {
    return ignored("invoice_has_no_subscription");
  }

  if (!invoice.amount_paid || !invoice.currency) {
    return ignored("invoice_has_no_amount");
  }

  /*
   * Every identifier this invoice carries is handed to the RPC,
   * which resolves them in order of trust: inherit from the first
   * purchase of this subscription, then our own metadata
   * snapshot, then the price. All three are database lookups
   * performed there rather than here, because Amendment 004
   * section 10.3.3 holds this path to RPC calls only.
   */
  const priceId = readId(
    invoice.lines?.data?.[0]?.pricing
      ?.price_details?.price as
      | string
      | { id: string }
      | null
      | undefined,
  );

  const outcome =
    await recordPaidServicePurchase({
      grossAmountMinor: invoice.amount_paid,
      currency: invoice.currency,
      stripeMode: verifiedMode,
      serviceId: readMetadataValue(
        metadata,
        "makehijrah_service_id",
      ),
      clientProfileId: readMetadataValue(
        metadata,
        "makehijrah_client_profile_id",
      ),
      stripeInvoiceId: invoice.id ?? null,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceId,
      stripePaymentIntentId:
        readInvoicePaymentIntent(invoice),
    });

  /*
   * FINANCE_SERVICE_NOT_FOUND means no identifier resolved to one
   * of our services, so this invoice is not a MakeHijrah service
   * purchase at all. Reported as ignored rather than as a
   * failure — an unrelated Stripe invoice is not an error.
   */
  if (
    outcome.reason === "failed" &&
    !outcome.purchaseId
  ) {
    return ignored(
      "invoice_not_a_service_purchase",
    );
  }

  return {
    handled: true,
    action:
      outcome.reason === "failed"
        ? "purchase_failed"
        : outcome.reason === "already_recorded"
          ? "purchase_already_recorded"
          : outcome.reason === "unattributed"
            ? "purchase_unattributed"
            : "purchase_recorded",
    purchaseId: outcome.purchaseId,
    reason: outcome.reason,
  };
};

/*
 * A refund, if it belongs to a service purchase.
 *
 * Returns null — not an outcome — when the charge resolves to no
 * service purchase, so the consultation refund path downstream
 * runs exactly as it always has.
 *
 * The refunded portion is taken from the charge, so a partial
 * refund reverses proportionally rather than clawing back the
 * whole earning. The RPC accumulates it and refuses to exceed the
 * gross, and a redelivery of the same event lands as
 * 'already_refunded' rather than as a second clawback.
 */
const handleChargeRefunded = async (
  charge: Stripe.Charge,
): Promise<ServiceWebhookOutcome | null> => {
  const paymentIntentId = readId(
    charge.payment_intent,
  );

  if (!paymentIntentId) {
    return null;
  }

  /*
   * charge.amount_refunded is CUMULATIVE — the total refunded on
   * this charge to date, not the amount of the refund that just
   * happened. It is passed as a TOTAL (migration 043), and the RPC
   * works out what is new.
   *
   * Treating it as a delta is precisely the bug migration 043
   * fixed: a redelivered event double-counted, a second partial
   * over-reversed the consultant's ledger by the first refund's
   * amount, and partial-then-full exceeded the remainder and was
   * silently dropped.
   */
  const outcome =
    await reverseServicePurchaseForPaymentIntent({
      paymentIntentId,
      reason:
        "Stripe refund processed by webhook",
      refundedTotalMinor:
        charge.amount_refunded > 0
          ? charge.amount_refunded
          : null,
    });

  /*
   * Not ours, so the consultation refund path downstream must
   * run. A `failed` outcome falls through for the same reason:
   * if the database could not answer, the safe assumption is
   * that this is the consultation refund it has always been,
   * and the error is already logged.
   */
  if (
    outcome.reason === "not_a_service_purchase" ||
    outcome.reason === "failed"
  ) {
    return null;
  }

  return {
    handled: true,
    action: outcome.reversed
      ? "refund_reversed"
      : "refund_noop",
    purchaseId: outcome.purchaseId,
    reason: outcome.reason,
  };
};

/*
 * The entry point. Returns null for anything that is not a
 * service purchase event, which is the signal to the caller that
 * the consultation path should run.
 *
 * Nothing here throws. A webhook that returns non-2xx is
 * redelivered, and redelivery re-runs the consultation payment
 * transition — a far worse outcome than a purchase row the next
 * delivery recreates.
 */
export const processServicePurchaseEvent =
  async (
    event: Stripe.Event,
    verifiedMode: "test" | "live" | undefined,
  ): Promise<ServiceWebhookOutcome | null> => {
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          if (!verifiedMode) {
            return ignored(
              "checkout_without_verified_mode",
            );
          }

          return await handleCheckoutSession(
            event.data
              .object as Stripe.Checkout.Session,
            verifiedMode,
          );
        }

        case "invoice.paid": {
          if (!verifiedMode) {
            return ignored(
              "invoice_without_verified_mode",
            );
          }

          return await handleInvoicePaid(
            event.data.object as Stripe.Invoice,
            verifiedMode,
          );
        }

        case "invoice.payment_failed": {
          const invoice = event.data
            .object as Stripe.Invoice;

          console.warn(
            "Stripe invoice payment failed; no purchase and no earning recorded",
            {
              invoiceId: invoice.id ?? null,
              billingReason:
                invoice.billing_reason ?? null,
            },
          );

          return ignored(
            "invoice_payment_failed",
          );
        }

        case "charge.refunded": {
          return await handleChargeRefunded(
            event.data.object as Stripe.Charge,
          );
        }

        default:
          return null;
      }
    } catch (error) {
      console.error(
        "Service purchase webhook handling threw",
        {
          eventType: event.type,
          message:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
      );

      return {
        handled: true,
        action: "purchase_failed",
        purchaseId: null,
        reason: "threw",
      };
    }
  };
