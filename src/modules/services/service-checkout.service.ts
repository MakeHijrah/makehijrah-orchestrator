import type Stripe from "stripe";
import { env } from "../../config/env.js";
import {
  getActiveStripeMode,
  getStripeClient,
} from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Trusted service checkout.
 *
 * The client asks to buy a service and supplies exactly one
 * thing: which service. Everything else that matters — who they
 * are, which consultation the service was recommended on, which
 * consultant recommended it — is resolved here, server-side, from
 * MakeHijrah records, and stamped into Stripe metadata so the
 * later webhook has trusted context to work from.
 *
 * Why this exists at all, when a static Payment Link already
 * does: a Payment Link is one shared URL per service. It carries
 * no client identity, so a payment made through it can only be
 * attributed by guessing, and a guess is exactly what a client
 * could bend. A Session created here is created for one client,
 * by the server, after the server has read who they are from
 * their bearer token.
 *
 * The metadata this writes is a convenience for the webhook, NOT
 * an authority. record_service_purchase re-derives the consultant
 * from service_recommendations regardless of what any metadata
 * says, and it accepts no consultant parameter at all. So even
 * this trusted path cannot inject an attribution, which is the
 * property that makes the whole design safe rather than merely
 * careful.
 */

export type ServiceCheckoutResult =
  | {
      ok: true;
      checkoutUrl: string;
      sessionId: string;
      mode: "payment" | "subscription";
      attributed: boolean;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "INVALID_TRANSITION"
        | "STRIPE_ERROR"
        | "INTERNAL_ERROR";
      message: string;
    };

type ServiceRow = {
  id: string;
  name: string;
  is_active: boolean;
  billing_type: "one_time" | "recurring" | null;
  recurring_interval: "month" | "year" | null;
  price_cents: number | null;
  currency: string | null;
  stripe_price_id: string | null;
};

export const createServiceCheckoutSession =
  async ({
    serviceId,
    clientProfileId,
  }: {
    serviceId: string;
    clientProfileId: string;
  }): Promise<ServiceCheckoutResult> => {
    /*
     * 1. The service, and whether it can be sold at all.
     */
    const { data: serviceData, error: serviceError } =
      await supabaseAdmin
        .from("services")
        .select(
          "id, name, is_active, billing_type, recurring_interval, price_cents, currency, stripe_price_id",
        )
        .eq("id", serviceId)
        .maybeSingle();

    if (serviceError) {
      console.error(
        "Service checkout service lookup failed",
        {
          serviceId,
          code: serviceError.code,
          message: serviceError.message,
        },
      );

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "The service could not be loaded.",
      };
    }

    const service =
      serviceData as unknown as ServiceRow | null;

    if (!service || !service.is_active) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "The service was not found.",
      };
    }

    if (
      !service.stripe_price_id ||
      !service.billing_type ||
      !service.price_cents ||
      !service.currency
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message:
          "The service is not yet available for purchase.",
      };
    }

    /*
     * 2. The trusted context.
     *
     *    Read with the service role so RLS cannot narrow it, and
     *    keyed on the AUTHENTICATED client — clientProfileId comes
     *    from the bearer token in the route, never from the body.
     *
     *    A client with no sent recommendation for this service may
     *    still buy it. They simply buy it unattributed, and no
     *    consultant is credited. Refusing the sale would be
     *    choosing to lose revenue in order to protect a
     *    commission that nobody has claimed.
     */
    const { data: recommendationData } =
      await supabaseAdmin
        .from("service_recommendations")
        .select(
          "consultation_id, recommended_by_consultant_id, sent_at, consultations!inner(client_profile_id)",
        )
        .eq("service_id", serviceId)
        .eq("status", "sent")
        .eq(
          "consultations.client_profile_id",
          clientProfileId,
        )
        .order("sent_at", {
          ascending: false,
          nullsFirst: false,
        })
        .limit(1)
        .maybeSingle();

    const recommendation =
      recommendationData as unknown as {
        consultation_id: string;
        recommended_by_consultant_id: string;
      } | null;

    const { data: requestData } =
      await supabaseAdmin
        .from("service_requests")
        .select("id")
        .eq("service_id", serviceId)
        .eq("client_profile_id", clientProfileId)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    const serviceRequestId =
      (requestData as unknown as {
        id: string;
      } | null)?.id ?? null;

    /*
     * 3. The Session.
     *
     *    Ordinary payment behaviour, never manual capture: manual
     *    capture belongs exclusively to the consultation flow
     *    (Amendment 004). A recurring service opens a
     *    subscription, and its context goes on
     *    subscription_data.metadata as well as the session's own,
     *    because a renewal invoice twelve months from now carries
     *    the subscription and not this session.
     */
    const mode =
      service.billing_type === "recurring"
        ? "subscription"
        : "payment";

    const metadata: Record<string, string> = {
      makehijrah_service_id: service.id,
      makehijrah_client_profile_id:
        clientProfileId,
      application: "makehijrah-orchestrator",
      environment: env.APP_ENV,
    };

    if (serviceRequestId) {
      metadata.makehijrah_service_request_id =
        serviceRequestId;
    }

    if (recommendation) {
      metadata.makehijrah_consultation_id =
        recommendation.consultation_id;
    }

    /*
     * 4. Where Stripe sends them back.
     *
     * {CHECKOUT_SESSION_ID} is Stripe's own placeholder and is
     * appended as a LITERAL — Stripe substitutes the real session
     * id when it builds the redirect. It must not be percent-
     * encoded, so it is concatenated after the encoded values
     * rather than passed through encodeURIComponent with them.
     * That session id is what lets the success page prove payment
     * before the webhook has written anything.
     *
     * The consultation id comes from the recommendation resolved
     * above, never from the request. An unattributed purchase has
     * no consultation to return to and falls back to the
     * dashboard; a consultant-recommended one always returns to
     * the consultation it was recommended on.
     */
    const returnBase = recommendation
      ? `${env.APP_URL}/dashboard/consultation/` +
        `${encodeURIComponent(
          recommendation.consultation_id,
        )}`
      : `${env.APP_URL}/dashboard`;

    const successUrl =
      `${returnBase}?purchase=success` +
      `&service=${encodeURIComponent(service.id)}` +
      `&session_id={CHECKOUT_SESSION_ID}`;

    /*
     * No service id on the cancel URL. An abandoned checkout
     * should not leave a "you bought this" signal in the address
     * bar; the client simply lands back where they started.
     */
    const cancelUrl = `${returnBase}?purchase=cancelled`;

    const activeMode = await getActiveStripeMode();
    const stripe = getStripeClient(activeMode);

    let session: Stripe.Checkout.Session;

    try {
      session =
        await stripe.checkout.sessions.create({
          mode,
          client_reference_id: clientProfileId,
          line_items: [
            {
              price: service.stripe_price_id,
              quantity: 1,
            },
          ],
          metadata,
          ...(mode === "subscription"
            ? {
                subscription_data: {
                  metadata,
                },
              }
            : {
                payment_intent_data: {
                  metadata,
                },
              }),
          success_url: successUrl,
          cancel_url: cancelUrl,
        });
    } catch (error) {
      console.error(
        "Service checkout session creation failed",
        {
          serviceId,
          message:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
      );

      return {
        ok: false,
        code: "STRIPE_ERROR",
        message:
          "The checkout session could not be created.",
      };
    }

    if (!session.url) {
      return {
        ok: false,
        code: "STRIPE_ERROR",
        message:
          "Stripe returned no checkout URL.",
      };
    }

    return {
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      mode,
      attributed: Boolean(recommendation),
    };
  };
