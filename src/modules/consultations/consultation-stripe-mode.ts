import type Stripe from "stripe";
import {
  getStripeClient,
  StripeModeNotConfiguredError,
  type StripeMode,
} from "../../lib/stripe.js";

/*
 * Stripe client selection for an existing payment.
 * PROJECT_LOCK Amendment 007 sections 5.7 and 5.8.
 *
 * Capture, cancellation and refund must always reach the Stripe
 * account the PaymentIntent was created in, whatever the current
 * global mode happens to be. The authoritative selector is
 * consultations.stripe_mode, never app_settings.
 *
 * Fails closed. A consultation carrying a PaymentIntent but no
 * recorded mode is an operational error, not something to guess
 * at: retrieving a test PaymentIntent with a live key returns a
 * generic resource_missing, which is indistinguishable from a
 * genuinely deleted object.
 */

export type ConsultationPaymentContext = {
  id: string;
  stripe_mode: string | null;
  stripe_payment_intent_id: string | null;
};

export type ResolveStripeClientResult =
  | {
      ok: true;
      client: Stripe;
      mode: StripeMode;
    }
  | {
      ok: false;
      message: string;
    };

const isStripeMode = (
  value: string | null,
): value is StripeMode =>
  value === "test" || value === "live";

export const resolveConsultationStripeClient = (
  consultation: ConsultationPaymentContext,
): ResolveStripeClientResult => {
  if (!isStripeMode(consultation.stripe_mode)) {
    console.error(
      "Consultation payment operation blocked because the Stripe mode is unknown",
      {
        consultationId: consultation.id,
        hasPaymentIntent: Boolean(
          consultation.stripe_payment_intent_id,
        ),
        stripeMode:
          consultation.stripe_mode,
      },
    );

    return {
      ok: false,
      message:
        "The payment could not be processed because its Stripe mode is unknown.",
    };
  }

  const mode = consultation.stripe_mode;

  try {
    return {
      ok: true,
      client: getStripeClient(mode),
      mode,
    };
  } catch (error) {
    if (
      error instanceof
      StripeModeNotConfiguredError
    ) {
      console.error(
        "Consultation payment operation blocked because its Stripe mode is not configured",
        {
          consultationId:
            consultation.id,
          mode,
        },
      );

      return {
        ok: false,
        message:
          "The payment could not be processed because its Stripe mode is not configured.",
      };
    }

    throw error;
  }
};

/*
 * Defence in depth after retrieving a Stripe object: the object's
 * own livemode must agree with the mode we selected. A mismatch
 * means the recorded mode is wrong, and no capture, cancellation
 * or refund may proceed.
 */
export const paymentIntentModeMatches = ({
  paymentIntent,
  mode,
}: {
  paymentIntent: {
    livemode: boolean;
  };
  mode: StripeMode;
}): boolean =>
  paymentIntent.livemode ===
  (mode === "live");
