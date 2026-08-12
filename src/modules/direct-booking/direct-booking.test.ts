/*
 * Direct consultant booking API. Amendment 011.
 *
 * The feature's whole security surface is that a consultant
 * publishes a page which decides what a stranger is charged. So
 * these tests are mostly about what the SERVER refuses to take
 * from the browser:
 *
 *   - a price, a booking_source, a commission or a split
 *   - a consultant id, when a slug names the consultant
 *   - another consultant's settings
 *   - a reserved or duplicate booking link
 *
 * and about what an anonymous visitor may see, which is a narrow
 * projection with the EFFECTIVE price rather than the stored one.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://direct-booking-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_direct_booking",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_direct_booking",
  STRIPE_LIVE_SECRET_KEY: "sk_live_direct_booking",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_direct_booking",
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
type InjectOptions = Parameters<
  ReturnType<typeof Fastify>["inject"]
>[0] & object;
const { supabaseAdmin } = await import("../../lib/supabase.js");
const { invalidateSettingsCache } = await import(
  "../settings/settings.provider.js"
);
const { registerDirectBookingRoutes } = await import(
  "./direct-booking.route.js"
);
const { resolveEffectiveDirectPrice } = await import(
  "./direct-booking.service.js"
);
const {
  DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS,
  estimateDirectBookingConsultantEarnings,
} = await import("./direct-booking.commission.js");

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CONSULTANT_PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
const INACTIVE_PROFILE = "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c";
const CLIENT_PROFILE = "22222222-2222-4222-8222-222222222222";
const ADMIN_PROFILE = "33333333-3333-4333-8333-333333333333";

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CONSULTANT_ID = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
const INACTIVE_CONSULTANT_ID =
  "4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c";

const PLATFORM_PRICE = 15_000;

/*
 * Values a public visitor must NEVER see. Each is distinctive, so
 * a leak is unmistakable in the serialized body.
 */
const SECRET_PROFILE_ID = "profile-id-leak-marker";
const SECRET_EMAIL = "private-email-leak-marker@example.test";

type Row = Record<string, unknown>;

const db: {
  profiles: Row[];
  consultants: Row[];
  consultant_countries: Row[];
  app_settings: Row[];
} = {
  profiles: [],
  consultants: [],
  consultant_countries: [],
  app_settings: [],
};

class FakeQuery {
  private readonly table: string;
  private columns: string[] = [];
  private readonly filters: Array<(row: Row) => boolean> = [];
  private max: number | null = null;
  private patch: Row | null = null;

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

  update(values: Row): this {
    this.patch = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  limit(count: number): this {
    this.max = count;
    return this;
  }

  private table_(): Row[] {
    return (
      (db as unknown as Record<string, Row[] | undefined>)[
        this.table
      ] ?? []
    );
  }

  private matched(): Row[] {
    return this.table_().filter((row) =>
      this.filters.every((matches) => matches(row)),
    );
  }

  /*
   * The unique slug index, reproduced. A save that would put two
   * consultants on one booking link fails with 23505 exactly as
   * PostgreSQL does, so the route's conflict handling is under
   * test rather than assumed.
   */
  private applyUpdate(): {
    rows: Row[];
    error: unknown;
  } {
    const patch = this.patch!;
    const targets = this.matched();

    if (
      typeof patch.consultant_slug === "string"
    ) {
      const clash = this.table_().find(
        (row) =>
          row.consultant_slug ===
            patch.consultant_slug &&
          !targets.includes(row),
      );

      if (clash) {
        return {
          rows: [],
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "uq_consultants_slug"',
          },
        };
      }
    }

    for (const row of targets) {
      Object.assign(row, patch);
    }

    return { rows: targets, error: null };
  }

  private resolve(): {
    data: Row[];
    error: unknown;
  } {
    if (this.patch) {
      const applied = this.applyUpdate();

      if (applied.error) {
        return { data: [], error: applied.error };
      }

      return {
        data: this.project(applied.rows),
        error: null,
      };
    }

    let rows = this.matched();

    if (this.max !== null) {
      rows = rows.slice(0, this.max);
    }

    return { data: this.project(rows), error: null };
  }

  /* Honours the SELECT list, exactly as PostgREST does. */
  private project(rows: Row[]): Row[] {
    if (this.columns.length === 0) {
      return rows.map((row) => ({ ...row }));
    }

    return rows.map((row) => {
      const projected: Row = {};

      for (const column of this.columns) {
        projected[column] = row[column];
      }

      return projected;
    });
  }

