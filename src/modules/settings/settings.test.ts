/*
 * Admin settings, dynamic pricing and Stripe mode tests.
 * PROJECT_LOCK Amendment 007.
 *
 * Nothing external is contacted. Supabase is an in-memory fake and
 * no Stripe network call is made.
 *
 * Credential values never appear in an assertion by name: the
 * leakage tests scan whole serialised responses for sk_ and whsec_
 * prefixes instead, which is what would actually catch a mistake.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const TEST_SECRET = "sk_test_settings_suite";
const TEST_WHSEC = "whsec_test_settings_suite";
const LIVE_SECRET = "sk_live_settings_suite";
const LIVE_WHSEC = "whsec_live_settings_suite";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://settings-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: TEST_SECRET,
  STRIPE_TEST_WEBHOOK_SECRET: TEST_WHSEC,
  STRIPE_LIVE_SECRET_KEY: LIVE_SECRET,
  STRIPE_LIVE_WEBHOOK_SECRET: LIVE_WHSEC,
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
const { registerSettingsRoutes } = await import(
  "./settings.route.js"
);
const {
  getSettings,
  invalidateSettingsCache,
  SettingsUnavailableError,
} = await import("./settings.provider.js");
const {
  getStripeClient,
  isStripeModeConfigured,
} = await import("../../lib/stripe.js");
const {
  resolveConsultationStripeClient,
  paymentIntentModeMatches,
} = await import(
  "../consultations/consultation-stripe-mode.js"
);

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const CONSULTANT_ID = "33333333-3333-4333-8333-333333333333";
const SETTINGS_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

const db: {
  app_settings: Row[];
  profiles: Row[];
} = {
  app_settings: [],
  profiles: [],
};

const tableRows = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

let failTable: string | null = null;

const dbError = {
  code: "XX000",
  message: "forced test failure",
  details: null,
  hint: null,
};

class FakeQuery {
  private readonly table: string;
  private readonly filters: Array<(row: Row) => boolean> = [];
  private values: Row | null = null;
  private op: "select" | "update" = "select";

  constructor(table: string) {
    this.table = table;
  }

  select(): this {
    return this;
  }

  update(values: Row): this {
    this.op = "update";
    this.values = values;

    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);

    return this;
  }

  limit(): this {
    return this;
  }

  private matchedRows(): Row[] {
    return tableRows(this.table).filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
  }

  private async run(): Promise<{ data: unknown; error: unknown }> {
    if (failTable === this.table) {
      return { data: null, error: dbError };
    }

    if (this.op === "update") {
      const matched = this.matchedRows();

      for (const row of matched) {
        Object.assign(row, this.values ?? {});
      }

      return { data: matched, error: null };
    }

    return { data: this.matchedRows(), error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const result = await this.run();

    if (result.error) {
      return { data: null, error: result.error };
    }

    const rows = result.data as Row[];

    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          data: unknown;
          error: unknown;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected);
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

supabaseAdmin.auth = {
  getUser: async (token: string) => {
    const profile = db.profiles.find((row) => row.id === token);

    if (!profile) {
      return {
        data: { user: null },
        error: { message: "invalid token" },
      };
    }

    return { data: { user: { id: profile.id } }, error: null };
  },
} as unknown as typeof supabaseAdmin.auth;

const settingsRow = (overrides: Row = {}): Row => ({
  id: SETTINGS_ID,
  is_singleton: true,
  consultation_price_cents: 15000,
  consultation_currency: "usd",
  consultation_duration_minutes: 60,
  stripe_mode: "test",
  support_email: null,
  default_timezone: "Africa/Cairo",
  updated_at: "2026-08-01T00:00:00.000Z",
  updated_by_admin_profile_id: null,
  ...overrides,
});

const buildApp = async () => {
  const app = Fastify();

  await registerSettingsRoutes(app);

  return app;
};

const call = async (
  method: "GET" | "PATCH",
  url: string,
  options: { token?: string; body?: unknown } = {},
) => {
  const app = await buildApp();

  try {
    return await app.inject({
      method,
      url,
      headers: options.token
        ? { authorization: `Bearer ${options.token}` }
        : {},
      payload: options.body as never,
    });
  } finally {
    await app.close();
  }
};

beforeEach(() => {
  db.app_settings = [settingsRow()];
  db.profiles = [
    { id: ADMIN_ID, role: "admin", email: "admin@example.test" },
    { id: CLIENT_ID, role: "client", email: "client@example.test" },
    {
      id: CONSULTANT_ID,
      role: "consultant",
      email: "consultant@example.test",
    },
  ];
  failTable = null;
  invalidateSettingsCache();
});

describe("Settings provider", () => {
  it("reads the singleton row", async () => {
    const settings = await getSettings();

    assert.equal(settings.consultation_price_cents, 15000);
    assert.equal(settings.consultation_duration_minutes, 60);
    assert.equal(settings.stripe_mode, "test");
    assert.equal(settings.default_timezone, "Africa/Cairo");
  });

  it("fails closed when no row exists", async () => {
    db.app_settings = [];

    await assert.rejects(
      () => getSettings(),
      SettingsUnavailableError,
    );
  });

  it("fails closed when more than one row exists", async () => {
    db.app_settings = [
      settingsRow(),
      settingsRow({ id: "other", is_singleton: true }),
    ];

    await assert.rejects(
      () => getSettings(),
      SettingsUnavailableError,
    );
  });

  it("fails closed when the read errors", async () => {
    failTable = "app_settings";

    await assert.rejects(
      () => getSettings(),
      SettingsUnavailableError,
    );
  });

  it("serves a cached value without re-reading", async () => {
    await getSettings();

    /* Emptying the table must not affect a cached read. */
    db.app_settings = [];

    const cached = await getSettings();

    assert.equal(cached.consultation_price_cents, 15000);
  });

  it("reloads after explicit invalidation", async () => {
    await getSettings();

    db.app_settings = [
      settingsRow({ consultation_price_cents: 22500 }),
    ];

    invalidateSettingsCache();

    const reloaded = await getSettings();

    assert.equal(reloaded.consultation_price_cents, 22500);
  });
});

