import type Stripe from "stripe";
import { env } from "../../config/env.js";
import {
  getActiveStripeMode,
  getStripeClient,
} from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { calculateHoldExpiration } from "./draft-hold.js";

type CheckoutConsultationRow = {
  id: string;
  client_profile_id: string;
  status: string;
  price_cents: number;
  currency: string;
  stripe_payment_intent_id: string | null;
  created_at: string;
};

type CheckoutIntakeRow = {
  email: string;
  full_name: string;
};

type CheckoutRecord = {
  consultation: CheckoutConsultationRow;
  intake: CheckoutIntakeRow;
  holdExpiresAt: string;
};

export type CreateStripeCheckoutResult =
  | {
      ok: true;
      checkoutUrl: string;
      checkoutSessionId: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "DRAFT_EXPIRED"
        | "INVALID_TRANSITION"
        | "STRIPE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

const loadCheckoutRecord = async (
  consultationId: string,
): Promise<
  | {
      ok: true;
      record: CheckoutRecord;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const {
    data: consultationData,
    error: consultationError,
  } = await supabaseAdmin
    .from("consultations")
    .select(
      "id, client_profile_id, status, price_cents, currency, stripe_payment_intent_id, created_at",
    )
    .eq("id", consultationId)
    .maybeSingle();

  if (consultationError) {
    console.error(
      "Checkout consultation lookup failed",
      {
        consultationId,
        code: consultationError.code,
        message:
          consultationError.message,
        details:
          consultationError.details,
        hint:
          consultationError.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation could not be loaded.",
    };
  }

  if (!consultationData) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The consultation was not found.",
    };
  }

  const consultation =
    consultationData as unknown as CheckoutConsultationRow;

  const {
    data: intakeData,
    error: intakeError,
  } = await supabaseAdmin
    .from("consultation_intake")
    .select("email, full_name")
    .eq(
      "consultation_id",
      consultationId,
    )
    .maybeSingle();

  if (intakeError) {
    console.error(
      "Checkout intake lookup failed",
      {
        consultationId,
        code: intakeError.code,
        message:
          intakeError.message,
        details:
          intakeError.details,
        hint:
          intakeError.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation intake could not be loaded.",
    };
  }

  if (!intakeData) {
    console.error(
      "Checkout intake row missing",
      {
        consultationId,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation intake could not be loaded.",
    };
  }

  const intake =
    intakeData as unknown as CheckoutIntakeRow;

  const holdExpiresAt =
    calculateHoldExpiration(
      consultation.created_at,
    );

  if (!holdExpiresAt) {
    console.error(
      "Checkout hold expiration calculation failed",
      {
        consultationId,
        createdAt:
          consultation.created_at,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultation hold could not be verified.",
    };
  }

  return {
    ok: true,
    record: {
      consultation,
      intake,
      holdExpiresAt,
    },
  };
};

export const createStripeCheckout =
  async (
    consultationId: string,
  ): Promise<CreateStripeCheckoutResult> => {
    const checkoutRecordResult =
      await loadCheckoutRecord(
        consultationId,
      );

    if (!checkoutRecordResult.ok) {
      return checkoutRecordResult;
    }

    const {
      consultation,
      intake,
      holdExpiresAt,
    } = checkoutRecordResult.record;

    if (
      consultation.status !== "draft"
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The consultation is no longer available for payment.",
      };
    }

    if (
      Date.parse(holdExpiresAt) <=
      Date.now()
    ) {
      return {
        ok: false,
        code: "DRAFT_EXPIRED",
        message:
          "The consultation hold has expired.",
      };
    }

    if (
      consultation
        .stripe_payment_intent_id
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "Payment has already been authorized for this consultation.",
      };
    }

    /*
     * The Checkout Session is created under the currently active
     * mode, so any PaymentIntent it produces belongs to that
     * Stripe account. The mode is recorded on the consultation
     * below, and every later operation on this payment selects its
     * client from that recorded value rather than from the global
     * mode. Amendment 007 sections 5.7 and 5.8.
     */
    const activeMode =
      await getActiveStripeMode();

    const stripe =
      getStripeClient(activeMode);

    let checkoutSession:
      Stripe.Checkout.Session;

    try {
      checkoutSession =
        await stripe.checkout.sessions.create(
          {
            mode: "payment",

            customer_email:
              intake.email,

            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency:
                    consultation.currency,
                  unit_amount:
                    consultation.price_cents,
                  product_data: {
                    name:
                      "MakeHijrah Consultation",
                    description:
                      "60-minute video consultation",
                  },
                },
              },
            ],

            payment_intent_data: {
              capture_method: "manual",
              receipt_email:
                intake.email,
              metadata: {
                consultation_id:
                  consultation.id,
                client_profile_id:
                  consultation.client_profile_id,
              },
            },

            metadata: {
              consultation_id:
                consultation.id,
              client_profile_id:
                consultation.client_profile_id,
            },

            success_url:
              `${env.APP_URL}/login` +
              `?payment=success` +
              `&redirect=${encodeURIComponent(
                "/dashboard",
              )}`,

            cancel_url:
              `${env.APP_URL}/consultation` +
              `?booking=cancelled` +
              `&cid=${encodeURIComponent(
                consultation.id,
              )}`,
          },
          {
            idempotencyKey:
              `consultation-checkout-${consultation.id}`,
          },
        );
    } catch (error) {
      console.error(
        "Stripe Checkout Session creation failed",
        {
          consultationId,
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
          "The payment session could not be created.",
      };
    }

    if (!checkoutSession.url) {
      console.error(
        "Stripe Checkout Session returned no URL",
        {
          consultationId,
          checkoutSessionId:
            checkoutSession.id,
        },
      );

      return {
        ok: false,
        code: "STRIPE_ERROR",
        message:
          "The payment session could not be created.",
      };
    }

    /*
     * Record the Stripe mode this consultation's payment belongs
     * to, as soon as the Session that will create it exists.
     *
     * The PaymentIntent id itself is written later by
     * process_stripe_webhook_event, so this is the earliest point
     * at which the mode is both known and attachable. The webhook
     * re-asserts it from its verified mode, which is authoritative.
     *
     * Guarded on stripe_mode is null so a retried checkout can
     * never rewrite the mode of an existing payment.
     */
    const { error: modeError } =
      await supabaseAdmin
        .from("consultations")
        .update({
          stripe_mode: activeMode,
        })
        .eq("id", consultationId)
        .is("stripe_mode", null);

    if (modeError) {
      console.error(
        "Consultation Stripe mode snapshot failed",
        {
          consultationId,
          code: modeError.code,
          message: modeError.message,
          details: modeError.details,
          hint: modeError.hint,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The payment session could not be created.",
      };
    }

    return {
      ok: true,
      checkoutUrl:
        checkoutSession.url,
      checkoutSessionId:
        checkoutSession.id,
    };
  };
