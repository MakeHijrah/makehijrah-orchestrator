import type Stripe from "stripe";

import { sanitizeRichText } from "../../lib/html-sanitizer.js";
import {
  getStripeClient,
  type StripeMode,
} from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";

/*
 * Private post-purchase delivery instructions for one service on
 * one consultation.
 *
 * The rule this file exists to enforce, and the one thing to read
 * if you read nothing else:
 *
 *   A SENT RECOMMENDATION IS NOT PROOF OF PAYMENT.
 *
 * An admin sending a recommendation says "you may buy this". It
 * does not say "you have bought this", and the instructions are
 * the thing being sold — download links, booking links, onboarding
 * routes. So association is necessary but never sufficient:
 * payment must be proved separately, by one of exactly two means.
 *
 *   A. A recorded service_purchases row. The durable path, used
 *      for every visit after the webhook has landed.
 *
 *   B. A Checkout Session retrieved SERVER-SIDE from Stripe and
 *      verified field by field. The immediate path, used in the
 *      seconds between the browser returning from Stripe and
 *      checkout.session.completed arriving.
 *
 * B is why no polling exists here. The browser can beat the
 * webhook — routinely does — and the answer to that is to ask
 * Stripe directly, not to make the client wait for our own
 * asynchronous processing to catch up.
 *
 * Every failure returns the SAME not-found result. A client
 * probing service ids cannot tell "no such service" from "not
 * yours" from "you did not pay", because the difference between
 * those answers is itself information.
 */

export type ServiceInstructionsResult =
  | {
      ok: true;
      serviceId: string;
      serviceName: string;
      postPurchaseInstructionsHtml: string | null;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    };

/* One shape for every refusal. See the note above. */
const notFound = (): ServiceInstructionsResult => ({
  ok: false,
  code: "NOT_FOUND",
  message:
    "The service instructions were not found.",
});

const internalError = (): ServiceInstructionsResult => ({
  ok: false,
  code: "INTERNAL_ERROR",
  message:
    "The service instructions could not be loaded.",
});

/*
 * Purchase states that entitle a client to the instructions.
 *
 * 'refunded' is included deliberately. A refund reverses the
 * money, and migration 040 records that reversal in the ledger;
 * it does not retract the fact that the client was once entitled
 * to read what they had bought. Removing delivery content on
 * refund would be a new business rule, and inventing one here —
 * silently, in a read path — is not this endpoint's job.
 *
 * 'cancelled' is excluded: it means the purchase never completed.
 */
const ENTITLING_PURCHASE_STATUSES = [
  "paid",
  "fulfilled",
  "refunded",
] as const;

/*
 * B. Stripe Checkout Session verification.
 *
 * Every field that could be lied about is checked against
 * something the server already knows. A session id in a query
 * string proves only that the browser has seen a session id, so
 * it is treated as a lookup key and nothing more.
 */