describe("Public settings endpoint", () => {
  it("returns exactly three fields", async () => {
    const response = await call(
      "GET",
      "/api/public/settings",
    );

    assert.equal(response.statusCode, 200);

    const data = response.json().data;

    assert.deepEqual(Object.keys(data).sort(), [
      "consultation_currency",
      "consultation_duration_minutes",
      "consultation_price_cents",
    ]);
    assert.equal(data.consultation_price_cents, 15000);
  });

  it("never exposes stripe mode, support email or timezone", async () => {
    const body = (
      await call("GET", "/api/public/settings")
    ).body;

    assert.ok(!body.includes("stripe_mode"));
    assert.ok(!body.includes("support_email"));
    assert.ok(!body.includes("default_timezone"));
    assert.ok(!body.includes("updated_at"));
    assert.ok(!body.includes("updated_by"));
  });

  it("needs no authentication", async () => {
    const response = await call(
      "GET",
      "/api/public/settings",
    );

    assert.equal(response.statusCode, 200);
  });

  it("fails closed rather than guessing a price", async () => {
    db.app_settings = [];

    const response = await call(
      "GET",
      "/api/public/settings",
    );

    assert.equal(response.statusCode, 500);
    assert.equal(
      response.json().error.code,
      "INTERNAL_ERROR",
    );
  });
});

describe("Admin settings endpoint", () => {
  it("returns the admin projection with configured booleans", async () => {
    const response = await call(
      "GET",
      "/api/admin/settings",
      { token: ADMIN_ID },
    );

    assert.equal(response.statusCode, 200);

    const data = response.json().data;

    assert.deepEqual(Object.keys(data).sort(), [
      "consultation_currency",
      "consultation_duration_minutes",
      "consultation_price_cents",
      "default_timezone",
      "stripe_live_configured",
      "stripe_mode",
      "stripe_test_configured",
      "support_email",
      "updated_at",
    ]);
    assert.equal(data.stripe_test_configured, true);
    assert.equal(data.stripe_live_configured, true);
  });

  it("rejects a non-admin caller", async () => {
    for (const token of [CLIENT_ID, CONSULTANT_ID]) {
      const response = await call(
        "GET",
        "/api/admin/settings",
        { token },
      );

      assert.equal(response.statusCode, 403);
      assert.equal(
        response.json().error.code,
        "FORBIDDEN",
      );
    }
  });

  it("rejects an unauthenticated caller", async () => {
    const response = await call(
      "GET",
      "/api/admin/settings",
    );

    assert.equal(response.statusCode, 401);
  });

  it("never returns key material", async () => {
    const body = (
      await call("GET", "/api/admin/settings", {
        token: ADMIN_ID,
      })
    ).body;

    assert.ok(!body.includes("sk_"));
    assert.ok(!body.includes("whsec_"));
    assert.ok(!body.includes(TEST_SECRET));
    assert.ok(!body.includes(LIVE_WHSEC));
  });
});

