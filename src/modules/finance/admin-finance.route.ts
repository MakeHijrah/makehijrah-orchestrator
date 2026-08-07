import type { FastifyInstance } from "fastify";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { recordAdminAdjustment } from "./finance.service.js";
import {
  adjustmentSchema,
  payoutDecisionSchema,
  payoutPaidSchema,
  payoutParamsSchema,
} from "./finance.schema.js";
import {
  decidePayoutAsAdmin,
  markPayoutPaidAsAdmin,
} from "./payout.service.js";

/*
 * Admin finance endpoints.
 *
 * Every one of them is admin-only at the route and admin-only
 * again inside the RPC, which re-checks the profile's role
 * against the database. That duplication is deliberate: the
 * route guard protects the endpoint, and the RPC check protects
 * the ledger from any future caller that forgets one.
 */

const statusForCode = (
  code:
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "CONFLICT"
    | "VALIDATION_ERROR"
    | "INTERNAL_ERROR",
): number => {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
      return 403;
    case "CONFLICT":
      return 409;
    case "VALIDATION_ERROR":
      return 400;
    case "INTERNAL_ERROR":
    default:
      return 500;
  }
};

export const registerAdminFinanceRoutes =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    /*
     * POST /api/admin/finance/adjustments
     *
     * A signed correction against one consultant's ledger. The
     * memo and the admin's identity are both required and both
     * stored on the entry, so no adjustment is ever anonymous.
     */
    app.post(
      "/api/admin/finance/adjustments",
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

        const parsedBody =
          adjustmentSchema.safeParse(
            request.body ?? {},
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The adjustment is invalid.",
            parsedBody.error.flatten(),
          );
        }

        const result =
          await recordAdminAdjustment({
            consultantId:
              parsedBody.data.consultant_id,
            amountMinor:
              parsedBody.data.amount_minor,
            currency:
              parsedBody.data.currency,
            memo: parsedBody.data.memo,
            adminProfileId:
              authentication.profile.id,
          });

        if (!result.ok) {
          return sendError(
            reply,
            statusForCode(result.code),
            result.code,
            result.message,
          );
        }

        return sendSuccess(
          reply,
          {
            entry_id:
              result.adjustment.entry_id,
            consultant_id:
              result.adjustment
                .consultant_id,
            amount_minor:
              result.adjustment
                .consultant_amount_minor,
            currency:
              result.adjustment.currency,
            memo: result.adjustment.memo,
            available_at:
              result.adjustment
                .available_at,
            created_at:
              result.adjustment.created_at,
          },
          201,
        );
      },
    );

    /*
     * approve / reject / cancel share one handler because they
     * differ only in the decision passed through. Registering
     * them separately would triple the guard and validation code
     * for no behavioural difference.
     */
    for (const decision of [
      "approve",
      "reject",
      "cancel",
    ] as const) {
      app.post(
        `/api/admin/payouts/:id/${decision}`,
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
            payoutParamsSchema.safeParse(
              request.params,
            );

          if (!parsedParams.success) {
            return sendError(
              reply,
              400,
              "VALIDATION_ERROR",
              "The payout ID is invalid.",
              parsedParams.error.flatten(),
            );
          }

          const parsedBody =
            payoutDecisionSchema.safeParse(
              request.body ?? {},
            );

          if (!parsedBody.success) {
            return sendError(
              reply,
              400,
              "VALIDATION_ERROR",
              "The payout decision is invalid.",
              parsedBody.error.flatten(),
            );
          }

          const result =
            await decidePayoutAsAdmin({
              payoutId:
                parsedParams.data.id,
              decision,
              adminProfileId:
                authentication.profile.id,
              note: parsedBody.data.note,
            });

          if (!result.ok) {
            return sendError(
              reply,
              statusForCode(result.code),
              result.code,
              result.message,
            );
          }

          return sendSuccess(reply, {
            payout_id:
              result.payout.payout_id,
            status: result.payout.status,
            currency:
              result.payout.currency,
            requested_amount_minor:
              result.payout
                .requested_amount_minor,
            released_entry_count:
              result.payout
                .released_entry_count,
            approved_at:
              result.payout.approved_at,
            rejected_at:
              result.payout.rejected_at,
            cancelled_at:
              result.payout.cancelled_at,
          });
        },
      );
    }

    /*
     * POST /api/admin/payouts/:id/paid
     *
     * V1 payouts are paid by hand, outside the system, so this
     * records what happened rather than causing it. The external
     * reference is the only link back to the transfer.
     */
    app.post(
      "/api/admin/payouts/:id/paid",
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
          payoutParamsSchema.safeParse(
            request.params,
          );

        if (!parsedParams.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The payout ID is invalid.",
            parsedParams.error.flatten(),
          );
        }

        const parsedBody =
          payoutPaidSchema.safeParse(
            request.body ?? {},
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The payout payment record is invalid.",
            parsedBody.error.flatten(),
          );
        }

        const result =
          await markPayoutPaidAsAdmin({
            payoutId: parsedParams.data.id,
            paidAmountMinor:
              parsedBody.data
                .paid_amount_minor,
            externalReference:
              parsedBody.data
                .external_reference,
            adminProfileId:
              authentication.profile.id,
            paidAt:
              parsedBody.data.paid_at,
            note: parsedBody.data.note,
          });

        if (!result.ok) {
          return sendError(
            reply,
            statusForCode(result.code),
            result.code,
            result.message,
          );
        }

        return sendSuccess(reply, {
          payout_id:
            result.payout.payout_id,
          status: result.payout.status,
          currency: result.payout.currency,
          requested_amount_minor:
            result.payout
              .requested_amount_minor,
          paid_amount_minor:
            result.payout.paid_amount_minor,
          paid_at: result.payout.paid_at,
          external_reference:
            result.payout
              .external_reference,
        });
      },
    );
  };
