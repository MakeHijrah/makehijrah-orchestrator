import type Stripe from "stripe";

import { supabaseAdmin } from "../../lib/supabase.js";
import { scheduleBookingNotification } from "../consultations/booking-notification.service.js";
import {
  reverseConsultationEarning,
  syncConsultationEarning,
} from "../finance/finance.service.js";
import { processServicePurchaseEvent } from "./service-purchase-webhook.js";
import {
  sendConsultationPurchaseEvent,
  shouldSendPurchaseEvent,
} from "../analytics/purchase.service.js";

type ConsultationStatus =
  | "pending_acceptance"
  | "authorization_cancelled"
  | "captured"
  | "refunded";

type NormalizedStripeEvent = {
  eventId: string;
  eventType: string;
  paymentIntentId: string;
  consultationId: string;
  amountCents: number;
  currency: string;
  paymentStatus: string;
  consultationStatus: ConsultationStatus;
  paymentAuthorizedAt: string | null;
  capturedAt: string | null;
  cancelledAt: string | null;
  rawJson: Stripe.Event;
  /*
   * Analytics facts written into PaymentIntent metadata at
   * checkout. They exist here so the GA4 purchase event can be
   * built without a table read, which this path may not do
   * (Amendment 004 section 10.3.3). Every one is optional and
   * nothing transactional reads them.
   */
  analytics: PurchaseAnalyticsMetadata;
};

type PurchaseAnalyticsMetadata = {
  gaClientId: string | null;
  consultantId: string | null;
  consultantName: string | null;
  destination: string | null;
};

const readAnalyticsMetadata = (
  metadata:
    | Stripe.Metadata
    | null
    | undefined,
): PurchaseAnalyticsMetadata => {
  const read = (key: string): string | null =>
    metadata?.[key]?.trim() || null;

  return {
    gaClientId: read("ga_client_id"),
    consultantId: read("consultant_id"),
    consultantName: read("consultant_name"),
    destination: read("destination"),
  };
};

/*
 * Why a correctly signed event may be ignored.
 *
 * non_consultation_event
 *   The event is one this webhook otherwise supports, but it
 *   carries no consultation_id. Service Payment Link purchases
 *   produce exactly these events. PROJECT_LOCK Amendment 004
 *   section 10.2 requires that they be acknowledged rather than
 *   rejected, because repeated rejections cause Stripe to retry
 *   and ultimately disable the endpoint, which would break
 *   consultation payment capture.
 *
 * unsupported_event_type
 *   The event type is not one this webhook handles at all. This
 *   was already acknowledged and ignored before Amendment 004;
 *   only the reason label is new.
 */
export type StripeWebhookIgnoredReason =
  | "non_consultation_event"
  | "unsupported_event_type"
  /*
   * Migration 040. The event WAS a service purchase event and was
   * handled by the service purchase path; it is reported as
   * ignored by the consultation path because no consultation was
   * transitioned and no payments row was written. The action
   * taken is in the response body.
   */
  | "service_purchase_event";

export type ProcessStripeWebhookResult =
  | {
      ok: true;
      ignored: boolean;
      reason:
        | StripeWebhookIgnoredReason
        | null;
      processed: boolean;
      alreadyProcessed: boolean;
      paymentId: string | null;
      consultationStatus: string | null;
      /*
       * Migration 040. Present only when the service purchase
       * path handled the event; null on every consultation event,
       * so nothing existing changes shape.
       */
      servicePurchaseAction?: string | null;
      servicePurchaseId?: string | null;
    }
  | {
      ok: false;
      code:
        | "INVALID_EVENT"
        | "STRIPE_ERROR"
        | "DATABASE_ERROR";
      message: string;
    };

type RpcResultRow = {
  processed: boolean;
  already_processed: boolean;
  payment_id: string;
  consultation_status: string;
};

const stripeTimestampToIso = (
  timestamp: number,
): string => {
  return new Date(
    timestamp * 1000,
  ).toISOString();
};

const readConsultationId = (
  metadata:
    | Stripe.Metadata
    | null
    | undefined,
): string | null => {
  const consultationId =
    metadata?.consultation_id?.trim();

  return consultationId || null;
};

/*
 * The caller establishes that this payment intent belongs to a
 * consultation and passes the identifier in. Reading metadata is
 * deliberately not repeated here, so that the decision to treat
 * an event as non-consultation is made in exactly one place.
 */
