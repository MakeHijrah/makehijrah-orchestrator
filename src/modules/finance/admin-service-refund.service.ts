import type Stripe from "stripe";

import { redis } from "../../lib/redis.js";
import {
  getStripeClient,
  isStripeModeConfigured,
  type StripeMode,
} from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Admin-initiated service purchase refunds.
 *
 * THE ONE RULE THIS FILE OBEYS: it INITIATES a refund and records
 * no accounting whatsoever. It does not touch refunded_amount_minor,
 * it does not move a status, it creates no ledger reversal and it
 * calls no finance RPC. Stripe's charge.refunded webhook remains
 * the sole recorder of the financial reversal, exactly as it was
 * before an admin could press a button.
 *
 * There is precisely one local write permitted here, and it is
 * metadata repair rather than financial state: backfilling a
 * missing stripe_payment_intent_id that was resolved from the
 * purchase's own stored invoice. See resolvePaymentIntent below for
 * why that is not optional.
 */

export type AdminRefundResult =
  | {
      ok: true;
      purchaseId: string;
      amountMinor: number;
      currency: string;
      stripeRefundId: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "INVALID_TRANSITION"
        | "STRIPE_MODE_NOT_CONFIGURED"
        | "STRIPE_ERROR"
        | "CONFLICT"
        | "INTERNAL_ERROR";
      message: string;
    };

type PurchaseRow = {
  id: string;
  service_id: string;
  client_profile_id: string | null;
  gross_amount_minor: number;
  refunded_amount_minor: number;
  currency: string;
  status: string;
  stripe_mode: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
};

/*
 * How long a submission holds its claim. Long enough to cover the
 * Stripe round trip and a double click behind it, short enough that
 * a crashed request does not lock an admin out of a legitimate
 * retry for any noticeable time.
 */
const REFUND_CLAIM_TTL_SECONDS = 90;

/*
 * The idempotency key, and the reason for its shape.
 *
 * refundedSoFar is the discriminator that makes this both safe and
 * not over-restrictive. Two clicks before the webhook lands read
 * the same refunded_amount_minor, build the same key, and Stripe
 * returns the SAME refund — one refund, not two. A deliberate
 * second refund of the same amount happens after the webhook has
 * moved refunded_amount_minor, so the key differs and a new refund
 * is created.
 *
 * Deliberately no timestamp and no random component: either would
 * defeat the deduplication this exists for.
 */
const buildRefundIdempotencyKey = ({
  purchaseId,
  amountMinor,
  refundedSoFarMinor,
}: {
  purchaseId: string;
  amountMinor: number;
  refundedSoFarMinor: number;
}): string =>
  `service-refund-${purchaseId}-${amountMinor}-${refundedSoFarMinor}`;

/*
 * The PaymentIntent to refund against.
 *
 * A one-time purchase stores its PaymentIntent at record time. A
 * subscription invoice may not: migration 040 reads it from
 * invoice.payments, which is an expandable list that can be absent
 * from the webhook payload, so the column is legitimately null for
 * some recurring purchases.
 *
 * That gap cannot simply be tolerated here, because the LATER
 * charge.refunded webhook finds the purchase BY PaymentIntent
 * (reverse_service_purchase_for_payment_intent). Refunding such a
 * purchase without repairing the column would succeed at Stripe and
 * then leave MakeHijrah unable to attach the refund to anything —
 * money returned to the client, and no reversal recorded against
 * the consultant. So the repair is a precondition of the refund,
 * not a nicety.
 *
 * Resolved through the installed SDK's actual shape:
 * stripe.invoicePayments.list({ invoice }) returns InvoicePayment
 * rows whose `payment` carries `type: 'payment_intent'` and
 * `payment_intent`. Both are checked, and the row's own `invoice`
 * is checked back against the one we asked about, so a paginated
 * or unexpected response cannot smuggle in a foreign PaymentIntent.
 */
const resolvePaymentIntent = async ({
  purchase,
  stripe,
}: {
  purchase: PurchaseRow;
  stripe: Stripe;
}): Promise<
  | { ok: true; paymentIntentId: string; repaired: boolean }
  | { ok: false; reason: "unresolvable" | "persist_failed" }
