/*
 * Consultant profile endpoint tests. PROJECT_LOCK Amendment 008.
 *
 * Nothing external is contacted. Supabase is an in-memory fake,
 * including a fake save_consultant_profile RPC that reproduces the
 * migration 027 contract: the same mode rules, the same gender
 * rules, the same country handling, the same markers, and the same
 * all-or-nothing behaviour on failure.
 *
 * That fake is what lets these tests assert that a rejected save
 * leaves zero partial writes, without a database.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://consultant-profile-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_consultant_profile",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_consultant_profile",
  STRIPE_LIVE_SECRET_KEY: "sk_live_consultant_profile",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_consultant_profile",
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
const { registerConsultantProfileRoute } = await import(
  "./consultant-profile.route.js"
);
const { registerAdminConsultantActivationRoutes } = await import(
  "../admin-consultants/admin-consultant-activation.route.js"
);
const { validateWorkingHours } = await import(
  "./consultant-profile.working-hours.js"
);
const { evaluateProfileCompleteness } = await import(
  "./consultant-profile.completeness.js"
);

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CONSULTANT_PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
const CLIENT_PROFILE = "22222222-2222-4222-8222-222222222222";
const ADMIN_PROFILE = "33333333-3333-4333-8333-333333333333";

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CONSULTANT_ID = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";

const COUNTRY_A = "55555555-5555-4555-8555-555555555555";
const COUNTRY_B = "66666666-6666-4666-8666-666666666666";
const COUNTRY_INACTIVE = "77777777-7777-4777-8777-777777777777";
const COUNTRY_UNKNOWN = "88888888-8888-4888-8888-888888888888";

const GOOD_HOURS = {
  monday: [{ start: "09:00", end: "17:00" }],
};

type Row = Record<string, unknown>;

const db: {
  profiles: Row[];
  consultants: Row[];
  countries: Row[];
  consultant_countries: Row[];
  oauth_connections: Row[];
} = {
  profiles: [],
  consultants: [],
  countries: [],
  consultant_countries: [],
  oauth_connections: [],
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

  is(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
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

type RpcCall = {
  name: string;
  args: Record<string, unknown>;
};

let rpcCalls: RpcCall[] = [];

/*
 * Faithful in-memory stand-in for migration 027. Same ordering,
 * same markers, and it mutates nothing until every check passes -
 * which is what lets the "zero partial writes" test be real.
 */
supabaseAdmin.rpc = (async (
  name: string,
  args: Record<string, unknown>,
) => {
  rpcCalls.push({ name, args });

  if (name !== "save_consultant_profile") {
    return { data: null, error: { message: "unknown rpc" } };
  }

  const fail = (marker: string) => ({
    data: null,
    error: { message: `${marker}: raised by fake`, code: "P0001" },
  });

  const mode = args.p_mode as string;
  const consultantId = args.p_consultant_id as string;

  if (!["draft", "submit", "update"].includes(mode)) {
    return fail("CONSULTANT_PROFILE_MODE_INVALID");
  }

  const consultant = db.consultants.find((row) => row.id === consultantId);
  if (!consultant) {
    return fail("CONSULTANT_PROFILE_NOT_FOUND");
  }

  const marker = consultant.onboarding_completed_at as string | null;

  if (["draft", "submit"].includes(mode) && marker !== null) {
    return fail("CONSULTANT_ONBOARDING_ALREADY_COMPLETED");
  }
  if (mode === "update" && marker === null) {
    return fail("CONSULTANT_ONBOARDING_INCOMPLETE");
  }

  const suppliedGender = args.p_gender as string | null;
  let nextGender = consultant.gender as string | null;

  if (mode === "submit") {
    if (suppliedGender !== "male" && suppliedGender !== "female") {
      return fail("CONSULTANT_GENDER_INVALID");
    }
    nextGender = suppliedGender;
  } else if (mode === "draft") {
    if (suppliedGender !== null) {
      if (suppliedGender !== "male" && suppliedGender !== "female") {
        return fail("CONSULTANT_GENDER_INVALID");
      }
      nextGender = suppliedGender;
    }
  } else if (
    suppliedGender !== null &&
    suppliedGender !== consultant.gender
  ) {
    return fail("CONSULTANT_GENDER_IMMUTABLE");
  }

  const countryIds = args.p_country_ids as string[] | null;
  let deduped: string[] | null = null;

  if (countryIds !== null) {
    deduped = [...new Set(countryIds)];
    const invalid = deduped.filter(
      (id) =>
        !db.countries.some(
          (country) => country.id === id && country.is_active === true,
        ),
    );
    if (invalid.length > 0) {
      return fail("CONSULTANT_COUNTRY_INVALID");
    }
  }

  /* Every check passed. Only now does anything mutate. */
  if (deduped !== null) {
    db.consultant_countries = db.consultant_countries.filter(
      (row) => row.consultant_id !== consultantId,
    );
    for (const id of deduped) {
      db.consultant_countries.push({
        consultant_id: consultantId,
        country_id: id,
      });
    }
  }

  const profile = db.profiles.find(
    (row) => row.id === consultant.profile_id,
  );
  if (profile) {
    profile.full_name = args.p_full_name ?? profile.full_name;
    profile.avatar_url = args.p_avatar_url ?? profile.avatar_url;
  }

  consultant.gender = nextGender;
  consultant.headline = args.p_headline ?? consultant.headline;
  consultant.bio = args.p_bio ?? consultant.bio;
  consultant.timezone = args.p_timezone ?? consultant.timezone;
  consultant.minimum_booking_notice_hours =
    args.p_minimum_booking_notice_hours ??
    consultant.minimum_booking_notice_hours;
  consultant.available_for_general =
    args.p_available_for_general ?? consultant.available_for_general;
  consultant.working_hours_jsonb =
    args.p_working_hours ?? consultant.working_hours_jsonb;

  const nextMarker = mode === "submit" ? new Date().toISOString() : marker;
  consultant.onboarding_completed_at = nextMarker;

  return {
    data: [
      { consultant_id: consultantId, onboarding_completed_at: nextMarker },
    ],
    error: null,
  };
}) as unknown as typeof supabaseAdmin.rpc;

