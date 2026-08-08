import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { createServiceCheckoutSession } from "./service-checkout.service.js";

const paramsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/*
 * POST /api/services/:id/checkout — client
 *
 * The client names a service and nothing else. There is no body
 * schema at all beyond the empty object, which is the point:
 * consultant_id, attributed_consultant_id, commission_bps,
 * service_request_id and consultation_id are not merely rejected
 * here, there is no field in which any of them could be sent.
 *
 * The purchasing client is taken from the bearer token. The
 * consultant, the consultation and the request are resolved
 * server-side from MakeHijrah records, and the database re-derives
 * the consultant again when the payment lands — so this endpoint
 * could not attribute a commission wrongly even if it wanted to.
 *
 * Consultants and admins are not accepted. Buying a service is
 * the client's own act; an admin purchasing on someone's behalf
 * is a different feature with different auditing.
 */
export const registerServiceCheckoutRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/services/:id/checkout",
      {
        config: {
          rateLimit: {
            max: 20,
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
            "The service id is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const result =
          await createServiceCheckoutSession({
            serviceId: parsedParams.data.id,
            clientProfileId:
              authentication.profile.id,
          });

        if (!result.ok) {
          switch (result.code) {
            case "NOT_FOUND":
              return sendError(
                reply,
                404,
                result.code,
                result.message,
              );

            case "INVALID_TRANSITION":
              return sendError(
                reply,
                409,
                result.code,
                result.message,
              );

            case "STRIPE_ERROR":
              return sendError(
                reply,
                502,
                result.code,
                result.message,
              );

            case "INTERNAL_ERROR":
            default:
              return sendError(
                reply,
                500,
                "INTERNAL_ERROR",
                result.message,
              );
          }
        }

        return sendSuccess(reply, {
          checkout_url: result.checkoutUrl,
          session_id: result.sessionId,
          mode: result.mode,
          /*
           * Whether a consultant will be credited. Surfaced so an
           * admin debugging a missing commission can see the
           * answer at the moment of purchase rather than
           * reconstructing it afterwards. It names no consultant.
           */
          attributed: result.attributed,
        });
      },
    );
  };