const verifyCheckoutSession = async ({
  sessionId,
  serviceId,
  clientProfileId,
  consultationId,
  mode,
}: {
  sessionId: string;
  serviceId: string;
  clientProfileId: string;
  consultationId: string;
  mode: StripeMode;
}): Promise<boolean> => {
  let session: Stripe.Checkout.Session;

  try {
    session = await getStripeClient(
      mode,
    ).checkout.sessions.retrieve(sessionId);
  } catch (error) {
    /*
     * A forged, malformed or foreign-account session id lands
     * here. Not an error worth failing the request over — it is
     * simply not proof — so it is logged quietly and treated as
     * unverified.
     */
    console.warn(
      "Checkout session could not be retrieved for instructions access",
      {
        sessionId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );

    return false;
  }

  /*
   * 1. The session belongs to the environment we are running in.
   *    A live session must never authorise anything in test, or
   *    the other way round.
   */
  if (session.livemode !== (mode === "live")) {
    return false;
  }

  /*
   * 2. Money actually moved. `payment_status` is the field that
   *    says so; `status: 'complete'` alone can be true for a
   *    session whose payment is still pending.
   */
  if (session.payment_status !== "paid") {
    return false;
  }

  /*
   * 3. The metadata is OURS. These three keys are written only by
   *    createServiceCheckoutSession, from server-resolved values,
   *    and a session created any other way will not carry them.
   *    All three must match what the caller is asking for, so a
   *    genuine paid session for a different service, a different
   *    consultation or a different client proves nothing here.
   */
  const metadata = session.metadata ?? {};

  if (
    metadata.makehijrah_service_id !== serviceId ||
    metadata.makehijrah_client_profile_id !==
      clientProfileId ||
    metadata.makehijrah_consultation_id !==
      consultationId
  ) {
    return false;
  }

  /*
   * 4. And the client_reference_id, which this orchestrator also
   *    sets from the authenticated profile. Belt and braces: a
   *    session would have to have both forged consistently to
   *    reach this point, and neither is settable by a client.
   */
  if (
    session.client_reference_id !== null &&
    session.client_reference_id !== clientProfileId
  ) {
    return false;
  }

  return true;
};

export const loadServiceInstructions = async ({
  consultationId,
  serviceId,
  clientProfileId,
  sessionId,
  stripeMode,
}: {
  consultationId: string;
  serviceId: string;
  clientProfileId: string;
  sessionId: string | null;
  stripeMode: StripeMode;
}): Promise<ServiceInstructionsResult> => {
  /*
   * 1. The consultation is the caller's own.
   *
   *    Read with the service role so RLS cannot narrow it, and
   *    filtered on the AUTHENTICATED profile — clientProfileId
   *    comes from the bearer token in the route, never from the
   *    request. This is what stops client A reading client B's
   *    consultation.
   */
  const { data: consultationData, error: consultationError } =
    await supabaseAdmin
      .from("consultations")
      .select("id, client_profile_id")
      .eq("id", consultationId)
      .eq("client_profile_id", clientProfileId)
      .maybeSingle();

  if (consultationError) {
    console.error(
      "Consultation lookup failed for service instructions",
      {
        consultationId,
        code: consultationError.code,
        message: consultationError.message,
      },
    );

    return internalError();
  }

  if (!consultationData) {
    return notFound();
  }

  /*
   * 2. The service exists.
   *
   *    Deliberately NOT filtered on is_active. A service
   *    deactivated after it was bought must still deliver its
   *    instructions to the person who paid for it — withdrawing
   *    the catalogue entry is not the same as withdrawing what
   *    somebody already owns.
   */
  const { data: serviceData, error: serviceError } =
    await supabaseAdmin
      .from("services")
      .select("id, name, post_purchase_instructions_html")
      .eq("id", serviceId)
      .maybeSingle();

  if (serviceError) {
    console.error(
      "Service lookup failed for service instructions",
      {
        serviceId,
        code: serviceError.code,
        message: serviceError.message,
      },
    );

    return internalError();
  }

  const service = serviceData as unknown as {
    id: string;
    name: string;
    post_purchase_instructions_html: string | null;
  } | null;

  if (!service) {
    return notFound();
  }

  /*
   * 3. The service is genuinely associated with this
   *    consultation — through a sent recommendation or a recorded
   *    purchase. Necessary, and on its own NOT sufficient; step 4
   *    is what authorises.
   */
  const { data: recommendationData } =
    await supabaseAdmin
      .from("service_recommendations")
      .select("id")
      .eq("consultation_id", consultationId)
      .eq("service_id", serviceId)
      .eq("status", "sent")
      .maybeSingle();

  /*
   * 4A. A recorded purchase. All three of service, client and
   *     consultation must match — a purchase of this service by
   *     this client on a DIFFERENT consultation does not unlock
   *     this consultation's copy.
   */
  const { data: purchaseData, error: purchaseError } =
    await supabaseAdmin
      .from("service_purchases")
      .select("id, status")
      .eq("service_id", serviceId)
      .eq("client_profile_id", clientProfileId)
      .eq("consultation_id", consultationId)
      .in("status", [...ENTITLING_PURCHASE_STATUSES])
      .maybeSingle();

  if (purchaseError) {
    console.error(
      "Service purchase lookup failed for service instructions",
      {
        serviceId,
        consultationId,
        code: purchaseError.code,
        message: purchaseError.message,
      },
    );

    return internalError();
  }

  const associated = Boolean(
    recommendationData ?? purchaseData,
  );

  if (!associated) {
    return notFound();
  }

  let paymentProved = Boolean(purchaseData);

  /*
   * 4B. No purchase row yet — the ordinary state in the seconds
   *     after returning from Stripe. Ask Stripe directly rather
   *     than waiting for our own webhook.
   */
  if (!paymentProved && sessionId) {
    paymentProved = await verifyCheckoutSession({
      sessionId,
      serviceId,
      clientProfileId,
      consultationId,
      mode: stripeMode,
    });
  }

  /*
   * Neither proof. Indistinguishable from "no such service" —
   * which is the point: a client who was merely recommended this
   * service learns nothing from being refused.
   */
  if (!paymentProved) {
    return notFound();
  }

  return {
    ok: true,
    serviceId: service.id,
    serviceName: service.name,
    /*
     * Sanitized AGAIN on the way out. It was sanitized on write,
     * so this is normally a no-op — the sanitizer is idempotent
     * and a test asserts it. What it defends against is the one
     * path write-time sanitization cannot cover: a row edited
     * directly in the Supabase SQL editor, which never passes
     * through the admin endpoints at all.
     */
    postPurchaseInstructionsHtml: sanitizeRichText(
      service.post_purchase_instructions_html,
    ),
  };
};