const normalizePaymentIntentEvent = (
  event: Stripe.Event,
  paymentIntent: Stripe.PaymentIntent,
  consultationId: string,
): NormalizedStripeEvent | null => {
  const eventTimestamp =
    stripeTimestampToIso(
      event.created,
    );

  switch (event.type) {
    case "payment_intent.amount_capturable_updated":
      return {
        eventId: event.id,
        eventType: event.type,
        paymentIntentId:
          paymentIntent.id,
        consultationId,
        amountCents:
          paymentIntent.amount,
        currency:
          paymentIntent.currency,
        paymentStatus:
          paymentIntent.status,
        consultationStatus:
          "pending_acceptance",
        paymentAuthorizedAt:
          eventTimestamp,
        capturedAt: null,
        cancelledAt: null,
        rawJson: event,
        analytics:
          readAnalyticsMetadata(
            paymentIntent.metadata,
          ),
      };

    case "payment_intent.canceled":
      return {
        eventId: event.id,
        eventType: event.type,
        paymentIntentId:
          paymentIntent.id,
        consultationId,
        amountCents:
          paymentIntent.amount,
        currency:
          paymentIntent.currency,
        paymentStatus:
          paymentIntent.status,
        consultationStatus:
          "authorization_cancelled",
        paymentAuthorizedAt: null,
        capturedAt: null,
        cancelledAt:
          eventTimestamp,
        rawJson: event,
        analytics:
          readAnalyticsMetadata(
            paymentIntent.metadata,
          ),
      };

    case "payment_intent.succeeded":
      return {
        eventId: event.id,
        eventType: event.type,
        paymentIntentId:
          paymentIntent.id,
        consultationId,
        amountCents:
          paymentIntent.amount_received,
        currency:
          paymentIntent.currency,
        paymentStatus:
          paymentIntent.status,
        consultationStatus:
          "captured",
        paymentAuthorizedAt: null,
        capturedAt:
          eventTimestamp,
        cancelledAt: null,
        rawJson: event,
        analytics:
          readAnalyticsMetadata(
            paymentIntent.metadata,
          ),
      };

    default:
      return null;
  }
};

const normalizeRefundEvent = async (
  stripe: Stripe,
  event: Stripe.Event,
  charge: Stripe.Charge,
): Promise<
  | {
      ok: true;
      ignored: true;
    }
  | {
      ok: true;
      ignored: false;
      normalized:
        NormalizedStripeEvent;
    }
  | {
      ok: false;
      code:
        | "INVALID_EVENT"
        | "STRIPE_ERROR";
      message: string;
    }
> => {
  const paymentIntentReference =
    charge.payment_intent;

  const paymentIntentId =
    typeof paymentIntentReference ===
    "string"
      ? paymentIntentReference
      : paymentIntentReference?.id;

  if (!paymentIntentId) {
    return {
      ok: false,
      code: "INVALID_EVENT",
      message:
        "The refunded charge has no PaymentIntent.",
    };
  }

  let paymentIntent:
    Stripe.PaymentIntent;

  try {
    paymentIntent =
      typeof paymentIntentReference ===
        "object" &&
      paymentIntentReference !== null
        ? paymentIntentReference
        : await stripe.paymentIntents.retrieve(
            paymentIntentId,
          );
  } catch (error) {
    console.error(
      "Stripe PaymentIntent retrieval failed for refund",
      {
        eventId: event.id,
        paymentIntentId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown Stripe error",
      },
    );

    return {
      ok: false,
      code: "STRIPE_ERROR",
      message:
        "The refunded payment could not be verified.",
    };
  }

  const consultationId =
    readConsultationId(
      paymentIntent.metadata,
    );

  /*
   * A refund of a service Payment Link purchase reaches this
   * point with no consultation_id. It is not a consultation
   * refund, so it is ignored rather than rejected. The two
   * failure paths above are unchanged: a charge with no
   * PaymentIntent is still INVALID_EVENT, and a failed Stripe
   * retrieval is still STRIPE_ERROR.
   */
  if (!consultationId) {
    return {
      ok: true,
      ignored: true,
    };
  }

  return {
    ok: true,
    ignored: false,
    normalized: {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      consultationId,
      amountCents:
        charge.amount_refunded,
      currency: charge.currency,
      paymentStatus:
        charge.refunded
          ? "refunded"
          : "partially_refunded",
      consultationStatus:
        "refunded",
      paymentAuthorizedAt: null,
      capturedAt: null,
      cancelledAt: null,
      rawJson: event,
      analytics: readAnalyticsMetadata(
        paymentIntent.metadata,
      ),
    },
  };
};

