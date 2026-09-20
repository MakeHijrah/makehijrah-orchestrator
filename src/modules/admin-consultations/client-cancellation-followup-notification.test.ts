/*
 * Client-requested cancellation follow-up email tests. Migration
 * 058.
 *
 * Nothing external is contacted. Supabase and Redis are replaced
 * with in-memory fakes, and Mandrill is intercepted at the fetch
 * boundary so the real lib/mandrill.ts payload builder runs —
 * matching booking-notification.test.ts's convention, which is
 * what lets these tests assert on the exact recipient and body
 * rather than on a mocked call signature.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://client-cancellation-followup-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_cancellation_followup",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_cancellation_followup",
  STRIPE_LIVE_SECRET_KEY: "sk_live_cancellation_followup",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_cancellation_followup",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_REDIRECT_URI: "https://example.test/oauth/callback",
  APP_URL: "https://hijrah.network",
  OAUTH_STATE_SECRET: "test-oauth-state-secret-of-sufficient-length",
  MANDRILL_API_KEY: "test-mandrill-key",
  MANDRILL_FROM_EMAIL: "no-reply@example.test",
  MANDRILL_FROM_NAME: "Make Hijrah Test",
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] ??= value;
}

const { supabaseAdmin } = await import("../../lib/supabase.js");
const { redis } = await import("../../lib/redis.js");
const { sendClientCancellationFollowUpEmail } = await import(
  "./client-cancellation-followup-notification.service.js"
);

const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const CONSULTANT_ID = "77777777-7777-4777-8777-777777777777";

type Row = Record<string, unknown>;

type FakeDatabase = {
  consultations: Row[];
  consultation_intake: Row[];
  consultants: Row[];
};

const db: FakeDatabase = {
  consultations: [],
  consultation_intake: [],
  consultants: [],
};

const tableRows = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

class FakeQuery {
  private readonly table: string;
  private readonly filters: Array<(row: Row) => boolean> = [];

  constructor(table: string) {
    this.table = table;
  }

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  private matchedRows(): Row[] {
    return tableRows(this.table).filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
  }

  async maybeSingle(): Promise<{
    data: unknown;
    error: unknown;
  }> {
    return { data: this.matchedRows()[0] ?? null, error: null };
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

/*
 * Redis fake: GET, SET (with NX honoured), and EVAL for the two
 * local Lua scripts (compare-and-set, compare-and-delete). Real
 * NX semantics matter here — the whole point of this suite is
 * proving the atomic reservation actually excludes a concurrent
 * second acquisition, which a fake that always succeeds would
 * hide rather than test. An unimplemented operation throws
 * instead of silently succeeding, for the same reason.
 */
const redisStore = new Map<string, string>();

let redisMode: "ok" | "unavailable" = "ok";

const redisUnavailableError = (): Error =>
  new Error("Simulated Redis outage");

redis.get = (async (key: string) => {
  if (redisMode === "unavailable") {
    throw redisUnavailableError();
  }

  return redisStore.get(key) ?? null;
}) as unknown as typeof redis.get;

redis.set = (async (
  key: string,
  value: string,
  ...rest: unknown[]
) => {
  if (redisMode === "unavailable") {
    throw redisUnavailableError();
  }

  const nx = rest.includes("NX");

  if (nx && redisStore.has(key)) {
    return null;
  }

  redisStore.set(key, value);
  return "OK";
}) as unknown as typeof redis.set;

/*
 * Interprets exactly the two scripts the service defines —
 * compare-and-set (3 ARGV: expected, next value, ttl) and
 * compare-and-delete (1 ARGV: expected) — by shape rather than by
 * matching the script text, so the fake does not silently drift
 * out of sync with the real script bodies.
 */
redis.eval = (async (
  _script: string,
  _numKeys: number,
  key: string,
  expected: string,
  ...rest: unknown[]
) => {
  if (redisMode === "unavailable") {
    throw redisUnavailableError();
  }

  const current = redisStore.get(key) ?? null;

  if (current !== expected) {
    return 0;
  }

  if (rest.length === 0) {
    redisStore.delete(key);
    return 1;
  }

  const [nextValue] = rest as [string];
  redisStore.set(key, nextValue);
  return 1;
}) as unknown as typeof redis.eval;

