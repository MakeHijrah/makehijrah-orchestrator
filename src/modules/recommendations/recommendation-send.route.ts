import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { sendRecommendationToClient } from "./recommendation-send.service.js";

const recommendationParamsSchema =
  z.object({
    id: z.string().uuid(),
  });

export const registerRecommendationSendRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/admin/recommendations/:id/send",
      async (request, reply) => {
        const authentication =
          await requireRole(
            request,
            ["admin"],
          );

        if (!authentication.ok) {
          return sendError(
            reply,
            authentication.statusCode,
            authentication.code,
            authentication.message,
          );
        }

        const parsedParams =
          recommendationParamsSchema.safeParse(
            request.params,
          );

        if (!parsedParams.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The recommendation ID is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const result =
          await sendRecommendationToClient({
            recommendationId:
              parsedParams.data.id,
            adminProfileId:
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

            case "EMAIL_ERROR":
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
          recommendation_id:
            result.recommendationId,
          status: result.status,
          sent_at: result.sentAt,
        });
      },
    );
  };
