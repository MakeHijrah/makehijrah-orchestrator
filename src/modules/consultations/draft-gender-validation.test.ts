/*
 * Consultant eligibility for a draft consultation: identity,
 * activation, gender, gender preference and destination
 * capability.
 *
 * Nothing external is contacted. Supabase is an in-memory fake.
 *
 * The suite has two halves. The unit half drives the validator
 * directly across the destination matrix. The route half drives
 * the real POST /api/consultations/draft handler and asserts that
 * a rejected request performs no write of any kind, which is the
 * property that actually matters: validation is worthless if a
 * draft, a hold or a booking account has already been created by
 * the time it runs.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://draft-validation-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_draft_validation",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_draft_validation",
  STRIPE_LIVE_SECRET_KEY: "sk_live_draft_validation",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_draft_validation",
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
const { validateDraftConsultantGender } = await import(
  "./draft-gender-validation.js"
);
const { registerDraftConsultationRoute } = await import("./draft.route.js");
const { invalidateSettingsCache } = await import(
  "../settings/settings.provider.js"
);

const CONSULTANT_ID = "11111111-1111-4111-8111-111111111111";
const COUNTRY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COUNTRY_ID = "33333333-3333-4333-8333-333333333333";
const SETTINGS_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

type Db = {
  consultants: Row[];
  countries: Row[];
  consultant_countries: Row[];
  app_settings: Row[];
};

const db: Db = {
  consultants: [],
  countries: [],
  consultant_countries: [],
  app_settings: [],
};

/*
 * Every non-select operation is recorded. A rejected request must
 * leave this empty.
 */
type WriteOp = { table: string; op: string };

let writes: WriteOp[] = [];
let selects: string[] = [];

const rowsFor = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

class FakeQuery {
  private op = "select";
  private filters: [string, unknown][] = [];
  private wantsSingle = false;

  constructor(private readonly table: string) {
    selects.push(table);
  }

  select() {
    return this;
  }

  limit() {
    return this;
  }

  insert(values: Row) {
    this.op = "insert";
    writes.push({ table: this.table, op: "insert" });
    void values;
    return this;
  }

  update(values: Row) {
    this.op = "update";
    writes.push({ table: this.table, op: "update" });
    void values;
    return this;
  }

  delete() {
    this.op = "delete";
    writes.push({ table: this.table, op: "delete" });
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  maybeSingle() {
    this.wantsSingle = true;
    return this.run();
  }

  then<T>(resolve: (value: unknown) => T, reject?: (reason: unknown) => T) {
    return this.run().then(resolve, reject);
  }

  private async run(): Promise<Row> {
    if (this.op !== "select") {
      return { data: null, error: null };
    }

    const matched = rowsFor(this.table).filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );

    return {
      data: this.wantsSingle ? (matched[0] ?? null) : matched,
      error: null,
    };
  }
}

const installStubs = (): void => {
  db.consultants = [
    {
      id: CONSULTANT_ID,
      gender: "male",
      is_active: true,
      available_for_general: false,
    },
  ];
  /*
   * tagline arrives with migration 033. Booking validation turns
   * on id and is_active only, so it is carried here to keep the
   * rows shaped like the deployed table.
   */
  db.countries = [
    {
      id: COUNTRY_ID,
      tagline: "The first country",
      is_active: true,
    },
    {
      id: OTHER_COUNTRY_ID,
      tagline: null,
      is_active: true,
    },
  ];
  db.consultant_countries = [
    { consultant_id: CONSULTANT_ID, country_id: COUNTRY_ID },
  ];
  db.app_settings = [
    {
      id: SETTINGS_ID,
      consultation_price_cents: 15_000,
      consultation_currency: "usd",
      consultation_duration_minutes: 60,
      stripe_mode: "test",
      support_email: null,
      default_timezone: "Africa/Cairo",
      updated_at: "2026-08-03T00:00:00.000Z",
    },
  ];

  writes = [];
  selects = [];

  supabaseAdmin.from = ((table: string) =>
    new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

  /*
   * The settings cache would otherwise carry a value across
   * tests and hide a lookup.
   */
  invalidateSettingsCache();
};

const validate = (overrides: {
  countryId: string | null;
  preferredConsultantGender?: "male" | "female" | "no_preference";
}) =>
  validateDraftConsultantGender({
    consultantId: CONSULTANT_ID,
    countryId: overrides.countryId,
    preferredConsultantGender:
      overrides.preferredConsultantGender ?? "no_preference",
  });

describe("draft consultant destination validation", () => {
  beforeEach(installStubs);

  it("accepts an assigned active country", async () => {
    const result = await validate({ countryId: COUNTRY_ID });

    assert.equal(result.ok, true);
    assert.equal(writes.length, 0);
  });

  it("rejects a country the consultant is not assigned to", async () => {
    const result = await validate({ countryId: OTHER_COUNTRY_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "VALIDATION_ERROR");
    assert.equal(
      result.ok === false && result.reason,
      "consultant_country_mismatch",
    );
    assert.equal(
      result.ok === false && result.message,
      "The selected consultant is not available for this destination.",
    );
  });

  it("rejects an assigned but inactive country", async () => {
    (db.countries[0] as Row).is_active = false;

    const result = await validate({ countryId: COUNTRY_ID });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.reason,
      "consultant_country_mismatch",
    );
  });

  it("rejects an unknown country", async () => {
    db.countries = [];

    const result = await validate({ countryId: COUNTRY_ID });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.reason,
      "consultant_country_mismatch",
    );
  });

  it("accepts a general-capable consultant with a null country", async () => {
    (db.consultants[0] as Row).available_for_general = true;

    const result = await validate({ countryId: null });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.consultantGender, "male");
  });

  it("rejects a non-general consultant with a null country", async () => {
    const result = await validate({ countryId: null });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "VALIDATION_ERROR");
    assert.equal(
      result.ok === false && result.reason,
      "consultant_not_general",
    );
    assert.equal(
      result.ok === false && result.message,
      "The selected consultant is not available for this destination.",
    );
  });

  it("decides on is_active, not on whether a tagline is set", async () => {
    /*
     * The country the consultant is assigned to carries a
     * tagline; the one they are not carries none. Neither fact
     * may move the decision.
     */
    const assigned = await validate({ countryId: COUNTRY_ID });
    assert.equal(assigned.ok, true);

    (db.countries[0] as Row).tagline = null;

    const withoutTagline = await validate({
      countryId: COUNTRY_ID,
    });
    assert.equal(withoutTagline.ok, true);

    (db.countries[1] as Row).tagline = "A tagline";

    const unassigned = await validate({
      countryId: OTHER_COUNTRY_ID,
    });
    assert.equal(unassigned.ok, false);
  });

  it("does not consult country tables for a general booking", async () => {
    (db.consultants[0] as Row).available_for_general = true;

    await validate({ countryId: null });

    assert.equal(selects.includes("countries"), false);
    assert.equal(selects.includes("consultant_countries"), false);
  });
});

