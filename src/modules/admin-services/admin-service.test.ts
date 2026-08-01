/*
 * Admin service catalog tests.
 *
 * Nothing external is contacted. Supabase, Stripe and Redis are
 * replaced with in-memory fakes, so no Stripe Product, Price or
 * Payment Link is ever created, in test mode or otherwise.
 *
 * The Stripe fake honours idempotency keys: a repeated create
 * with the same key returns the object it returned before. That
 * is what lets the resume tests assert "exactly one Product"
 * rather than merely asserting a call count.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://admin-services-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_SECRET_KEY: "sk_test_admin_services",
  STRIPE_TEST_SECRET_KEY: "sk_test_admin_services",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_admin_services",
  STRIPE_LIVE_SECRET_KEY: "sk_live_admin_services",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_admin_services",
  STRIPE_WEBHOOK_SECRET: "whsec_admin_services",
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
const { getStripeClient } = await import("../../lib/stripe.js");
/* Amendment 007: one client per mode. Tests run in test mode. */
const stripe = getStripeClient("test");
const { supabaseAdmin } = await import("../../lib/supabase.js");
const { redis } = await import("../../lib/redis.js");
const { registerAdminServiceRoutes } = await import(
  "./admin-service.route.js"
);

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const CONSULTANT_ID = "33333333-3333-3333-3333-333333333333";
/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const SERVICE_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

type DbFailure = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  column?: string;
  remaining: number;
};

type FakeDatabase = {
  /* Amendment 007: the catalog resolves its Stripe mode from here. */
  app_settings: Row[];
  services: Row[];
  service_recommendations: Row[];
  service_requests: Row[];
  profiles: Row[];
};

const APP_SETTINGS_ROW: Row = {
  id: "99999999-9999-4999-8999-999999999999",
  is_singleton: true,
  consultation_price_cents: 15000,
  consultation_currency: "usd",
  consultation_duration_minutes: 60,
  stripe_mode: "test",
  support_email: null,
  default_timezone: "Africa/Cairo",
  updated_at: "2026-08-01T00:00:00.000Z",
  updated_by_admin_profile_id: null,
};

const db: FakeDatabase = {
  app_settings: [{ ...APP_SETTINGS_ROW }],
  services: [],
  service_recommendations: [],
  service_requests: [],
  profiles: [],
};

const tableRows = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

const setTableRows = (table: string, rows: Row[]): void => {
  (db as unknown as Record<string, Row[]>)[table] = rows;
};

let dbFailures: DbFailure[] = [];

/*
 * Lets a test return a count query that succeeded but carries no
 * usable number, which is the shape the fail-closed guard exists
 * for.
 */
type CountOverride = {
  table: string;
  value: unknown;
  remaining: number;
};

let countOverrides: CountOverride[] = [];

const takeDbFailure = (
  table: string,
  op: DbFailure["op"],
  values: Row | null,
): boolean => {
  const match = dbFailures.find(
    (failure) =>
      failure.table === table &&
      failure.op === op &&
      failure.remaining > 0 &&
      (failure.column === undefined ||
        (values !== null &&
          Object.prototype.hasOwnProperty.call(values, failure.column))),
  );

  if (!match) {
    return false;
  }

  match.remaining -= 1;

  return true;
};

const dbError = {
  code: "TEST",
  message: "injected database failure",
  details: null,
  hint: null,
};

class FakeQuery {
  private op: DbFailure["op"] = "select";
  private values: Row | null = null;
  private filters: [string, unknown][] = [];
  private wantsSingle = false;
  private countMode = false;

  constructor(private readonly table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (options?.head) {
      this.countMode = true;
    }
    return this;
  }

  insert(values: Row) {
    this.op = "insert";
    this.values = values;
    return this;
  }

  update(values: Row) {
    this.op = "update";
    this.values = values;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  /*
   * Amendment 007: the settings provider reads with .limit(2) so a
   * violated singleton invariant is detectable. The fake keeps
   * every row; no test relies on truncation.
   */
  limit(_count: number) {
    return this;
  }

  maybeSingle() {
    this.wantsSingle = true;
    return this.run();
  }

  then<T>(resolve: (value: unknown) => T, reject?: (reason: unknown) => T) {
    return this.run().then(resolve, reject);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private async run(): Promise<Row> {
    const rows = tableRows(this.table);

    if (takeDbFailure(this.table, this.op, this.values)) {
      return { data: null, error: dbError, count: null };
    }

    if (this.op === "insert") {
      /*
       * Columns absent from the insert default to NULL in
       * Postgres, so the fake must materialise them too. Without
       * this an omitted column reads back as undefined and hides
       * a genuine difference from the real schema.
       */
      const defaults: Row =
        this.table === "services"
          ? {
              description: null,
              price_display: null,
              is_active: true,
              sort_order: 0,
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              billing_type: null,
              recurring_interval: null,
              price_cents: null,
              currency: null,
              stripe_product_id: null,
              stripe_price_id: null,
              stripe_payment_link_id: null,
              stripe_payment_link_url: null,
            }
          : {};

      const inserted = { ...defaults, ...(this.values ?? {}) } as Row;
      rows.push(inserted);
      return { data: this.wantsSingle ? inserted : [inserted], error: null };
    }

    if (this.op === "update") {
      for (const row of rows.filter((candidate) => this.matches(candidate))) {
        Object.assign(row, this.values ?? {});
      }
      return { data: null, error: null };
    }

    if (this.op === "delete") {
      setTableRows(
        this.table,
        rows.filter((row) => !this.matches(row)),
      );
      return { data: null, error: null };
    }

    const matched = rows.filter((row) => this.matches(row));

    if (this.countMode) {
      const override = countOverrides.find(
        (candidate) =>
          candidate.table === this.table && candidate.remaining > 0,
      );

      if (override) {
        override.remaining -= 1;
        return { data: null, error: null, count: override.value };
      }

      return { data: null, error: null, count: matched.length };
    }

    return {
      data: this.wantsSingle ? (matched[0] ?? null) : matched,
      error: null,
      count: matched.length,
    };
  }
}

type StripeCall = { op: string; args: unknown[] };

let stripeCalls: StripeCall[] = [];
let stripeFailures = new Map<string, number>();
let idempotencyStore = new Map<string, { params: unknown; value: Row }>();
let stripeSequence = 0;

const callsOf = (op: string): StripeCall[] =>
  stripeCalls.filter((call) => call.op === op);

class FakeStripeError extends Error {
  type: string;
  code: string;
  requestId = "req_secret_12345";

  constructor(code = "card_declined", type = "api_error") {
    super("Stripe said: card was declined (decline_code: do_not_honor)");
    this.code = code;
    this.type = type;
  }
}

/*
 * Stripe rejects a reused idempotency key whose parameters
 * differ. Modelling that is the only way a test can prove the
 * Product key covers its parameters.
 */
class FakeStripeIdempotencyError extends Error {
  type = "invalid_request_error";
  code = "idempotency_error";
  requestId = "req_secret_12345";

  constructor() {
    super(
      "Keys for idempotent requests can only be used with the same parameters they were first used with.",
    );
  }
}

type PaymentLinkState = {
  active: boolean;
  priceId: string | null;
};

const paymentLinkState = new Map<string, PaymentLinkState>();
let stripeFailureCodes = new Map<string, string>();

/*
 * Populated only when the fake actually mints a new object. An
 * idempotent replay returns the cached value without touching
 * these, so their size is the true count of resources created.
 */
const mintedProducts = new Set<string>();
const mintedPrices = new Set<string>();
const mintedLinks = new Set<string>();

/*
 * Lets a test hold a Stripe call open so a second request runs
 * while the first is genuinely mid-flight. Without it the winner
 * usually finishes before the loser starts, and the concurrency
 * branches never execute.
 */
let stripeGate: { op: string; promise: Promise<void> } | null = null;

const openStripeGate = (
  op: string,
): (() => void) => {
  let release = (): void => {};

  stripeGate = {
    op,
    promise: new Promise<void>((resolve) => {
      release = () => resolve();
    }),
  };

  return () => {
    stripeGate = null;
    release();
  };
};

const stripeCall = async <T extends Row>(
  op: string,
  args: unknown[],
  idempotencyKey: string | undefined,
  build: () => T,
): Promise<T> => {
  stripeCalls.push({ op, args });

  if (stripeGate && stripeGate.op === op) {
    await stripeGate.promise;
  }

  const remaining = stripeFailures.get(op) ?? 0;

  if (remaining > 0) {
    stripeFailures.set(op, remaining - 1);
    throw new FakeStripeError(
      stripeFailureCodes.get(op) ?? "card_declined",
      stripeFailureCodes.get(op) === "resource_missing"
        ? "invalid_request_error"
        : "api_error",
    );
  }

  if (idempotencyKey) {
    const existing = idempotencyStore.get(idempotencyKey);

    if (existing) {
      /*
       * Same key, different parameters is an error in Stripe, not
       * a silent replay.
       */
      if (
        JSON.stringify(existing.params) !== JSON.stringify(args[0] ?? null)
      ) {
        throw new FakeStripeIdempotencyError();
      }

      return existing.value as T;
    }
  }

  const created = build();

  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, {
      params: args[0] ?? null,
      value: created,
    });
  }

