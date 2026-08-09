import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import {
  disableDirectBookingAsAdmin,
  getAdminDirectBookingSettings,
  getOwnDirectBookingSettings,
  getPublicConsultantBySlug,
  updateOwnDirectBookingSettings,
  type DirectBookingSettingsResult,
} from "./direct-booking.service.js";
import { SLUG_MAX_LENGTH } from "./direct-booking.slug.js";

const slugParamsSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    /*
     * Generous on the way in, because the service normalizes.
     * A little longer than the stored maximum so "Aïsha Rahman"
     * still reaches the normalizer rather than being rejected for
     * a length it will not have once normalized.
     */
    .max(SLUG_MAX_LENGTH * 2),
});

const consultantIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/*
 * The consultant's own settings. STRICT, and the strictness is the
 * security control.
 *
 * Three fields, all of them the consultant's to set. Anything else
 * — a consultant id, a commission rate, a split, an earnings
 * figure, a booking_source — is rejected by .strict() rather than
 * ignored, so an attempt to send one fails loudly instead of
 * silently doing nothing and looking like it worked.
 */
const updateSettingsSchema = z
  .object({
    consultant_slug: z
      .union([
        z.string().trim().min(1).max(SLUG_MAX_LENGTH * 2),
        z.null(),
      ])
      .optional(),

    direct_booking_enabled: z
      .boolean()
      .optional(),

    direct_booking_price_cents: z
      .union([
        z
          .number()
          .int()
          .min(100)
          .max(1_000_000),
        z.null(),
      ])
      .optional(),
  })
  .strict();

const sendSettingsResult = (
  reply: Parameters<typeof sendSuccess>[0],
  result: DirectBookingSettingsResult,
): ReturnType<typeof sendSuccess> => {
  if (result.ok) {
    return sendSuccess(reply, {
      direct_booking: result.settings,
    });
  }

  const details = result.reason
    ? { reason: result.reason }
    : undefined;

  switch (result.code) {
    case "NOT_FOUND":
      return sendError(
        reply,
        404,
        "NOT_FOUND",
        result.message,
        details,
      );

    case "VALIDATION_ERROR":
      return sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        result.message,
        details,
      );

    case "CONFLICT":
      return sendError(
        reply,
        409,
        "CONFLICT",
        result.message,
        details,
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
};

export const registerDirectBookingRoutes = async (
  app: FastifyInstance,
): Promise<void> => {
  /*
   * The public booking page. No authentication, by design: this is
   * the page a consultant shares.
   *
   * Rate limited more generously than the draft endpoint — it is a
   * page load, not a booking — but limited all the same, because
   * an unlimited slug lookup is a way to enumerate who has a page.
   */
  app.get(
    "/api/public/consultants/:slug",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const params =
        slugParamsSchema.safeParse(
          request.params,
        );

      if (!params.success) {
        return sendError(
          reply,
          404,
          "NOT_FOUND",
          "No booking page was found at that link.",
        );
      }

      const result =
        await getPublicConsultantBySlug(
          params.data.slug,
        );

      if (!result.ok) {
        return sendError(
          reply,
          result.code === "NOT_FOUND"
            ? 404
            : 500,
          result.code,
          result.message,
        );
      }

      return sendSuccess(reply, {
        consultant: result.consultant,
      });
    },
  );

  app.get(
    "/api/consultant/direct-booking",
    async (request, reply) => {
      const authentication =
        await requireRole(request, [
          "consultant",
        ]);

      if (!authentication.ok) {
        return sendError(
          reply,
          authentication.statusCode,
          authentication.code,
          authentication.message,
        );
      }

      return sendSettingsResult(
        reply,
        await getOwnDirectBookingSettings(
          authentication.profile.id,
        ),
      );
    },
  );

  app.patch(
    "/api/consultant/direct-booking",
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
          "consultant",
        ]);

      if (!authentication.ok) {
        return sendError(
          reply,
          authentication.statusCode,
          authentication.code,
          authentication.message,
        );
      }

      const parsed =
        updateSettingsSchema.safeParse(
          request.body,
        );

      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "Those booking page settings are not valid.",
          parsed.error.flatten(),
        );
      }

      /*
       * The profile id comes from the verified token. It is the
       * only identity this call has, which is what makes "own
       * settings only" structural.
       */
      return sendSettingsResult(
        reply,
        await updateOwnDirectBookingSettings(
          {
            profileId:
              authentication.profile.id,
            input: parsed.data,
          },
        ),
      );
    },
  );

  /*
   * Admin. Part of the existing consultant management surface —
   * same /api/admin/consultants/:id prefix as activate and
   * deactivate — rather than a new admin area.
   */
  app.get(
    "/api/admin/consultants/:id/direct-booking",
    async (request, reply) => {
      const authentication =
        await requireRole(request, [
          "admin",
        ]);

      if (!authentication.ok) {
        return sendError(
          reply,
          authentication.statusCode,
          authentication.code,
          authentication.message,
        );
      }

      const params =
        consultantIdParamsSchema.safeParse(
          request.params,
        );

      if (!params.success) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "A valid consultant identifier is required.",
        );
      }

      return sendSettingsResult(
        reply,
        await getAdminDirectBookingSettings(
          params.data.id,
        ),
      );
    },
  );

  app.post(
    "/api/admin/consultants/:id/direct-booking/disable",
    async (request, reply) => {
      const authentication =
        await requireRole(request, [
          "admin",
        ]);

      if (!authentication.ok) {
        return sendError(
          reply,
          authentication.statusCode,
          authentication.code,
          authentication.message,
        );
      }

      const params =
        consultantIdParamsSchema.safeParse(
          request.params,
        );

      if (!params.success) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "A valid consultant identifier is required.",
        );
      }

      return sendSettingsResult(
        reply,
        await disableDirectBookingAsAdmin(
          params.data.id,
        ),
      );
    },
  );
};