  async maybeSingle(): Promise<{
    data: Row | null;
    error: unknown;
  }> {
    const result = this.resolve();

    return {
      data: result.error
        ? null
        : (result.data[0] ?? null),
      error: result.error,
    };
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
    return Promise.resolve(
      this.resolve(),
    ).then(onFulfilled, onRejected);
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
await registerDirectBookingRoutes(app);
await app.ready();

type Response = {
  statusCode: number;
  raw: string;
  json: () => {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; details?: unknown };
  };
};

const call = async ({
  method,
  url,
  token,
  body,
}: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  token?: string | null;
  body?: unknown;
}): Promise<Response> => {
  /*
   * Assembled first and typed as one object. Passing a union
   * `method` inline makes TypeScript pick inject's CHAINABLE
   * overload, whose result has no statusCode - which is a type
   * error rather than a runtime one, and was invisible until
   * typecheck:test was run.
   */
  const options: InjectOptions = {
    method,
    url,
    ...(token
      ? { headers: { authorization: `Bearer ${token}` } }
      : {}),
    ...(body === undefined
      ? {}
      : { payload: body as object }),
  };

  const response = await app.inject(options);

  return {
    statusCode: response.statusCode,
    raw: response.body,
    json: () => JSON.parse(response.body),
  };
};

beforeEach(() => {
  invalidateSettingsCache();

  db.profiles = [
    {
      id: CONSULTANT_PROFILE,
      role: "consultant",
      email: SECRET_EMAIL,
      full_name: "Legal Name Leak Marker",
    },
    {
      id: OTHER_PROFILE,
      role: "consultant",
      email: "other@example.test",
    },
    {
      id: INACTIVE_PROFILE,
      role: "consultant",
      email: "inactive@example.test",
    },
    {
      id: CLIENT_PROFILE,
      role: "client",
      email: "client@example.test",
    },
    {
      id: ADMIN_PROFILE,
      role: "admin",
      email: "admin@example.test",
    },
  ];

  db.consultants = [
    {
      id: CONSULTANT_ID,
      profile_id: SECRET_PROFILE_ID,
      is_active: true,
      display_name: "Aisha R.",
      headline: "Relocation to Turkey",
      bio: "Ten years of practice.",
      photo_url: "https://cdn.example.test/aisha.jpg",
      timezone: "Europe/Istanbul",
      gender: "female",
      available_for_general: true,
      minimum_booking_notice_hours: 24,
      consultant_slug: "aisha-rahman",
      direct_booking_enabled: true,
      direct_booking_price_cents: 20_000,
      direct_booking_only: false,
      /* Must never appear in a public projection. */
      payout_email: SECRET_EMAIL,
      internal_note: "leak-marker-internal",
    },
    {
      id: OTHER_CONSULTANT_ID,
      profile_id: OTHER_PROFILE,
      is_active: true,
      display_name: "Yusuf A.",
      consultant_slug: "yusuf-al-amin",
      direct_booking_enabled: false,
      direct_booking_price_cents: 18_000,
      direct_booking_only: false,
      timezone: "UTC",
    },
    {
      id: INACTIVE_CONSULTANT_ID,
      profile_id: INACTIVE_PROFILE,
      is_active: false,
      display_name: "Not Activated",
      consultant_slug: null,
      direct_booking_enabled: false,
      direct_booking_price_cents: null,
      direct_booking_only: false,
      timezone: "UTC",
    },
  ];

  /*
   * The consultant whose settings are edited is addressed through
   * their profile id, so the row's profile_id has to match the
   * token for those tests. The public row above deliberately
   * carries a marker instead, to prove the public projection never
   * exposes it.
   */
  db.consultants[0]!.profile_id = CONSULTANT_PROFILE;

  db.consultant_countries = [
    {
      consultant_id: CONSULTANT_ID,
      country_id: "99999999-9999-4999-8999-999999999999",
    },
  ];

  db.app_settings = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      consultation_price_cents: PLATFORM_PRICE,
      consultation_consultant_commission_bps: 5_000,
      consultation_currency: "usd",
      consultation_duration_minutes: 60,
      stripe_mode: "test",
      support_email: "support@example.test",
      default_timezone: "UTC",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  ];
});

describe("Effective price", () => {
  it("is the higher of the consultant's price and the platform's", () => {
    assert.equal(
      resolveEffectiveDirectPrice({
        configuredPriceCents: 20_000,
        platformPriceCents: 15_000,
      }),
      20_000,
    );
  });

  it("rises with the platform when a stored price falls behind", () => {
    /*
     * The case this rule exists for. A consultant set 20000 when
     * the platform charged 15000; the platform later charges
     * 25000. Their page must not sell the platform's own product
     * at a discount, so the floor moves.
     */
    assert.equal(
      resolveEffectiveDirectPrice({
        configuredPriceCents: 20_000,
        platformPriceCents: 25_000,
      }),
      25_000,
    );
  });
});

