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
import { getPublicConsultantBySlug } from "../direct-booking/direct-booking.service.js";

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

      /*
       * WHICH CONSULTANT, AT WHAT PRICE, FROM WHICH SOURCE.
       *
       * All three are decided HERE, on the server, before anything
       * else happens. Everything downstream — eligibility, the
       * slot, the draft row, checkout — uses these values and
       * never re-reads the request body for them.
       *
       * For a direct booking the slug is the ONLY consultant
       * identifier consulted. The schema has already refused a
       * request carrying both a slug and an id, so there is no
       * browser-supplied id here to prefer or to compare against;
       * the consultant is whoever the published page belongs to.
       *
       * The price is the EFFECTIVE direct price, from the same
       * function the public page displays. That is what makes the
       * quoted price and the charged price the same number by
       * construction rather than by two call sites agreeing.
       */
      let consultantId: string;
      let priceCents: number;
      let bookingSource:
        | "standard"
        | "direct_booking";

      if (parsed.data.consultant_slug) {
        const page =
          await getPublicConsultantBySlug(
            parsed.data.consultant_slug,
          );

        if (!page.ok) {
          /*
           * An unpublished, deactivated or unknown page is a 404,
           * exactly as the page itself is. A booking cannot be
           * started against a page a visitor could not have seen.
           */
          return sendError(
            reply,
            page.code === "NOT_FOUND"
              ? 404
              : 500,
            page.code,
            page.message,
          );
        }

        consultantId =
          page.consultant.consultant_id;

        priceCents =
          page.consultant
            .effective_direct_booking_price_cents;

        bookingSource = "direct_booking";
      } else {
        consultantId =
          parsed.data.consultant_id!;

        priceCents =
          settings.consultation_price_cents;

        bookingSource = "standard";
      }

      /*
       * Consultant eligibility, including destination capability,
       * is settled here - before slot validation, before the
       * booking client is resolved, before the draft row exists
       * and before any checkout capability is issued. A rejected
       * request therefore produces no external side effect.
       */
      const genderValidation =
        await validateDraftConsultantGender({
          consultantId,
          countryId:
            parsed.data.country_id,
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
            genderValidation.reason
              ? {
                  reason:
                    genderValidation.reason,
                }
              : undefined,
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
          consultantId,
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
            consultantId,
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
          consultantId,
          priceCents,
          bookingSource,
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
