/*
 * Acceptance recovery after a post-capture failure.
 *
 * The defect these cover: a consultant accepted, the payment was
 * CAPTURED, creating the Google Calendar event failed, and the
 * consultation was parked in admin_attention with reason
 * 'calendar_failed'. Every retry was then refused with
 * INVALID_TRANSITION, so the client had paid, no calendar event
 * existed, and the consultant could never finish.
 *
 * finalize_consultation_acceptance has allowed this recovery since
 * migration 008 (for one of the two reasons; migration 051 adds the
 * other), but this service's own guard refused admin_attention
 * outright, so the retry never reached the RPC.
 *
 * These tests assert the guard, not Stripe or Google. A row that
 * gets PAST the guard fails a step later at the Google OAuth
 * lookup — no oauth_connections row is faked — so GOOGLE_ERROR is
 * the signal that the guard let it through, and INVALID_TRANSITION
 * the signal that it did not.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://acceptance-recovery-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_SECRET_KEY: "sk_test_acceptance_recovery",
  STRIPE_WEBHOOK_SECRET: "whsec_acceptance_recovery",
  STRIPE_TEST_SECRET_KEY: "sk_test_acceptance_recovery",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_acceptance_recovery",
  STRIPE_LIVE_SECRET_KEY: "sk_live_acceptance_recovery",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_acceptance_recovery",
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
const { acceptConsultation } = await import("./acceptance.service.js");

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const CONSULTANT_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_CONSULTANT_ID = "88888888-8888-4888-8888-888888888888";

type Row = Record<string, unknown>;

let consultationRow: Row | null = null;
let updateCalls: Row[] = [];

class FakeQuery {
  private readonly table: string;
  private values: Row | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(): this {
    return this;
  }

  update(values: Row): this {
    this.values = values;

    return this;
  }

  eq(): this {
    return this;
  }

  in(): this {
    if (this.values) {
      updateCalls.push(this.values);
    }

    return this;
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "consultations") {
      return { data: consultationRow, error: null };
    }

    /* No oauth_connections row: Google is deliberately unreachable. */
    return { data: null, error: null };
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

supabaseAdmin.rpc = (async () => {
  throw new Error(
    "The acceptance RPC must not be reached in these tests.",
  );
}) as unknown as typeof supabaseAdmin.rpc;

const consultation = (overrides: Row = {}): Row => ({
  id: CONSULTATION_ID,
  consultant_id: CONSULTANT_ID,
  status: "pending_acceptance",
  scheduled_start_at: "2026-09-02T17:00:00.000Z",
  scheduled_end_at: "2026-09-02T18:00:00.000Z",
  client_timezone: "America/Chicago",
  stripe_payment_intent_id: "pi_test_acceptance",
  stripe_mode: "test",
  payment_authorized_at: new Date(
    Date.now() - 60 * 60 * 1000,
  ).toISOString(),
  google_event_id: null,
  meet_link: null,
  admin_attention_reason: null,
  ...overrides,
});

const accept = async () =>
  acceptConsultation({
    consultationId: CONSULTATION_ID,
    consultantId: CONSULTANT_ID,
  });

/*
 * Past the guard. The next step is the Google OAuth lookup, which
 * has no connection row, so this is where a permitted acceptance
 * lands.
 */
const assertReachedGoogle = (
  result: Awaited<ReturnType<typeof accept>>,
): void => {
  assert.equal(result.ok, false);
  assert.equal(
    !result.ok && result.code,
    "GOOGLE_ERROR",
    "expected the acceptance to pass the status guard",
  );
};

const assertRefused = (
  result: Awaited<ReturnType<typeof accept>>,
): void => {
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "INVALID_TRANSITION");
};

beforeEach(() => {
  consultationRow = consultation();
  updateCalls = [];
});

describe("Acceptance recovery: the two post-capture failures", () => {
  it("lets a consultant retry after the calendar event failed", async () => {
    consultationRow = consultation({
      status: "admin_attention",
      admin_attention_reason: "calendar_failed",
    });

    assertReachedGoogle(await accept());
  });

  it("lets a consultant retry after the post-calendar finalization failed", async () => {
    consultationRow = consultation({
      status: "admin_attention",
      admin_attention_reason:
        "calendar_created_confirmation_failed",
      google_event_id: "gcal-event-1",
    });

    assertReachedGoogle(await accept());
  });

  it("recovers even after the 48-hour window has closed", async () => {
    /*
     * The money is already captured and the consultant did accept
     * in time. Applying the window here would strand the payment
     * with no calendar event and no way to finish.
     */
    consultationRow = consultation({
      status: "admin_attention",
      admin_attention_reason: "calendar_failed",
      payment_authorized_at: new Date(
        Date.now() - 72 * 60 * 60 * 1000,
      ).toISOString(),
    });

    assertReachedGoogle(await accept());
  });
});

describe("Acceptance recovery: what stays refused", () => {
  for (const reason of [
    "declined",
    "timeout",
    "Cancelled by admin: client requested a refund",
  ]) {
    it(`refuses admin_attention with reason ${reason}`, async () => {
      consultationRow = consultation({
        status: "admin_attention",
        admin_attention_reason: reason,
      });

      assertRefused(await accept());
    });
  }

  it("refuses admin_attention with no reason recorded", async () => {
    consultationRow = consultation({
      status: "admin_attention",
      admin_attention_reason: null,
    });

    assertRefused(await accept());
  });

  it("refuses a cancelled consultation", async () => {
    consultationRow = consultation({ status: "cancelled" });

    assertRefused(await accept());
  });

  it("refuses another consultant's recovery", async () => {
    consultationRow = consultation({
      consultant_id: OTHER_CONSULTANT_ID,
      status: "admin_attention",
      admin_attention_reason: "calendar_failed",
    });

    const result = await accept();

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "FORBIDDEN");
  });
});

describe("Acceptance recovery: ordinary acceptance is unchanged", () => {
  it("still accepts from pending_acceptance", async () => {
    assertReachedGoogle(await accept());
  });

  it("still accepts from captured", async () => {
    consultationRow = consultation({ status: "captured" });

    assertReachedGoogle(await accept());
  });

  it("still enforces the 48-hour window on a first acceptance", async () => {
    consultationRow = consultation({
      payment_authorized_at: new Date(
        Date.now() - 72 * 60 * 60 * 1000,
      ).toISOString(),
    });

    const result = await accept();

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "ACCEPTANCE_EXPIRED");
  });

  it("still refuses a consultation with no payment authorization", async () => {
    consultationRow = consultation({
      payment_authorized_at: null,
    });

    const result = await accept();

    assert.equal(result.ok, false);
    assert.equal(
      !result.ok && result.code,
      "PAYMENT_NOT_AUTHORIZED",
    );
  });

  it("returns the confirmed result without retrying a finished consultation", async () => {
    consultationRow = consultation({
      status: "confirmed",
      google_event_id: "gcal-event-1",
      meet_link: "https://meet.google.com/abc-defg-hij",
    });

    const result = await accept();

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.meetLink,
      "https://meet.google.com/abc-defg-hij",
    );
  });
});