const normalizeStripeEvent = async (
  stripe: Stripe,
  event: Stripe.Event,
): Promise<
  | {
      ok: true;
      ignored: true;
      reason: StripeWebhookIgnoredReason;
    }
  | {
      ok: true;
      ignored: false;
      normalized:
        NormalizedStripeEvent;
    }
  | {
      ok: false;
      code:
        | "INVALID_EVENT"
        | "STRIPE_ERROR";
      message: string;
    }
> => {
  switch (event.type) {
    case "payment_intent.amount_capturable_updated":
    case "payment_intent.canceled":
    case "payment_intent.succeeded": {
      const paymentIntent =
        event.data
          .object as Stripe.PaymentIntent;

      const consultationId =
        readConsultationId(
          paymentIntent.metadata,
        );

      /*
       * This is the single decision point for payment intents.
       * No consultation_id means the payment is not a
       * consultation payment, so the event is acknowledged and
       * ignored. Nothing downstream runs: no payment row, no
       * consultation transition, no RPC call.
       */
      if (!consultationId) {
        return {
          ok: true,
          ignored: true,
          reason:
            "non_consultation_event",
        };
      }

      const normalized =
        normalizePaymentIntentEvent(
          event,
          paymentIntent,
          consultationId,
        );

      /*
       * Unreachable in practice: the switch above admits only
       * the three event types normalizePaymentIntentEvent
       * handles. Retained so that adding a case here without
       * adding one there fails loudly rather than silently
       * dropping a consultation payment.
       */
      if (!normalized) {
        return {
          ok: false,
          code: "INVALID_EVENT",
          message:
            "The payment event could not be interpreted.",
        };
      }

      return {
        ok: true,
        ignored: false,
        normalized,
      };
    }

    case "charge.refunded": {
      const charge =
        event.data
          .object as Stripe.Charge;

      const refundResult =
        await normalizeRefundEvent(
          stripe,
          event,
          charge,
        );

      if (!refundResult.ok) {
        return refundResult;
      }

      /*
       * A refund with no consultation_id belongs to a service
       * purchase, not a consultation.
       */
      if (refundResult.ignored) {
        return {
          ok: true,
          ignored: true,
          reason:
            "non_consultation_event",
        };
      }

      return {
        ok: true,
        ignored: false,
        normalized:
          refundResult.normalized,
      };
    }

    /*
     * Event types this webhook does not handle were already
     * acknowledged and ignored before Amendment 004. That
     * behaviour is unchanged; only the reason label is new.
     */
    default:
      return {
        ok: true,
        ignored: true,
        reason:
          "unsupported_event_type",
      };
  }
};

