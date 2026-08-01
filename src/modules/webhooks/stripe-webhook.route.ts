import type {
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import type Stripe from "stripe";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import {
  configuredStripeModes,
  getStripeClient,
  stripeWebhookSecretFor,
  type StripeMode,
} from "../../lib/stripe.js";
import { processStripeWebhookEvent } from "./stripe-webhook.service.js";

/*
 * Dual-mode webhook verification. PROJECT_LOCK Amendment 007
 * section 6.
 *
 * Each configured mode's signing secret is tried in a fixed order,
 * bounded to at most two attempts. Verification deliberately does
 * not consult app_settings: a test event must stay verifiable
 * while the platform is live, and a live event while it is in
 * test.
 *
 * constructEvent is a pure HMAC comparison with no side effects,
 * so trying both secrets cannot cause duplicate processing.
 * Processing happens once, after a mode has been established.
 */
const VERIFICATION_ORDER = [
  "test",
  "live",
] as const satisfies readonly StripeMode[];

type VerifiedEvent = {
  event: Stripe.Event;
  mode: StripeMode;
};

const verifyStripeEvent = ({
  rawBody,
  signature,
}: {
  rawBody: string | Buffer;
  signature: string;
}): VerifiedEvent | null => {
  const available = new Set(
    configuredStripeModes(),
  );

  for (const mode of VERIFICATION_ORDER) {
    if (!available.has(mode)) {
      continue;
    }

    const secret =
      stripeWebhookSecretFor(mode);

    if (!secret) {
      continue;
    }

    try {
      const event =
        getStripeClient(
          mode,
        ).webhooks.constructEvent(
          rawBody,
          signature,
          secret,
        );

      return { event, mode };
    } catch {
      /*
       * Try the next configured mode. Which secret failed is
       * never surfaced or logged.
       */
      continue;
    }
  }

  return null;
};

type StripeWebhookRequest =
  FastifyRequest & {
    rawBody?: string | Buffer;
  };

const readStripeSignature = (
  request: FastifyRequest,
): string | null => {
  const signature =
    request.headers["stripe-signature"];

  if (typeof signature === "string") {
    return signature;
  }

  if (
    Array.isArray(signature) &&
    typeof signature[0] === "string"
  ) {
    return signature[0];
  }

  return null;
};

export const registerStripeWebhookRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/webhooks/stripe",
      {
        config: {
          rawBody: true,
        },
      },
      async (request, reply) => {
        const webhookRequest =
          request as StripeWebhookRequest;

        const signature =
          readStripeSignature(request);

        if (!signature) {
          return sendError(
            reply,
            400,
            "STRIPE_SIGNATURE_MISSING",
            "The Stripe signature header is missing.",
          );
        }

        if (!webhookRequest.rawBody) {
          request.log.error(
            {
              eventRoute:
                "/api/webhooks/stripe",
            },
            "Stripe webhook raw body is unavailable",
          );

          return sendError(
            reply,
            500,
            "RAW_BODY_UNAVAILABLE",
            "The webhook request could not be verified.",
          );
        }

        const verified =
          verifyStripeEvent({
            rawBody:
              webhookRequest.rawBody,
            signature,
          });

        if (!verified) {
          request.log.warn(
            {},
            "Stripe webhook signature verification failed for every configured mode",
          );

          return sendError(
            reply,
            400,
            "STRIPE_SIGNATURE_INVALID",
            "The Stripe webhook signature is invalid.",
          );
        }

        const {
          event,
          mode: verifiedMode,
        } = verified;

        /*
         * The event's own livemode must agree with the mode of the
         * secret that verified it. This is what stops a test event
         * from ever driving live payment handling, and vice versa.
         * Amendment 007 section 6.2.
         */
        if (
          event.livemode !==
          (verifiedMode === "live")
        ) {
          request.log.error(
            {
              eventId: event.id,
              eventType: event.type,
              verifiedMode,
              eventLivemode:
                event.livemode,
            },
            "Stripe webhook rejected because event livemode does not match the verifying secret",
          );

          return sendError(
            reply,
            400,
            "STRIPE_LIVEMODE_MISMATCH",
            "The Stripe webhook event does not match its signing mode.",
          );
        }

        const processingResult =
          await processStripeWebhookEvent(
            getStripeClient(
              verifiedMode,
            ),
            event,
            verifiedMode,
          );

        if (!processingResult.ok) {
          switch (
            processingResult.code
          ) {
            case "INVALID_EVENT":
              return sendError(
                reply,
                400,
                "INVALID_EVENT",
                processingResult.message,
              );

            case "STRIPE_ERROR":
              return sendError(
                reply,
                502,
                "STRIPE_ERROR",
                processingResult.message,
              );

            case "DATABASE_ERROR":
            default:
              return sendError(
                reply,
                500,
                "DATABASE_ERROR",
                processingResult.message,
              );
          }
        }

        /*
         * Safe fields only: the Stripe event identifier, its
         * type, and the ignore reason. The Stripe payload, the
         * signature header and the webhook secret are never
         * logged. An ignored event is recorded here, which is
         * what PROJECT_LOCK Amendment 004 section 10.3.1
         * requires of it.
         */
        request.log.info(
          {
            stripeEventId: event.id,
            stripeEventType:
              event.type,
            ignored:
              processingResult.ignored,
            reason:
              processingResult.reason,
            processed:
              processingResult.processed,
            alreadyProcessed:
              processingResult
                .alreadyProcessed,
            paymentId:
              processingResult.paymentId,
            consultationStatus:
              processingResult
                .consultationStatus,
          },
          "Stripe webhook handled",
        );

        /*
         * HTTP 200. A correctly signed event is acknowledged
         * whether it was processed or ignored, so that Stripe
         * does not retry it and does not disable the endpoint.
         */
        return sendSuccess(reply, {
          received: true,
          event_id: event.id,
          event_type: event.type,
          ignored:
            processingResult.ignored,
          reason:
            processingResult.reason,
          processed:
            processingResult.processed,
          already_processed:
            processingResult
              .alreadyProcessed,
        });
      },
    );
  };
