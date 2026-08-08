import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { getActiveStripeMode } from "../../lib/stripe.js";
import { loadServiceInstructions } from "./service-instructions.service.js";

const paramsSchema = z
  .object({
    consultationId: z.string().uuid(),
    serviceId: z.string().uuid(),
  })
  .strict();

/*
 * The Stripe Checkout Session id, as Stripe substitutes it into
 * the success URL. Bounded and pattern-matched so a hostile value
 * is rejected before it reaches a Stripe API call — the id is a
 * lookup key, and a lookup key from a query string gets validated
 * like any other client input.
 */
const querySchema = z
  .object({
    session_id: z
      .string()
      .trim()
      .regex(/^cs_[A-Za-z0-9_]{1,250}$/)
      .optional(),
  })
  .strict();

/*
 * GET /api/consultations/:consultationId/services/:serviceId/instructions
 * — client
 *
 * Private post-purchase delivery content for one service on one
 * consultation. This is the ONLY client-facing read of
 * services.post_purchase_instructions_html, which the base table
 * withholds from every authenticated caller by column privilege
 * (migration 042). The service role reads past that privilege
 * here, after the authorisation in the service layer has proved
 * both ownership and payment.
 *
 * A sent recommendation alone does NOT authorise: an admin
 * offering a service is not the client having bought it. Payment
 * is proved either by a recorded service_purchases row or by a
 * Checkout Session retrieved and verified server-side, which is
 * what makes the success page work before the webhook lands.
 *
 * Consultants and admins are refused. An admin reads the same
 * content through public.admin_services (migration 041); a
 * consultant has no business with delivery material.
 */
export const registerServiceInstructionsRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.get(
      "/api/consultations/:consultationId/services/:serviceId/instructions",
      {
        config: {
          rateLimit: {
            max: 60,
            timeWindow: "1 minute",
          },
        },
      },
      async (request, reply) => {
        const authentication =
          await requireRole(request, [
            "client",
          ]);

        if (!authentication.ok) {
          return sendError(
            reply,
            authentication.statusCode,
            authentication.code,
            authentication.message,
          );
        }

        const parsedParams =
          paramsSchema.safeParse(
            request.params ?? {},
          );

        if (!parsedParams.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The consultation or service id is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const parsedQuery =
          querySchema.safeParse(
            request.query ?? {},
          );

        /*
         * A malformed session_id is not a client error worth
         * failing on — the durable purchase path may still
         * authorise the read. It is simply discarded, so a junk
         * query string degrades to "no session supplied" rather
         * than to a 400 that would tell a prober their guess was
         * the wrong SHAPE.
         */
        const sessionId = parsedQuery.success
          ? (parsedQuery.data.session_id ?? null)
          : null;

        const result =
          await loadServiceInstructions({
            consultationId:
              parsedParams.data.consultationId,
            serviceId:
              parsedParams.data.serviceId,
            clientProfileId:
              authentication.profile.id,
            sessionId,
            stripeMode:
              await getActiveStripeMode(),
          });

        if (!result.ok) {
          return sendError(
            reply,
            result.code === "NOT_FOUND"
              ? 404
              : 500,
            result.code,
            result.message,
          );
        }

        /*
         * Exactly three fields. No price, no Stripe identifier,
         * no commission, no purchase, no consultant — the
         * response is the delivery content and the name it
         * belongs to, and nothing that would turn this endpoint
         * into a general service reader.
         */
        return sendSuccess(reply, {
          service_id: result.serviceId,
          service_name: result.serviceName,
          post_purchase_instructions_html:
            result.postPurchaseInstructionsHtml,
        });
      },
    );
  };