  return created;
};

const redisStore = new Map<string, string>();

const installStubs = (): void => {
  db.app_settings = [
    { ...APP_SETTINGS_ROW },
  ];
  db.services = [];
  db.service_recommendations = [];
  db.service_requests = [];
  db.profiles = [
    { id: ADMIN_ID, role: "admin", email: "admin@example.test" },
    { id: CLIENT_ID, role: "client", email: "client@example.test" },
    { id: CONSULTANT_ID, role: "consultant", email: "c@example.test" },
  ];
  dbFailures = [];
  stripeCalls = [];
  stripeFailures = new Map();
  stripeFailureCodes = new Map();
  idempotencyStore = new Map();
  paymentLinkState.clear();
  mintedProducts.clear();
  mintedPrices.clear();
  mintedLinks.clear();
  stripeSequence = 0;
  redisStore.clear();
  countOverrides = [];

  /*
   * Reset unconditionally. A concurrency test that fails between
   * opening and releasing the gate would otherwise leave it held,
   * blocking every later test that touches the gated Stripe call
   * and burying the original failure.
   */
  stripeGate = null;

  supabaseAdmin.from = ((table: string) =>
    new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

  supabaseAdmin.auth = {
    getUser: async (token: string) => {
      const map: Record<string, string> = {
        "admin-token": ADMIN_ID,
        "client-token": CLIENT_ID,
        "consultant-token": CONSULTANT_ID,
      };

      const id = map[token];

      if (!id) {
        return { data: { user: null }, error: { message: "invalid" } };
      }

      return { data: { user: { id } }, error: null };
    },
  } as unknown as typeof supabaseAdmin.auth;

  stripe.products.create = (async (params: Row, options?: Row) =>
    stripeCall("products.create", [params], options?.idempotencyKey as string, () => {
      const id = `prod_${++stripeSequence}`;
      mintedProducts.add(id);
      return { id, active: true };
    })) as unknown as typeof stripe.products.create;

  stripe.products.update = (async (id: string, params: Row) =>
    stripeCall("products.update", [id, params], undefined, () => ({
      id,
      active: params.active !== false,
    }))) as unknown as typeof stripe.products.update;

  stripe.prices.create = (async (params: Row, options?: Row) =>
    stripeCall("prices.create", [params], options?.idempotencyKey as string, () => {
      const id = `price_${++stripeSequence}`;
      mintedPrices.add(id);
      return { id, active: true };
    })) as unknown as typeof stripe.prices.create;

  stripe.prices.update = (async (id: string, params: Row) =>
    stripeCall("prices.update", [id, params], undefined, () => ({
      id,
      active: false,
    }))) as unknown as typeof stripe.prices.update;

  stripe.paymentLinks.create = (async (params: Row, options?: Row) =>
    stripeCall(
      "paymentLinks.create",
      [params],
      options?.idempotencyKey as string,
      () => {
        const id = `plink_${++stripeSequence}`;
        const lineItems = params.line_items as { price: string }[];
        const priceId = lineItems[0]?.price ?? null;

        mintedLinks.add(id);
        paymentLinkState.set(id, { active: true, priceId });

        return { id, url: `https://buy.stripe.test/${id}`, active: true };
      },
    )) as unknown as typeof stripe.paymentLinks.create;

  stripe.paymentLinks.update = (async (id: string, params: Row) =>
    stripeCall("paymentLinks.update", [id, params], undefined, () => {
      const state = paymentLinkState.get(id);

      if (state && params.active === false) {
        state.active = false;
      }

      return {
        id,
        active: params.active !== false,
        url: `https://buy.stripe.test/${id}`,
      };
    })) as unknown as typeof stripe.paymentLinks.update;

  /*
   * Mirrors the real API: line_items appear only when expanded.
   */
  stripe.paymentLinks.retrieve = (async (id: string, params?: Row) =>
    stripeCall("paymentLinks.retrieve", [id, params], undefined, () => {
      const state = paymentLinkState.get(id) ?? {
        active: true,
        priceId: null,
      };

      const expanded = (params?.expand as string[] | undefined)?.includes(
        "line_items",
      );

      return {
        id,
        active: state.active,
        url: `https://buy.stripe.test/${id}`,
        ...(expanded
          ? {
              line_items: {
                data: state.priceId
                  ? [{ price: { id: state.priceId } }]
                  : [],
              },
            }
          : {}),
      };
    })) as unknown as typeof stripe.paymentLinks.retrieve;

  redis.set = (async (
    key: string,
    value: string,
    ...rest: unknown[]
  ) => {
    const nx = rest.includes("NX");

    if (nx && redisStore.has(key)) {
      return null;
    }

    redisStore.set(key, value);

    return "OK";
  }) as unknown as typeof redis.set;

  redis.get = (async (key: string) =>
    redisStore.get(key) ?? null) as unknown as typeof redis.get;

  redis.eval = (async (
    script: string,
    _numKeys: number,
    key: string,
    ...args: string[]
  ) => {
    const current = redisStore.get(key);

    if (current !== args[0]) {
      return 0;
    }

    if (script.includes('"del"')) {
      redisStore.delete(key);
      return 1;
    }

    redisStore.set(key, args[1] as string);

    return 1;
  }) as unknown as typeof redis.eval;
};

const buildApp = async () => {
  const app = Fastify({ logger: false });
  await registerAdminServiceRoutes(app);
  await app.ready();
  return app;
};

type ApiResponse = {
  statusCode: number;
  body: {
    ok: boolean;
    data?: {
      service?: Row;
      deleted?: boolean;
      id?: string;
    };
    error?: { code: string; message: string; details?: Row };
  };
};

const request = async (options: {
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  token?: string | null;
  body?: unknown;
  idempotencyKey?: string | string[] | null;
}): Promise<ApiResponse> => {
  const app = await buildApp();

  try {
    const headers: Record<string, string | string[]> = {};

    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    if (options.token !== null) {
      headers.authorization = `Bearer ${options.token ?? "admin-token"}`;
    }

    if (options.idempotencyKey !== null && options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const response = await app.inject({
      method: options.method,
      url: options.url,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });

    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
};

const PRICED = {
  name: "Relocation Package",
  billing_type: "one_time",
  price_cents: 50_000,
  currency: "usd",
};

const KEY_A = "idem-key-aaaaaaaaaaaaaaaa";
const KEY_B = "idem-key-bbbbbbbbbbbbbbbb";

const createPriced = (key = KEY_A, body: Row = PRICED) =>
  request({
    method: "POST",
    url: "/api/admin/services",
    idempotencyKey: key,
    body,
  });

const seedService = (overrides: Row = {}): Row => {
  const row: Row = {
    id: SERVICE_ID,
    name: "Seeded",
    description: null,
    price_display: null,
    is_active: false,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    billing_type: null,
    recurring_interval: null,
    price_cents: null,
    currency: null,
    stripe_product_id: null,
    stripe_price_id: null,
    stripe_payment_link_id: null,
    stripe_payment_link_url: null,
    ...overrides,
  };

  db.services.push(row);

  return row;
};

const seedPricedActive = (overrides: Row = {}) => {
  paymentLinkState.set("plink_seed", {
    active: true,
    priceId: "price_seed",
  });

  return seedService({
    is_active: true,
    billing_type: "one_time",
    price_cents: 50_000,
    currency: "usd",
    price_display: "$500",
    stripe_product_id: "prod_seed",
    stripe_price_id: "price_seed",
    stripe_payment_link_id: "plink_seed",
    stripe_payment_link_url: "https://buy.stripe.test/plink_seed",
    ...overrides,
  });
};

describe("admin services: authorization", () => {
  beforeEach(installStubs);

  const endpoints: {
    method: "POST" | "PATCH" | "DELETE";
    url: string;
    body?: unknown;
    idempotencyKey?: string;
  }[] = [
    { method: "POST", url: "/api/admin/services", body: { name: "x" }, idempotencyKey: KEY_A },
    { method: "PATCH", url: `/api/admin/services/${SERVICE_ID}`, body: { name: "x" } },
    { method: "POST", url: `/api/admin/services/${SERVICE_ID}/activate` },
    { method: "POST", url: `/api/admin/services/${SERVICE_ID}/deactivate` },
    { method: "DELETE", url: `/api/admin/services/${SERVICE_ID}?confirm=true` },
  ];

  for (const endpoint of endpoints) {
    it(`rejects a missing token on ${endpoint.method} ${endpoint.url}`, async () => {
      const response = await request({ ...endpoint, token: null });

      assert.equal(response.statusCode, 401);
      assert.equal(response.body.error?.code, "UNAUTHENTICATED");
      assert.notEqual(response.body.error?.code, "UNAUTHORIZED");
    });

    it(`rejects a client on ${endpoint.method} ${endpoint.url}`, async () => {
      const response = await request({ ...endpoint, token: "client-token" });

      assert.equal(response.statusCode, 403);
      assert.equal(response.body.error?.code, "FORBIDDEN");
    });

    it(`rejects a consultant on ${endpoint.method} ${endpoint.url}`, async () => {
      const response = await request({ ...endpoint, token: "consultant-token" });

      assert.equal(response.statusCode, 403);
      assert.equal(response.body.error?.code, "FORBIDDEN");
    });
  }

  it("re-reads the role from the database, not the token", async () => {
    const profile = db.profiles.find((row) => row.id === ADMIN_ID);
    assert.ok(profile);
    profile.role = "client";

    const response = await createPriced();

    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error?.code, "FORBIDDEN");
    assert.equal(db.services.length, 0);
  });
});

describe("admin services: validation", () => {
  beforeEach(installStubs);

  const invalidBodies: [string, Row][] = [
    ["missing name", { billing_type: "one_time", price_cents: 1, currency: "usd" }],
    ["empty name", { name: "" }],
    ["price without billing_type", { name: "n", price_cents: 100, currency: "usd" }],
    ["billing_type without price", { name: "n", billing_type: "one_time" }],
    ["price without currency", { name: "n", billing_type: "one_time", price_cents: 100 }],
    ["currency alone", { name: "n", currency: "usd" }],
    ["recurring without interval", { name: "n", billing_type: "recurring", price_cents: 100, currency: "usd" }],
    [
      "one_time with interval",
      { name: "n", billing_type: "one_time", recurring_interval: "month", price_cents: 100, currency: "usd" },
    ],
    ["currency cad", { name: "n", billing_type: "one_time", price_cents: 100, currency: "cad" }],
    ["currency USD uppercase", { name: "n", billing_type: "one_time", price_cents: 100, currency: "USD" }],
    ["price zero", { name: "n", billing_type: "one_time", price_cents: 0, currency: "usd" }],
    ["price negative", { name: "n", billing_type: "one_time", price_cents: -100, currency: "usd" }],
    ["unknown key", { name: "n", colour: "blue" }],
    ["negative sort_order", { name: "n", sort_order: -1 }],
  ];

  for (const [label, body] of invalidBodies) {
    it(`rejects ${label}`, async () => {
      const response = await createPriced(KEY_A, body);

      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error?.code, "VALIDATION_ERROR");
      assert.equal(db.services.length, 0);
      assert.equal(stripeCalls.length, 0);
    });
  }

  const serverOwned = [
    "id",
    "is_active",
    "price_display",
    "stripe_product_id",
    "stripe_price_id",
    "stripe_payment_link_id",
    "stripe_payment_link_url",
    "created_at",
    "updated_at",
  ];

  for (const key of serverOwned) {
    it(`rejects client-submitted ${key}`, async () => {
      const response = await createPriced(KEY_A, { name: "n", [key]: "x" });

      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error?.code, "VALIDATION_ERROR");
      assert.deepEqual(response.body.error?.details?.forbidden_keys, [key]);
      assert.equal(db.services.length, 0);
      assert.equal(stripeCalls.length, 0);
    });
  }

  it("rejects a malformed service id", async () => {
    const response = await request({
      method: "POST",
      url: "/api/admin/services/not-a-uuid/activate",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error?.code, "VALIDATION_ERROR");
  });
});

describe("admin services: POST idempotency", () => {
  beforeEach(installStubs);

  it("rejects a missing Idempotency-Key", async () => {
    const response = await request({
      method: "POST",
      url: "/api/admin/services",
      body: PRICED,
      idempotencyKey: null,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error?.code, "VALIDATION_ERROR");
    assert.equal(response.body.error?.details?.reason, "idempotency_key_required");
  });

  it("rejects a key shorter than 16 characters", async () => {
    const response = await createPriced("a".repeat(15));

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error?.details?.reason, "idempotency_key_invalid");
  });

  it("accepts keys at both length boundaries", async () => {
    const short = await createPriced("a".repeat(16));
    assert.equal(short.statusCode, 200);

    const long = await createPriced("b".repeat(128), { ...PRICED, name: "Other" });
    assert.equal(long.statusCode, 200);
  });

  it("rejects a key longer than 128 characters", async () => {
    const response = await createPriced("a".repeat(129));

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error?.details?.reason, "idempotency_key_invalid");
  });

  it("rejects a repeated Idempotency-Key header", async () => {
    const response = await request({
      method: "POST",
      url: "/api/admin/services",
      body: PRICED,
      idempotencyKey: [KEY_A, KEY_B],
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error?.details?.reason, "idempotency_key_invalid");
  });

  it("does not consume the key when the body is invalid", async () => {
    const response = await createPriced(KEY_A, { name: "n", currency: "usd" });

    assert.equal(response.statusCode, 400);
    assert.equal([...redisStore.keys()].filter((k) => k.startsWith("service:create:")).length, 0);

    const retry = await createPriced(KEY_A);
    assert.equal(retry.statusCode, 200);
  });

  it("returns the stored response on a completed replay", async () => {
    const first = await createPriced();
    assert.equal(first.statusCode, 200);

    const callsAfterFirst = stripeCalls.length;

    const replay = await createPriced();

    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.body.data?.service, first.body.data?.service);
    assert.equal(db.services.length, 1);
    assert.equal(stripeCalls.length, callsAfterFirst);
  });

  it("rejects the same key with a different payload", async () => {
    await createPriced();

    const response = await createPriced(KEY_A, { ...PRICED, name: "Different" });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error?.code, "INVALID_TRANSITION");
    assert.equal(response.body.error?.details?.reason, "idempotency_key_reused");
    assert.equal(db.services.length, 1);
  });

  it("rejects a concurrent duplicate as request_in_progress", async () => {
    const release = openStripeGate("products.create");

    const firstPromise = createPriced();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await createPriced();

    assert.equal(second.statusCode, 409);
    assert.equal(second.body.error?.code, "INVALID_TRANSITION");
    assert.equal(second.body.error?.details?.reason, "request_in_progress");

    release();

    const first = await firstPromise;

    assert.equal(first.statusCode, 200);
    assert.equal(db.services.length, 1, "exactly one service row");
    assert.equal(callsOf("products.create").length, 1, "exactly one Product");
  });

  it("allows takeover of a stale lease", async () => {
    stripeFailures.set("prices.create", 1);

    const failed = await createPriced();
    assert.equal(failed.statusCode, 502);

    const key = [...redisStore.keys()].find((k) => k.startsWith("service:create:"));
    assert.ok(key);

    const record = JSON.parse(redisStore.get(key) as string);
    record.status = "in_progress";
    record.lease_expires_at = new Date(Date.now() - 60_000).toISOString();
    redisStore.set(key, JSON.stringify(record));

    const retry = await createPriced();

    assert.equal(retry.statusCode, 200);
    assert.equal(db.services.length, 1);
  });

  it("refuses takeover while the lease is live", async () => {
    stripeFailures.set("prices.create", 1);
    await createPriced();

    const key = [...redisStore.keys()].find((k) => k.startsWith("service:create:"));
    assert.ok(key);

    const record = JSON.parse(redisStore.get(key) as string);
    record.status = "in_progress";
    record.lease_expires_at = new Date(Date.now() + 60_000).toISOString();
    redisStore.set(key, JSON.stringify(record));

    const retry = await createPriced();

    assert.equal(retry.statusCode, 409);
    assert.equal(retry.body.error?.details?.reason, "request_in_progress");
  });

  const resumeCases: [string, () => void, number][] = [
    ["insert", () => dbFailures.push({ table: "services", op: "insert", remaining: 1 }), 500],
    ["Product creation", () => stripeFailures.set("products.create", 1), 502],
    [
      "product id persistence",
      () =>
        dbFailures.push({
          table: "services",
          op: "update",
          column: "stripe_product_id",
          remaining: 1,
        }),
      500,
    ],
    ["Price creation", () => stripeFailures.set("prices.create", 1), 502],
    ["Payment Link creation", () => stripeFailures.set("paymentLinks.create", 1), 502],
    [
      "atomic persistence",
      () =>
        dbFailures.push({
          table: "services",
          op: "update",
          column: "stripe_price_id",
          remaining: 1,
        }),
      500,
    ],
  ];

  for (const [label, inject, expectedStatus] of resumeCases) {
    it(`resumes the same row after ${label} failure`, async () => {
      inject();

      const failed = await createPriced();

      assert.equal(failed.statusCode, expectedStatus);
      assert.ok(failed.body.error?.details?.service_id);

      const retry = await createPriced();

      assert.equal(retry.statusCode, 200);
      assert.equal(db.services.length, 1, "exactly one service row");

      /*
       * The Product must be created at most once across the
       * failure and the retry, and every Product create must have
       * resolved to the same object.
       */
      assert.equal(
        mintedProducts.size,
        1,
        "exactly one Product minted across failure and retry",
      );

      const service = retry.body.data?.service as Row;
      assert.equal(service.id, failed.body.error?.details?.service_id);
      assert.equal(service.is_active, false);
      assert.ok(service.stripe_product_id);
      assert.ok(service.stripe_price_id);
      assert.ok(service.stripe_payment_link_id);

      const productIds = new Set(
        db.services.map((row) => row.stripe_product_id),
      );
      assert.equal(productIds.size, 1, "exactly one Product referenced");
    });
  }

  it("resumes after a final Redis completion failure", async () => {
    const first = await createPriced();
    assert.equal(first.statusCode, 200);

    const key = [...redisStore.keys()].find((k) => k.startsWith("service:create:"));
    assert.ok(key);

    const record = JSON.parse(redisStore.get(key) as string);
    record.status = "recoverable_failure";
    record.lease_expires_at = new Date(Date.now() - 60_000).toISOString();
    redisStore.set(key, JSON.stringify(record));

    const retry = await createPriced();

    assert.equal(retry.statusCode, 200);
    assert.equal(db.services.length, 1);
    assert.equal(callsOf("products.create").length, 1);
  });
});