describe("Public booking page", () => {
  it("serves a published consultant with the EFFECTIVE price", async () => {
    const response = await call({
      method: "GET",
      url: "/api/public/consultants/aisha-rahman",
    });

    assert.equal(response.statusCode, 200);

    const consultant = response.json().data!
      .consultant as Record<string, unknown>;

    assert.equal(
      consultant.effective_direct_booking_price_cents,
      20_000,
    );
    assert.equal(consultant.currency, "usd");
    assert.equal(
      consultant.consultant_slug,
      "aisha-rahman",
    );
  });

  it("quotes the platform price when the stored price has fallen behind", async () => {
    db.app_settings[0]!.consultation_price_cents = 25_000;
    invalidateSettingsCache();

    const response = await call({
      method: "GET",
      url: "/api/public/consultants/aisha-rahman",
    });

    /*
     * The page must never display the stale stored price while
     * checkout charges the higher one. Both read this number.
     */
    assert.equal(
      (
        response.json().data!.consultant as Record<
          string,
          unknown
        >
      ).effective_direct_booking_price_cents,
      25_000,
    );
  });

  it("exposes the safe projection and nothing else", async () => {
    const response = await call({
      method: "GET",
      url: "/api/public/consultants/aisha-rahman",
    });

    const consultant = response.json().data!
      .consultant as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(consultant).sort(),
      [
        "available_for_general",
        "bio",
        "consultant_id",
        "consultant_slug",
        "country_ids",
        "currency",
        "display_name",
        "effective_direct_booking_price_cents",
        "gender",
        "headline",
        "minimum_booking_notice_hours",
        "photo_url",
        "timezone",
      ].sort(),
    );

    /*
     * And nothing internal anywhere in the body, however it might
     * have been nested.
     */
    for (const marker of [
      SECRET_EMAIL,
      SECRET_PROFILE_ID,
      "leak-marker-internal",
      "Legal Name Leak Marker",
      "commission",
      "payout",
      "ledger",
    ]) {
      assert.equal(
        response.raw.includes(marker),
        false,
        `public page leaked "${marker}"`,
      );
    }

    /*
     * Notably absent: direct_booking_price_cents. Only the
     * effective price is published, so a frontend cannot
     * accidentally render the stored one.
     */
    assert.equal(
      "direct_booking_price_cents" in consultant,
      false,
    );
  });

  it("404s a consultant who has switched their page off", async () => {
    const response = await call({
      method: "GET",
      url: "/api/public/consultants/yusuf-al-amin",
    });

    assert.equal(response.statusCode, 404);
  });

  it("404s a deactivated consultant, and an unknown slug, identically", async () => {
    db.consultants[0]!.is_active = false;

    const deactivated = await call({
      method: "GET",
      url: "/api/public/consultants/aisha-rahman",
    });

    const unknown = await call({
      method: "GET",
      url: "/api/public/consultants/nobody-at-all",
    });

    assert.equal(deactivated.statusCode, 404);
    assert.equal(unknown.statusCode, 404);

    /*
     * The same answer for both. A different one for each would
     * turn this endpoint into a directory of who has been
     * deactivated.
     */
    assert.equal(
      deactivated.json().error!.message,
      unknown.json().error!.message,
    );
  });

  it("resolves however the link was typed", async () => {
    const response = await call({
      method: "GET",
      url: "/api/public/consultants/Aisha%20Rahman",
    });

    assert.equal(response.statusCode, 200);
  });

  it("404s a reserved name without consulting the database", async () => {
    /* Even if somebody managed to store one. */
    db.consultants[0]!.consultant_slug = "dashboard";

    const response = await call({
      method: "GET",
      url: "/api/public/consultants/dashboard",
    });

    assert.equal(response.statusCode, 404);
  });
});

