/*
 * Client service purchase list tests.
 *
 * public.service_purchases stays closed to clients at the database
 * layer — migration 034's policy names the attributed consultant
 * and an admin and nobody else, and this endpoint does not change
 * it. So the whole security question here is whether the
 * orchestrator's narrow read leaks anything the table would not
 * have, and these tests answer it two ways: by asserting the
 * response key set exactly, and by asserting that no finance or
 * Stripe value appears anywhere in the serialized body.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://client-purchases-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_client_purchases",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_client_purchases",
  STRIPE_LIVE_SECRET_KEY: "sk_live_client_purchases",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_client_purchases",
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

const { default: Fastify } = await import("fastify");
const { supabaseAdmin } = await import("../../lib/supabase.js");
const { registerClientServicePurchasesRoute } = await import(
  "./client-service-purchases.route.js"
);

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CLIENT_PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT_PROFILE = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
const CONSULTANT_PROFILE = "22222222-2222-4222-8222-222222222222";
const ADMIN_PROFILE = "33333333-3333-4333-8333-333333333333";

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";

/* Values that must NEVER reach a client. Each is distinctive so a
   leak is unmistakable in the serialized body. */
const SECRET_PAYMENT_INTENT = "pi_secret_leak_marker";
const SECRET_SESSION = "cs_secret_leak_marker";
const SECRET_INVOICE = "in_secret_leak_marker";
const SECRET_SUBSCRIPTION = "sub_secret_leak_marker";

type Row = Record<string, unknown>;

const db: { profiles: Row[]; service_purchases: Row[] } = {
  profiles: [],
  service_purchases: [],
};

/*
 * The fake honours the SELECT column list, exactly as PostgREST
 * does. That matters: if the projection were ever widened to
 * select-star, these tests would start seeing the secret markers
 * and fail — which is the whole point of asserting on them.
 */
