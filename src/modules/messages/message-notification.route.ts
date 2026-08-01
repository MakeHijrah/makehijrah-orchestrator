import type {
  FastifyInstance,
} from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import {
  scheduleMessageNotification,
} from "./message-notification.service.js";

const messageParamsSchema =
  z.object({
    id: z.string().uuid(),
  });

export const registerMessageNotificationRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/messages/:id/notification",
      {
        config: {
          rateLimit: {
            max: 30,
            timeWindow:
              "1 minute",
          },
        },
      },
      async (request, reply) => {
        const authentication =
          await requireRole(
            request,
            [
              "client",
              "consultant",
              /*
               * Amendment 006 section 5.2. An admin sending a
               * direct message must be able to schedule its
               * notification. This grants no other admin
               * capability: the service still requires the caller
               * to be the message's own sender.
               */
              "admin",
            ],
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
          messageParamsSchema.safeParse(
            request.params,
          );

        if (!parsedParams.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The message ID is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const result =
          await scheduleMessageNotification({
            messageId:
              parsedParams.data.id,
            senderProfileId:
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
          message_id:
            result.messageId,
          notification:
            result.notification,
        });
      },
    );
  };