type MandrillPayload = {
  key: string;
  message: {
    to: Array<{ email: string; name?: string }>;
    subject: string;
    html: string;
    text: string;
    tags: string[];
  };
};

let mandrillRequests: MandrillPayload[] = [];
let mandrillMode: "ok" | "http_error" = "ok";

globalThis.fetch = (async (
  _url: unknown,
  init: { body?: unknown },
) => {
  mandrillRequests.push(
    JSON.parse(String(init.body)) as MandrillPayload,
  );

  if (mandrillMode === "http_error") {
    return new Response("upstream failure", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }

  return new Response(
    JSON.stringify([
      {
        email: "client@example.test",
        status: "sent",
        _id: "mandrill-1",
      },
    ]),
    { status: 200 },
  );
}) as unknown as typeof fetch;

const lastEmail = (): MandrillPayload["message"] => {
  assert.equal(
    mandrillRequests.length,
    1,
    `expected exactly one Mandrill request, got ${mandrillRequests.length}`,
  );

  return mandrillRequests[0]!.message;
};

const seedClientRequestedConsultation = (
  overrides: Partial<Row> = {},
): void => {
  db.consultations = [
    {
      id: CONSULTATION_ID,
      consultant_id: CONSULTANT_ID,
      booking_source: "standard",
      status: "cancelled",
      cancellation_source: "client_requested",
      ...overrides,
    },
  ];

  db.consultation_intake = [
    {
      consultation_id: CONSULTATION_ID,
      full_name: "Amina Yusuf",
      email: "amina@example.test",
    },
  ];
};

beforeEach(() => {
  db.consultations = [];
  db.consultation_intake = [];
  db.consultants = [];
  redisStore.clear();
  redisMode = "ok";
  mandrillRequests = [];
  mandrillMode = "ok";
});

describe("Client cancellation follow-up: eligibility", () => {
  it("sends for a cancelled, client_requested consultation", async () => {
    seedClientRequestedConsultation();

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "sent");
    assert.equal(mandrillRequests.length, 1);
  });

  it("does not send for cancellation_source = admin", async () => {
    seedClientRequestedConsultation({
      cancellation_source: "admin",
    });

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "skipped");
    assert.equal(mandrillRequests.length, 0);
  });

  it("does not send for cancellation_source = system", async () => {
    seedClientRequestedConsultation({
      cancellation_source: "system",
    });

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "skipped");
    assert.equal(mandrillRequests.length, 0);
  });

  it("does not send for a null cancellation_source", async () => {
    seedClientRequestedConsultation({
      cancellation_source: null,
    });

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "skipped");
    assert.equal(mandrillRequests.length, 0);
  });

  it("does not send for a non-cancelled status, even if client_requested is somehow set", async () => {
    seedClientRequestedConsultation({
      status: "refunded",
    });

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "skipped");
    assert.equal(mandrillRequests.length, 0);
  });

  it("skips silently when the consultation cannot be found", async () => {
    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "skipped");
  });

  it("skips when the intake email is unusable", async () => {
    seedClientRequestedConsultation();
    db.consultation_intake[0]!.email = "not-an-email";

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "skipped");
    assert.equal(mandrillRequests.length, 0);
  });
});