describe("admin services: create", () => {
  beforeEach(installStubs);

  it("makes zero Stripe calls for an unpriced create", async () => {
    const response = await createPriced(KEY_A, { name: "Unpriced" });

    assert.equal(response.statusCode, 200);
    assert.equal(stripeCalls.length, 0);

    const service = response.body.data?.service as Row;
    assert.equal(service.is_active, false);
    assert.equal(service.billing_type, null);
    assert.equal(service.stripe_product_id, null);
  });

  it("provisions Product, Price then Link and stays inactive", async () => {
    const response = await createPriced();

    assert.equal(response.statusCode, 200);

    assert.deepEqual(
      stripeCalls.map((call) => call.op),
      ["products.create", "prices.create", "paymentLinks.create"],
    );

    const service = response.body.data?.service as Row;
    assert.equal(service.is_active, false);
    assert.equal(service.billing_type, "one_time");
    assert.equal(service.price_cents, 50_000);
    assert.equal(service.currency, "usd");
    assert.ok(service.stripe_payment_link_url);
  });

  it("redirects the Payment Link to APP_URL/dashboard", async () => {
    await createPriced();

    const params = callsOf("paymentLinks.create")[0]?.args[0] as Row;
    const afterCompletion = params.after_completion as Row;
    const redirect = afterCompletion.redirect as Row;

    assert.equal(redirect.url, "https://app.example.test/dashboard");
  });

  it("never sets manual capture on a Payment Link", async () => {
    await createPriced();

    const serialised = JSON.stringify(callsOf("paymentLinks.create"));
    assert.equal(serialised.includes("capture_method"), false);
    assert.equal(serialised.includes("manual"), false);
  });

  it("stamps attribution metadata on created objects", async () => {
    await createPriced();

    for (const op of ["products.create", "prices.create", "paymentLinks.create"]) {
      const params = callsOf(op)[0]?.args[0] as Row;
      const metadata = params.metadata as Row;

      assert.ok(metadata.makehijrah_service_id);
      assert.equal(metadata.application, "makehijrah-orchestrator");
      /*
       * APP_ENV, not NODE_ENV. NODE_ENV is "test" in this suite,
       * so asserting "staging" proves the metadata follows the
       * operational label rather than the runtime mode.
       */
      assert.equal(metadata.environment, "staging");
    }
  });

  it("creates a recurring Price with the requested interval", async () => {
    await createPriced(KEY_A, {
      name: "Subscription",
      billing_type: "recurring",
      recurring_interval: "month",
      price_cents: 9_900,
      currency: "gbp",
    });

    const params = callsOf("prices.create")[0]?.args[0] as Row;
    assert.deepEqual(params.recurring, { interval: "month" });
  });
});