describe("Admin settings update", () => {
  it("rejects unknown keys", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings",
      {
        token: ADMIN_ID,
        body: {
          consultation_price_cents: 20000,
          stripe_mode: "live",
        },
      },
    );

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.json().error.code,
      "VALIDATION_ERROR",
    );
    assert.equal(
      db.app_settings[0]!.consultation_price_cents,
      15000,
    );
  });

  it("rejects an empty body", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings",
      { token: ADMIN_ID, body: {} },
    );

    assert.equal(response.statusCode, 400);
  });

  it("enforces price bounds", async () => {
    for (const value of [99, 1_000_001, 15000.5]) {
      const response = await call(
        "PATCH",
        "/api/admin/settings",
        {
          token: ADMIN_ID,
          body: { consultation_price_cents: value },
        },
      );

      assert.equal(
        response.statusCode,
        400,
        `price ${value} should be rejected`,
      );
    }
  });

  it("enforces duration bounds", async () => {
    for (const value of [14, 241]) {
      const response = await call(
        "PATCH",
        "/api/admin/settings",
        {
          token: ADMIN_ID,
          body: { consultation_duration_minutes: value },
        },
      );

      assert.equal(response.statusCode, 400);
    }
  });

  it("rejects an invalid timezone", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings",
      {
        token: ADMIN_ID,
        body: { default_timezone: "Mars/Olympus_Mons" },
      },
    );

    assert.equal(response.statusCode, 400);
  });

  it("accepts a valid timezone", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings",
      {
        token: ADMIN_ID,
        body: { default_timezone: "Europe/London" },
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(
      db.app_settings[0]!.default_timezone,
      "Europe/London",
    );
  });

  it("validates support email and allows clearing it", async () => {
    const invalid = await call(
      "PATCH",
      "/api/admin/settings",
      {
        token: ADMIN_ID,
        body: { support_email: "not-an-email" },
      },
    );

    assert.equal(invalid.statusCode, 400);

    const valid = await call(
      "PATCH",
      "/api/admin/settings",
      {
        token: ADMIN_ID,
        body: { support_email: "Help@Example.Test" },
      },
    );

    assert.equal(valid.statusCode, 200);
    assert.equal(
      db.app_settings[0]!.support_email,
      "help@example.test",
    );

    const cleared = await call(
      "PATCH",
      "/api/admin/settings",
      { token: ADMIN_ID, body: { support_email: null } },
    );

    assert.equal(cleared.statusCode, 200);
    assert.equal(db.app_settings[0]!.support_email, null);
  });

  it("writes the acting admin as the audit id", async () => {
    await call("PATCH", "/api/admin/settings", {
      token: ADMIN_ID,
      body: { consultation_price_cents: 20000 },
    });

    assert.equal(
      db.app_settings[0]!.updated_by_admin_profile_id,
      ADMIN_ID,
    );
    assert.equal(
      db.app_settings[0]!.consultation_price_cents,
      20000,
    );
  });

  it("invalidates the cache so the next read is fresh", async () => {
    await getSettings();

    await call("PATCH", "/api/admin/settings", {
      token: ADMIN_ID,
      body: { consultation_price_cents: 33000 },
    });

    const after = await getSettings();

    assert.equal(after.consultation_price_cents, 33000);
  });

  it("rejects a non-admin caller", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings",
      {
        token: CONSULTANT_ID,
        body: { consultation_price_cents: 20000 },
      },
    );

    assert.equal(response.statusCode, 403);
    assert.equal(
      db.app_settings[0]!.consultation_price_cents,
      15000,
    );
  });
});

