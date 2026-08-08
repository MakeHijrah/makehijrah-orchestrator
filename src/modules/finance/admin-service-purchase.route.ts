import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { fulfillServicePurchase } from "./service-purchase.repository.js";

const paramsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/*
 * POST /api/admin/service-purchases/:id/fulfill — admin
 *
 * The financial fulfilment act, and the only thing that turns a
 * service earning from pending into available.
 *
 * It is an endpoint rather than an RLS write because
 * service_purchases has no write policy and never will: every
 * finance table in this system is written by RPC only. It is
 * separate from marking the service_request completed because
 * those are genuinely different facts — the request is the
 * operational record an admin drives from the browser, and a
 * status an ordinary browser write can move must never be the
 * thing that releases money.
 *
 * Each renewal of a recurring service is fulfilled individually.
 * Paying for a month does not deliver it.
 */
export const registerAdminServicePurchaseRoutes =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/admin/service-purchases/:id/fulfill",
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

        const parsedParams =
          paramsSchema.safeParse(
            request.params ?? {},
          );

        if (!parsedParams.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The service purchase id is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const result =
          await fulfillServicePurchase({
            purchaseId: parsedParams.data.id,
            adminProfileId:
              authentication.profile.id,
          });

        if (!result.ok) {
          switch (result.marker) {
            case "FINANCE_PURCHASE_NOT_FOUND":
              return sendError(
                reply,
                404,
                "NOT_FOUND",
                "The service purchase was not found.",
              );

            case "FINANCE_ADMIN_REQUIRED":
              return sendError(
                reply,
                403,
                "FORBIDDEN",
                "Only an admin may fulfil a service purchase.",
              );

            case "FINANCE_PURCHASE_NOT_FULFILLABLE":
              return sendError(
                reply,
                409,
                "INVALID_TRANSITION",
                "Only a paid purchase may be fulfilled.",
              );

            default:
              return sendError(
                reply,
                500,
                "INTERNAL_ERROR",
                "The service purchase could not be fulfilled.",
              );
          }
        }

        return sendSuccess(reply, {
          purchase_id: result.row.purchase_id,
          status: result.row.status,
          fulfilled_at: result.row.fulfilled_at,
          /*
           * released is false on a second call and on a purchase
           * that never earned anything. reason says which, so a
           * double click reads as "already_fulfilled" rather than
           * as a silent success that changed nothing.
           */
          released: result.row.released,
          reason: result.row.reason,
          entry_id: result.row.entry_id,
          available_at: result.row.available_at,
        });
      },
    );
  };