describe("admin services: patch", () => {
  beforeEach(installStubs);

  it("updates descriptive fields and the Stripe Product", async () => {
    seedPricedActive();

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { name: "Renamed" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.body.data?.service as Row).name, "Renamed");
    assert.equal(callsOf("products.update").length, 1);
  });

  it("treats a Stripe Product update failure as non-fatal", async () => {
    seedPricedActive();
    stripeFailures.set("products.update", 1);

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { name: "Renamed" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.body.data?.service as Row).name, "Renamed");
  });

  it("commits the database before retiring the superseded resources", async () => {
    seedPricedActive();

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { billing_type: "one_time", price_cents: 75_000, currency: "eur" },
    });

    assert.equal(response.statusCode, 200);

    const ops = stripeCalls.map((call) => call.op);
    const linkCreated = ops.indexOf("paymentLinks.create");
    const linkRetired = ops.indexOf("paymentLinks.update");

    assert.ok(linkCreated >= 0);
    assert.ok(linkRetired > linkCreated, "old link retired after the new one exists");

    const retiredLink = callsOf("paymentLinks.update")[0]?.args[0];
    assert.equal(retiredLink, "plink_seed");

    const retiredPrice = callsOf("prices.update")[0]?.args[0];
    assert.equal(retiredPrice, "price_seed");

    const service = response.body.data?.service as Row;
    assert.equal(service.price_cents, 75_000);
    assert.equal(service.currency, "eur");
    assert.notEqual(service.stripe_payment_link_id, "plink_seed");
  });

  it("reuses the existing Product on a pricing change", async () => {
    seedPricedActive();

    await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { billing_type: "one_time", price_cents: 75_000, currency: "eur" },
    });

    assert.equal(callsOf("products.create").length, 0);
  });

  it("leaves the old link authoritative when Price creation fails", async () => {
    seedPricedActive();
    stripeFailures.set("prices.create", 1);

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { billing_type: "one_time", price_cents: 75_000, currency: "eur" },
    });

    assert.equal(response.statusCode, 502);

    const row = db.services[0] as Row;
    assert.equal(row.price_cents, 50_000);
    assert.equal(row.stripe_payment_link_id, "plink_seed");
    assert.equal(callsOf("paymentLinks.update").length, 0, "old link untouched");
  });

  it("blocks clearing pricing while active", async () => {
    seedPricedActive();

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: {
        billing_type: null,
        recurring_interval: null,
        price_cents: null,
        currency: null,
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error?.details?.reason, "service_active");
    assert.equal(stripeCalls.length, 0);
  });

  it("clears pricing while inactive and retains the Product", async () => {
    seedPricedActive();
    (db.services[0] as Row).is_active = false;

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: {
        billing_type: null,
        recurring_interval: null,
        price_cents: null,
        currency: null,
      },
    });

    assert.equal(response.statusCode, 200);

    const service = response.body.data?.service as Row;
    assert.equal(service.price_cents, null);
    assert.equal(service.stripe_payment_link_id, null);
    assert.equal(service.stripe_product_id, "prod_seed");
    assert.equal(callsOf("paymentLinks.update").length, 1);
  });

  it("rejects a partial pricing clear", async () => {
    seedPricedActive();
    (db.services[0] as Row).is_active = false;

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { price_cents: null },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error?.code, "VALIDATION_ERROR");
  });

  it("returns NOT_FOUND for an unknown service", async () => {
    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { name: "x" },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error?.code, "NOT_FOUND");
  });
});

