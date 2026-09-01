import { env } from "../../config/env.js";
import { decryptOAuthToken } from "../../lib/oauth-token-crypto.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { findMissingScopes } from "./google-oauth.js";

const GOOGLE_TOKEN_ENDPOINT =
  "https://oauth2.googleapis.com/token";

type GoogleRefreshResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type GoogleAccessTokenResult =
  | {
      ok: true;
      accessToken: string;
      expiresInSeconds: number;
    }
  | {
      ok: false;
      code:
        | "OAUTH_NOT_CONNECTED"
        | "OAUTH_REVOKED"
        | "OAUTH_INSUFFICIENT_SCOPE"
        | "INTERNAL_ERROR";
      message: string;
    };

export const getGoogleAccessToken = async (
  consultantId: string,
  /*
   * Scopes this particular call needs. Defaults to none, so every
   * existing caller behaves exactly as it did before.
   */
  requiredScopes: readonly string[] = [],
): Promise<GoogleAccessTokenResult> => {
  const { data: connection, error: connectionError } =
    await supabaseAdmin
      .from("oauth_connections")
      .select(
        "encrypted_refresh_token, revoked_at, scopes",
      )
      .eq("consultant_id", consultantId)
      .eq("provider", "google")
      .maybeSingle();

  if (connectionError) {
    console.error("Google OAuth connection lookup failed:", {
      code: connectionError.code,
      message: connectionError.message,
      details: connectionError.details,
      hint: connectionError.hint,
    });

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "Unable to load the Google Calendar connection.",
    };
  }

  if (!connection) {
    return {
      ok: false,
      code: "OAUTH_NOT_CONNECTED",
      message:
        "The consultant has not connected Google Calendar.",
    };
  }

  if (connection.revoked_at) {
    return {
      ok: false,
      code: "OAUTH_REVOKED",
      message:
        "The consultant's Google Calendar connection has been revoked.",
    };
  }

  /*
   * A connected grant that cannot do the job the caller needs.
   *
   * Google presents its scopes as individual checkboxes, so a
   * consultant can complete the flow having unticked one and still
   * look connected everywhere — the row exists, it is not revoked,
   * the refresh token works. The failure surfaces only when the
   * token is used, which for event creation is AFTER the client's
   * payment has been captured.
   *
   * Required scopes are per-operation, not global: a grant with
   * calendar.events.freebusy but not calendar.events can still
   * answer availability perfectly well, and refusing it outright
   * would break a consultant's calendar for no reason. Callers ask
   * for what they actually need.
   *
   * Only enforced when scopes were recorded. An empty column means
   * the grant is unknown, not known-bad.
   */
  const grantedScopes =
    (connection.scopes as string[] | null) ?? [];

  if (
    requiredScopes.length > 0 &&
    grantedScopes.length > 0
  ) {
    const missingScopes =
      findMissingScopes(
        grantedScopes,
        requiredScopes,
      );

    if (missingScopes.length > 0) {
      console.error(
        "Google connection is missing a scope the caller requires",
        {
          consultantId,
          missingScopes,
          grantedScopes,
        },
      );

      return {
        ok: false,
        code: "OAUTH_INSUFFICIENT_SCOPE",
        message:
          "Reconnect Google Calendar and allow calendar access — the current connection cannot create calendar events.",
      };
    }
  }

  let refreshToken: string;

  try {
    refreshToken = decryptOAuthToken(
      connection.encrypted_refresh_token,
    );
  } catch (error) {
    console.error(
      "Google refresh token decryption failed:",
      error instanceof Error ? error.message : error,
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "The Google Calendar connection could not be decrypted.",
    };
  }

  try {
    const response = await fetch(
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );

    const data =
      (await response.json()) as GoogleRefreshResponse;

    if (!response.ok || !data.access_token) {
      console.error("Google access-token refresh failed:", {
        status: response.status,
        error: data.error,
        description: data.error_description,
      });

      if (
        data.error === "invalid_grant" ||
        data.error === "unauthorized_client"
      ) {
        await supabaseAdmin
          .from("oauth_connections")
          .update({
            revoked_at: new Date().toISOString(),
            health_status: "revoked",
            last_health_check_at:
              new Date().toISOString(),
            health_failure_code:
              "OAUTH_REVOKED",
            health_failure_message:
              "Google Calendar connection is revoked. Reconnection is required.",
            updated_at:
              new Date().toISOString(),
          })
          .eq("consultant_id", consultantId)
          .eq("provider", "google");

        return {
          ok: false,
          code: "OAUTH_REVOKED",
          message:
            "The consultant must reconnect Google Calendar.",
        };
      }

      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message:
          "Google Calendar authorization could not be refreshed.",
      };
    }

    return {
      ok: true,
      accessToken: data.access_token,
      expiresInSeconds:
        typeof data.expires_in === "number"
          ? data.expires_in
          : 3600,
    };
  } catch (error) {
    console.error(
      "Google access-token refresh failed:",
      error instanceof Error ? error.message : error,
    );

    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message:
        "Google Calendar authorization could not be refreshed.",
    };
  }
};