const buildApp = async () => {
  const app = Fastify();
  await registerConsultantProfileRoute(app);
  await registerAdminConsultantActivationRoutes(app);
  return app;
};

const save = async (
  body: unknown,
  token: string | null = CONSULTANT_PROFILE,
) => {
  const app = await buildApp();
  try {
    return await app.inject({
      method: "PUT",
      url: "/api/consultant/profile",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as never,
    });
  } finally {
    await app.close();
  }
};

const activate = async (
  consultantId: string,
  token: string = ADMIN_PROFILE,
) => {
  const app = await buildApp();
  try {
    return await app.inject({
      method: "POST",
      url: `/api/admin/consultants/${consultantId}/activate`,
      headers: { authorization: `Bearer ${token}` },
    });
  } finally {
    await app.close();
  }
};

const consultantRow = (): Row =>
  db.consultants.find((row) => row.id === CONSULTANT_ID)!;

const completeConsultant = (overrides: Row = {}): Row => ({
  id: CONSULTANT_ID,
  profile_id: CONSULTANT_PROFILE,
  gender: "female",
  headline: "Relocation specialist",
  bio: "Fifteen years of experience.",
  timezone: "Africa/Cairo",
  minimum_booking_notice_hours: 24,
  available_for_general: true,
  working_hours_jsonb: { ...GOOD_HOURS },
  is_active: false,
  onboarding_completed_at: null,
  ...overrides,
});

beforeEach(() => {
  db.profiles = [
    {
      id: CONSULTANT_PROFILE,
      role: "consultant",
      email: "c@example.test",
      full_name: "Aisha Consultant",
      avatar_url: "https://cdn.example.test/a.png",
    },
    {
      id: OTHER_PROFILE,
      role: "consultant",
      email: "o@example.test",
      full_name: "Other Consultant",
      avatar_url: "https://cdn.example.test/o.png",
    },
    {
      id: CLIENT_PROFILE,
      role: "client",
      email: "cl@example.test",
      full_name: "Client",
      avatar_url: null,
    },
    {
      id: ADMIN_PROFILE,
      role: "admin",
      email: "ad@example.test",
      full_name: "Admin",
      avatar_url: null,
    },
  ];

  db.consultants = [
    completeConsultant(),
    completeConsultant({
      id: OTHER_CONSULTANT_ID,
      profile_id: OTHER_PROFILE,
      headline: "Other headline",
    }),
  ];

  db.countries = [
    { id: COUNTRY_A, name: "A", iso_code: "AA", is_active: true },
    { id: COUNTRY_B, name: "B", iso_code: "BB", is_active: true },
    {
      id: COUNTRY_INACTIVE,
      name: "Inactive",
      iso_code: "II",
      is_active: false,
    },
  ];

  db.consultant_countries = [
    { consultant_id: CONSULTANT_ID, country_id: COUNTRY_A },
    { consultant_id: OTHER_CONSULTANT_ID, country_id: COUNTRY_B },
  ];

  db.oauth_connections = [
    {
      consultant_id: CONSULTANT_ID,
      provider: "google",
      revoked_at: null,
      encrypted_refresh_token: "encrypted",
    },
    {
      consultant_id: OTHER_CONSULTANT_ID,
      provider: "google",
      revoked_at: null,
      encrypted_refresh_token: "encrypted",
    },
  ];

  failTable = null;
  rpcCalls = [];
});