describe("Client cancellation follow-up: recipient and copy", () => {
  it("sends to consultation_intake.email, not any other address", async () => {
    seedClientRequestedConsultation();

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();

    assert.equal(email.to.length, 1);
    assert.equal(email.to[0]!.email, "amina@example.test");
  });

  it("personalizes with the first name only", async () => {
    seedClientRequestedConsultation();

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();

    assert.equal(email.to[0]!.name, "Amina");
    assert.ok(
      email.html.includes("Assalamu alaikum Amina,"),
      "expected the HTML greeting to use the first name",
    );
    assert.ok(
      email.text.includes("Assalamu alaikum Amina,"),
      "expected the text greeting to use the first name",
    );
    assert.ok(
      !email.html.includes("Yusuf"),
      "the surname must not appear in the greeting",
    );
  });

  it("falls back safely for a blank name", async () => {
    seedClientRequestedConsultation();
    db.consultation_intake[0]!.full_name = "   ";

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();

    assert.equal(email.to[0]!.name, "there");
    assert.ok(email.html.includes("Assalamu alaikum there,"));
  });

  it("uses the exact required subject line", async () => {
    seedClientRequestedConsultation();

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(
      lastEmail().subject,
      "We noticed you cancelled your Make Hijrah consultation",
    );
  });

  it("contains no urgency, discount or pressure language", async () => {
    seedClientRequestedConsultation();

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();
    const lower = (email.html + email.text).toLowerCase();

    for (const forbidden of [
      "discount",
      "% off",
      "hurry",
      "limited time",
      "act now",
      "offer expires",
    ]) {
      assert.ok(
        !lower.includes(forbidden),
        `email must not contain "${forbidden}"`,
      );
    }
  });

  it("never exposes internal cancellation metadata", async () => {
    seedClientRequestedConsultation();

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();
    const combined = email.html + email.text;

    for (const forbidden of [
      "client_requested",
      "admin_attention_reason",
      "cancellation_source",
      CONSULTATION_ID,
    ]) {
      assert.ok(
        !combined.includes(forbidden),
        `email must not contain internal marker "${forbidden}"`,
      );
    }
  });
});

describe("Client cancellation follow-up: rebook link", () => {
  it("links to /consultation for a standard booking", async () => {
    seedClientRequestedConsultation({
      booking_source: "standard",
    });

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();

    assert.ok(
      email.html.includes(
        "https://hijrah.network/consultation",
      ),
      email.html,
    );
    assert.ok(
      email.text.includes(
        "https://hijrah.network/consultation",
      ),
    );
  });

  it("links to the consultant's own slug for a direct booking", async () => {
    db.consultants = [
      {
        id: CONSULTANT_ID,
        consultant_slug: "aisha-rahman",
        direct_booking_enabled: true,
      },
    ];

    seedClientRequestedConsultation({
      booking_source: "direct_booking",
    });

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();

    assert.ok(
      email.html.includes(
        "https://hijrah.network/aisha-rahman",
      ),
      email.html,
    );
    assert.ok(
      !email.html.includes("/consultation"),
      "a direct booking must not link to the generic chooser",
    );
  });

  it("omits the rebook line entirely when a direct booking's consultant has no slug", async () => {
    db.consultants = [
      {
        id: CONSULTANT_ID,
        consultant_slug: null,
        direct_booking_enabled: true,
      },
    ];

    seedClientRequestedConsultation({
      booking_source: "direct_booking",
    });

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    const email = lastEmail();

    assert.ok(
      !email.html.includes("book another consultation"),
      "no rebook line should render without a safe destination",
    );
  });
});

describe("Client cancellation follow-up: idempotency", () => {
  it("does not send a second email for the same consultation", async () => {
    seedClientRequestedConsultation();

    const first = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });
    const second = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(first, "sent");
    assert.equal(second, "already_sent");
    assert.equal(
      mandrillRequests.length,
      1,
      "only one Mandrill request should ever have been made",
    );
  });

  it("survives a fresh in-process call as if after a restart", async () => {
    /*
     * The delivery marker lives in Redis, not in any module-level
     * variable, so re-importing or re-invoking the function with
     * the same Redis-backed store must still see it — this is
     * what makes the marker survive a worker/process restart
     * rather than only an in-memory guard within one call chain.
     */
    seedClientRequestedConsultation();

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(
      redisStore.get(
        `client-cancellation-followup:delivery:${CONSULTATION_ID}`,
      ),
      "sent",
    );

    const repeat = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(repeat, "already_sent");
  });
});

describe("Client cancellation follow-up: failure behaviour", () => {
  it("reports failure without throwing when Mandrill rejects the request", async () => {
    seedClientRequestedConsultation();
    mandrillMode = "http_error";

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "failed");
  });

  it("does not record delivery on a failed send, so a retry can succeed", async () => {
    seedClientRequestedConsultation();
    mandrillMode = "http_error";

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    mandrillMode = "ok";

    const retry = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(retry, "sent");
    assert.equal(mandrillRequests.length, 2);
  });
});

