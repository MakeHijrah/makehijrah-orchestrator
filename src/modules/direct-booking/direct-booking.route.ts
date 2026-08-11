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
  updateDirectBookingAsAdmin,
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
 * ONE field. Amendment 013 settled the ownership split: a
 * consultant sets what they charge for their own time, and an
 * administrator manages the booking link and whether the page is
 * live — both of which publish something under the platform's own
 * domain.
 *
 * consultant_slug and direct_booking_enabled are therefore absent,
 * and because the schema is strict a client sending either gets a
 * 400 rather than a silent no-op. That is the right answer for
 * fields that used to work: a save that appeared to succeed and
 * changed nothing is worse than one that failed.
 *
 * A consultant may still READ both, and their booking URL, from
 * the GET.
 *
 * Everything else — a consultant id, a commission rate, a split, an
 * earnings figure, a booking_source — is refused for the same
 * reason it always was.
 */
const updateSettingsSchema = z
  .object({
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

/*
 * The administrator's write. Strict, and exactly the two settings
 * an administrator owns. Amendment 013.
 *
 * direct_booking_price_cents is ABSENT, and that is the point: an
 * admin who could set a consultant's price could set what that
 * consultant earns, and through the effective price rule what a
 * client is charged. Sending it is a 400, not a silent no-op.
 *
 * At least one field must be present. A body that asks for nothing
 * is a mistake somewhere, and answering 200 to it would hide the
 * mistake behind a success.
 */
const adminUpdateSchema = z
  .object({
    consultant_slug: z
      .string()
      .trim()
      .min(1)
      .max(SLUG_MAX_LENGTH * 2)
      .optional(),

    direct_booking_enabled: z
      .boolean()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.consultant_slug !== undefined ||
      value.direct_booking_enabled !==
        undefined,
    {
      message:
        "Provide a booking link or an enabled state to change.",
    },
  );

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

  app.patch(
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

      const parsed =
        adminUpdateSchema.safeParse(
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
       * Straight through to the same service the consultant's own
       * update uses. Normalization, the reserved set, format,
       * length, uniqueness and every publish precondition are
       * settled in one place; a raw unique-violation never reaches
       * HTTP, and an admin enabling a page is held to exactly the
       * preconditions a consultant was.
       */
      return sendSettingsResult(
        reply,
        await updateDirectBookingAsAdmin({
          consultantId: params.data.id,
          input: parsed.data,
        }),
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