describe("Consultant profile: authentication and ownership", () => {
  it("requires authentication", async () => {
    const response = await save({ mode: "draft" }, null);
    assert.equal(response.statusCode, 401);
    assert.equal(rpcCalls.length, 0);
  });

  it("rejects a non-consultant caller", async () => {
    for (const token of [CLIENT_PROFILE, ADMIN_PROFILE]) {
      const response = await save({ mode: "draft" }, token);
      assert.equal(response.statusCode, 403);
    }
    assert.equal(rpcCalls.length, 0);
  });

  it("rejects a supplied consultant id as an unknown field", async () => {
    const response = await save({
      mode: "draft",
      consultant_id: OTHER_CONSULTANT_ID,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
    assert.equal(rpcCalls.length, 0);
  });

  it("always calls the RPC with the resolved consultant, never a spoofed one", async () => {
    await save({ mode: "draft", headline: "New" });
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0]!.args.p_consultant_id, CONSULTANT_ID);
  });

  it("cannot edit another consultant", async () => {
    await save({ mode: "draft", headline: "Mine" });

    const other = db.consultants.find(
      (row) => row.id === OTHER_CONSULTANT_ID,
    )!;
    assert.equal(other.headline, "Other headline");
    assert.equal(
      db.consultant_countries.filter(
        (row) => row.consultant_id === OTHER_CONSULTANT_ID,
      ).length,
      1,
    );
  });

  it("returns NOT_FOUND when the account has no consultant row", async () => {
    db.consultants = db.consultants.filter(
      (row) => row.id !== CONSULTANT_ID,
    );
    const response = await save({ mode: "draft" });
    assert.equal(response.statusCode, 404);
  });
});