describe("Client cancellation follow-up: atomic reservation", () => {
  const deliveryKeyFor = (consultationId: string): string =>
    `client-cancellation-followup:delivery:${consultationId}`;

  it("the first invocation acquires the reservation and sends", async () => {
    seedClientRequestedConsultation();

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "sent");
    assert.equal(mandrillRequests.length, 1);
    assert.ok(
      redisStore.has(deliveryKeyFor(CONSULTATION_ID)),
      "the delivery key must exist once a reservation has been acquired",
    );
  });

  it("a successful send records the durable sent state, not the pending reservation value", async () => {
    seedClientRequestedConsultation();

    await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(
      redisStore.get(deliveryKeyFor(CONSULTATION_ID)),
      "sent",
      "the key must hold the plain durable marker, not a pending:<token> value, once Mandrill has confirmed delivery",
    );
  });

  it("two concurrent invocations for the same consultation produce exactly one Mandrill request", async () => {
    seedClientRequestedConsultation();

    const [first, second] = await Promise.all([
      sendClientCancellationFollowUpEmail({
        consultationId: CONSULTATION_ID,
      }),
      sendClientCancellationFollowUpEmail({
        consultationId: CONSULTATION_ID,
      }),
    ]);

    assert.equal(
      mandrillRequests.length,
      1,
      "exactly one Mandrill request must be made for two concurrent calls",
    );

    const results = [first, second].sort();
    assert.deepEqual(
      results,
      ["already_sent", "sent"],
      "one call must win the reservation (sent) and the other must lose it (already_sent)",
    );
  });

  it("a pre-existing pending reservation from another in-flight call causes NX acquisition to fail and the send to be skipped", async () => {
    seedClientRequestedConsultation();

    redisStore.set(
      deliveryKeyFor(CONSULTATION_ID),
      "pending:someone-elses-in-flight-token",
    );

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result, "already_sent");
    assert.equal(mandrillRequests.length, 0);
  });

  it("a Mandrill failure releases only its own reservation, never one a different process has already taken over", async () => {
    seedClientRequestedConsultation();

    const key = deliveryKeyFor(CONSULTATION_ID);
    let sawForeignTakeover = false;

    const originalFetch = globalThis.fetch;

    /*
     * Simulates the reservation's TTL having been outlived by an
     * unusually slow round trip, with a different process already
     * having reclaimed the key, all before this call's own failure
     * handling runs its release. The real release script must
     * refuse to delete a value it no longer owns.
     */
    globalThis.fetch = (async () => {
      redisStore.set(
        key,
        "pending:foreign-token-from-another-process",
      );
      sawForeignTakeover = true;

      return new Response("upstream failure", {
        status: 500,
        statusText: "Internal Server Error",
      });
    }) as unknown as typeof fetch;

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    globalThis.fetch = originalFetch;

    assert.ok(
      sawForeignTakeover,
      "test setup error: the foreign takeover must have been simulated before asserting on it",
    );
    assert.equal(result, "failed");
    assert.equal(
      redisStore.get(key),
      "pending:foreign-token-from-another-process",
      "a failed call must never delete a reservation it does not still own",
    );
  });

  it("a Redis error at acquisition time sends no email", async () => {
    seedClientRequestedConsultation();
    redisMode = "unavailable";

    const result = await sendClientCancellationFollowUpEmail({
      consultationId: CONSULTATION_ID,
    });

    redisMode = "ok";

    assert.equal(result, "failed");
    assert.equal(
      mandrillRequests.length,
      0,
      "a Redis outage must fail closed: no reservation means no send",
    );
  });

  it("does not throw when Redis is unavailable, and cancellation-affecting state is never touched by this service", async () => {
    seedClientRequestedConsultation();
    redisMode = "unavailable";

    await assert.doesNotReject(
      sendClientCancellationFollowUpEmail({
        consultationId: CONSULTATION_ID,
      }),
    );

    redisMode = "ok";
  });
});
