import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { inviteBlogManager } from "./blog-manager-invite.service.js";

const bodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(3)
      .max(320),
    note: z
      .string()
      .trim()
      .max(2_000)
      .nullable()
      .optional()
      .transform(
        (value) => value || null,
      ),
  })
  .strict();

export const registerBlogManagerInviteRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.post(
      "/api/admin/blog-managers/invite",
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

        const parsedBody =
          bodySchema.safeParse(
            request.body,
          );

        if (!parsedBody.success) {
          return sendError(
            reply,
            400,
            "VALIDATION_ERROR",
            "The invitation details are invalid.",
            {
              reason: "invalid_body",
            },
          );
        }

        const result =
          await inviteBlogManager({
            email:
              parsedBody.data.email,
            note:
              parsedBody.data.note,
            adminProfileId:
              authentication.profile
                .id,
          });

        if (!result.ok) {
          /*
           * result.message is written in this repo, never taken
           * from Supabase or Postgres: the service logs the
           * driver's text and returns its own wording, so no
           * SQLSTATE or database prose can reach a client.
           */
          return sendError(
            reply,
            result.code ===
              "VALIDATION_ERROR"
              ? 400
              : 500,
            result.code,
            result.message,
            {
              reason: result.reason,
            },
          );
        }

        return sendSuccess(reply, {
          blog_manager: result.grant,
        });
      },
    );
  };
