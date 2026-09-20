/*
 * Admin consultation cancellation tests, focused on migration
 * 058's cancellation_source contract and the client-requested
 * follow-up email it gates.
 *
 * The RPC fake is a faithful in-memory stand-in for migration
 * 058's finalize_admin_consultation_cancel: same idempotent
 * early-return branches, same coalesce-based immutability of
 * cancellation_source once set, same validation marker. Each
 * behaviour it reproduces was verified against PostgreSQL 16 in
 * MIGRATION_058_VERIFICATION.sql before being mirrored here.
 *
 * Every fixture consultation is status = 'confirmed' with no
 * stripe_payment_intent_id and no google_event_id, and every call
 * here passes refund: false. That combination is deliberate: it
 * is not in AUTHORIZATION_STATUSES and refund is false, so
 * neither Stripe branch in admin-consultation-cancel.service.ts
 * fires, and google_event_id being null short-circuits the
 * calendar branch before it calls out anywhere — the full,
 * exported adminCancelConsultation runs end to end with nothing
 * to mock beyond Supabase, Redis and Mandrill. Stripe still needs
 * a resolvable client (getStripeClient does no I/O, only reads
 * env credentials), so stripe_mode is always set.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://admin-consultation-cancel-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_admin_cancel",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_admin_cancel",
  STRIPE_LIVE_SECRET_KEY: "sk_live_admin_cancel",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_admin_cancel",
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
const { adminCancelConsultation } = await import(
  "./admin-consultation-cancel.service.js"
);

const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const CONSULTANT_ID = "77777777-7777-4777-8777-777777777777";
const CONSULTANT_PROFILE_ID =
  "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

type FakeDatabase = {
  consultations: Row[];
  consultation_intake: Row[];
  consultants: Row[];
  profiles: Row[];
};

const db: FakeDatabase = {
  consultations: [],
  consultation_intake: [],
  consultants: [],
  profiles: [],
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
 * The RPC fake. Mirrors migration 058's finalize_admin_
 * consultation_cancel exactly: validate the source, load and
 * lock, the two idempotent early returns, the transition guards,
 * then the update with coalesce-based immutability on both
 * admin_attention_reason and cancellation_source.
 */
const VALID_SOURCES = new Set([
  "client_requested",
  "admin",
  "system",
]);

const rpcCalls: Array<{
  name: string;
  args: Record<string, unknown>;
}> = [];

supabaseAdmin.rpc = (async (
  name: string,
  args: Record<string, unknown>,
) => {
  rpcCalls.push({ name, args });

  if (name !== "finalize_admin_consultation_cancel") {
    return { data: null, error: { message: "unknown rpc" } };
  }

  const consultationId = args.p_consultation_id as string;
  const refund = args.p_refund as boolean;
  const note = (args.p_note as string | null) ?? null;
  const source =
    (args.p_cancellation_source as string | undefined) ?? "admin";

  const trimmedSource =
    source.trim() === "" ? null : source.trim();

  if (
    trimmedSource !== null &&
    !VALID_SOURCES.has(trimmedSource)
  ) {
    return {
      data: null,
      error: {
        message: `INVALID_CANCELLATION_SOURCE:${trimmedSource}`,
        code: "P0001",
      },
    };
  }

  const row = db.consultations.find(
    (r) => r.id === consultationId,
  );

  if (!row) {
    return {
      data: null,
      error: {
        message: "CONSULTATION_NOT_FOUND",
        code: "P0001",
      },
    };
  }

  const targetStatus = refund ? "refunded" : "cancelled";
  const trimmedNote =
    typeof note === "string" && note.trim() !== ""
      ? note.trim()
      : null;

  if (row.status === "refunded") {
    return {
      data: [
        {
          consultation_id: row.id,
          consultation_status: row.status,
          cancelled_at: row.cancelled_at,
          admin_attention_reason:
            row.admin_attention_reason,
          cancellation_source:
            row.cancellation_source,
        },
      ],
      error: null,
    };
  }

  if (row.status === "cancelled" && !refund) {
    return {
      data: [
        {
          consultation_id: row.id,
          consultation_status: row.status,
          cancelled_at: row.cancelled_at,
          admin_attention_reason:
            row.admin_attention_reason,
          cancellation_source:
            row.cancellation_source,
        },
      ],
      error: null,
    };
  }

  const refundEligible = new Set([
    "confirmed",
    "captured",
    "completed",
    "cancelled",
    "admin_attention",
  ]);

  if (refund && !refundEligible.has(row.status as string)) {
    return {
      data: null,
      error: {
        message: `INVALID_REFUND_TRANSITION:${row.status}`,
        code: "P0001",
      },
    };
  }

  const cancelEligible = new Set([
    "draft",
    "payment_authorized",
    "pending_acceptance",
    "confirmed",
    "declined",
    "admin_attention",
    "completed",
    "authorization_cancelled",
    "captured",
    "cancelled",
  ]);

  if (!refund && !cancelEligible.has(row.status as string)) {
    return {
      data: null,
      error: {
        message: `INVALID_CANCEL_TRANSITION:${row.status}`,
        code: "P0001",
      },
    };
  }

  row.status = targetStatus;
  row.cancelled_at = row.cancelled_at ?? new Date().toISOString();
  row.admin_attention_reason =
    trimmedNote ?? row.admin_attention_reason ?? null;
  row.cancellation_source =
    row.cancellation_source ?? trimmedSource;

  return {
    data: [
      {
        consultation_id: row.id,
        consultation_status: row.status,
        cancelled_at: row.cancelled_at,
        admin_attention_reason:
          row.admin_attention_reason,
        cancellation_source: row.cancellation_source,
      },
    ],
    error: null,
  };
}) as unknown as typeof supabaseAdmin.rpc;