class FakeQuery {
  private readonly table: string;
  private columns: string[] = [];
  private readonly filters: Array<(row: Row) => boolean> = [];
  private readonly sorts: Array<{
    column: string;
    ascending: boolean;
  }> = [];
  private max: number | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(columns?: string): this {
    this.columns = (columns ?? "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);

    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  order(
    column: string,
    options?: { ascending?: boolean },
  ): this {
    this.sorts.push({
      column,
      ascending: options?.ascending !== false,
    });

    return this;
  }

  limit(count: number): this {
    this.max = count;
    return this;
  }

  private rows(): Row[] {
    let rows = (
      (db as unknown as Record<string, Row[] | undefined>)[
        this.table
      ] ?? []
    ).filter((row) =>
      this.filters.every((matches) => matches(row)),
    );

    for (const sort of [...this.sorts].reverse()) {
      rows = [...rows].sort((a, b) => {
        const left = String(a[sort.column] ?? "");
        const right = String(b[sort.column] ?? "");
        const comparison = left.localeCompare(right);

        return sort.ascending ? comparison : -comparison;
      });
    }

    if (this.max !== null) {
      rows = rows.slice(0, this.max);
    }

    /* Project exactly the requested columns. */
    return rows.map((row) => {
      if (this.columns.length === 0) {
        return row;
      }

      const projected: Row = {};

      for (const column of this.columns) {
        projected[column] = row[column];
      }

      return projected;
    });
  }

  /* The auth layer loads the caller's profile this way. */
  async maybeSingle(): Promise<{
    data: Row | null;
    error: unknown;
  }> {
    return { data: this.rows()[0] ?? null, error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          data: Row[];
          error: unknown;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({
      data: this.rows(),
      error: null,
    }).then(onFulfilled, onRejected);
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

supabaseAdmin.auth = {
  getUser: async (token: string) => {
    const profile = db.profiles.find(
      (row) => row.id === token,
    );

    if (!profile) {
      return {
        data: { user: null },
        error: { message: "invalid token" },
      };
    }

    return {
      data: { user: { id: profile.id } },
      error: null,
    };
  },
} as unknown as typeof supabaseAdmin.auth;

const app = Fastify();
await registerClientServicePurchasesRoute(app);
await app.ready();

const get = async (
  token: string | null,
): Promise<{
  statusCode: number;
  raw: string;
  json: () => {
    ok: boolean;
    data?: { purchases: Row[] };
    error?: Row;
  };
}> => {
  const response = await app.inject({
    method: "GET",
    url: "/api/me/service-purchases",
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
  });

  return {
    statusCode: response.statusCode,
    raw: response.body,
    json: () =>
      response.json() as {
        ok: boolean;
        data?: { purchases: Row[] };
        error?: Row;
      },
  };
};

const purchase = (overrides: Row = {}): Row => ({
  id: "99999999-9999-4999-8999-000000000001",
  service_id: SERVICE_ID,
  service_request_id: "77777777-7777-4777-8777-777777777777",
  consultation_id: CONSULTATION_ID,
  client_profile_id: CLIENT_PROFILE,
  attributed_consultant_id: CONSULTANT_ID,
  gross_amount_minor: 9_999,
  currency: "usd",
  billing_type: "one_time",
  recurring_interval: null,
  billing_period_sequence: 1,
  status: "paid",
  stripe_mode: "test",
  stripe_payment_intent_id: SECRET_PAYMENT_INTENT,
  stripe_checkout_session_id: SECRET_SESSION,
  stripe_invoice_id: SECRET_INVOICE,
  stripe_subscription_id: SECRET_SUBSCRIPTION,
  refunded_amount_minor: 0,
  purchased_at: "2026-08-01T10:00:00.000Z",
  fulfilled_at: null,
  refunded_at: null,
  ...overrides,
});

beforeEach(() => {
  db.profiles = [
    { id: CLIENT_PROFILE, role: "client" },
    { id: OTHER_CLIENT_PROFILE, role: "client" },
    { id: CONSULTANT_PROFILE, role: "consultant" },
    { id: ADMIN_PROFILE, role: "admin" },
  ];

  db.service_purchases = [];
});

describe("Client service purchases: scoping", () => {
  it("returns the caller's own purchases", async () => {
    db.service_purchases = [purchase()];

    const response = await get(CLIENT_PROFILE);

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data!.purchases.length,
      1,
    );
    assert.equal(
      response.json().data!.purchases[0]!.service_id,
      SERVICE_ID,
    );
  });

  it("never returns another client's purchases", async () => {
    db.service_purchases = [
      purchase(),
      purchase({
        id: "99999999-9999-4999-8999-000000000002",
        client_profile_id: OTHER_CLIENT_PROFILE,
        gross_amount_minor: 12_345,
      }),
    ];

    const response = await get(CLIENT_PROFILE);
    const purchases = response.json().data!.purchases;

    assert.equal(purchases.length, 1);
    assert.equal(
      purchases[0]!.id,
      "99999999-9999-4999-8999-000000000001",
    );
    assert.ok(
      !response.raw.includes("12345"),
      "another client's amount must not appear anywhere in the body",
    );
  });

  it("returns an empty list rather than an error when there are none", async () => {
    const response = await get(CLIENT_PROFILE);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().data!.purchases,
      [],
    );
  });

  it("sorts newest first", async () => {
    db.service_purchases = [
      purchase({
        id: "99999999-9999-4999-8999-000000000001",
        purchased_at: "2026-06-01T10:00:00.000Z",
      }),
      purchase({
        id: "99999999-9999-4999-8999-000000000003",
        purchased_at: "2026-08-15T10:00:00.000Z",
      }),
      purchase({
        id: "99999999-9999-4999-8999-000000000002",
        purchased_at: "2026-07-01T10:00:00.000Z",
      }),
    ];

    const purchases = (
      await get(CLIENT_PROFILE)
    ).json().data!.purchases;

    assert.deepEqual(
      purchases.map((row) => row.purchased_at),
      [
        "2026-08-15T10:00:00.000Z",
        "2026-07-01T10:00:00.000Z",
        "2026-06-01T10:00:00.000Z",
      ],
    );
  });

  it("returns every status a purchase can hold", async () => {
    db.service_purchases = [
      purchase({
        id: "99999999-9999-4999-8999-000000000001",
        status: "paid",
      }),
      purchase({
        id: "99999999-9999-4999-8999-000000000002",
        status: "fulfilled",
      }),
      purchase({
        id: "99999999-9999-4999-8999-000000000003",
        status: "refunded",
      }),
    ];

    const purchases = (
      await get(CLIENT_PROFILE)
    ).json().data!.purchases;

    assert.deepEqual(
      purchases.map((row) => row.status).sort(),
      ["fulfilled", "paid", "refunded"],
      "a refunded purchase is still a historical purchase fact and must be returned",
    );
  });

  it("returns recurring purchases with their period", async () => {
    db.service_purchases = [
      purchase({
        billing_type: "recurring",
        recurring_interval: "month",
        billing_period_sequence: 3,
      }),
    ];

    const row = (await get(CLIENT_PROFILE)).json().data!
      .purchases[0]!;

    assert.equal(row.billing_type, "recurring");
    assert.equal(row.recurring_interval, "month");
    assert.equal(row.billing_period_sequence, 3);
  });

  it("returns a purchase with no consultation", async () => {
    db.service_purchases = [
      purchase({ consultation_id: null }),
    ];

    const row = (await get(CLIENT_PROFILE)).json().data!
      .purchases[0]!;

    assert.equal(
      row.consultation_id,
      null,
      "the frontend needs this to decide whether an instructions button is possible",
    );
  });
});

describe("Client service purchases: authorization", () => {
  it("refuses a consultant", async () => {
    db.service_purchases = [purchase()];

    const response = await get(CONSULTANT_PROFILE);

    assert.equal(response.statusCode, 403);
  });

  it("refuses an admin", async () => {
    db.service_purchases = [purchase()];

    const response = await get(ADMIN_PROFILE);

    assert.equal(
      response.statusCode,
      403,
      "an admin reads service_purchases through RLS; a 'me' route resolving to nothing would be a confusing surface",
    );
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await get(null);

    assert.equal(response.statusCode, 401);
  });

  it("refuses an invalid token", async () => {
    const response = await get("not-a-real-token");

    assert.equal(response.statusCode, 401);
  });
});

describe("Client service purchases: privacy of the projection", () => {
  it("returns exactly the ten approved fields", async () => {
    db.service_purchases = [purchase()];

    const row = (await get(CLIENT_PROFILE)).json().data!
      .purchases[0]!;

    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "billing_period_sequence",
        "billing_type",
        "consultation_id",
        "currency",
        "gross_amount_minor",
        "id",
        "purchased_at",
        "recurring_interval",
        "service_id",
        "status",
      ],
      "the projection is the only thing standing between a client and the finance row",
    );
  });

  it("returns no Stripe identifier", async () => {
    db.service_purchases = [purchase()];

    const response = await get(CLIENT_PROFILE);

    for (const secret of [
      SECRET_PAYMENT_INTENT,
      SECRET_SESSION,
      SECRET_INVOICE,
      SECRET_SUBSCRIPTION,
    ]) {
      assert.ok(
        !response.raw.includes(secret),
        `${secret} leaked into the response body`,
      );
    }

    assert.ok(!response.raw.includes("stripe"));
  });

  it("returns no consultant, commission or platform finance data", async () => {
    db.service_purchases = [
      purchase({ refunded_amount_minor: 4_242 }),
    ];

    const response = await get(CLIENT_PROFILE);

    assert.ok(
      !response.raw.includes(CONSULTANT_ID),
      "who earns from this sale is not the buyer's business",
    );
    assert.ok(
      !response.raw.includes("attributed_consultant_id"),
    );
    assert.ok(
      !response.raw.includes("refunded_amount_minor"),
    );
    assert.ok(
      !response.raw.includes("4242"),
      "internal refund accounting must not leak by value either",
    );
    assert.ok(
      !response.raw.includes("commission"),
    );
    assert.ok(!response.raw.includes("platform"));
  });

  it("returns no service_request_id or client_profile_id", async () => {
    db.service_purchases = [purchase()];

    const response = await get(CLIENT_PROFILE);

    assert.ok(
      !response.raw.includes("service_request_id"),
      "the operational workflow record is not needed to render a purchase",
    );
    assert.ok(
      !response.raw.includes("client_profile_id"),
      "the caller already knows who they are; echoing it back widens the surface for nothing",
    );
  });
});
