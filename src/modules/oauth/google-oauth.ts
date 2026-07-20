import { env } from "../../config/env.js";
import { createOAuthState } from "../../lib/oauth-state.js";

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
] as const;

export const createGoogleAuthorizationUrl = (
  consultantId: string,
): string => {
  const parameters = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    state: createOAuthState(consultantId),
  });

  return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${parameters.toString()}`;
};