describe("Consultant booking page settings", () => {
  const patch = (body: unknown, token = CONSULTANT_PROFILE) =>
    call({
      method: "PATCH",
      url: "/api/consultant/direct-booking",
      token,
      body,
    });

  it("returns the consultant's own settings and canonical URL", async () => {
    const response = await call({
      method: "GET",
      url: "/api/consultant/direct-booking",
      token: CONSULTANT_PROFILE,
    });

    assert.equal(response.statusCode, 200);

    const settings = response.json().data!
      .direct_booking as Record<string, unknown>;

    assert.equal(
      settings.consultant_slug,
      "aisha-rahman",
    );
    assert.equal(
      settings.direct_booking_price_cents,
      20_000,
    );
    assert.equal(
      settings.effective_direct_booking_price_cents,
      20_000,
    );
    assert.equal(
      settings.booking_url,
      "https://app.example.test/aisha-rahman",
    );
  });

  /*
   * Amendment 012. The booking link is admin-managed: a slug is a
   * ROOT url in the same namespace as every top-level route the
   * platform owns, and a link a consultant can rewrite is a link
   * that breaks every card and signature already carrying it.
   *
   * The schema is strict, so a client still sending the field gets
   * a 400 rather than a silent no-op - the right answer for
   * something that used to work.
   */
  it("refuses a consultant's attempt to set their own link", async () => {
    const response = await patch({
      consultant_slug: "something-else",
    });

    assert.equal(response.statusCode, 400);

    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
  });

  it("refuses it even alongside settings they may change", async () => {
    const response = await patch({
      direct_booking_price_cents: 30_000,
      consultant_slug: "something-else",
    });

    assert.equal(response.statusCode, 400);

    /* And the permitted field did not sneak through either. */
    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
  });

  it("returns the full read contract", async () => {
    const response = await call({
      method: "GET",
      url: "/api/consultant/direct-booking",
      token: CONSULTANT_PROFILE,
    });

    const settings = response.json().data!
      .direct_booking as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(settings).sort(),
      [
        "base_consultant_commission_bps",
        "booking_url",
        "consultant_id",
        "consultant_slug",
        "currency",
        "direct_booking_enabled",
        "direct_booking_only",
        "direct_booking_price_cents",
        "effective_direct_booking_price_cents",
        "minimum_direct_booking_price_cents",
        "premium_consultant_commission_bps",
        "standard_booking_price_cents",
      ].sort(),
    );
  });

  it("still lets a consultant read their link and booking URL", async () => {
    const response = await call({
      method: "GET",
      url: "/api/consultant/direct-booking",
      token: CONSULTANT_PROFILE,
    });

    const settings = response.json().data!
      .direct_booking as Record<string, unknown>;

    assert.equal(
      settings.consultant_slug,
      "aisha-rahman",
    );
    assert.equal(
      settings.booking_url,
      "https://app.example.test/aisha-rahman",
    );
  });

  it("accepts a valid price change", async () => {
    const response = await patch({
      direct_booking_price_cents: 30_000,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      30_000,
    );

    /* And the settings an admin owns did not move with it. */
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );
  });

  it("reports the effective price after a change", async () => {
    const response = await patch({
      direct_booking_price_cents: 30_000,
    });

    const settings = response.json().data!
      .direct_booking as Record<string, unknown>;

    /*
     * max(configured, platform). The rule is unchanged by the
     * ownership correction.
     */
    assert.equal(
      settings.effective_direct_booking_price_cents,
      30_000,
    );
    assert.equal(
      settings.minimum_direct_booking_price_cents,
      PLATFORM_PRICE,
    );
  });

  it("refuses a price below the platform's own", async () => {
    const response = await patch({
      direct_booking_price_cents: PLATFORM_PRICE - 1,
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(
      response.json().error!.details,
      { reason: "PRICE_BELOW_PLATFORM_MINIMUM" },
    );

    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );
  });

  it("refuses a consultant's attempt to publish their own page", async () => {
    /*
     * Amendment 013 moved enabling to the administrator. Publishing
     * a page under the platform's own domain is a platform
     * decision, the same kind activation already is.
     */
    for (const body of [
      { direct_booking_enabled: true },
      { direct_booking_enabled: false },
      {
        direct_booking_price_cents: 30_000,
        direct_booking_enabled: false,
      },
    ]) {
      const response = await patch(body);

      assert.equal(
        response.statusCode,
        400,
        `${JSON.stringify(body)} was not refused`,
      );
    }

    /* Neither field moved. */
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );
    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );
  });

  it("refuses a commission, a split or an earnings figure", async () => {
    /*
     * Not ignored — REFUSED. A request that tried to set its own
     * commission and appeared to succeed would be worse than one
     * that failed, because nobody would look again.
     */
    for (const body of [
      { commission_bps: 0 },
      { consultant_amount_minor: 999_999 },
      { platform_amount_minor: 0 },
      { premium_bps: 10_000 },
      { direct_booking_price_cents: 20_000, commission_bps: 0 },
    ]) {
      const response = await patch(body);

      assert.equal(
        response.statusCode,
        400,
        `${JSON.stringify(body)} was not refused`,
      );
    }
  });

  it("cannot address another consultant's settings", async () => {
    /*
     * There is no consultant id in this API at all. The row is
     * found from the profile id on the verified token, so there is
     * nothing to tamper with — including these, which the strict
     * schema refuses outright.
     */
    for (const body of [
      {
        consultant_id: OTHER_CONSULTANT_ID,
        direct_booking_enabled: false,
      },
      {
        profile_id: OTHER_PROFILE,
        direct_booking_enabled: false,
      },
    ]) {
      const response = await patch(body);

      assert.equal(response.statusCode, 400);
    }

    assert.equal(
      db.consultants[1]!.direct_booking_enabled,
      false,
    );

    /* And a consultant's own edit touches only their own row. */
    await patch({ direct_booking_price_cents: 30_000 });

    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      30_000,
    );
    assert.equal(
      db.consultants[1]!.direct_booking_price_cents,
      18_000,
    );
  });

  it("is closed to clients, admins and anonymous callers", async () => {
    for (const token of [
      CLIENT_PROFILE,
      ADMIN_PROFILE,
    ]) {
      const response = await patch(
        { direct_booking_enabled: false },
        token,
      );

      assert.equal(response.statusCode, 403);
    }

    const anonymous = await call({
      method: "PATCH",
      url: "/api/consultant/direct-booking",
      body: { direct_booking_enabled: false },
    });

    assert.equal(anonymous.statusCode, 401);

    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );
  });
});

