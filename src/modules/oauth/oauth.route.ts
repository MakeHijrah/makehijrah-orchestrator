import type {
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import { env } from "../../config/env.js";
import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { verifyOAuthState } from "../../lib/oauth-state.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import {
  createGoogleAuthorizationUrl,
  findMissingGoogleScopes,
} from "./google-oauth.js";
import { exchangeGoogleAuthorizationCode } from "./google-token.js";
import { saveGoogleConnection } from "./oauth.repository.js";

type ConsultantLookupResult =
  | {
      ok: true;
      consultantId: string;
    }
  | {
      ok: false;
      statusCode: 404 | 500;
      code: "NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    };

type GoogleCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
};

const getConsultantIdForProfile = async (
  request: FastifyRequest,
  profileId: string,
): Promise<ConsultantLookupResult> => {
  const { data: consultant, error } =
    await supabaseAdmin
      .from("consultants")
      .select("id")
      .eq("profile_id", profileId)
      .maybeSingle();

  if (error) {
    request.log.error(
      {
        consultantError: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
        profileId,
      },
      "Consultant lookup failed",
    );

    return {
      ok: false,
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Unable to load the consultant account.",
    };
  }

  if (!consultant) {
    return {
      ok: false,
      statusCode: 404,
      code: "NOT_FOUND",
      message: "Consultant account not found.",
    };
  }

  return {
    ok: true,
    consultantId: consultant.id,
  };
};

const createProfileRedirectUrl = (
  result: "connected" | "error",
  reason?: string,
): string => {
  const redirectUrl = new URL(
    "/consultant/profile",
    env.APP_URL,
  );

  redirectUrl.searchParams.set("google", result);

  /*
   * Kept as google=error so the existing profile screen still
   * shows a failure; the reason is additive, for a screen that
   * wants to say which permission was missing.
   */
  if (reason) {
    redirectUrl.searchParams.set("reason", reason);
  }

  return redirectUrl.toString();
};

export const registerOAuthRoutes = async (
  app: FastifyInstance,
): Promise<void> => {
  app.get(
    "/api/consultant/oauth-status",
    async (request, reply) => {
      const authentication = await requireRole(
        request,
        ["consultant"],
      );

      if (!authentication.ok) {
        return sendError(
          reply,
          authentication.statusCode,
          authentication.code,
          authentication.message,
        );
      }

      const consultantResult =
        await getConsultantIdForProfile(
          request,
          authentication.profile.id,
        );

      if (!consultantResult.ok) {
        return sendError(
          reply,
          consultantResult.statusCode,
          consultantResult.code,
          consultantResult.message,
        );
      }

      const { data: connection, error } =
        await supabaseAdmin
          .from("oauth_connections")
          .select("google_email")
          .eq(
            "consultant_id",
            consultantResult.consultantId,
          )
          .eq("provider", "google")
          .is("revoked_at", null)
          .maybeSingle();

      if (error) {
        request.log.error(
          {
            oauthError: {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            },
            consultantId:
              consultantResult.consultantId,
          },
          "Google OAuth status lookup failed",
        );

        return sendError(
          reply,
          500,
          "INTERNAL_ERROR",
          "Unable to check the Google connection.",
        );
      }

      if (!connection) {
        return sendSuccess(reply, {
          connected: false,
        });
      }

      return sendSuccess(reply, {
        connected: true,
        google_email: connection.google_email,
      });
    },
  );

  app.get(
    "/api/consultant/oauth/connect",
    async (request, reply) => {
      const authentication = await requireRole(
        request,
        ["consultant"],
      );

      if (!authentication.ok) {
        return sendError(
          reply,
          authentication.statusCode,
          authentication.code,
          authentication.message,
        );
      }

      const consultantResult =
        await getConsultantIdForProfile(
          request,
          authentication.profile.id,
        );

      if (!consultantResult.ok) {
        return sendError(
          reply,
          consultantResult.statusCode,
          consultantResult.code,
          consultantResult.message,
        );
      }

      const redirectUrl =
        createGoogleAuthorizationUrl(
          consultantResult.consultantId,
        );

      return sendSuccess(reply, {
        redirect_url: redirectUrl,
      });
    },
  );

  app.get(
    "/api/oauth/google/callback",
    async (request, reply) => {
      const query =
        request.query as GoogleCallbackQuery;

      const errorRedirect =
        createProfileRedirectUrl("error");

      if (query.error) {
        request.log.warn(
          {
            googleError: query.error,
            googleErrorDescription:
              query.error_description,
          },
          "Google OAuth authorization was denied",
        );

        return reply.redirect(errorRedirect);
      }

      if (!query.code || !query.state) {
        request.log.warn(
          "Google OAuth callback was missing code or state",
        );

        return reply.redirect(errorRedirect);
      }

      const state = verifyOAuthState(query.state);

      if (!state) {
        request.log.warn(
          "Google OAuth callback state was invalid or expired",
        );

        return reply.redirect(errorRedirect);
      }

      const { data: consultant, error: consultantError } =
        await supabaseAdmin
          .from("consultants")
          .select("id")
          .eq("id", state.consultant_id)
          .maybeSingle();

      if (consultantError || !consultant) {
        request.log.error(
          {
            consultantError:
              consultantError?.message,
            consultantId: state.consultant_id,
          },
          "OAuth callback consultant validation failed",
        );

        return reply.redirect(errorRedirect);
      }

      const exchangeResult =
        await exchangeGoogleAuthorizationCode(
          query.code,
        );

      if (!exchangeResult.ok) {
        request.log.error(
          {
            consultantId: consultant.id,
            message: exchangeResult.message,
          },
          "Google OAuth token exchange failed",
        );

        return reply.redirect(errorRedirect);
      }

      /*
       * Refuse a grant that cannot do the job.
       *
       * Google lets a consultant untick the calendar permission
       * and still complete the flow. Saving that grant produces a
       * connection which looks healthy everywhere — the row
       * exists, the refresh token works — and fails only when it
       * is used to create the calendar event, which happens AFTER
       * the client's payment has been captured.
       *
       * Nothing is saved when a scope is missing, so a consultant
       * who already has a good grant and re-runs the flow badly
       * keeps the good one rather than overwriting it.
       */
      const missingScopes = findMissingGoogleScopes(
        exchangeResult.scopes,
      );

      if (missingScopes.length > 0) {
        request.log.error(
          {
            consultantId: consultant.id,
            missingScopes,
            grantedScopes:
              exchangeResult.scopes,
          },
          "Google OAuth grant is missing required calendar scopes",
        );

        return reply.redirect(
          createProfileRedirectUrl(
            "error",
            "missing_calendar_permission",
          ),
        );
      }

      const saveResult = await saveGoogleConnection({
        consultantId: consultant.id,
        refreshToken:
          exchangeResult.refreshToken,
        googleEmail: exchangeResult.googleEmail,
        scopes: exchangeResult.scopes,
      });

      if (!saveResult.ok) {
        request.log.error(
          {
            consultantId: consultant.id,
            message: saveResult.message,
          },
          "Google OAuth connection save failed",
        );

        return reply.redirect(errorRedirect);
      }

      return reply.redirect(
        createProfileRedirectUrl("connected"),
      );
    },
  );
};
