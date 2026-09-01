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

/*
 * The scopes a consultant's grant MUST contain to be usable.
 *
 * Google presents these as individual checkboxes and lets a user
 * untick one while still completing the flow. A grant missing
 * calendar.events looks connected in every way — the connection
 * row exists, the refresh token works, the access token is issued
 * — right up to the moment it is used to create the event, which
 * happens AFTER the client's payment has been captured.
 *
 * Checked against only these two, never against
 * GOOGLE_OAUTH_SCOPES: Google normalises "email" to
 * ".../auth/userinfo.email" in its response, so an exact match on
 * the requested list would reject every grant, including good
 * ones.
 */
export const GOOGLE_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
] as const;

/* The scope that creates a calendar event and its Meet link. */
export const GOOGLE_EVENT_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

export const findMissingScopes = (
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
): string[] => {
  const granted = new Set(
    grantedScopes.map((scope) => scope.trim()),
  );

  return requiredScopes.filter(
    (scope) => !granted.has(scope),
  );
};

/* Used at connect time, where a complete grant is demanded. */
export const findMissingGoogleScopes = (
  grantedScopes: readonly string[],
): string[] =>
  findMissingScopes(
    grantedScopes,
    GOOGLE_REQUIRED_SCOPES,
  );

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