/*
 * Redis fake covering BOTH delivery-marker shapes this test
 * exercises: the simple GET/SET this file's own follow-up
 * service uses, AND the HGET/MULTI-HSET-EXPIRE shape the EXISTING
 * admin-consultation-cancel-notification.service.ts uses for its
 * own (unconditionally-called) client/consultant notifications.
 * Without the second shape, that service's real, unstubbed Redis
 * calls would try to reach an actual Redis connection and hang
 * the test run.
 */
const redisStore = new Map<string, string>();
const redisHashes = new Map<string, Map<string, string>>();

redis.get = (async (key: string) =>
  redisStore.get(key) ?? null) as unknown as typeof redis.get;

redis.set = (async (
  key: string,
  value: string,
  ..._rest: unknown[]
) => {
  redisStore.set(key, value);
  return "OK";
}) as unknown as typeof redis.set;

redis.hget = (async (
  key: string,
  field: string,
) =>
  redisHashes.get(key)?.get(field) ??
  null) as unknown as typeof redis.hget;

class FakeMulti {
  private readonly ops: Array<() => void> = [];

  hset(
    key: string,
    field: string,
    value: string,
  ): this {
    this.ops.push(() => {
      const hash =
        redisHashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      redisHashes.set(key, hash);
    });
    return this;
  }

  expire(_key: string, _ttl: number): this {
    return this;
  }

  async exec(): Promise<
    Array<[unknown, unknown]>
  > {
    for (const op of this.ops) op();
    return this.ops.map(() => [null, "OK"]);
  }
}

redis.multi = (() =>
  new FakeMulti()) as unknown as typeof redis.multi;

type MandrillPayload = {
  message: {
    to: Array<{ email: string; name?: string }>;
    subject: string;
    tags: string[];
  };
};

let mandrillRequests: MandrillPayload[] = [];

globalThis.fetch = (async (
  _url: unknown,
  init: { body?: unknown },
) => {
  mandrillRequests.push(
    JSON.parse(String(init.body)) as MandrillPayload,
  );

  return new Response(
    JSON.stringify([
      { email: "x@example.test", status: "sent", _id: "m-1" },
    ]),
    { status: 200 },
  );
}) as unknown as typeof fetch;

const followUpRequests = (): MandrillPayload[] =>
  mandrillRequests.filter((request) =>
    request.message.tags.includes(
      "consultation-cancellation-followup-client",
    ),
  );

const seedConfirmedConsultation = (
  overrides: Partial<Row> = {},
): void => {
  db.consultations = [
    {
      id: CONSULTATION_ID,
      consultant_id: CONSULTANT_ID,
      status: "confirmed",
      stripe_payment_intent_id: null,
      stripe_mode: "test",
      google_event_id: null,
      cancelled_at: null,
      admin_attention_reason: null,
      cancellation_source: null,
      booking_source: "standard",
      scheduled_start_at: new Date(
        Date.now() + 86_400_000,
      ).toISOString(),
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

  db.consultants = [
    {
      id: CONSULTANT_ID,
      profile_id: CONSULTANT_PROFILE_ID,
    },
  ];

  db.profiles = [
    {
      id: CONSULTANT_PROFILE_ID,
      full_name: "Consultant Name",
      email: "consultant@example.test",
    },
  ];
};

beforeEach(() => {
  db.consultations = [];
  db.consultation_intake = [];
  db.consultants = [];
  db.profiles = [];
  rpcCalls.length = 0;
  redisStore.clear();
  mandrillRequests = [];
});

describe("Admin cancellation: cancellation_source persistence", () => {
  it("succeeds for a client_requested cancellation", async () => {
    seedConfirmedConsultation();

    const result = await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: "client called and asked to cancel",
      cancellationSource: "client_requested",
    });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.status === "cancelled");
  });

  it("persists cancellation_source on the row", async () => {
    seedConfirmedConsultation();

    const result = await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    assert.ok(
      result.ok &&
        result.cancellationSource === "client_requested",
    );
    assert.equal(
      db.consultations[0]!.cancellation_source,
      "client_requested",
    );
  });

  it("defaults to admin when the caller omits cancellationSource entirely", async () => {
    seedConfirmedConsultation();

    const result = await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: "a caller that predates migration 058",
    });

    assert.ok(
      result.ok && result.cancellationSource === "admin",
    );
  });

  it("preserves free-text note behaviour unchanged", async () => {
    seedConfirmedConsultation();

    const result = await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: "  scheduling conflict on our side  ",
      cancellationSource: "admin",
    });

    assert.ok(
      result.ok &&
        result.adminAttentionReason ===
          "scheduling conflict on our side",
    );
  });
});

