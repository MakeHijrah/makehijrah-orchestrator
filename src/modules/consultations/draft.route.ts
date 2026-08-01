import type { FastifyInstance } from "fastify";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { resolveBookingClient } from "./booking-client.service.js";
import { createCheckoutCapability } from "./checkout-capability.service.js";
import {
  validateDraftConsultantGender,
} from "./draft-gender-validation.js";
import { validateDraftSlot } from "./draft-availability.js";
import { createDraftConsultationRecord } from "./draft.repository.js";
import { createDraftConsultationSchema } from "./draft.schema.js";
import {
  getSettings,
  SettingsUnavailableError,
} from "../settings/settings.provider.js";

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

      /*
       * Settings are loaded once per request and reused for slot
       * duration and for the price snapshot, so both come from the
       * same read. Amendment 007 sections 4.1 and 8.5.
       *
       * Fails closed: a booking must never be created at a guessed
       * price.
       */
      let settings;

      try {
        settings = await getSettings();
      } catch (error) {
        request.log.error(
          {
            message:
              error instanceof
              SettingsUnavailableError
                ? error.message
                : "Unknown settings error",
          },
          "Draft consultation settings lookup failed",
        );

        return sendError(
          reply,
          500,
          "INTERNAL_ERROR",
          "The consultation could not be created.",
        );
      }

      const genderValidation =
        await validateDraftConsultantGender({
          consultantId:
            parsed.data.consultant_id,
          preferredConsultantGender:
            parsed.data.intake.answers
              .preferred_consultant_gender,
        });

      if (!genderValidation.ok) {
        if (
          genderValidation.code ===
          "NOT_FOUND"
        ) {
          return sendError(
            reply,
            404,
            "NOT_FOUND",
            genderValidation.message,
          );
        }

        if (
          genderValidation.code ===
          "VALIDATION_ERROR"
        ) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            genderValidation.message,
          );
        }

        return sendError(
          reply,
          500,
          "INTERNAL_ERROR",
          "The selected consultant could not be verified.",
        );
      }

      const slotValidation =
        await validateDraftSlot({
          consultantId:
            parsed.data.consultant_id,
          startAt: parsed.data.start_at,
          durationMinutes:
            settings.consultation_duration_minutes,
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

      const clientResult =
        await resolveBookingClient({
          email: parsed.data.intake.email,
          fullName:
            parsed.data.intake.full_name,
          phoneWhatsapp:
            parsed.data.intake
              .phone_whatsapp,
        });

      if (!clientResult.ok) {
        request.log.error(
          {
            code: clientResult.code,
            consultantId:
              parsed.data.consultant_id,
            startAt: parsed.data.start_at,
          },
          "Public booking client resolution failed",
        );

        return sendError(
          reply,
          500,
          "INTERNAL_ERROR",
          "The booking account could not be prepared.",
        );
      }

      const creationResult =
        await createDraftConsultationRecord({
          clientProfileId:
            clientResult.profileId,
          scheduledEndAt:
            slotValidation.endAt,
          priceCents:
            settings.consultation_price_cents,
          currency:
            settings.consultation_currency,
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

      const capabilityResult =
        await createCheckoutCapability({
          consultationId:
            creationResult.draft
              .consultationId,
          holdExpiresAt:
            creationResult.draft
              .holdExpiresAt,
        });

      if (!capabilityResult.ok) {
        request.log.error(
          {
            consultationId:
              creationResult.draft
                .consultationId,
            code: capabilityResult.code,
          },
          "Checkout capability creation failed",
        );

        return sendError(
          reply,
          500,
          "INTERNAL_ERROR",
          "The booking could not be prepared for payment.",
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
        checkout_token:
          capabilityResult.token,
      });
    },
  );
};