describe("admin services: activate", () => {
  beforeEach(installStubs);

  it("blocks activation without pricing", async () => {
    seedService();

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error?.details?.reason, "pricing_required");
    assert.equal(stripeCalls.length, 0);
    assert.equal((db.services[0] as Row).is_active, false);
  });

  it("reconciles missing Stripe resources then activates last", async () => {
    seedService({
      billing_type: "one_time",
      price_cents: 50_000,
      currency: "usd",
    });

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);

    assert.deepEqual(
      stripeCalls.map((call) => call.op),
      ["products.create", "prices.create", "paymentLinks.create"],
    );

    const service = response.body.data?.service as Row;
    assert.equal(service.is_active, true);
    assert.ok(service.stripe_payment_link_id);
  });

  it("leaves the service inactive when provisioning fails", async () => {
    seedService({
      billing_type: "one_time",
      price_cents: 50_000,
      currency: "usd",
    });

    stripeFailures.set("paymentLinks.create", 1);

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 502);
    assert.equal((db.services[0] as Row).is_active, false);
  });

  it("is a no-op for an already active service", async () => {
    seedPricedActive();

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(stripeCalls.length, 0);
  });
});

describe("admin services: deactivate", () => {
  beforeEach(installStubs);

  it("deactivates the Payment Link before the database", async () => {
    seedPricedActive();

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/deactivate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(callsOf("paymentLinks.update").length, 1);
    assert.equal(callsOf("paymentLinks.update")[0]?.args[0], "plink_seed");
    assert.equal((db.services[0] as Row).is_active, false);
  });

  it("leaves the service active when link deactivation fails", async () => {
    seedPricedActive();
    stripeFailures.set("paymentLinks.update", 1);

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/deactivate`,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.body.error?.code, "STRIPE_ERROR");
    assert.equal((db.services[0] as Row).is_active, true, "still active and purchasable");
  });

  it("preserves the Product and Price", async () => {
    seedPricedActive();

    await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/deactivate`,
    });

    assert.equal(callsOf("prices.update").length, 0);
    assert.equal(callsOf("products.update").length, 0);
    assert.equal((db.services[0] as Row).stripe_price_id, "price_seed");
  });

  it("deactivates a legacy unpriced service directly", async () => {
    seedService({ is_active: true });

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/deactivate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(stripeCalls.length, 0);
    assert.equal((db.services[0] as Row).is_active, false);
  });

  it("is a no-op for an already inactive service", async () => {
    seedService();

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/deactivate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(stripeCalls.length, 0);
  });
});

