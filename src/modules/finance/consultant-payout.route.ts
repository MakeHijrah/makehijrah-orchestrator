import type { FastifyInstance } from "fastify";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { payoutRequestSchema } from "./finance.schema.js";
import { requestPayoutForProfile } from "./payout.service.js";

/*
 * POST /api/consultant/payouts
 *
 * The consultant requests payment of their available balance in
 * one currency. The consultant is taken from the bearer token,
 * never from the body, so a consultant cannot request against
 * another consultant's balance: there is no field in which to
 * name one. Admins are not accepted here either — this is the
 * consultant's own action, and an admin acting for a consultant
 * is a different feature with different auditing.
 *
 * The whole available balance is requested. There is no amount
 * field for the same reason there is no consultant field.
 */
export const registerConsultantPayoutRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/consultant/payouts",
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

        const parsedBody =
          payoutRequestSchema.safeParse(
            request.body ?? {},
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The payout request is invalid.",
            parsedBody.error.flatten(),
          );
        }

        const result =
          await requestPayoutForProfile({
            profileId:
              authentication.profile.id,
            currency:
              parsedBody.data.currency,
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

            case "VALIDATION_ERROR":
              return sendError(
                reply,
                400,
                result.code,
                result.message,
              );

            case "CONFLICT":
            /*
             * Also 409: the request is well formed and the
             * consultant's account is simply not ready. The code
             * is distinct so the dialog can link straight to the
             * payout method section instead of parsing a message.
             */
            case "PAYOUT_METHOD_MISSING":
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
          {
            payout_id:
              result.payout.payout_id,
            payout_reference:
              result.payout.payout_reference,
            status: result.payout.status,
            currency:
              result.payout.currency,
            requested_amount_minor:
              result.payout
                .requested_amount_minor,
            entry_count:
              result.payout.entry_count,
            requested_at:
              result.payout.requested_at,
            /*
             * Migration 039. The destination the database
             * snapshotted onto this payout, so the consultant is
             * shown where the money is going by the same response
             * that confirms the request.
             */
            destination_note:
              result.payout.destination_note,
          },
          201,
        );
      },
    );
  };
