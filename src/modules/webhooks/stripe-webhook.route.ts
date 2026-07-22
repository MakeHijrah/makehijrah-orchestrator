import type {
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import type Stripe from "stripe";
import { env } from "../../config/env.js";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { stripe } from "../../lib/stripe.js";
import { processStripeWebhookEvent } from "./stripe-webhook.service.js";

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

        let event: Stripe.Event;

        try {
          event =
            stripe.webhooks.constructEvent(
              webhookRequest.rawBody,
              signature,
              env.STRIPE_WEBHOOK_SECRET,
            );
        } catch (error) {
          request.log.warn(
            {
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown Stripe signature error",
            },
            "Stripe webhook signature verification failed",
          );

          return sendError(
            reply,
            400,
            "STRIPE_SIGNATURE_INVALID",
            "The Stripe webhook signature is invalid.",
          );
        }

        const processingResult =
          await processStripeWebhookEvent(
            event,
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

            case "MISSING_METADATA":
              return sendError(
                reply,
                422,
                "MISSING_METADATA",
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

        request.log.info(
          {
            stripeEventId: event.id,
            stripeEventType:
              event.type,
            ignored:
              processingResult.ignored,
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

        return sendSuccess(reply, {
          received: true,
          event_id: event.id,
          event_type: event.type,
          ignored:
            processingResult.ignored,
          processed:
            processingResult.processed,
          already_processed:
            processingResult
              .alreadyProcessed,
        });
      },
    );
  };
