/*
 * The Google scope gate.
 *
 * Google presents its scopes as individual checkboxes and lets a
 * consultant finish the flow having unticked one. Consultation
 * 549beff0 was booked against such a grant: connected, not
 * revoked, refresh token working, and missing calendar.events. The
 * acceptance captured $97 and only then discovered it could not
 * create the event.
 *
 * These cover both ends of that: refusing the grant at connect
 * time, and refusing to reach the capture with it.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://scope-gate-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_SECRET_KEY: "sk_test_scope_gate",
  STRIPE_WEBHOOK_SECRET: "whsec_scope_gate",
  STRIPE_TEST_SECRET_KEY: "sk_test_scope_gate",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_scope_gate",
  STRIPE_LIVE_SECRET_KEY: "sk_live_scope_gate",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_scope_gate",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_REDIRECT_URI: "https://example.test/oauth/callback",
  APP_URL: "https://app.example.test",
  OAUTH_STATE_SECRET: "test-oauth-state-secret-of-sufficient-length",
  MANDRILL_API_KEY: "test-mandrill-key",
  MANDRILL_FROM_EMAIL: "no-reply@example.test",
  MANDRILL_FROM_NAME: "Make Hijrah Test",
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] ??= value;
}

const { supabaseAdmin } = await import("../../lib/supabase.js");
const {
  GOOGLE_EVENT_WRITE_SCOPE,
  GOOGLE_REQUIRED_SCOPES,
  findMissingGoogleScopes,
  findMissingScopes,
} = await import("./google-oauth.js");
const { getGoogleAccessToken } = await import(
  "./google-access-token.js"
);

const EVENTS = "https://www.googleapis.com/auth/calendar.events";
const FREEBUSY =
  "https://www.googleapis.com/auth/calendar.events.freebusy";

/* The exact grant recorded for the consultant on 549beff0. */
const BROKEN_GRANT = [
  "openid",
  FREEBUSY,
  "https://www.googleapis.com/auth/userinfo.email",
];

/* A grant Google issued correctly. */
const GOOD_GRANT = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  EVENTS,
  FREEBUSY,
];

const CONSULTANT_ID = "77777777-7777-4777-8777-777777777777";

let connectionRow: Record<string, unknown> | null = null;

class FakeQuery {
  select(): this {
    return this;
  }

  eq(): this {
    return this;
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    return { data: connectionRow, error: null };
  }
}

supabaseAdmin.from = (() =>
  new FakeQuery()) as unknown as typeof supabaseAdmin.from;

/*
 * Reaching Google would mean the gate let it through. Nothing here
 * gets that far in practice — the fake refresh token fails to
 * decrypt first — but the stub makes a network call impossible
 * rather than merely unlikely.
 */
globalThis.fetch = (async () => {
  throw new Error(
    "Google must not be contacted from these tests.",
  );
}) as unknown as typeof fetch;

const connection = (scopes: string[]) => ({
  encrypted_refresh_token: "not-a-real-token",
  revoked_at: null,
  scopes,
});

beforeEach(() => {
  connectionRow = connection(GOOD_GRANT);
});

describe("findMissingScopes", () => {
  it("names the scope the broken grant is missing", () => {
    assert.deepEqual(
      findMissingScopes(BROKEN_GRANT, [GOOGLE_EVENT_WRITE_SCOPE]),
      [EVENTS],
    );
  });

  it("passes a grant that has what was asked for", () => {
    assert.deepEqual(
      findMissingScopes(GOOD_GRANT, [GOOGLE_EVENT_WRITE_SCOPE]),
      [],
    );
  });

  it("accepts freebusy-only for a freebusy-only requirement", () => {
    /*
     * Availability still works for this consultant, which is why
     * the requirement is per-operation rather than global.
     */
    assert.deepEqual(findMissingScopes(BROKEN_GRANT, [FREEBUSY]), []);
  });

  it("ignores surrounding whitespace in a granted scope", () => {
    assert.deepEqual(
      findMissingScopes([` ${EVENTS} `], [GOOGLE_EVENT_WRITE_SCOPE]),
      [],
    );
  });
});