describe("Consultant profile: draft", () => {
  it("saves partial data", async () => {
    const response = await save({
      mode: "draft",
      headline: "Draft headline",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(consultantRow().headline, "Draft headline");
  });

  it("preserves null fields", async () => {
    const before = { ...consultantRow() };
    const response = await save({ mode: "draft" });
    assert.equal(response.statusCode, 200);
    assert.equal(consultantRow().headline, before.headline);
    assert.equal(consultantRow().bio, before.bio);
    assert.equal(consultantRow().timezone, before.timezone);
  });

  it("does not set the marker", async () => {
    await save({ mode: "draft", headline: "x" });
    assert.equal(consultantRow().onboarding_completed_at, null);
    assert.equal(
      (await save({ mode: "draft" })).json().data.consultant
        .onboarding_completed_at,
      null,
    );
  });

  it("may set gender before completion", async () => {
    db.consultants[0]!.gender = null;
    const response = await save({ mode: "draft", gender: "male" });
    assert.equal(response.statusCode, 200);
    assert.equal(consultantRow().gender, "male");
  });

  it("rejects an invalid draft gender", async () => {
    const response = await save({ mode: "draft", gender: "other" });
    assert.equal(response.statusCode, 400);
    assert.equal(rpcCalls.length, 0);
  });

  it("does not require completeness or Google", async () => {
    db.oauth_connections = [];
    db.profiles[0]!.avatar_url = null;
    const response = await save({ mode: "draft", bio: "partial" });
    assert.equal(response.statusCode, 200);
  });

  it("is rejected after completion", async () => {
    db.consultants[0]!.onboarding_completed_at = "2026-08-01T00:00:00.000Z";
    const response = await save({ mode: "draft" });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "INVALID_TRANSITION");
    assert.equal(rpcCalls.length, 0);
  });
});

describe("Consultant profile: submit", () => {
  it("sets the marker and returns the persisted state", async () => {
    const response = await save({ mode: "submit", gender: "female" });
    assert.equal(response.statusCode, 200);

    const consultant = response.json().data.consultant;
    assert.ok(consultant.onboarding_completed_at);
    assert.equal(consultant.gender, "female");
    assert.deepEqual(consultant.country_ids, [COUNTRY_A]);
    assert.ok(consultantRow().onboarding_completed_at);
  });

  it("returns every missing identifier at once", async () => {
    db.profiles[0]!.avatar_url = null;
    db.profiles[0]!.full_name = null;
    db.consultants[0]!.gender = null;
    db.consultants[0]!.headline = null;
    db.consultants[0]!.bio = null;
    db.consultants[0]!.timezone = null;
    db.consultants[0]!.available_for_general = false;
    db.consultants[0]!.working_hours_jsonb = {};
    db.consultant_countries = [];
    db.oauth_connections = [];

    const response = await save({ mode: "submit" });
    assert.equal(response.statusCode, 409);

    const body = response.json();
    assert.equal(body.error.code, "CONSULTANT_PROFILE_INCOMPLETE");
    assert.deepEqual(body.error.details.missing, [
      "avatar",
      "full_name",
      "gender",
      "headline",
      "bio",
      "timezone",
      "booking_capability",
      "working_hours",
      "google_calendar",
    ]);
    assert.equal(rpcCalls.length, 0);
  });

  it("validates the merged state, not only the request", async () => {
    db.consultants[0]!.headline = null;

    const missingHeadline = await save({ mode: "submit", gender: "female" });
    assert.equal(missingHeadline.statusCode, 409);
    assert.ok(
      missingHeadline
        .json()
        .error.details.missing.includes("headline"),
    );

    /* Supplying it in the request completes the merged state. */
    const supplied = await save({
      mode: "submit",
      gender: "female",
      headline: "Supplied now",
    });
    assert.equal(supplied.statusCode, 200);
  });

  it("requires an active Google connection", async () => {
    db.oauth_connections = [];
    const missing = await save({ mode: "submit", gender: "female" });
    assert.equal(missing.statusCode, 409);
    assert.ok(
      missing.json().error.details.missing.includes("google_calendar"),
    );

    db.oauth_connections = [
      {
        consultant_id: CONSULTANT_ID,
        provider: "google",
        revoked_at: "2026-01-01T00:00:00.000Z",
        encrypted_refresh_token: "encrypted",
      },
    ];
    const revoked = await save({ mode: "submit", gender: "female" });
    assert.equal(revoked.statusCode, 409);
    assert.ok(
      revoked.json().error.details.missing.includes("google_calendar"),
    );
  });

  it("passes with general-only booking capability", async () => {
    db.consultant_countries = db.consultant_countries.filter(
      (row) => row.consultant_id !== CONSULTANT_ID,
    );
    db.consultants[0]!.available_for_general = true;

    const response = await save({ mode: "submit", gender: "female" });
    assert.equal(response.statusCode, 200);
  });

  it("passes with country-only booking capability", async () => {
    db.consultants[0]!.available_for_general = false;
    const response = await save({
      mode: "submit",
      gender: "female",
      country_ids: [COUNTRY_A],
    });
    assert.equal(response.statusCode, 200);
  });

  it("fails with no booking capability", async () => {
    db.consultants[0]!.available_for_general = false;
    const response = await save({
      mode: "submit",
      gender: "female",
      country_ids: [],
    });
    assert.equal(response.statusCode, 409);
    assert.ok(
      response
        .json()
        .error.details.missing.includes("booking_capability"),
    );
  });

  it("is rejected before onboarding when already completed", async () => {
    db.consultants[0]!.onboarding_completed_at = "2026-08-01T00:00:00.000Z";
    const response = await save({ mode: "submit", gender: "female" });
    assert.equal(response.statusCode, 409);
    assert.equal(rpcCalls.length, 0);
  });
});

describe("Consultant profile: countries", () => {
  it("persists multiple countries and deduplicates", async () => {
    const response = await save({
      mode: "draft",
      country_ids: [COUNTRY_A, COUNTRY_B, COUNTRY_A, COUNTRY_B],
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      [...response.json().data.consultant.country_ids].sort(),
      [COUNTRY_A, COUNTRY_B].sort(),
    );
    assert.equal(
      db.consultant_countries.filter(
        (row) => row.consultant_id === CONSULTANT_ID,
      ).length,
      2,
    );
  });

  it("rejects an unknown country", async () => {
    const response = await save({
      mode: "draft",
      country_ids: [COUNTRY_A, COUNTRY_UNKNOWN],
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error.code,
      "CONSULTANT_COUNTRY_INVALID",
    );
    assert.equal(rpcCalls.length, 0);
  });

  it("rejects an inactive country", async () => {
    const response = await save({
      mode: "draft",
      country_ids: [COUNTRY_A, COUNTRY_INACTIVE],
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error.code,
      "CONSULTANT_COUNTRY_INVALID",
    );
  });

  it("never exposes raw PostgreSQL text", async () => {
    const body = (
      await save({ mode: "draft", country_ids: [COUNTRY_UNKNOWN] })
    ).body;
    assert.ok(!body.includes("raised by fake"));
    assert.ok(!body.includes("P0001"));
    assert.ok(!body.includes("public."));
  });

  it("preserves assignments when country_ids is null", async () => {
    await save({ mode: "draft", headline: "unchanged countries" });
    assert.deepEqual(
      db.consultant_countries
        .filter((row) => row.consultant_id === CONSULTANT_ID)
        .map((row) => row.country_id),
      [COUNTRY_A],
    );
  });

  it("removes all assignments for an empty array", async () => {
    const response = await save({ mode: "draft", country_ids: [] });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.consultant.country_ids, []);
    assert.equal(
      db.consultant_countries.filter(
        (row) => row.consultant_id === CONSULTANT_ID,
      ).length,
      0,
    );
  });
});

describe("Consultant profile: working hours", () => {
  it("rejects empty hours for submit", async () => {
    db.consultants[0]!.working_hours_jsonb = {};
    const response = await save({ mode: "submit", gender: "female" });
    assert.equal(response.statusCode, 409);
    assert.ok(
      response.json().error.details.missing.includes("working_hours"),
    );
  });

  it("rejects an invalid time format", async () => {
    const response = await save({
      mode: "draft",
      working_hours: { monday: [{ start: "9am", end: "5pm" }] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(rpcCalls.length, 0);
  });

  it("rejects start after end", async () => {
    const response = await save({
      mode: "draft",
      working_hours: { monday: [{ start: "17:00", end: "09:00" }] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects overlapping intervals on the same day", async () => {
    const response = await save({
      mode: "draft",
      working_hours: {
        monday: [
          { start: "09:00", end: "12:00" },
          { start: "11:00", end: "15:00" },
        ],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.ok(
      JSON.stringify(response.json().error.details.issues).includes(
        "overlapping",
      ),
    );
  });

  it("accepts a valid partial week", async () => {
    const response = await save({
      mode: "draft",
      working_hours: {
        tuesday: [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
        friday: [{ start: "10:00", end: "11:00" }],
      },
    });
    assert.equal(response.statusCode, 200);
  });

  it("accepts touching intervals but rejects unsupported day keys", () => {
    assert.equal(
      validateWorkingHours({
        monday: [
          { start: "09:00", end: "10:00" },
          { start: "10:00", end: "11:00" },
        ],
      }).ok,
      true,
    );
    assert.equal(
      validateWorkingHours({ funday: [] }).ok,
      false,
    );
  });
});

describe("Consultant profile: update", () => {
  const complete = () => {
    db.consultants[0]!.onboarding_completed_at =
      "2026-08-01T00:00:00.000Z";
  };

  it("is rejected before completion", async () => {
    const response = await save({ mode: "update", headline: "x" });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "INVALID_TRANSITION");
    assert.equal(
      response.json().error.details.reason,
      "CONSULTANT_ONBOARDING_INCOMPLETE",
    );
    assert.equal(rpcCalls.length, 0);
  });

  it("rejects a gender change after completion", async () => {
    complete();
    const response = await save({ mode: "update", gender: "male" });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error.code,
      "CONSULTANT_GENDER_IMMUTABLE",
    );
    assert.equal(rpcCalls.length, 0, "rejected before the RPC");
    assert.equal(consultantRow().gender, "female");
  });

  it("ignores a null gender after completion", async () => {
    complete();
    const response = await save({
      mode: "update",
      gender: null,
      headline: "Still fine",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(consultantRow().gender, "female");
  });

  it("tolerates an unchanged gender after completion", async () => {
    complete();
    const response = await save({ mode: "update", gender: "female" });
    assert.equal(response.statusCode, 200);
    assert.equal(consultantRow().gender, "female");
  });

  it("keeps gender locked while deactivated", async () => {
    complete();
    db.consultants[0]!.is_active = false;
    const response = await save({ mode: "update", gender: "male" });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error.code,
      "CONSULTANT_GENDER_IMMUTABLE",
    );
  });

  it("never clears or moves the marker", async () => {
    complete();
    const before = consultantRow().onboarding_completed_at;
    await save({ mode: "update", headline: "Changed" });
    assert.equal(consultantRow().onboarding_completed_at, before);
  });

  it("stops an active consultant becoming incomplete", async () => {
    complete();
    db.consultants[0]!.is_active = true;

    const response = await save({
      mode: "update",
      available_for_general: false,
      country_ids: [],
    });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error.code,
      "CONSULTANT_PROFILE_INCOMPLETE",
    );
    assert.ok(
      response
        .json()
        .error.details.missing.includes("booking_capability"),
    );
    assert.equal(rpcCalls.length, 0);
    assert.equal(
      db.consultant_countries.filter(
        (row) => row.consultant_id === CONSULTANT_ID,
      ).length,
      1,
      "no partial write",
    );
  });

  it("allows a valid partial update while inactive", async () => {
    complete();
    db.consultants[0]!.is_active = false;
    db.consultants[0]!.available_for_general = false;
    db.consultant_countries = db.consultant_countries.filter(
      (row) => row.consultant_id !== CONSULTANT_ID,
    );

    const response = await save({ mode: "update", bio: "Reworked bio" });
    assert.equal(response.statusCode, 200);
    assert.equal(consultantRow().bio, "Reworked bio");
    assert.ok(consultantRow().onboarding_completed_at);
  });

  it("allows a complete active update", async () => {
    complete();
    db.consultants[0]!.is_active = true;
    const response = await save({
      mode: "update",
      headline: "Refreshed headline",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(consultantRow().headline, "Refreshed headline");
  });
});

describe("Consultant profile: failure handling", () => {
  it("maps every RPC marker to a safe API result", async () => {
    /*
     * Exercises the marker path itself: the pre-check is satisfied
     * but the stored gender changes underneath, so only the RPC can
     * reject. That is the concurrency case the marker mapping
     * exists for.
     */
    db.consultants[0]!.onboarding_completed_at =
      "2026-08-01T00:00:00.000Z";
    db.consultants[0]!.is_active = false;

    const originalRpc = supabaseAdmin.rpc;
    let forced = true;

    supabaseAdmin.rpc = (async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (forced) {
        forced = false;
        rpcCalls.push({ name, args });
        return {
          data: null,
          error: {
            message:
              "CONSULTANT_GENDER_IMMUTABLE: consultant gender cannot be changed",
            code: "P0001",
          },
        };
      }
      return (originalRpc as never as typeof supabaseAdmin.rpc)(
        name as never,
        args as never,
      );
    }) as unknown as typeof supabaseAdmin.rpc;

    try {
      const response = await save({
        mode: "update",
        headline: "Triggers the RPC",
      });

      assert.equal(response.statusCode, 409);
      assert.equal(
        response.json().error.code,
        "CONSULTANT_GENDER_IMMUTABLE",
      );
      assert.ok(!response.body.includes("P0001"));
      assert.ok(!response.body.includes("consultant gender cannot be changed"));
    } finally {
      supabaseAdmin.rpc = originalRpc;
    }
  });

  it("maps an unrecognised RPC failure to INTERNAL_ERROR", async () => {
    const originalRpc = supabaseAdmin.rpc;

    supabaseAdmin.rpc = (async () => ({
      data: null,
      error: { message: "42P01: relation does not exist", code: "42P01" },
    })) as unknown as typeof supabaseAdmin.rpc;

    try {
      const response = await save({ mode: "draft", headline: "x" });
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().error.code, "INTERNAL_ERROR");
      assert.ok(!response.body.includes("42P01"));
      assert.ok(!response.body.includes("relation does not exist"));
    } finally {
      supabaseAdmin.rpc = originalRpc;
    }
  });

  it("returns INTERNAL_ERROR when a lookup fails", async () => {
    failTable = "consultants";
    const response = await save({ mode: "draft" });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, "INTERNAL_ERROR");
  });

  it("leaves zero partial writes when validation rejects", async () => {
    const before = JSON.stringify(db);
    const response = await save({
      mode: "draft",
      headline: "Should not persist",
      country_ids: [COUNTRY_INACTIVE],
    });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.stringify(db), before);
  });
});

describe("Admin activation: shared completeness evaluator", () => {
  const complete = () => {
    db.consultants[0]!.onboarding_completed_at =
      "2026-08-01T00:00:00.000Z";
  };

  it("returns every missing requirement", async () => {
    db.profiles[0]!.avatar_url = null;
    db.consultants[0]!.headline = null;
    db.consultants[0]!.bio = null;
    db.oauth_connections = [];

    const response = await activate(CONSULTANT_ID);
    assert.equal(response.statusCode, 409);

    const body = response.json();
    assert.equal(body.error.code, "CONSULTANT_PROFILE_INCOMPLETE");

    const missing = body.error.details.missing;
    assert.ok(missing.includes("onboarding_completed"));
    assert.ok(missing.includes("avatar"));
    assert.ok(missing.includes("headline"));
    assert.ok(missing.includes("bio"));
    assert.ok(missing.includes("google_calendar"));
    assert.ok(missing.length >= 5);
  });

  it("refuses activation without onboarding completion", async () => {
    const response = await activate(CONSULTANT_ID);
    assert.equal(response.statusCode, 409);
    assert.ok(
      response
        .json()
        .error.details.missing.includes("onboarding_completed"),
    );
    assert.equal(consultantRow().is_active, false);
  });

  it("activates a complete consultant", async () => {
    complete();
    const response = await activate(CONSULTANT_ID);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.consultant.is_active, true);
    assert.equal(consultantRow().is_active, true);
  });

  it("still refuses a non-admin caller", async () => {
    const response = await activate(CONSULTANT_ID, CONSULTANT_PROFILE);
    assert.equal(response.statusCode, 403);
  });
});

describe("Amendment 003: degraded Google does not block profile updates", () => {
  const completedActive = () => {
    db.consultants[0]!.onboarding_completed_at =
      "2026-08-01T00:00:00.000Z";
    db.consultants[0]!.is_active = true;
  };

  const revokedGoogle = () => {
    db.oauth_connections = [
      {
        consultant_id: CONSULTANT_ID,
        provider: "google",
        revoked_at: "2026-08-02T00:00:00.000Z",
        encrypted_refresh_token: "encrypted",
      },
    ];
  };

  const missingGoogle = () => {
    db.oauth_connections = [];
  };

  const unhealthyGoogle = () => {
    db.oauth_connections = [
      {
        consultant_id: CONSULTANT_ID,
        provider: "google",
        revoked_at: null,
        encrypted_refresh_token: "",
      },
    ];
  };

  it("lets a completed active consultant update headline with revoked Google", async () => {
    completedActive();
    revokedGoogle();

    const response = await save({
      mode: "update",
      headline: "Updated during outage",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      consultantRow().headline,
      "Updated during outage",
    );
  });

  it("lets a completed active consultant update bio with no Google connection", async () => {
    completedActive();
    missingGoogle();

    const response = await save({
      mode: "update",
      bio: "Rewritten while disconnected",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      consultantRow().bio,
      "Rewritten while disconnected",
    );
  });

  it("lets a completed active consultant update working hours with unhealthy Google", async () => {
    completedActive();
    unhealthyGoogle();

    const response = await save({
      mode: "update",
      working_hours: {
        wednesday: [{ start: "08:00", end: "12:00" }],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      consultantRow().working_hours_jsonb,
      { wednesday: [{ start: "08:00", end: "12:00" }] },
    );
  });

  it("never reports google_calendar as missing on an active update", async () => {
    completedActive();
    missingGoogle();
    db.consultants[0]!.headline = null;

    const response = await save({ mode: "update", bio: "x" });

    assert.equal(response.statusCode, 409);
    const missing = response.json().error.details.missing;
    assert.ok(missing.includes("headline"));
    assert.ok(
      !missing.includes("google_calendar"),
      "google_calendar must not gate an active update",
    );
  });

  it("still blocks a structurally incomplete active update", async () => {
    completedActive();
    revokedGoogle();

    const response = await save({
      mode: "update",
      available_for_general: false,
      country_ids: [],
    });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error.code,
      "CONSULTANT_PROFILE_INCOMPLETE",
    );
    assert.ok(
      response
        .json()
        .error.details.missing.includes("booking_capability"),
    );
    assert.equal(rpcCalls.length, 0);
  });

  it("does not clear the marker, change is_active or unlock gender", async () => {
    completedActive();
    revokedGoogle();

    const response = await save({
      mode: "update",
      headline: "Still editable",
    });
    assert.equal(response.statusCode, 200);

    assert.equal(
      consultantRow().onboarding_completed_at,
      "2026-08-01T00:00:00.000Z",
    );
    assert.equal(consultantRow().is_active, true);
    assert.equal(consultantRow().gender, "female");

    /* Gender is still locked while Google is degraded. */
    const genderChange = await save({
      mode: "update",
      gender: "male",
    });
    assert.equal(genderChange.statusCode, 409);
    assert.equal(
      genderChange.json().error.code,
      "CONSULTANT_GENDER_IMMUTABLE",
    );
    assert.equal(consultantRow().gender, "female");
  });

  it("does not touch OAuth state during a profile save", async () => {
    completedActive();
    revokedGoogle();
    const before = JSON.stringify(db.oauth_connections);

    await save({ mode: "update", headline: "No OAuth writes" });

    assert.equal(
      JSON.stringify(db.oauth_connections),
      before,
    );
  });

  it("still requires Google for the initial submit", async () => {
    missingGoogle();

    const response = await save({
      mode: "submit",
      gender: "female",
    });

    assert.equal(response.statusCode, 409);
    assert.ok(
      response
        .json()
        .error.details.missing.includes("google_calendar"),
    );
    assert.equal(consultantRow().onboarding_completed_at, null);
  });

  it("still requires Google for admin activation", async () => {
    db.consultants[0]!.onboarding_completed_at =
      "2026-08-01T00:00:00.000Z";
    revokedGoogle();

    const response = await activate(CONSULTANT_ID);

    assert.equal(response.statusCode, 409);
    assert.ok(
      response
        .json()
        .error.details.missing.includes("google_calendar"),
    );
    assert.equal(consultantRow().is_active, false);
  });
});

describe("Shared completeness evaluator", () => {
  const base = {
    avatarUrl: "https://cdn.example.test/a.png",
    fullName: "Aisha",
    gender: "female",
    headline: "Headline",
    bio: "Bio",
    timezone: "Africa/Cairo",
    minimumBookingNoticeHours: 24,
    availableForGeneral: true,
    countryIds: [] as string[],
    workingHours: GOOD_HOURS,
    googleConnection: {
      revokedAt: null,
      encryptedRefreshToken: "encrypted",
    },
  };

  it("reports nothing missing for a complete profile", () => {
    assert.deepEqual(
      evaluateProfileCompleteness(base, "onboarding_submit"),
      [],
    );
  });

  it("rejects an invalid timezone", () => {
    assert.deepEqual(
      evaluateProfileCompleteness(
        { ...base, timezone: "Mars/Olympus_Mons" },
        "onboarding_submit",
      ),
      ["timezone"],
    );
  });

  it("rejects an out-of-range notice period", () => {
    assert.deepEqual(
      evaluateProfileCompleteness(
        { ...base, minimumBookingNoticeHours: -1 },
        "onboarding_submit",
      ),
      ["minimum_booking_notice_hours"],
    );
  });

  it("treats a blank string as missing", () => {
    assert.deepEqual(
      evaluateProfileCompleteness(
        { ...base, headline: "   " },
        "onboarding_submit",
      ),
      ["headline"],
    );
  });

  it("requires google_calendar only for submit and activation", () => {
    const degraded = {
      ...base,
      googleConnection: null,
    };

    assert.deepEqual(
      evaluateProfileCompleteness(degraded, "onboarding_submit"),
      ["google_calendar"],
    );
    assert.deepEqual(
      evaluateProfileCompleteness(degraded, "admin_activation"),
      ["google_calendar"],
    );
    assert.deepEqual(
      evaluateProfileCompleteness(degraded, "active_profile_update"),
      [],
      "an active update must not require Google (Amendment 003)",
    );
  });

  it("applies identical structural rules in every context", () => {
    const broken = { ...base, bio: null, googleConnection: null };

    assert.deepEqual(
      evaluateProfileCompleteness(broken, "active_profile_update"),
      ["bio"],
    );
    assert.deepEqual(
      evaluateProfileCompleteness(broken, "onboarding_submit"),
      ["bio", "google_calendar"],
    );
  });
});
