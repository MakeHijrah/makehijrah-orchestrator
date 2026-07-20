import { env } from "../../config/env.js";
import { decryptOAuthToken } from "../../lib/oauth-token-crypto.js";
import { supabaseAdmin } from "../../lib/supabase.js";

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
        | "INTERNAL_ERROR";
      message: string;
    };

export const getGoogleAccessToken = async (
  consultantId: string,
): Promise<GoogleAccessTokenResult> => {
  const { data: connection, error: connectionError } =
    await supabaseAdmin
      .from("oauth_connections")
      .select(
        "encrypted_refresh_token, revoked_at",
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