describe("admin services: delete", () => {
  beforeEach(installStubs);

  const badConfirms = [
    ["missing", ""],
    ["false", "?confirm=false"],
    ["uppercase TRUE", "?confirm=TRUE"],
    ["numeric 1", "?confirm=1"],
    ["empty", "?confirm="],
    ["unknown key", "?confirm=true&force=yes"],
  ];

  for (const [label, query] of badConfirms) {
    it(`refuses confirmation ${label}`, async () => {
      seedPricedActive();
      (db.services[0] as Row).is_active = false;

      const response = await request({
        method: "DELETE",
        url: `/api/admin/services/${SERVICE_ID}${query}`,
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error?.code, "VALIDATION_ERROR");
      assert.equal(response.body.error?.details?.reason, "confirmation_required");
      assert.equal(stripeCalls.length, 0);
      assert.equal(db.services.length, 1);
    });
  }

  it("blocks deletion of an active service", async () => {
    seedPricedActive();

    const response = await request({
      method: "DELETE",
      url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error?.details?.reason, "service_active");
    assert.equal(stripeCalls.length, 0);
    assert.equal(db.services.length, 1);
  });

  it("blocks deletion of a referenced service with counts", async () => {
    seedPricedActive();
    (db.services[0] as Row).is_active = false;

    db.service_recommendations.push({ id: "r1", service_id: SERVICE_ID });
    db.service_recommendations.push({ id: "r2", service_id: SERVICE_ID });

    const response = await request({
      method: "DELETE",
      url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error?.details?.reason, "service_in_use");
    assert.deepEqual(response.body.error?.details?.references, {
      service_recommendations: 2,
      service_requests: 0,
    });
    assert.equal(stripeCalls.length, 0, "no Stripe call when blocked");
    assert.equal(db.services.length, 1);
  });

  it("blocks deletion when a service_request references it", async () => {
    seedService();
    db.service_requests.push({ id: "q1", service_id: SERVICE_ID });

    const response = await request({
      method: "DELETE",
      url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body.error?.details?.references, {
      service_recommendations: 0,
      service_requests: 1,
    });
  });

  it("tears down Link, Price, Product then deletes the row", async () => {
    seedPricedActive();
    (db.services[0] as Row).is_active = false;

    const response = await request({
      method: "DELETE",
      url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.deleted, true);

    assert.deepEqual(
      stripeCalls.map((call) => call.op),
      ["paymentLinks.update", "prices.update", "products.update"],
    );

    assert.equal(db.services.length, 0);
  });

  it("retains the row when teardown fails", async () => {
    seedPricedActive();
    (db.services[0] as Row).is_active = false;
    stripeFailures.set("products.update", 1);

    const response = await request({
      method: "DELETE",
      url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.body.error?.code, "STRIPE_ERROR");
    assert.equal(db.services.length, 1, "row retained");
  });

  it("logs the Stripe identifiers before removing the row", async () => {
    seedPricedActive();
    (db.services[0] as Row).is_active = false;

    const logged: unknown[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      await request({
        method: "DELETE",
        url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
      });
    } finally {
      console.info = originalInfo;
    }

    const serialised = JSON.stringify(logged);
    assert.ok(serialised.includes("prod_seed"));
    assert.ok(serialised.includes("price_seed"));
    assert.ok(serialised.includes("plink_seed"));
  });

  it("never issues a Stripe delete call", async () => {
    seedPricedActive();
    (db.services[0] as Row).is_active = false;

    await request({
      method: "DELETE",
      url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
    });

    for (const call of stripeCalls) {
      assert.equal(call.op.endsWith(".del"), false);
      assert.equal(call.op.endsWith(".delete"), false);
    }
  });
});

describe("admin services: concurrency and sanitisation", () => {
  beforeEach(installStubs);

  it("serialises concurrent mutations of one service", async () => {
    seedService({
      billing_type: "one_time",
      price_cents: 50_000,
      currency: "usd",
    });

    const release = openStripeGate("products.create");

    const firstPromise = request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(second.statusCode, 409);
    assert.equal(second.body.error?.details?.reason, "mutation_in_progress");

    release();

    const first = await firstPromise;

    assert.equal(first.statusCode, 200);
    assert.equal(callsOf("paymentLinks.create").length, 1);
  });

  it("keeps the race safe when a stale worker resumes after takeover", async () => {
    stripeFailures.set("prices.create", 1);

    const failed = await createPriced();
    assert.equal(failed.statusCode, 502);

    const key = [...redisStore.keys()].find((k) =>
      k.startsWith("service:create:"),
    );
    assert.ok(key);

    const stale = redisStore.get(key) as string;

    const record = JSON.parse(stale);
    record.status = "in_progress";
    record.lease_expires_at = new Date(Date.now() - 60_000).toISOString();
    redisStore.set(key, JSON.stringify(record));

    /* Worker B takes over and completes. */
    const takeover = await createPriced();
    assert.equal(takeover.statusCode, 200);

    /* Worker A resumes against its now-stale view and must not win. */
    redisStore.set(key, stale);
    const resumed = await createPriced();

    assert.equal(db.services.length, 1, "one row across both workers");
    assert.equal(mintedProducts.size, 1, "one Product across both workers");
    assert.equal(mintedLinks.size, 1, "one Payment Link across both workers");

    const row = db.services[0] as Row;
    assert.equal(row.stripe_payment_link_id, [...mintedLinks][0]);
    assert.ok(resumed.statusCode === 200 || resumed.statusCode === 409);
  });

  it("never leaks Stripe error detail to the client", async () => {
    seedService({
      billing_type: "one_time",
      price_cents: 50_000,
      currency: "usd",
    });

    stripeFailures.set("paymentLinks.create", 1);

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 502);

    const serialised = JSON.stringify(response.body);
    assert.equal(serialised.includes("req_secret_12345"), false);
    assert.equal(serialised.includes("do_not_honor"), false);
    assert.equal(serialised.includes("declined"), false);
    assert.equal(serialised.includes("api_error"), false);
    assert.equal(serialised.includes("resource_missing"), false);
  });
});

describe("admin services: pricing generations", () => {
  beforeEach(installStubs);

  it("creates fresh resources when pricing reverts to a previous value", async () => {
    /*
     * A is created through the API so its Stripe idempotency keys
     * are genuinely recorded. Seeding the row instead would leave
     * no cached response for A, and the replay this test exists
     * to catch could not occur.
     */
    const created = await createPriced();
    assert.equal(created.statusCode, 200);

    const serviceId = (created.body.data?.service as Row).id as string;
    const originalPriceId = (created.body.data?.service as Row)
      .stripe_price_id as string;
    const originalLinkId = (created.body.data?.service as Row)
      .stripe_payment_link_id as string;

    const SERVICE_ID = serviceId;

    const toB = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { billing_type: "one_time", price_cents: 75_000, currency: "eur" },
    });

    assert.equal(toB.statusCode, 200);

    /* Snapshot: db rows are live objects mutated in place. */
    const afterB = { ...(db.services[0] as Row) };
    assert.notEqual(afterB.stripe_price_id, originalPriceId);
    assert.notEqual(afterB.stripe_payment_link_id, originalLinkId);

    /* A's resources were retired. */
    assert.equal(paymentLinkState.get(originalLinkId)?.active, false);

    const backToA = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { billing_type: "one_time", price_cents: 50_000, currency: "usd" },
    });

    assert.equal(backToA.statusCode, 200);

    const service = backToA.body.data?.service as Row;

    assert.equal(service.price_cents, 50_000);
    assert.equal(service.currency, "usd");

    /* The second A must not resurrect the first A's retired pair. */
    assert.notEqual(service.stripe_price_id, originalPriceId);
    assert.notEqual(service.stripe_payment_link_id, originalLinkId);
    assert.notEqual(service.stripe_payment_link_id, afterB.stripe_payment_link_id);

    const currentLink = paymentLinkState.get(
      service.stripe_payment_link_id as string,
    );

    assert.equal(currentLink?.active, true, "current Link is live");
    assert.equal(currentLink?.priceId, service.stripe_price_id);

    assert.equal(mintedPrices.size, 3, "a new Price for each of A, B and A'");
    assert.equal(mintedLinks.size, 3, "a new Link for each of A, B and A'");
  });

  it("keeps the key stable when the same transition is retried", async () => {
    seedPricedActive();
    stripeFailures.set("paymentLinks.create", 1);

    const failed = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { billing_type: "one_time", price_cents: 75_000, currency: "eur" },
    });

    assert.equal(failed.statusCode, 502);

    const retry = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { billing_type: "one_time", price_cents: 75_000, currency: "eur" },
    });

    assert.equal(retry.statusCode, 200);
    assert.equal(mintedPrices.size, 1, "retry reused the in-flight Price");
    assert.equal(mintedLinks.size, 1);
  });
});

