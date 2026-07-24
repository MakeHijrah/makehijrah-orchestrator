import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { completeConsultation } from "./completion.service.js";

const completionParamsSchema = z.object({
  id: z.string().uuid(),
});

const getConsultantIdForProfile = async (
  profileId: string,
): Promise<
  | {
      ok: true;
      consultantId: string;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    }
> => {
  const { data, error } =
    await supabaseAdmin
      .from("consultants")
      .select("id")
      .eq("profile_id", profileId)
      .maybeSingle();

  if (error) {
    console.error(
      "Completion consultant lookup failed",
      {
        profileId,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The consultant account could not be loaded.",
    };
  }

  if (!data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "The consultant account was not found.",
    };
  }

  return {
    ok: true,
    consultantId:
      (
        data as unknown as {
          id: string;
        }
      ).id,
  };
};

export const registerCompletionRoute = async (
  app: FastifyInstance,
): Promise<void> => {
  app.post(
    "/api/consultations/:id/complete",
    async (request, reply) => {
      const authentication =
        await requireRole(
          request,
          [
            "consultant",
            "admin",
          ],
        );

      if (!authentication.ok) {
        return sendError(
          reply,
          authentication.statusCode,
          authentication.code,
          authentication.message,
        );
      }

      const parsedParams =
        completionParamsSchema.safeParse(
          request.params,
        );

      if (!parsedParams.success) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "The consultation ID is invalid.",
          parsedParams.error.flatten(),
        );
      }

      const isAdmin =
        authentication.profile.role ===
        "admin";

      let consultantId:
        | string
        | null = null;

      if (!isAdmin) {
        const consultantResult =
          await getConsultantIdForProfile(
            authentication.profile.id,
          );

        if (!consultantResult.ok) {
          return sendError(
            reply,
            consultantResult.code ===
              "NOT_FOUND"
              ? 404
              : 500,
            consultantResult.code,
            consultantResult.message,
          );
        }

        consultantId =
          consultantResult.consultantId;
      }

      const result =
        await completeConsultation({
          consultationId:
            parsedParams.data.id,
          consultantId,
          isAdmin,
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

          case "FORBIDDEN":
            return sendError(
              reply,
              403,
              result.code,
              result.message,
            );

          case "INVALID_TRANSITION":
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

      return sendSuccess(reply, {
        consultation_id:
          result.consultationId,
        status:
          result.status,
        completed_at:
          result.completedAt,
      });
    },
  );
};