describe("findMissingGoogleScopes: the connect-time grant", () => {
  it("rejects the grant that caused this incident", () => {
    assert.deepEqual(findMissingGoogleScopes(BROKEN_GRANT), [EVENTS]);
  });

  it("rejects a grant with no calendar scopes at all", () => {
    assert.deepEqual(
      findMissingGoogleScopes([
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
      ]),
      [EVENTS, FREEBUSY],
    );
  });

  it("accepts a complete grant", () => {
    assert.deepEqual(findMissingGoogleScopes(GOOD_GRANT), []);
  });

  it("does not require 'email', which Google renames", () => {
    /*
     * Google returns .../auth/userinfo.email for the "email"
     * scope we request. Requiring the requested list verbatim
     * would reject every real grant, good ones included.
     */
    assert.ok(!GOOGLE_REQUIRED_SCOPES.includes("email" as never));
    assert.deepEqual(findMissingGoogleScopes([EVENTS, FREEBUSY]), []);
  });
});

describe("getGoogleAccessToken: the pre-capture gate", () => {
  it("refuses a grant that cannot create events", async () => {
    connectionRow = connection(BROKEN_GRANT);

    const result = await getGoogleAccessToken(CONSULTANT_ID, [
      GOOGLE_EVENT_WRITE_SCOPE,
    ]);

    assert.equal(result.ok, false);
    assert.equal(
      !result.ok && result.code,
      "OAUTH_INSUFFICIENT_SCOPE",
    );
    assert.match(
      !result.ok ? result.message : "",
      /Reconnect Google Calendar/,
    );
  });

  it("still refuses a revoked connection first", async () => {
    connectionRow = {
      ...connection(GOOD_GRANT),
      revoked_at: "2026-09-01T00:00:00.000Z",
    };

    const result = await getGoogleAccessToken(CONSULTANT_ID, [
      GOOGLE_EVENT_WRITE_SCOPE,
    ]);

    assert.equal(!result.ok && result.code, "OAUTH_REVOKED");
  });

  it("still refuses when there is no connection", async () => {
    connectionRow = null;

    const result = await getGoogleAccessToken(CONSULTANT_ID, [
      GOOGLE_EVENT_WRITE_SCOPE,
    ]);

    assert.equal(!result.ok && result.code, "OAUTH_NOT_CONNECTED");
  });

  it("does not gate a caller that asks for nothing", async () => {
    /*
     * Availability passes no requirement, so the broken grant
     * gets past the gate exactly as it does today and fails later
     * on the unusable test refresh token.
     */
    connectionRow = connection(BROKEN_GRANT);

    const result = await getGoogleAccessToken(CONSULTANT_ID);

    assert.notEqual(
      !result.ok && result.code,
      "OAUTH_INSUFFICIENT_SCOPE",
    );
  });

  it("does not gate when no scopes were ever recorded", async () => {
    /*
     * An empty column means unknown, not known-bad. Blocking on it
     * would refuse a consultant whose Google access works.
     */
    connectionRow = connection([]);

    const result = await getGoogleAccessToken(CONSULTANT_ID, [
      GOOGLE_EVENT_WRITE_SCOPE,
    ]);

    assert.notEqual(
      !result.ok && result.code,
      "OAUTH_INSUFFICIENT_SCOPE",
    );
  });
});

/*
 * The status endpoint decides whether the profile screen offers a
 * Connect control at all, so an incomplete grant reported as
 * "connected" leaves the consultant with no way to fix it. That is
 * the state consultation 549beff0 was booked in.
 */
describe("oauth-status: an incomplete grant is not connected", () => {
  const statusFor = (scopes: string[]) => {
    const missing = findMissingGoogleScopes(scopes);

    return missing.length > 0
      ? {
          connected: false,
          requires_reconnect: true,
          missing_scopes: missing,
        }
      : { connected: true };
  };

  it("reports the incident grant as not connected", () => {
    assert.deepEqual(statusFor(BROKEN_GRANT), {
      connected: false,
      requires_reconnect: true,
      missing_scopes: [EVENTS],
    });
  });

  it("reports a grant with no calendar scopes as not connected", () => {
    const status = statusFor([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);

    assert.equal(status.connected, false);
    assert.deepEqual(status.missing_scopes, [EVENTS, FREEBUSY]);
  });

  it("still reports a complete grant as connected", () => {
    assert.deepEqual(statusFor(GOOD_GRANT), { connected: true });
  });
});
