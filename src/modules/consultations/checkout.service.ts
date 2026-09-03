import type Stripe from "stripe";
import { env } from "../../config/env.js";
import {
  getActiveStripeMode,
  getStripeClient,
} from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { loadDirectBookingSettingsById } from "../direct-booking/direct-booking.repository.js";
import { buildDirectBookingUrl } from "../direct-booking/direct-booking.slug.js";
import { calculateHoldExpiration } from "./draft-hold.js";

type CheckoutConsultationRow = {
  id: string;
  client_profile_id: string;
  consultant_id: string;
  booking_source: string;
  status: string;
  price_cents: number;
  currency: string;
  stripe_payment_intent_id: string | null;
  created_at: string;
  country_id: string | null;
  /*
   * Embedded rows. PostgREST returns an object for a
   * to-one embed, or null when the foreign key is null —
   * country_id is null for a general consultation.
   */
  consultants: { display_name: string | null } | null;
  countries: { name: string | null } | null;
};

/*
 * Analytics facts carried to Stripe so the webhook can build the
 * GA4 purchase event without reading a table. Every value is a
 * plain string because Stripe metadata holds nothing else, and
 * every one is optional because analytics must never be able to
 * stop a checkout.
 */
const buildAnalyticsMetadata = ({
  consultation,
  gaClientId,
}: {
  consultation: CheckoutConsultationRow;
  gaClientId: string | null;
}): Record<string, string> => {
  const consultantName =
    consultation.consultants?.display_name ?? null;

  const destination =
    consultation.countries?.name ?? null;

  return {
    /* item_id for the GA4 purchase event. */
    consultant_id: consultation.consultant_id,
    ...(gaClientId
      ? { ga_client_id: gaClientId }
      : {}),
    ...(consultantName
      ? {
          consultant_name:
            consultantName.slice(0, 200),
        }
      : {}),
    ...(destination
      ? { destination: destination.slice(0, 200) }
      : {}),
  };
};

/*
 * WHERE STRIPE SENDS A VISITOR WHO CHANGES THEIR MIND.
 *
 * A standard booking came from /consultation and goes back there. A
 * DIRECT booking came from the consultant's own page at a root URL,
 * and returning it to the generic consultation page drops the
 * visitor somewhere they never were - a different page, with a
 * different consultant, and no way back to the one they were
 * booking.
 *
 * Built in ONE place. The alternative is a route handler composing
 * URLs, and two composers eventually disagree about the trailing
 * slash or the encoding.
 *
 * The origin is normalised so an APP_URL of https://hijrah.network/
 * does not produce a doubled slash; buildDirectBookingUrl already
 * does that for the consultant page, and the generic branch does
 * the same thing the same way.
 *
 * The consultation id is percent-encoded. It is a uuid and needs
 * nothing, but encoding what goes in a query string is not a thing
 * to decide case by case.
 */
const buildCancelUrl = ({
  appUrl,
  consultationId,
  consultantSlug,
}: {
  appUrl: string;
  consultationId: string;
  /*
   * Present only for a direct booking, and read from the
   * consultant's stored row. Never derived from a name again, and
   * never accepted from a request.
   */
  consultantSlug: string | null;
}): string => {
  const base = consultantSlug
    ? buildDirectBookingUrl({
        origin: appUrl,
        slug: consultantSlug,
      })
    : `${appUrl.replace(/\/+$/, "")}/consultation`;

  return (
    `${base}?booking=cancelled` +
    `&cid=${encodeURIComponent(consultationId)}`
  );
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
      /*
       * consultant_id and booking_source are read for the CANCEL
       * URL: a visitor who abandons a direct booking must land back
       * on the consultant's own page, not the generic one. See
       * buildCancelUrl below.
       */
      /*
       * consultants.display_name and countries.name are read for
       * the GA4 purchase event's item, which reports which
       * consultant and which destination converted. Both are
       * already public on the booking surface. They are embedded
       * here rather than looked up in the webhook because the
       * webhook may not read tables at all (Amendment 004
       * section 10.3.3), so they travel in Stripe metadata.
       */
      "id, client_profile_id, consultant_id, booking_source, status, price_cents, currency, stripe_payment_intent_id, created_at, country_id, consultants(display_name), countries(name)",
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
    gaClientId: string | null = null,
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

    const analyticsMetadata =
      buildAnalyticsMetadata({
        consultation,
        gaClientId,
      });

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
     * WHERE A CANCELLED CHECKOUT RETURNS TO, decided here from the
     * PERSISTED records and from nothing else.
     *
     * The request carries no cancel URL, no slug and no booking
     * source, and none would be accepted: a browser that could name
     * its own return URL could send a visitor anywhere under the
     * platform's domain with a real consultation id attached.
     * booking_source and consultant_id come off the consultation
     * row, and the slug off the consultant row.
     *
     * The slug is READ, never re-derived. Regenerating it from the
     * consultant's name would reproduce the generator's collision
     * suffixes and could point at a different consultant entirely -
     * john-smith when the booking belongs to john-smith-2.
     */
    let consultantSlug: string | null = null;

    if (
      consultation.booking_source ===
      "direct_booking"
    ) {
      const consultantRecord =
        await loadDirectBookingSettingsById(
          consultation.consultant_id,
        );

      if (!consultantRecord.ok) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The consultation could not be prepared for payment.",
        };
      }

      consultantSlug =
        consultantRecord.data
          ?.consultant_slug ?? null;

      /*
       * A direct booking whose consultant has no link should not
       * exist: activation generates one, the column guard stops a
       * client clearing it, and neither sanctioned write path can
       * null it. If it happens anyway, refuse rather than fall back
       * to the generic page - creating a payment session on top of
       * a data integrity problem hides the problem behind a
       * successful checkout.
       */
      if (!consultantSlug) {
        console.error(
          "Direct booking checkout blocked: the consultant has no booking link",
          {
            consultationId,
            consultantId:
              consultation.consultant_id,
          },
        );

        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            "The consultation could not be prepared for payment.",
        };
      }
    }

    const cancelUrl = buildCancelUrl({
      appUrl: env.APP_URL,
      consultationId: consultation.id,
      consultantSlug,
    });

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
              /*
               * The webhook reads its whole world from here. The
               * analytics keys are additive: consultation_id and
               * client_profile_id are unchanged and still the only
               * two anything transactional depends on.
               */
              metadata: {
                consultation_id:
                  consultation.id,
                client_profile_id:
                  consultation.client_profile_id,
                ...analyticsMetadata,
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

            cancel_url: cancelUrl,
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