export const processStripeWebhookEvent =
  async (
    stripe: Stripe,
    event: Stripe.Event,
    verifiedMode?: "test" | "live",
  ): Promise<ProcessStripeWebhookResult> => {
    /*
     * Migration 040: the service purchase path, FIRST and
     * separate.
     *
     * It returns null for anything that is not a service purchase
     * event, so every consultation event falls straight through
     * to the code below unchanged — same normaliser, same RPC,
     * same payments row, same transitions.
     *
     * charge.refunded is the one event both paths can care about.
     * The service handler claims it only when the charge resolves
     * to a service purchase; a consultation refund returns null
     * from it and is handled below exactly as before.
     */
    const serviceOutcome =
      await processServicePurchaseEvent(
        event,
        verifiedMode,
      );

    if (serviceOutcome) {
      return {
        ok: true,
        ignored: true,
        reason: "service_purchase_event",
        processed: false,
        alreadyProcessed: false,
        paymentId: null,
        consultationStatus: null,
        servicePurchaseAction:
          serviceOutcome.action,
        servicePurchaseId:
          serviceOutcome.purchaseId,
      };
    }

    const normalizationResult =
      await normalizeStripeEvent(
        stripe,
        event,
      );

    if (!normalizationResult.ok) {
      return normalizationResult;
    }

    /*
     * The ignored path returns before any database or Stripe
     * work. This is what guarantees Amendment 004 sections
     * 10.3.2 through 10.3.4: an ignored event cannot reach the
     * RPC below, so it cannot transition a consultation, write
     * a payment row, or call a consultation payment RPC.
     */
    if (
      normalizationResult.ignored
    ) {
      return {
        ok: true,
        ignored: true,
        reason:
          normalizationResult.reason,
        processed: false,
        alreadyProcessed: false,
        paymentId: null,
        consultationStatus: null,
      };
    }

    const normalized =
      normalizationResult.normalized;

    const {
      data,
      error,
    } = await supabaseAdmin.rpc(
      "process_stripe_webhook_event",
      {
        p_stripe_event_id:
          normalized.eventId,
        p_event_type:
          normalized.eventType,
        p_stripe_payment_intent_id:
          normalized.paymentIntentId,
        p_consultation_id:
          normalized.consultationId,
        p_amount_cents:
          normalized.amountCents,
        p_currency:
          normalized.currency,
        p_payment_status:
          normalized.paymentStatus,
        p_raw_jsonb:
          normalized.rawJson,
        p_consultation_status:
          normalized.consultationStatus,
        p_payment_authorized_at:
          normalized.paymentAuthorizedAt,
        p_captured_at:
          normalized.capturedAt,
        p_cancelled_at:
          normalized.cancelledAt,
      },
    );

    if (error) {
      console.error(
        "Stripe webhook transaction RPC failed",
        {
          eventId:
            normalized.eventId,
          eventType:
            normalized.eventType,
          consultationId:
            normalized.consultationId,
          paymentIntentId:
            normalized.paymentIntentId,
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      );

      return {
        ok: false,
        code: "DATABASE_ERROR",
        message:
          "The Stripe event could not be processed.",
      };
    }

    /*
     * Record the Stripe mode this consultation's payment belongs
     * to, from the mode whose signing secret verified the event.
     * That is authoritative: the signature and the livemode check
     * both passed for it.
     *
     * Checkout already sets this when the Session is created; this
     * is the defensive backfill for any consultation that reached
     * a PaymentIntent without one. Guarded on stripe_mode is null,
     * so an existing value is never rewritten.
     */
    if (
      verifiedMode &&
      normalized.consultationId
    ) {
      /*
       * Secondary to the transition above. A failure here is
       * logged and swallowed: the payment has already been
       * processed correctly, and checkout sets this value on the
       * primary path.
       */
      try {
        const { error: modeError } =
          await supabaseAdmin
            .from("consultations")
            .update({
              stripe_mode:
                verifiedMode,
            })
            .eq(
              "id",
              normalized.consultationId,
            )
            .is(
              "stripe_mode",
              null,
            );

        if (modeError) {
          console.error(
            "Consultation Stripe mode backfill failed during webhook processing",
            {
              consultationId:
                normalized.consultationId,
              code: modeError.code,
              message:
                modeError.message,
            },
          );
        }
      } catch (error) {
        console.error(
          "Consultation Stripe mode backfill threw during webhook processing",
          {
            consultationId:
              normalized.consultationId,
            message:
              error instanceof Error
                ? error.message
                : "Unknown error",
          },
        );
      }
    }

    const row =
      (
        data as unknown as
          | RpcResultRow[]
          | null
      )?.[0];

    if (!row) {
      console.error(
        "Stripe webhook RPC returned no result",
        {
          eventId:
            normalized.eventId,
          eventType:
            normalized.eventType,
        },
      );

      return {
        ok: false,
        code: "DATABASE_ERROR",
        message:
          "The Stripe event returned no processing result.",
      };
    }

    /*
     * Ledger side effects of a payment that has now been
     * recorded.
     *
     * Run on replays as well as first delivery. Both finance
     * operations are idempotent — the ledger's unique index
     * refuses a second earning and the reversal guard refuses to
     * claw back twice — and running them again is what lets a
     * replay repair an earning that a previous delivery failed to
     * write. Skipping already-processed events would make that
     * failure permanent.
     *
     * Secondary to the payment, exactly like the Stripe mode
     * backfill above: every failure is logged and swallowed. A
     * non-2xx here would have Stripe redeliver the event, and
     * redelivery re-runs the payment transition, which is a far
     * worse outcome than a ledger row the next delivery recreates.
     */
    if (normalized.consultationId) {
      try {
        if (
          normalized.eventType ===
          "payment_intent.succeeded"
        ) {
          await syncConsultationEarning(
            normalized.consultationId,
          );
        } else if (
          normalized.eventType ===
          "charge.refunded"
        ) {
          await reverseConsultationEarning({
            consultationId:
              normalized.consultationId,
            reason:
              "Stripe refund processed by webhook",
            /*
             * charge.amount_refunded is CUMULATIVE: it is the
             * total refunded against this charge so far, not the
             * amount of this refund, and Stripe repeats it on
             * every redelivery.
             *
             * The direct booking reversal reads it as such and
             * applies only the difference against what each
             * component has already had reversed, so two partial
             * refunds reverse each partial once and a redelivery
             * reverses nothing. The standard path ignores it and
             * still reverses in full, exactly as before.
             */
            refundedTotalMinor:
              normalized.amountCents,
          });
        }
      } catch (error) {
        console.error(
          "Consultation ledger sync threw during webhook processing",
          {
            consultationId:
              normalized.consultationId,
            eventType:
              normalized.eventType,
            message:
              error instanceof Error
                ? error.message
                : "Unknown error",
          },
        );
      }
    }

    /*
     * Tell the consultant a client has booked them.
     *
     * Redis only — no table is read or written here, because
     * Amendment 004 section 10.3.3 keeps the webhook path off the
     * tables and the webhook tests throw on any direct access.
     * Every lookup the email needs happens later, in the worker.
     *
     * Run on replays as well as first delivery, exactly like the
     * ledger side effects above: the done marker makes a second
     * scheduling a no-op, and re-running is what lets a redelivery
     * repair a notification an earlier delivery failed to queue.
     *
     * Secondary to the payment. A failure is logged and swallowed;
     * a non-2xx here would have Stripe redeliver the event and
     * re-run the payment transition, which is far worse than a
     * missed email.
     */
    if (
      normalized.eventType ===
        "payment_intent.amount_capturable_updated" &&
      normalized.consultationId
    ) {
      try {
        await scheduleBookingNotification(
          {
            consultationId:
              normalized.consultationId,
          },
        );
      } catch (error) {
        console.error(
          "Consultant booking notification scheduling threw during webhook processing",
          {
            consultationId:
              normalized.consultationId,
            message:
              error instanceof Error
                ? error.message
                : "Unknown error",
          },
        );
      }
    }

    /*
     * GA4 `purchase`, on CAPTURE.
     *
     * Not on authorization. A consultation can be authorized and
     * then declined or timed out and never captured, so reporting
     * authorization as revenue reports money that was not
     * collected. Capture is also what the finance ledger credits,
     * so the analytics and the ledger agree by construction.
     *
     * Gated on this delivery having done the work, which is the
     * opposite of the finance and notification hooks above. Those
     * re-run on redelivery because repeating them repairs; this
     * one must not, because GA4 does not reliably discard a
     * duplicate purchase and a redelivered event would book the
     * revenue twice. row.processed with already_processed false
     * means exactly one delivery reaches here per Stripe event,
     * and the payments table's unique stripe_event_id is what
     * makes that true.
     *
     * Secondary to the payment and swallowed on failure, like
     * every other side effect here: analytics must never be the
     * reason Stripe redelivers a payment.
     */
    if (
      shouldSendPurchaseEvent({
        eventType: normalized.eventType,
        consultationId:
          normalized.consultationId,
        processed: row.processed,
        alreadyProcessed:
          row.already_processed,
      })
    ) {
      try {
        const outcome =
          await sendConsultationPurchaseEvent({
            consultationId:
              normalized.consultationId,
            amountMinor:
              normalized.amountCents,
            currency: normalized.currency,
            gaClientId:
              normalized.analytics.gaClientId,
            consultantId:
              normalized.analytics.consultantId,
            consultantName:
              normalized.analytics
                .consultantName,
            destination:
              normalized.analytics.destination,
          });

        /*
         * Logged so the unattributed slice is measurable from
         * the server as well as from GA: a booking whose
         * checkout carried no _ga value cannot join the session
         * that produced it.
         */
        if (
          outcome.clientIdSource ===
          "server_fallback"
        ) {
          console.warn(
            "GA4 purchase sent without a browser client id",
            {
              consultationId:
                normalized.consultationId,
              sent: outcome.sent,
              reason: outcome.reason,
            },
          );
        }
      } catch (error) {
        console.error(
          "GA4 purchase event threw during webhook processing",
          {
            consultationId:
              normalized.consultationId,
            message:
              error instanceof Error
                ? error.message
                : "Unknown error",
          },
        );
      }
    }

    return {
      ok: true,
      ignored: false,
      reason: null,
      processed: row.processed,
      alreadyProcessed:
        row.already_processed,
      paymentId: row.payment_id,
      consultationStatus:
        row.consultation_status,
    };
  };
