import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import {
  activateConsultant,
  deactivateConsultant,
  type AdminConsultantActivationResult,
} from "./admin-consultant-activation.service.js";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const sendActivationResult = (
  reply: Parameters<
    typeof sendSuccess
  >[0],
  result: AdminConsultantActivationResult,
): ReturnType<typeof sendSuccess> => {
  if (!result.ok) {
    switch (result.code) {
      case "NOT_FOUND":
        return sendError(
          reply,
          404,
          result.code,
          result.message,
        );

      case "CONSULTANT_PROFILE_INCOMPLETE":
        return sendError(
          reply,
          409,
          result.code,
          result.message,
          {
            missing:
              result.missing,
          },
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
    consultant: result.consultant,
  });
};

export const registerAdminConsultantActivationRoutes =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/admin/consultants/:id/activate",
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
          paramsSchema.safeParse(
            request.params,
          );

        if (!parsedParams.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The consultant ID is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const result =
          await activateConsultant(
            parsedParams.data.id,
          );

        return sendActivationResult(
          reply,
          result,
        );
      },
    );

    app.post(
      "/api/admin/consultants/:id/deactivate",
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
          paramsSchema.safeParse(
            request.params,
          );

        if (!parsedParams.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The consultant ID is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const result =
          await deactivateConsultant(
            parsedParams.data.id,
          );

        return sendActivationResult(
          reply,
          result,
        );
      },
    );
  };
