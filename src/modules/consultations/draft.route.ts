import type { FastifyInstance } from "fastify";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { validateDraftSlot } from "./draft-availability.js";
import { createDraftConsultationRecord } from "./draft.repository.js";
import { createDraftConsultationSchema } from "./draft.schema.js";

export const registerDraftConsultationRoute = async (
  app: FastifyInstance,
): Promise<void> => {
  app.post(
    "/api/consultations/draft",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const authentication = await requireRole(
        request,
        ["client"],
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
        createDraftConsultationSchema.safeParse(
          request.body,
        );

      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "The consultation request is invalid.",
          parsed.error.flatten(),
        );
      }

      const slotValidation =
        await validateDraftSlot({
          consultantId:
            parsed.data.consultant_id,
          startAt: parsed.data.start_at,
        });

      if (!slotValidation.ok) {
        switch (slotValidation.code) {
          case "NOT_FOUND":
            return sendError(
              reply,
              404,
              "NOT_FOUND",
              slotValidation.message,
            );

          case "OAUTH_NOT_CONNECTED":
            return sendError(
              reply,
              409,
              "OAUTH_NOT_CONNECTED",
              slotValidation.message,
            );

          case "SLOT_TAKEN":
            return sendError(
              reply,
              409,
              "SLOT_TAKEN",
              slotValidation.message,
            );

          case "SLOT_TOO_SOON":
            return sendError(
              reply,
              409,
              "SLOT_TOO_SOON",
              slotValidation.message,
            );

          case "SLOT_OUTSIDE_HOURS":
            return sendError(
              reply,
              409,
              "SLOT_OUTSIDE_HOURS",
              slotValidation.message,
            );

          case "GOOGLE_ERROR":
            return sendError(
              reply,
              502,
              "GOOGLE_ERROR",
              slotValidation.message,
            );

          case "INTERNAL_ERROR":
          default:
            return sendError(
              reply,
              500,
              "INTERNAL_ERROR",
              "The selected time could not be verified.",
            );
        }
      }

      const creationResult =
        await createDraftConsultationRecord({
          clientProfileId:
            authentication.profile.id,
          scheduledEndAt:
            slotValidation.endAt,
          draft: parsed.data,
        });

      if (!creationResult.ok) {
        if (
          creationResult.code ===
          "SLOT_TAKEN"
        ) {
          return sendError(
            reply,
            409,
            "SLOT_TAKEN",
            creationResult.message,
          );
        }

        return sendError(
          reply,
          500,
          "INTERNAL_ERROR",
          creationResult.message,
        );
      }

      return sendSuccess(reply, {
        consultation_id:
          creationResult.draft
            .consultationId,
        status:
          creationResult.draft.status,
        hold_expires_at:
          creationResult.draft
            .holdExpiresAt,
        price_cents:
          creationResult.draft.priceCents,
        currency:
          creationResult.draft.currency,
      });
    },
  );
};
