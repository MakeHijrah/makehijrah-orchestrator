import type { FastifyInstance } from "fastify";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import {
  applySettingsUpdate,
  applyStripeModeUpdate,
  readAdminSettings,
  readPublicSettings,
} from "./settings.service.js";
import {
  updateSettingsSchema,
  updateStripeModeSchema,
} from "./settings.schema.js";

/*
 * Settings endpoints. PROJECT_LOCK Amendment 007 section 6.
 *
 * Four explicit endpoints. There is deliberately no generic
 * settings writer accepting arbitrary keys.
 */

export const registerSettingsRoutes =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    /*
     * Public booking price, currency and duration. No
     * authentication. Rate limited following the convention used
     * by the other public routes.
     */
    app.get(
      "/api/public/settings",
      {
        config: {
          rateLimit: {
            max: 60,
            timeWindow: "1 minute",
          },
        },
      },
      async (_request, reply) => {
        const result =
          await readPublicSettings();

        if (!result.ok) {
          return sendError(
            reply,
            500,
            "INTERNAL_ERROR",
            result.message,
          );
        }

        return sendSuccess(
          reply,
          result.data,
        );
      },
    );

    app.get(
      "/api/admin/settings",
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

        const result =
          await readAdminSettings();

        if (!result.ok) {
          return sendError(
            reply,
            500,
            "INTERNAL_ERROR",
            result.message,
          );
        }

        return sendSuccess(
          reply,
          result.data,
        );
      },
    );

    app.patch(
      "/api/admin/settings",
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
          updateSettingsSchema.safeParse(
            request.body ?? {},
          );

        if (!parsed.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The settings update request is invalid.",
            parsed.error.flatten(),
          );
        }

        const result =
          await applySettingsUpdate({
            input: parsed.data,
            adminProfileId:
              authentication.profile
                .id,
          });

        if (!result.ok) {
          return sendError(
            reply,
            500,
            "INTERNAL_ERROR",
            result.message,
          );
        }

        return sendSuccess(
          reply,
          result.data,
        );
      },
    );

    app.patch(
      "/api/admin/settings/stripe-mode",
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
          updateStripeModeSchema.safeParse(
            request.body ?? {},
          );

        if (!parsed.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The Stripe mode update request is invalid.",
            parsed.error.flatten(),
          );
        }

        const result =
          await applyStripeModeUpdate({
            input: parsed.data,
            adminProfileId:
              authentication.profile
                .id,
          });

        if (!result.ok) {
          switch (result.code) {
            case "STRIPE_MODE_NOT_CONFIGURED":
            case "LIVE_MODE_CONFIRMATION_REQUIRED":
              return sendError(
                reply,
                409,
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

        return sendSuccess(
          reply,
          result.data,
        );
      },
    );
  };
