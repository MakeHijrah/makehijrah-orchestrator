import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import {
  adminCancelConsultation,
} from "./admin-consultation-cancel.service.js";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const bodySchema = z.object({
  refund: z.boolean().default(false),
  note: z
    .string()
    .trim()
    .max(2_000)
    .nullable()
    .optional()
    .transform((value) => value || null),
});

export const registerAdminConsultationCancelRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/admin/consultations/:id/cancel",
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
            "The consultation ID is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const parsedBody =
          bodySchema.safeParse(
            request.body ?? {},
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The cancellation request is invalid.",
            parsedBody.error.flatten(),
          );
        }

        const result =
          await adminCancelConsultation({
            consultationId:
              parsedParams.data.id,
            refund:
              parsedBody.data.refund,
            note:
              parsedBody.data.note,
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
            case "PAYMENT_NOT_AVAILABLE":
              return sendError(
                reply,
                409,
                result.code,
                result.message,
              );

            case "STRIPE_ERROR":
            case "GOOGLE_ERROR":
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
          consultation_id:
            result.consultationId,
          status:
            result.status,
          cancelled_at:
            result.cancelledAt,
          admin_attention_reason:
            result.adminAttentionReason,
          refunded:
            result.refunded,
          stripe_action:
            result.stripeAction,
          calendar_action:
            result.calendarAction,
        });
      },
    );
  };