describe("draft consultant gender validation is unchanged", () => {
  beforeEach(installStubs);

  it("accepts a matching gender preference", async () => {
    const result = await validate({
      countryId: COUNTRY_ID,
      preferredConsultantGender: "male",
    });

    assert.equal(result.ok, true);
  });

  it("rejects a mismatched gender preference", async () => {
    const result = await validate({
      countryId: COUNTRY_ID,
      preferredConsultantGender: "female",
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "VALIDATION_ERROR");
    assert.equal(
      result.ok === false && result.message,
      "The selected consultant does not match your consultant preference.",
    );
    /* Gender rejections carry no reason: contract unchanged. */
    assert.equal(result.ok === false && result.reason, undefined);
  });

  it("rejects a gender mismatch before any destination lookup", async () => {
    await validate({
      countryId: OTHER_COUNTRY_ID,
      preferredConsultantGender: "female",
    });

    assert.equal(selects.includes("countries"), false);
    assert.equal(selects.includes("consultant_countries"), false);
  });

  it("rejects an inactive consultant as not found", async () => {
    (db.consultants[0] as Row).is_active = false;

    const result = await validate({ countryId: COUNTRY_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "NOT_FOUND");
  });

  it("rejects a consultant with an unusable gender", async () => {
    (db.consultants[0] as Row).gender = null;

    const result = await validate({ countryId: COUNTRY_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "VALIDATION_ERROR");
  });
});

describe("draft route rejects before any side effect", () => {
  beforeEach(installStubs);

  const buildApp = async () => {
    const app = Fastify({ logger: false });
    await registerDraftConsultationRoute(app);
    await app.ready();
    return app;
  };

  const body = (countryId: string | null) => ({
    consultant_id: CONSULTANT_ID,
    country_id: countryId,
    start_at: "2026-09-01T09:00:00.000Z",
    client_timezone: "Africa/Cairo",
    intake: {
      full_name: "Regression Client",
      email: "client@example.test",
      phone_whatsapp: {
        country_code: "EG",
        local_number: "1001234567",
      },
      answers: {
        consultation_summary: "Temporary regression fixture.",
        client_gender: "male",
        preferred_consultant_gender: "no_preference",
      },
    },
  });

  const post = async (countryId: string | null) => {
    const app = await buildApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/consultations/draft",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(body(countryId)),
      });

      return { statusCode: response.statusCode, body: response.json() };
    } finally {
      await app.close();
    }
  };

  it("returns 400 consultant_country_mismatch and writes nothing", async () => {
    const response = await post(OTHER_COUNTRY_ID);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error?.code, "VALIDATION_ERROR");
    assert.equal(
      response.body.error?.details?.reason,
      "consultant_country_mismatch",
    );
    assert.equal(
      response.body.error?.message,
      "The selected consultant is not available for this destination.",
    );

    assert.deepEqual(writes, [], "no insert, update or delete occurred");
    assert.equal(
      selects.includes("consultations"),
      false,
      "no draft was created or held",
    );
    assert.equal(
      selects.includes("profiles"),
      false,
      "no booking account was resolved",
    );
  });

  it("returns 400 consultant_not_general and writes nothing", async () => {
    const response = await post(null);

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.body.error?.details?.reason,
      "consultant_not_general",
    );
    assert.deepEqual(writes, [], "no insert, update or delete occurred");
  });
});
