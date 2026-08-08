import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { refundServicePurchaseAsAdmin } from "./admin-service-refund.service.js";
import { fulfillServicePurchase } from "./service-purchase.repository.js";

const paramsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/*
 * The refund request, and what it deliberately cannot carry.
 *
 * A discriminated union of exactly two shapes, both .strict(), so
 * payment_intent_id, charge_id, stripe_invoice_id,
 * client_profile_id, consultant_id, service_id, currency,
 * commission, a ledger amount, a success URL and arbitrary
 * metadata are not merely ignored — there is no field for any of
 * them and an attempt to send one is a 400.
 *
 * amount_minor is an INTEGER in minor units. No decimal or
 * floating-point currency value crosses this boundary; converting
 * "5.00" to 500 is the caller's job, done by string manipulation
 * rather than multiplication.
 */
const refundBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("full") }).strict(),
  z
    .object({
      type: z.literal("partial"),
      amount_minor: z.number().int().positive(),
    })
    .strict(),
]);

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

    /*
     * POST /api/admin/service-purchases/:id/refund — admin
     *
     * INITIATES a Stripe refund and records no accounting. It does
     * not move refunded_amount_minor, does not set a status, and
     * creates no ledger reversal: charge.refunded remains the sole
     * financial recorder, exactly as it was before this button
     * existed. A test asserts zero finance RPCs are called from
     * here.
     *
     * Everything trusted — the PaymentIntent, the Stripe mode, the
     * gross, the amount already refunded, the service and the
     * client — is read from the purchase by id.
     */
    app.post(
      "/api/admin/service-purchases/:id/refund",
      {
        config: {
          rateLimit: {
            max: 30,
            timeWindow: "1 minute",
          },
        },
      },
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

        const parsedBody =
          refundBodySchema.safeParse(
            request.body ?? {},
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The refund request is invalid.",
            parsedBody.error.flatten(),
          );
        }

        const result =
          await refundServicePurchaseAsAdmin({
            purchaseId: parsedParams.data.id,
            intent:
              parsedBody.data.type === "full"
                ? { type: "full" }
                : {
                    type: "partial",
                    amountMinor:
                      parsedBody.data.amount_minor,
                  },
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
            case "STRIPE_MODE_NOT_CONFIGURED":
            case "CONFLICT":
              return sendError(
                reply,
                409,
                result.code,
                result.message,
              );

            case "STRIPE_ERROR":
              return sendError(
                reply,
                502,
                result.code,
                result.message,
              );

            default:
              return sendError(
                reply,
                500,
                "INTERNAL_ERROR",
                result.message,
              );
          }
        }

        /*
         * Submission information only. Deliberately no status and
         * no refunded total: the row has not changed yet, and
         * returning either would let the UI render a refund that
         * MakeHijrah has not recorded.
         */
        return sendSuccess(reply, {
          purchase_id: result.purchaseId,
          refund_submitted: true,
          amount_minor: result.amountMinor,
          currency: result.currency,
          stripe_refund_id: result.stripeRefundId,
        });
      },
    );
  };