describe("admin services: Product idempotency parameters", () => {
  beforeEach(installStubs);

  it("survives a name change between Product creation and its retry", async () => {
    /* Product is created, then persisting its id fails. */
    dbFailures.push({
      table: "services",
      op: "update",
      column: "stripe_product_id",
      remaining: 1,
    });

    const failed = await createPriced();
    assert.equal(failed.statusCode, 500);

    const serviceId = failed.body.error?.details?.service_id as string;
    assert.ok(serviceId);
    assert.equal(mintedProducts.size, 1);

    /*
     * The administrator renames the service before retrying. With
     * a parameter-blind key this retry would hit Stripe's
     * idempotency-parameter error and stay stuck for 24 hours.
     */
    const row = db.services[0] as Row;
    row.name = "Renamed Before Retry";

    const retry = await createPriced();

    assert.equal(
      retry.statusCode,
      200,
      "no Stripe idempotency-parameter error",
    );

    const service = retry.body.data?.service as Row;
    assert.ok(service.stripe_product_id);
    assert.ok(service.stripe_payment_link_id);
    assert.equal(db.services.length, 1, "one service row");
    assert.equal(
      new Set(db.services.map((r) => r.stripe_product_id)).size,
      1,
      "one Product stored on the row",
    );
  });

  it("rejects a reused key with different parameters, proving the fake is strict", async () => {
    await createPriced();

    const key = callsOf("products.create").length;
    assert.equal(key, 1);

    /*
     * Directly re-invoking the stub with the same key but altered
     * params must throw, otherwise the test above proves nothing.
     */
    await assert.rejects(async () => {
      await stripe.products.create(
        { name: "Different", metadata: {} } as never,
        { idempotencyKey: [...idempotencyStore.keys()][0] } as never,
      );
    });
  });
});