describe("Stripe mode endpoint", () => {
  it("switches to test without confirmation", async () => {
    db.app_settings = [settingsRow({ stripe_mode: "live" })];

    const response = await call(
      "PATCH",
      "/api/admin/settings/stripe-mode",
      { token: ADMIN_ID, body: { stripe_mode: "test" } },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data.stripe_mode,
      "test",
    );
    assert.equal(db.app_settings[0]!.stripe_mode, "test");
  });

  it("requires explicit confirmation for live", async () => {
    const refused = await call(
      "PATCH",
      "/api/admin/settings/stripe-mode",
      { token: ADMIN_ID, body: { stripe_mode: "live" } },
    );

    assert.equal(refused.statusCode, 409);
    assert.equal(
      refused.json().error.code,
      "LIVE_MODE_CONFIRMATION_REQUIRED",
    );
    assert.equal(db.app_settings[0]!.stripe_mode, "test");

    const confirmed = await call(
      "PATCH",
      "/api/admin/settings/stripe-mode",
      {
        token: ADMIN_ID,
        body: { stripe_mode: "live", confirm_live: true },
      },
    );

    assert.equal(confirmed.statusCode, 200);
    assert.equal(db.app_settings[0]!.stripe_mode, "live");
  });

  it("rejects an unknown mode", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings/stripe-mode",
      {
        token: ADMIN_ID,
        body: { stripe_mode: "sandbox" },
      },
    );

    assert.equal(response.statusCode, 400);
  });

  it("returns only mode and configured booleans", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings/stripe-mode",
      { token: ADMIN_ID, body: { stripe_mode: "test" } },
    );

    assert.deepEqual(
      Object.keys(response.json().data).sort(),
      [
        "stripe_live_configured",
        "stripe_mode",
        "stripe_test_configured",
      ],
    );

    assert.ok(!response.body.includes("sk_"));
    assert.ok(!response.body.includes("whsec_"));
  });

  it("invalidates the cache after a mode change", async () => {
    await getSettings();

    await call(
      "PATCH",
      "/api/admin/settings/stripe-mode",
      {
        token: ADMIN_ID,
        body: { stripe_mode: "live", confirm_live: true },
      },
    );

    assert.equal(
      (await getSettings()).stripe_mode,
      "live",
    );
  });

  it("rejects a non-admin caller", async () => {
    const response = await call(
      "PATCH",
      "/api/admin/settings/stripe-mode",
      {
        token: CLIENT_ID,
        body: { stripe_mode: "test" },
      },
    );

    assert.equal(response.statusCode, 403);
    assert.equal(db.app_settings[0]!.stripe_mode, "test");
  });
});

describe("Stripe client provider", () => {
  it("reports both modes configured from env presence alone", () => {
    assert.equal(isStripeModeConfigured("test"), true);
    assert.equal(isStripeModeConfigured("live"), true);
  });

  it("caches one client per mode", () => {
    assert.strictEqual(
      getStripeClient("test"),
      getStripeClient("test"),
    );
    assert.notStrictEqual(
      getStripeClient("test"),
      getStripeClient("live"),
    );
  });
});

describe("Existing payment mode safety", () => {
  it("selects the client recorded on the consultation", () => {
    const result = resolveConsultationStripeClient({
      id: "c1",
      stripe_mode: "test",
      stripe_payment_intent_id: "pi_test_1",
    });

    assert.equal(result.ok, true);
    assert.equal(
      (result as { mode: string }).mode,
      "test",
    );
    assert.strictEqual(
      (result as { client: unknown }).client,
      getStripeClient("test"),
    );
  });

  it("keeps a test payment on test after a global switch to live", () => {
    /*
     * The global mode is irrelevant here by construction: the
     * resolver never reads app_settings.
     */
    db.app_settings = [settingsRow({ stripe_mode: "live" })];
    invalidateSettingsCache();

    const result = resolveConsultationStripeClient({
      id: "c1",
      stripe_mode: "test",
      stripe_payment_intent_id: "pi_test_1",
    });

    assert.equal(
      (result as { mode: string }).mode,
      "test",
    );
  });

  it("fails safely when the mode is null but a PaymentIntent exists", () => {
    const result = resolveConsultationStripeClient({
      id: "c1",
      stripe_mode: null,
      stripe_payment_intent_id: "pi_test_1",
    });

    assert.equal(result.ok, false);
    assert.ok(
      !(result as { message: string }).message.includes("sk_"),
    );
  });

  it("fails safely on an unrecognised mode value", () => {
    const result = resolveConsultationStripeClient({
      id: "c1",
      stripe_mode: "sandbox",
      stripe_payment_intent_id: "pi_test_1",
    });

    assert.equal(result.ok, false);
  });

  it("matches livemode against the recorded mode", () => {
    assert.equal(
      paymentIntentModeMatches({
        paymentIntent: { livemode: false },
        mode: "test",
      }),
      true,
    );
    assert.equal(
      paymentIntentModeMatches({
        paymentIntent: { livemode: true },
        mode: "live",
      }),
      true,
    );
    assert.equal(
      paymentIntentModeMatches({
        paymentIntent: { livemode: true },
        mode: "test",
      }),
      false,
    );
    assert.equal(
      paymentIntentModeMatches({
        paymentIntent: { livemode: false },
        mode: "live",
      }),
      false,
    );
  });
});
