import type {
  FastifyInstance,
} from "fastify";
import {
  authenticateRequest,
  requireRole,
} from "../../lib/auth.js";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import {
  createConsultantInviteSchema,
  redeemConsultantInviteSchema,
} from "./invite.schema.js";
import {
  createConsultantInvite,
  redeemConsultantInvite,
} from "./invite.service.js";

export const registerInviteRoutes =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/admin/invites",
      {
        config: {
          rateLimit: {
            max: 5,
            timeWindow:
              "1 minute",
          },
        },
      },
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

        const parsed =
          createConsultantInviteSchema.safeParse(
            request.body,
          );

        if (!parsed.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The consultant invitation request is invalid.",
            parsed.error.flatten(),
          );
        }

        const result =
          await createConsultantInvite({
            input: parsed.data,
            adminProfileId:
              authentication.profile.id,
          });

        if (!result.ok) {
          return sendError(
            reply,
            500,
            result.code,
            result.message,
          );
        }

        return sendSuccess(
          reply,
          {
            invite_id:
              result.inviteId,
            invite_url:
              result.inviteUrl,
            expires_at:
              result.expiresAt,
          },
          201,
        );
      },
    );

    app.post(
      "/api/onboard/redeem",
      {
        config: {
          rateLimit: {
            max: 5,
            timeWindow:
              "1 minute",
          },
        },
      },
      async (request, reply) => {
        const authentication =
          await authenticateRequest(
            request,
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
          redeemConsultantInviteSchema.safeParse(
            request.body,
          );

        if (!parsed.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The consultant invitation redemption request is invalid.",
            parsed.error.flatten(),
          );
        }

        const result =
          await redeemConsultantInvite({
            input: parsed.data,
            authenticatedProfileId:
              authentication.profile.id,
          });

        if (!result.ok) {
          switch (result.code) {
            case "INVITE_INVALID":
              return sendError(
                reply,
                400,
                result.code,
                result.message,
              );

            case "INVITE_EXPIRED":
              return sendError(
                reply,
                410,
                result.code,
                result.message,
              );

            case "FORBIDDEN":
              return sendError(
                reply,
                403,
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
          profile_id:
            result.profileId,
          consultant_id:
            result.consultantId,
          role: result.role,
          is_active:
            result.isActive,
        });
      },
    );
  };