> => {
  if (purchase.stripe_payment_intent_id) {
    return {
      ok: true,
      paymentIntentId: purchase.stripe_payment_intent_id,
      repaired: false,
    };
  }

  if (!purchase.stripe_invoice_id) {
    return { ok: false, reason: "unresolvable" };
  }

  let payments: Stripe.ApiList<Stripe.InvoicePayment>;

  try {
    payments = await stripe.invoicePayments.list({
      invoice: purchase.stripe_invoice_id,
    });
  } catch (error) {
    console.error(
      "Invoice payment lookup failed during admin refund",
      {
        purchaseId: purchase.id,
        invoiceId: purchase.stripe_invoice_id,
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );

    return { ok: false, reason: "unresolvable" };
  }

  const readId = (
    value: string | { id: string } | null | undefined,
  ): string | null => {
    if (!value) {
      return null;
    }

    return typeof value === "string" ? value : value.id;
  };

  let resolved: string | null = null;

  for (const entry of payments.data) {
    /*
     * The row must belong to the invoice we asked about. A
     * deleted-invoice object or a mismatch means this is not
     * evidence about our purchase.
     */
    if (
      readId(
        entry.invoice as
          | string
          | { id: string }
          | null
          | undefined,
      ) !== purchase.stripe_invoice_id
    ) {
      continue;
    }

    if (entry.payment?.type !== "payment_intent") {
      continue;
    }

    const candidate = readId(
      entry.payment.payment_intent,
    );

    if (candidate) {
      resolved = candidate;
      break;
    }
  }

  if (!resolved) {
    return { ok: false, reason: "unresolvable" };
  }

  /*
   * Persisted BEFORE the refund is created, and guarded on the
   * column still being null so a concurrent repair cannot be
   * overwritten. This write carries no financial meaning — it
   * records which Stripe object this purchase was always paid by.
   */
  const { error } = await supabaseAdmin
    .from("service_purchases")
    .update({ stripe_payment_intent_id: resolved })
    .eq("id", purchase.id)
    .is("stripe_payment_intent_id", null);

  if (error) {
    console.error(
      "Could not persist the resolved PaymentIntent before refunding",
      {
        purchaseId: purchase.id,
        code: error.code,
        message: error.message,
      },
    );

    return { ok: false, reason: "persist_failed" };
  }

  return {
    ok: true,
    paymentIntentId: resolved,
    repaired: true,
  };
};

export const refundServicePurchaseAsAdmin =
  async ({
    purchaseId,
    intent,
  }: {
    purchaseId: string;
    intent:
      | { type: "full" }
      | { type: "partial"; amountMinor: number };
  }): Promise<AdminRefundResult> => {
    /*
     * 1. Everything trusted comes from the purchase row.
     *
     *    No Stripe identifier, no client, no consultant, no
     *    currency and no amount other than a partial figure is
     *    accepted from the request — the route's schema has no
     *    field for any of them.
     */
    const { data, error } = await supabaseAdmin
      .from("service_purchases")
      .select(
        "id, service_id, client_profile_id, gross_amount_minor, refunded_amount_minor, currency, status, stripe_mode, stripe_payment_intent_id, stripe_invoice_id",
      )
      .eq("id", purchaseId)
      .maybeSingle();

    if (error) {
      console.error(
        "Service purchase lookup failed during admin refund",
        {
          purchaseId,
          code: error.code,
          message: error.message,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The service purchase could not be loaded.",
      };
    }

    const purchase =
      data as unknown as PurchaseRow | null;

    if (!purchase) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message:
          "The service purchase was not found.",
      };
    }

    if (purchase.status === "cancelled") {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "A cancelled purchase cannot be refunded.",
      };
    }

    // 2. What is left to refund, from stored values only.
    const remaining =
      purchase.gross_amount_minor -
      purchase.refunded_amount_minor;

    if (remaining <= 0) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "This purchase has already been fully refunded.",
      };
    }

    const amountMinor =
      intent.type === "full"
        ? remaining
        : intent.amountMinor;

    if (amountMinor <= 0) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "A refund must be a positive amount.",
      };
    }

    if (amountMinor > remaining) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message: `The refund exceeds the ${remaining} minor units remaining on this purchase.`,
      };
    }

    /*
     * 3. The Stripe client, chosen by the PURCHASE's own recorded
     *    mode — never the current global mode. A purchase taken in
     *    test refunds against test after the platform switches to
     *    live, which is the rule Amendment 007 locked for
     *    consultations and which applies for the same reason here.
     */
    const mode = purchase.stripe_mode as
      | StripeMode
      | null;

    if (
      mode !== "test" &&
      mode !== "live"
    ) {
      return {
        ok: false,
        code: "STRIPE_MODE_NOT_CONFIGURED",
        message:
          "This purchase has no recorded Stripe mode and cannot be refunded automatically.",
      };
    }

    if (!isStripeModeConfigured(mode)) {
      return {
        ok: false,
        code: "STRIPE_MODE_NOT_CONFIGURED",
        message: `Stripe ${mode} mode is not configured on this deployment.`,
      };
    }

    const stripe = getStripeClient(mode);

    // 4. The PaymentIntent, repairing it from the invoice if needed.
    const resolution = await resolvePaymentIntent({
      purchase,
      stripe,
    });

    if (!resolution.ok) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          resolution.reason === "persist_failed"
            ? "The payment reference for this purchase could not be recorded, so the refund was not submitted."
            : "This purchase has no resolvable Stripe payment reference. Refund it in the Stripe Dashboard.",
      };
    }

    /*
     * 5. The in-flight claim.
     *
     *    Stripe would deduplicate two identical submissions anyway
     *    through the idempotency key below, so this is not the only
     *    protection — it just refuses the second one before a
     *    network call is made, and gives the UI a clear answer
     *    rather than a silently identical result.
     */
    const idempotencyKey = buildRefundIdempotencyKey({
      purchaseId: purchase.id,
      amountMinor,
      refundedSoFarMinor:
        purchase.refunded_amount_minor,
    });

    let claimed = false;

    try {
      claimed =
        (await redis.set(
          `claim:${idempotencyKey}`,
          "1",
          "EX",
          REFUND_CLAIM_TTL_SECONDS,
          "NX",
        )) === "OK";
    } catch (claimError) {
      /*
       * Redis being unavailable must not block a refund: the
       * Stripe idempotency key is the durable protection, and this
       * layer is an optimisation. Logged and continued.
       */
      console.warn(
        "Refund in-flight claim unavailable; relying on Stripe idempotency",
        {
          purchaseId: purchase.id,
          message:
            claimError instanceof Error
              ? claimError.message
              : "Unknown error",
        },
      );

      claimed = true;
    }

    if (!claimed) {
      return {
        ok: false,
        code: "CONFLICT",
        message:
          "A refund for this amount is already being submitted.",
      };
    }

    // 6. The refund itself. The only outward effect of this call.
    const metadata: Record<string, string> = {
      makehijrah_service_purchase_id: purchase.id,
      makehijrah_service_id: purchase.service_id,
    };

    if (purchase.client_profile_id) {
      metadata.makehijrah_client_profile_id =
        purchase.client_profile_id;
    }

    let refund: Stripe.Refund;

    try {
      refund = await stripe.refunds.create(
        {
          payment_intent: resolution.paymentIntentId,
          amount: amountMinor,
          metadata,
        },
        { idempotencyKey },
      );
    } catch (stripeError) {
      console.error(
        "Stripe refund creation failed",
        {
          purchaseId: purchase.id,
          amountMinor,
          message:
            stripeError instanceof Error
              ? stripeError.message
              : "Unknown error",
        },
      );

      /*
       * Nothing local was mutated by the failure. The claim is
       * released so the admin can correct and retry immediately
       * rather than waiting out the TTL.
       */
      try {
        await redis.del(`claim:${idempotencyKey}`);
      } catch {
        /* The TTL will clear it. */
      }

      return {
        ok: false,
        code: "STRIPE_ERROR",
        message:
          "Stripe refused the refund. Nothing has been changed.",
      };
    }

    /*
     * 7. Report the SUBMISSION, and nothing about local state.
     *
     *    No status and no refunded total: the purchase row has not
     *    changed and will not until charge.refunded arrives.
     *    Returning either would invite a caller to render something
     *    that is not yet true.
     */
    return {
      ok: true,
      purchaseId: purchase.id,
      amountMinor,
      currency: purchase.currency,
      stripeRefundId: refund.id,
    };
  };
