import { env } from "../../config/env.js";

const GOOGLE_TOKEN_ENDPOINT =
  "https://oauth2.googleapis.com/token";

const GOOGLE_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo";

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfoResponse = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export type GoogleAuthorizationExchangeResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      googleEmail: string;
      scopes: string[];
    }
  | {
      ok: false;
      message: string;
    };

const parseScopes = (scope: string | undefined): string[] => {
  if (!scope) {
    return [];
  }

  return scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
};

export const exchangeGoogleAuthorizationCode = async (
  code: string,
): Promise<GoogleAuthorizationExchangeResult> => {
  if (!code.trim()) {
    return {
      ok: false,
      message: "Google authorization code is missing.",
    };
  }

  try {
    const tokenResponse = await fetch(
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: env.GOOGLE_REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      },
    );

    const tokenData =
      (await tokenResponse.json()) as GoogleTokenResponse;

    if (
      !tokenResponse.ok ||
      !tokenData.access_token ||
      !tokenData.refresh_token
    ) {
      console.error("Google token exchange failed:", {
        status: tokenResponse.status,
        error: tokenData.error,
        description: tokenData.error_description,
        hasAccessToken: Boolean(tokenData.access_token),
        hasRefreshToken: Boolean(tokenData.refresh_token),
      });

      return {
        ok: false,
        message:
          "Google did not return the required authorization tokens.",
      };
    }

    const userInfoResponse = await fetch(
      GOOGLE_USERINFO_ENDPOINT,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      },
    );

    const userInfo =
      (await userInfoResponse.json()) as GoogleUserInfoResponse;

    if (
      !userInfoResponse.ok ||
      !userInfo.email ||
      userInfo.email_verified !== true
    ) {
      console.error("Google user information lookup failed:", {
        status: userInfoResponse.status,
        hasEmail: Boolean(userInfo.email),
        emailVerified: userInfo.email_verified,
      });

      return {
        ok: false,
        message:
          "Google account information could not be verified.",
      };
    }

    return {
      ok: true,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      googleEmail: userInfo.email,
      scopes: parseScopes(tokenData.scope),
    };
  } catch (error) {
    console.error(
      "Google authorization exchange failed:",
      error instanceof Error ? error.message : error,
    );

    return {
      ok: false,
      message:
        "Google authorization could not be completed.",
    };
  }
};