describe("admin services: reference counting fails closed", () => {
  beforeEach(installStubs);

  const invalidCounts: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
  ];

  for (const [label, value] of invalidCounts) {
    it(`refuses deletion when a count is ${label}`, async () => {
      seedPricedActive({ is_active: false });

      countOverrides.push({
        table: "service_recommendations",
        value,
        remaining: 1,
      });

      const response = await request({
        method: "DELETE",
        url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
      });

      assert.equal(response.statusCode, 500);
      assert.equal(response.body.error?.code, "INTERNAL");
      assert.equal(stripeCalls.length, 0, "no Stripe teardown");
      assert.equal(db.services.length, 1, "row retained");
    });
  }

  it("refuses deletion when the second table returns an invalid count", async () => {
    seedPricedActive({ is_active: false });

    countOverrides.push({
      table: "service_requests",
      value: null,
      remaining: 1,
    });

    const response = await request({
      method: "DELETE",
      url: `/api/admin/services/${SERVICE_ID}?confirm=true`,
    });

    assert.equal(response.statusCode, 500);
    assert.equal(stripeCalls.length, 0);
    assert.equal(db.services.length, 1);
  });
});

describe("admin services: Payment Link verification", () => {
  beforeEach(installStubs);

  it("reuses an active Link that references the expected Price", async () => {
    seedPricedActive({ is_active: false });

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(mintedLinks.size, 0, "existing Link reused");
    assert.equal((db.services[0] as Row).stripe_payment_link_id, "plink_seed");
  });

  it("replaces a Link that references another Price", async () => {
    seedPricedActive({ is_active: false });
    paymentLinkState.set("plink_seed", {
      active: true,
      priceId: "price_somethingelse",
    });

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(mintedLinks.size, 1, "replacement Link created");
    assert.notEqual(
      (db.services[0] as Row).stripe_payment_link_id,
      "plink_seed",
    );
  });

  it("replaces an inactive Link", async () => {
    seedPricedActive({ is_active: false });
    paymentLinkState.set("plink_seed", {
      active: false,
      priceId: "price_seed",
    });

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(mintedLinks.size, 1);
  });

  it("replaces a Link with no usable line item", async () => {
    seedPricedActive({ is_active: false });
    paymentLinkState.set("plink_seed", { active: true, priceId: null });

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(mintedLinks.size, 1);
  });

  it("expands line items when retrieving the Link", async () => {
    seedPricedActive({ is_active: false });

    await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    const params = callsOf("paymentLinks.retrieve")[0]?.args[1] as Row;
    assert.deepEqual(params.expand, ["line_items"]);
  });
});

describe("admin services: resource_missing reconciliation", () => {
  beforeEach(installStubs);

  it("replaces a stored Link that Stripe no longer knows about", async () => {
    seedPricedActive({ is_active: false });
    stripeFailures.set("paymentLinks.retrieve", 1);
    stripeFailureCodes.set("paymentLinks.retrieve", "resource_missing");

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);

    const service = response.body.data?.service as Row;
    assert.notEqual(service.stripe_payment_link_id, "plink_seed");
    assert.equal(mintedLinks.size, 1, "replacement persisted");
    assert.equal(service.is_active, true, "activation happened last");

    const serialised = JSON.stringify(response.body);
    assert.equal(serialised.includes("resource_missing"), false);
  });

  it("still fails on a non-resource_missing retrieval error", async () => {
    seedPricedActive({ is_active: false });
    stripeFailures.set("paymentLinks.retrieve", 1);
    stripeFailureCodes.set("paymentLinks.retrieve", "rate_limit");

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.body.error?.code, "STRIPE_ERROR");
    assert.equal((db.services[0] as Row).is_active, false);
    assert.equal(mintedLinks.size, 0);
  });
});

describe("admin services: price_display", () => {
  beforeEach(installStubs);

  const formatterCases: [Row, string][] = [
    [{ billing_type: "one_time", price_cents: 15_000, currency: "usd" }, "$150"],
    [{ billing_type: "one_time", price_cents: 1_299, currency: "usd" }, "$12.99"],
    [
      {
        billing_type: "recurring",
        recurring_interval: "month",
        price_cents: 9_900,
        currency: "gbp",
      },
      "£99/month",
    ],
    [
      {
        billing_type: "recurring",
        recurring_interval: "year",
        price_cents: 120_000,
        currency: "eur",
      },
      "€1,200/year",
    ],
    [{ billing_type: "one_time", price_cents: 1, currency: "usd" }, "$0.01"],
    [
      { billing_type: "one_time", price_cents: 100_000_00, currency: "usd" },
      "$100,000",
    ],
  ];

  for (const [pricing, expected] of formatterCases) {
    it(`formats ${JSON.stringify(pricing)} as ${expected}`, async () => {
      const response = await createPriced(KEY_A, {
        name: "Formatted",
        ...pricing,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(
        (response.body.data?.service as Row).price_display,
        expected,
      );
    });
  }

  it("regenerates price_display on a pricing change", async () => {
    seedPricedActive();

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: {
        billing_type: "recurring",
        recurring_interval: "month",
        price_cents: 9_900,
        currency: "gbp",
      },
    });

    assert.equal(
      (response.body.data?.service as Row).price_display,
      "£99/month",
    );
  });

  it("clears price_display when pricing is cleared", async () => {
    seedPricedActive({ is_active: false });

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: {
        billing_type: null,
        recurring_interval: null,
        price_cents: null,
        currency: null,
      },
    });

    assert.equal((response.body.data?.service as Row).price_display, null);
  });

  it("repairs a stale price_display during activation", async () => {
    seedPricedActive({ is_active: false, price_display: "wrong legacy text" });

    const response = await request({
      method: "POST",
      url: `/api/admin/services/${SERVICE_ID}/activate`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.body.data?.service as Row).price_display, "$500");
  });

  it("leaves an unpriced legacy value untouched", async () => {
    seedService({ price_display: "legacy free text" });

    const response = await request({
      method: "PATCH",
      url: `/api/admin/services/${SERVICE_ID}`,
      body: { name: "Renamed" },
    });

    assert.equal(
      (response.body.data?.service as Row).price_display,
      "legacy free text",
    );
  });
});
