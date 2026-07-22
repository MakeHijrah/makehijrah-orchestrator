import type Stripe from "stripe";
import { stripe } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";

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
};

export type ProcessStripeWebhookResult =
  | {
      ok: true;
      ignored: boolean;
      processed: boolean;
      alreadyProcessed: boolean;
      paymentId: string | null;
      consultationStatus: string | null;
    }
  | {
      ok: false;
      code:
        | "INVALID_EVENT"
        | "MISSING_METADATA"
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

const normalizePaymentIntentEvent = (
  event: Stripe.Event,
  paymentIntent: Stripe.PaymentIntent,
): NormalizedStripeEvent | null => {
  const consultationId =
    readConsultationId(
      paymentIntent.metadata,
    );

  if (!consultationId) {
    return null;
  }

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
      };

    default:
      return null;
  }
};

const normalizeRefundEvent = async (
  event: Stripe.Event,
  charge: Stripe.Charge,
): Promise<
  | {
      ok: true;
      normalized:
        NormalizedStripeEvent;
    }
  | {
      ok: false;
      code:
        | "INVALID_EVENT"
        | "MISSING_METADATA"
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

  if (!consultationId) {
    return {
      ok: false,
      code: "MISSING_METADATA",
      message:
        "The refunded payment is missing its consultation ID.",
    };
  }

  return {
    ok: true,
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
    },
  };
};

const normalizeStripeEvent = async (
  event: Stripe.Event,
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
        | "MISSING_METADATA"
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

      const normalized =
        normalizePaymentIntentEvent(
          event,
          paymentIntent,
        );

      if (!normalized) {
        return {
          ok: false,
          code: "MISSING_METADATA",
          message:
            "The payment is missing its consultation ID.",
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
          event,
          charge,
        );

      if (!refundResult.ok) {
        return refundResult;
      }

      return {
        ok: true,
        ignored: false,
        normalized:
          refundResult.normalized,
      };
    }

    default:
      return {
        ok: true,
        ignored: true,
      };
  }
};

export const processStripeWebhookEvent =
  async (
    event: Stripe.Event,
  ): Promise<ProcessStripeWebhookResult> => {
    const normalizationResult =
      await normalizeStripeEvent(event);

    if (!normalizationResult.ok) {
      return normalizationResult;
    }

    if (
      normalizationResult.ignored
    ) {
      return {
        ok: true,
        ignored: true,
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

    return {
      ok: true,
      ignored: false,
      processed: row.processed,
      alreadyProcessed:
        row.already_processed,
      paymentId: row.payment_id,
      consultationStatus:
        row.consultation_status,
    };
  };