describe("Admin cancellation: follow-up trigger", () => {
  it("sends the follow-up for client_requested", async () => {
    seedConfirmedConsultation();

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    assert.equal(followUpRequests().length, 1);
    assert.equal(
      followUpRequests()[0]!.message.to[0]!.email,
      "amina@example.test",
    );
  });

  it("sends no follow-up for an admin cancellation", async () => {
    seedConfirmedConsultation();

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: "made in error",
      cancellationSource: "admin",
    });

    assert.equal(followUpRequests().length, 0);
  });

  it("sends no follow-up for a system-sourced cancellation", async () => {
    seedConfirmedConsultation();

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "system",
    });

    assert.equal(followUpRequests().length, 0);
  });

  it("sends no follow-up when cancellationSource is omitted (defaults to admin)", async () => {
    seedConfirmedConsultation();

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
    });

    assert.equal(followUpRequests().length, 0);
  });

  it("recipient is consultation_intake.email, not profiles.email", async () => {
    seedConfirmedConsultation();
    /* A deliberately different address on the consultant's own
     * profile, to prove it is never the source used. */
    db.profiles[0]!.email = "wrong-recipient@example.test";

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    const sent = followUpRequests()[0]!.message.to[0]!.email;

    assert.equal(sent, "amina@example.test");
    assert.notEqual(sent, "wrong-recipient@example.test");
  });
});

describe("Admin cancellation: rebook URL by booking type", () => {
  it("standard booking gets the /consultation URL", async () => {
    seedConfirmedConsultation({ booking_source: "standard" });

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    const request = followUpRequests()[0]!;

    assert.ok(
      JSON.stringify(request).includes(
        "https://hijrah.network/consultation",
      ),
    );
  });

  it("direct booking gets the consultant's slug URL", async () => {
    seedConfirmedConsultation({
      booking_source: "direct_booking",
    });
    db.consultants[0]!.consultant_slug = "aisha-rahman";
    db.consultants[0]!.direct_booking_enabled = true;

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    const request = followUpRequests()[0]!;

    assert.ok(
      JSON.stringify(request).includes(
        "https://hijrah.network/aisha-rahman",
      ),
    );
  });
});

describe("Admin cancellation: idempotency and immutability", () => {
  it("a second identical call does not send a duplicate follow-up", async () => {
    seedConfirmedConsultation();

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });
    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    assert.equal(followUpRequests().length, 1);
  });

  /*
   * A later refund of an already client_requested cancellation
   * (cancel today, refund issued next week) is the scenario the
   * Redis-level idempotency in the follow-up service exists for:
   * the orchestrator's own early-return only short-circuits a
   * repeat call carrying the SAME refund flag, so cancel-then-
   * refund genuinely reaches finalizeCancellation a second time.
   * Exercising that specific sequence end to end needs a real
   * Stripe PaymentIntent and a mocked stripe.paymentIntents.
   * retrieve/refund pair, which is disproportionate machinery for
   * one scenario when the property itself is already proven three
   * ways without it: MIGRATION_058_VERIFICATION.sql check 8 proves
   * the RPC's own coalesce immutability directly against
   * PostgreSQL; client-cancellation-followup-notification.test.ts's
   * idempotency suite proves the Redis marker stops a second SEND
   * regardless of how many times it is asked to send; and the test
   * directly below proves the orchestration layer never re-fires
   * the trigger for a call it resolves via its own early return.
   */

  it("cancellation_source is immutable once set, even if a later call supplies a different value", async () => {
    seedConfirmedConsultation();

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "admin",
    });

    await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    assert.equal(
      db.consultations[0]!.cancellation_source,
      "admin",
    );
    assert.equal(
      followUpRequests().length,
      0,
      "the follow-up must not fire retroactively for a repeat call",
    );
  });
});

describe("Admin cancellation: Mandrill failure does not affect the cancellation", () => {
  it("a client_requested cancellation still succeeds even if the follow-up email throws", async () => {
    seedConfirmedConsultation();

    globalThis.fetch = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    const result = await adminCancelConsultation({
      consultationId: CONSULTATION_ID,
      refund: false,
      note: null,
      cancellationSource: "client_requested",
    });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.status === "cancelled");
    assert.equal(
      db.consultations[0]!.status,
      "cancelled",
      "the cancellation itself must still have committed",
    );
  });
});