describe("Admin booking page management", () => {
  it("returns the full read contract", async () => {
    const response = await call({
      method: "GET",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking`,
      token: ADMIN_PROFILE,
    });

    const settings = response.json().data!
      .direct_booking as Record<string, unknown>;

    /*
     * Amendment 013 settled who may WRITE each setting; Amendment
     * 014 added direct_booking_only and the three read-only
     * calculator terms. Both roles read the same object, and the
     * exact key set is asserted so a field cannot appear or vanish
     * without somebody deciding to.
     */
    assert.deepEqual(
      Object.keys(settings).sort(),
      [
        "base_consultant_commission_bps",
        "booking_url",
        "consultant_id",
        "consultant_slug",
        "currency",
        "direct_booking_enabled",
        "direct_booking_only",
        "direct_booking_price_cents",
        "effective_direct_booking_price_cents",
        "minimum_direct_booking_price_cents",
        "premium_consultant_commission_bps",
        "standard_booking_price_cents",
      ].sort(),
    );
  });

  it("reads the enabled flag, the link and both prices", async () => {
    const response = await call({
      method: "GET",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking`,
      token: ADMIN_PROFILE,
    });

    assert.equal(response.statusCode, 200);

    const settings = response.json().data!
      .direct_booking as Record<string, unknown>;

    assert.equal(settings.direct_booking_enabled, true);
    assert.equal(
      settings.consultant_slug,
      "aisha-rahman",
    );
    assert.equal(
      settings.direct_booking_price_cents,
      20_000,
    );
    assert.equal(
      settings.effective_direct_booking_price_cents,
      20_000,
    );
  });

  it("disables a booking page without freeing the link", async () => {
    const response = await call({
      method: "POST",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking/disable`,
      token: ADMIN_PROFILE,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      false,
    );

    /*
     * The slug and the price survive, so re-enabling restores the
     * same URL rather than handing it to somebody else.
     */
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );

    /* And the page is immediately gone. */
    const page = await call({
      method: "GET",
      url: "/api/public/consultants/aisha-rahman",
    });

    assert.equal(page.statusCode, 404);
  });

  const adminSlug = (
    body: unknown,
    token = ADMIN_PROFILE,
  ) =>
    call({
      method: "PATCH",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking`,
      token,
      body,
    });

  it("sets a consultant's booking link", async () => {
    const response = await adminSlug({
      consultant_slug: "  Aïsha  Rahman-2  ",
    });

    assert.equal(response.statusCode, 200);

    /* Stored normalized, never as typed. */
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman-2",
    );

    assert.equal(
      (
        response.json().data!
          .direct_booking as Record<
          string,
          unknown
        >
      ).booking_url,
      "https://app.example.test/aisha-rahman-2",
    );
  });

  it("leaves the price and the enabled flag alone", async () => {
    await adminSlug({
      consultant_slug: "new-link",
    });

    /*
     * An admin sets the address. Whether the page is live and what
     * it charges remain the consultant's.
     */
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );
    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );
  });

  it("refuses a reserved link", async () => {
    const response = await adminSlug({
      consultant_slug: "Dashboard",
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(
      response.json().error!.details,
      { reason: "SLUG_RESERVED" },
    );

    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
  });

  it("refuses the hyphenated policy routes too", async () => {
    for (const reserved of [
      "privacy-policy",
      "terms-of-service",
    ]) {
      const response = await adminSlug({
        consultant_slug: reserved,
      });

      assert.equal(
        response.statusCode,
        400,
        `${reserved} was accepted`,
      );
      assert.deepEqual(
        response.json().error!.details,
        { reason: "SLUG_RESERVED" },
      );
    }
  });

  it("refuses a link another consultant holds", async () => {
    const response = await adminSlug({
      consultant_slug: "Yusuf Al Amin",
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(
      response.json().error!.details,
      { reason: "SLUG_TAKEN" },
    );

    /*
     * An admin typed this one, so it is refused rather than
     * silently suffixed. Only generated defaults suffix.
     */
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
  });

  it("refuses a malformed or empty link", async () => {
    const tooShort = await adminSlug({
      consultant_slug: "ab",
    });

    assert.equal(tooShort.statusCode, 400);
    assert.deepEqual(
      tooShort.json().error!.details,
      { reason: "SLUG_TOO_SHORT" },
    );

    const tooLong = await adminSlug({
      consultant_slug: "a".repeat(61),
    });

    assert.equal(tooLong.statusCode, 400);
    assert.deepEqual(
      tooLong.json().error!.details,
      { reason: "SLUG_TOO_LONG" },
    );

    const empty = await adminSlug({
      consultant_slug: "///",
    });

    assert.equal(empty.statusCode, 400);
    assert.deepEqual(
      empty.json().error!.details,
      { reason: "SLUG_EMPTY" },
    );
  });

  it("refuses to set a consultant's price", async () => {
    /*
     * The field is absent from the admin schema entirely.
     * Amendment 013: an admin who could set a consultant's price
     * could set what that consultant earns, and through the
     * effective price rule what a client is charged.
     */
    for (const body of [
      { direct_booking_price_cents: 1 },
      {
        consultant_slug: "fine",
        direct_booking_price_cents: 50_000,
      },
    ]) {
      const response = await adminSlug(body);

      assert.equal(
        response.statusCode,
        400,
        `${JSON.stringify(body)} was not refused`,
      );
    }

    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );
  });

  it("refuses a body that asks for nothing", async () => {
    /*
     * Answering 200 to a request that changes nothing would hide
     * whatever mistake produced it.
     */
    const response = await adminSlug({});

    assert.equal(response.statusCode, 400);
  });

  it("enables and disables a consultant's page", async () => {
    db.consultants[0]!.direct_booking_enabled =
      false;

    const enabled = await adminSlug({
      direct_booking_enabled: true,
    });

    assert.equal(enabled.statusCode, 200);
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );

    const disabled = await adminSlug({
      direct_booking_enabled: false,
    });

    assert.equal(disabled.statusCode, 200);
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      false,
    );

    /*
     * Disabling turns the page off and nothing else. The link
     * stays reserved for this consultant so re-enabling restores
     * the same URL, and the price stays stored so they do not have
     * to set it again.
     */
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );
  });

  it("sets the link and the enabled state together", async () => {
    db.consultants[0]!.direct_booking_enabled =
      false;

    const response = await adminSlug({
      consultant_slug: "aisha-r",
      direct_booking_enabled: true,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-r",
    );
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );
  });

  it("holds an admin to the same publish preconditions", async () => {
    /*
     * The actor changed; the rules did not. An admin enabling a
     * page is held to exactly what a consultant was held to when
     * enabling was theirs.
     */
    db.consultants[1]!.direct_booking_price_cents =
      null;

    const noPrice = await call({
      method: "PATCH",
      url: `/api/admin/consultants/${OTHER_CONSULTANT_ID}/direct-booking`,
      token: ADMIN_PROFILE,
      body: { direct_booking_enabled: true },
    });

    assert.equal(noPrice.statusCode, 400);
    assert.deepEqual(
      noPrice.json().error!.details,
      { reason: "PRICE_REQUIRED" },
    );

    db.consultants[1]!.direct_booking_price_cents =
      20_000;
    db.consultants[1]!.consultant_slug = null;

    const noSlug = await call({
      method: "PATCH",
      url: `/api/admin/consultants/${OTHER_CONSULTANT_ID}/direct-booking`,
      token: ADMIN_PROFILE,
      body: { direct_booking_enabled: true },
    });

    assert.equal(noSlug.statusCode, 400);
    assert.deepEqual(
      noSlug.json().error!.details,
      { reason: "SLUG_REQUIRED" },
    );

    /* And an inactive consultant is not publishable at all. */
    const inactive = await call({
      method: "PATCH",
      url: `/api/admin/consultants/${INACTIVE_CONSULTANT_ID}/direct-booking`,
      token: ADMIN_PROFILE,
      body: {
        consultant_slug: "not-activated",
        direct_booking_enabled: true,
      },
    });

    assert.equal(inactive.statusCode, 409);
    assert.deepEqual(
      inactive.json().error!.details,
      { reason: "CONSULTANT_NOT_ACTIVE" },
    );

    assert.equal(
      db.consultants[2]!.direct_booking_enabled,
      false,
    );
  });

  it("is closed to consultants and clients for the slug write too", async () => {
    for (const token of [
      CONSULTANT_PROFILE,
      CLIENT_PROFILE,
    ]) {
      const response = await adminSlug(
        { consultant_slug: "taken-over" },
        token,
      );

      assert.equal(response.statusCode, 403);
    }

    const anonymous = await call({
      method: "PATCH",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking`,
      body: { consultant_slug: "taken-over" },
    });

    assert.equal(anonymous.statusCode, 401);

    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
  });

  it("is closed to consultants and clients", async () => {
    for (const token of [
      CONSULTANT_PROFILE,
      CLIENT_PROFILE,
    ]) {
      const response = await call({
        method: "POST",
        url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking/disable`,
        token,
      });

      assert.equal(response.statusCode, 403);
    }

    const anonymous = await call({
      method: "POST",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking/disable`,
    });

    assert.equal(anonymous.statusCode, 401);

    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );
  });
});

/*
 * Direct-booking-only, and the calculator terms. Amendment 014.
 *
 * The exclusion itself is an RLS policy — the /consultation chooser
 * reads public.consultants directly, so that is where it has to
 * live, and MIGRATION_050_VERIFICATION exercises it as anon and as
 * each authenticated role. What is tested HERE is the half the
 * orchestrator owns: who may write the preference, and that the
 * calculator terms are published read-only and match the backend's
 * own configuration.
 */
describe("Direct-booking-only preference", () => {
  const patch = (body: unknown, token = CONSULTANT_PROFILE) =>
    call({
      method: "PATCH",
      url: "/api/consultant/direct-booking",
      token,
      body,
    });

  it("defaults to false, preserving today's eligibility", async () => {
    const response = await call({
      method: "GET",
      url: "/api/consultant/direct-booking",
      token: CONSULTANT_PROFILE,
    });

    assert.equal(
      (
        response.json().data!
          .direct_booking as Record<string, unknown>
      ).direct_booking_only,
      false,
    );
  });

  it("lets a consultant turn it on and off again", async () => {
    const on = await patch({
      direct_booking_only: true,
    });

    assert.equal(on.statusCode, 200);
    assert.equal(
      db.consultants[0]!.direct_booking_only,
      true,
    );

    const off = await patch({
      direct_booking_only: false,
    });

    assert.equal(off.statusCode, 200);
    assert.equal(
      db.consultants[0]!.direct_booking_only,
      false,
    );
  });

  it("accepts it while the direct page is disabled", async () => {
    /*
     * The consultant is then bookable nowhere — excluded from the
     * chooser with no live page to replace it. That is a state
     * they chose, and refusing it would let an admin-owned setting
     * block a consultant's own preference. The frontend warns; the
     * backend does not refuse.
     */
    db.consultants[0]!.direct_booking_enabled = false;

    const response = await patch({
      direct_booking_only: true,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      db.consultants[0]!.direct_booking_only,
      true,
    );
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      false,
    );
  });

  it("does not disturb the settings an admin owns", async () => {
    await patch({ direct_booking_only: true });

    assert.equal(
      db.consultants[0]!.consultant_slug,
      "aisha-rahman",
    );
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      true,
    );
    assert.equal(
      db.consultants[0]!.direct_booking_price_cents,
      20_000,
    );
  });

  it("is refused on the admin endpoint", async () => {
    /*
     * Admin may READ it — it is in the shared view — but the admin
     * schema has no such field, so asking to set it is a 400.
     */
    const response = await call({
      method: "PATCH",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking`,
      token: ADMIN_PROFILE,
      body: { direct_booking_only: true },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(
      db.consultants[0]!.direct_booking_only,
      false,
    );
  });

  it("is visible read-only to an admin", async () => {
    db.consultants[0]!.direct_booking_only = true;

    const response = await call({
      method: "GET",
      url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking`,
      token: ADMIN_PROFILE,
    });

    assert.equal(
      (
        response.json().data!
          .direct_booking as Record<string, unknown>
      ).direct_booking_only,
      true,
    );
  });

  it("is closed to clients and anonymous callers", async () => {
    const client = await patch(
      { direct_booking_only: true },
      CLIENT_PROFILE,
    );

    assert.equal(client.statusCode, 403);

    const anonymous = await call({
      method: "PATCH",
      url: "/api/consultant/direct-booking",
      body: { direct_booking_only: true },
    });

    assert.equal(anonymous.statusCode, 401);

    assert.equal(
      db.consultants[0]!.direct_booking_only,
      false,
    );
  });
});

describe("Direct booking calculator terms", () => {
  const readTerms = async (): Promise<
    Record<string, unknown>
  > => {
    const response = await call({
      method: "GET",
      url: "/api/consultant/direct-booking",
      token: CONSULTANT_PROFILE,
    });

    return response.json().data!
      .direct_booking as Record<string, unknown>;
  };

  it("matches the backend's own commission configuration", async () => {
    const terms = await readTerms();

    /*
     * The base rate is READ from app_settings — the same row
     * record_consultation_earning and the base component of
     * record_direct_booking_earning both read. No copy.
     */
    assert.equal(
      terms.base_consultant_commission_bps,
      db.app_settings[0]!
        .consultation_consultant_commission_bps,
    );

    /*
     * The premium rate is MIRRORED from the ledger function, which
     * has no table to read. MIGRATION_050_VERIFICATION check 2
     * fails if the two ever diverge.
     */
    assert.equal(
      terms.premium_consultant_commission_bps,
      DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS,
    );
    assert.equal(
      terms.premium_consultant_commission_bps,
      8_000,
    );

    assert.equal(
      terms.standard_booking_price_cents,
      db.app_settings[0]!.consultation_price_cents,
    );
  });

  it("keeps the two names for the platform price in step", async () => {
    const terms = await readTerms();

    /*
     * standard_booking_price_cents and
     * minimum_direct_booking_price_cents are one number answering
     * two questions. They must never diverge.
     */
    assert.equal(
      terms.standard_booking_price_cents,
      terms.minimum_direct_booking_price_cents,
    );
  });

  it("follows the platform price when it moves", async () => {
    db.app_settings[0]!.consultation_price_cents = 25_000;
    db.app_settings[0]!
      .consultation_consultant_commission_bps = 4_000;
    invalidateSettingsCache();

    const terms = await readTerms();

    assert.equal(
      terms.standard_booking_price_cents,
      25_000,
    );
    assert.equal(
      terms.base_consultant_commission_bps,
      4_000,
    );
  });

  it("does not move when the consultant changes their price", async () => {
    const before = await readTerms();

    const response = await call({
      method: "PATCH",
      url: "/api/consultant/direct-booking",
      token: CONSULTANT_PROFILE,
      body: { direct_booking_price_cents: 40_000 },
    });

    assert.equal(response.statusCode, 200);

    const after = await readTerms();

    /* The terms are the platform's, not the consultant's. */
    assert.equal(
      after.standard_booking_price_cents,
      before.standard_booking_price_cents,
    );
    assert.equal(
      after.base_consultant_commission_bps,
      before.base_consultant_commission_bps,
    );
    assert.equal(
      after.premium_consultant_commission_bps,
      before.premium_consultant_commission_bps,
    );

    /* And only the price they own actually moved. */
    assert.equal(
      after.direct_booking_price_cents,
      40_000,
    );
  });

  it("leaves the effective and minimum price rules unchanged", async () => {
    const terms = await readTerms();

    assert.equal(
      terms.effective_direct_booking_price_cents,
      20_000,
    );
    assert.equal(
      terms.minimum_direct_booking_price_cents,
      PLATFORM_PRICE,
    );

    /* A stale price below the platform default still lifts. */
    db.consultants[0]!.direct_booking_price_cents = 20_000;
    db.app_settings[0]!.consultation_price_cents = 30_000;
    invalidateSettingsCache();

    const lifted = await readTerms();

    assert.equal(
      lifted.effective_direct_booking_price_cents,
      30_000,
    );
  });

  it("neither role may write any of the three", async () => {
    for (const body of [
      { standard_booking_price_cents: 1 },
      { base_consultant_commission_bps: 9_000 },
      { premium_consultant_commission_bps: 10_000 },
    ]) {
      const consultant = await call({
        method: "PATCH",
        url: "/api/consultant/direct-booking",
        token: CONSULTANT_PROFILE,
        body,
      });

      assert.equal(
        consultant.statusCode,
        400,
        `consultant PATCH accepted ${JSON.stringify(body)}`,
      );

      const admin = await call({
        method: "PATCH",
        url: `/api/admin/consultants/${CONSULTANT_ID}/direct-booking`,
        token: ADMIN_PROFILE,
        body,
      });

      assert.equal(
        admin.statusCode,
        400,
        `admin PATCH accepted ${JSON.stringify(body)}`,
      );
    }
  });

  it("reproduces the ledger's arithmetic exactly", async () => {
    /*
     * The locked example: 15000 platform default, 20000 direct
     * price. record_direct_booking_earning writes 7500 + 4000 =
     * 11500 to the consultant. The calculator must agree, or a
     * consultant is shown a number the ledger will not honour.
     */
    const terms = {
      standardBookingPriceCents: 15_000,
      baseConsultantCommissionBps: 5_000,
      premiumConsultantCommissionBps:
        DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS,
    };

    assert.equal(
      estimateDirectBookingConsultantEarnings({
        priceCents: 20_000,
        terms,
      }),
      11_500,
    );

    /* At exactly the platform price it is an ordinary 50/50. */
    assert.equal(
      estimateDirectBookingConsultantEarnings({
        priceCents: 15_000,
        terms,
      }),
      7_500,
    );

    /*
     * Below the platform price the effective price rule lifts the
     * charge, so the estimate must lift with it rather than
     * quoting an amount nobody will be charged.
     */
    assert.equal(
      estimateDirectBookingConsultantEarnings({
        priceCents: 9_000,
        terms,
      }),
      7_500,
    );

    /* Rounded per component, never on the blended total. */
    assert.equal(
      estimateDirectBookingConsultantEarnings({
        priceCents: 15_001,
        terms,
      }),
      7_501,
    );
  });
});
