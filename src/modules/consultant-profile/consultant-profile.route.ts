import type { FastifyInstance } from "fastify";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { consultantProfileSchema } from "./consultant-profile.schema.js";
import { saveProfileForConsultant } from "./consultant-profile.service.js";

/*
 * PUT /api/consultant/profile — PROJECT_LOCK Amendment 008.
 *
 * The consultant is resolved from the authenticated profile. The
 * body carries no consultant identifier and the schema is strict,
 * so one cannot be smuggled in under any name.
 */

export const registerConsultantProfileRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.put(
      "/api/consultant/profile",
      {
        config: {
          rateLimit: {
            max: 30,
            timeWindow: "1 minute",
          },
        },
      },
      async (request, reply) => {
        const authentication =
          await requireRole(
            request,
            ["consultant"],
          );

        if (!authentication.ok) {
          return sendError(
            reply,
            authentication.statusCode,
            authentication.code,
            authentication.message,
          );
        }

        const parsed =
          consultantProfileSchema.safeParse(
            request.body ?? {},
          );

        if (!parsed.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The consultant profile request is invalid.",
            parsed.error.flatten(),
          );
        }

        const result =
          await saveProfileForConsultant(
            {
              profileId:
                authentication.profile
                  .id,
              input: parsed.data,
            },
          );

        if (!result.ok) {
          switch (result.code) {
            case "NOT_FOUND":
              return sendError(
                reply,
                404,
                result.code,
                result.message,
              );

            case "VALIDATION_ERROR":
              return sendError(
                reply,
                400,
                result.code,
                result.message,
                {
                  issues:
                    result.issues,
                },
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

            case "CONSULTANT_COUNTRY_INVALID":
              return sendError(
                reply,
                409,
                result.code,
                result.message,
                {
                  issues:
                    result.issues,
                },
              );

            case "CONSULTANT_GENDER_IMMUTABLE":
              return sendError(
                reply,
                409,
                result.code,
                result.message,
              );

            case "INVALID_TRANSITION":
              return sendError(
                reply,
                409,
                result.code,
                result.message,
                {
                  reason: result.marker,
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
      },
    );
  };
