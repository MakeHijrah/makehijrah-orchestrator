/*
 * Where Stripe sends a visitor who abandons checkout.
 *
 * A standard booking came from /consultation and goes back there. A
 * DIRECT booking came from the consultant's own page at a root URL,
 * and returning it to the generic consultation page drops the
 * visitor somewhere they never were — a different page, a different
 * consultant, and no way back to the one they were booking.
 *
 * The security question underneath is authority: the request must
 * not be able to name its own return URL, because a browser that
 * could would send visitors anywhere under the platform's domain
 * with a real consultation id attached. So these tests drive the
 * real service against a fake Stripe and assert what it actually
 * put in cancel_url, and separately that no request field can move
 * it.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const APP_URL = "https://hijrah.network";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://cancel-url-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_cancel_url",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_cancel_url",
  STRIPE_LIVE_SECRET_KEY: "sk_live_cancel_url",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_cancel_url",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_REDIRECT_URI: "https://example.test/oauth/callback",
  APP_URL,
  OAUTH_STATE_SECRET: "test-oauth-state-secret-of-sufficient-length",
  MANDRILL_API_KEY: "test-mandrill-key",
  MANDRILL_FROM_EMAIL: "no-reply@example.test",
  MANDRILL_FROM_NAME: "Make Hijrah Test",
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] ??= value;
}

const { supabaseAdmin } = await import("../../lib/supabase.js");
const { getStripeClient } = await import("../../lib/stripe.js");
const { invalidateSettingsCache } = await import(
  "../settings/settings.provider.js"
);
const { createStripeCheckout } = await import(
  "./checkout.service.js"
);

const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const CLIENT_PROFILE = "22222222-2222-4222-8222-222222222222";
const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

const db: {
  consultations: Row[];
  consultation_intake: Row[];
  consultants: Row[];
  app_settings: Row[];
} = {
  consultations: [],
  consultation_intake: [],
  consultants: [],
  app_settings: [],
};

/* What the fake Stripe was asked to create. */
let sessionParams: Record<string, unknown> | null = null;

const minutesAgo = (minutes: number): string =>
  new Date(
    Date.now() - minutes * 60 * 1000,
  ).toISOString();

class FakeQuery {
  private readonly table: string;
  private columns: string[] = [];
  private readonly filters: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(columns?: string): this {
    this.columns = (columns ?? "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
      /* Strip the comment block the real projection carries. */
      .filter((column) => !column.startsWith("/*"));

    return this;
  }

  update(values: Row): this {
    this.patch = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push(
      (row) => row[column] === value,
    );

    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push(
      (row) => (row[column] ?? null) === value,
    );

    return this;
  }

  limit(): this {
    return this;
  }

  private matched(): Row[] {
    return (
      (db as unknown as Record<string, Row[] | undefined>)[
        this.table
      ] ?? []
    ).filter((row) =>
      this.filters.every((matches) => matches(row)),
    );
  }

  private resolve(): { data: Row[]; error: unknown } {
    const rows = this.matched();

    if (this.patch) {
      for (const row of rows) {
        Object.assign(row, this.patch);
      }
    }

    return {
      data: rows.map((row) => ({ ...row })),
      error: null,
    };
  }

  async maybeSingle(): Promise<{
    data: Row | null;
    error: unknown;
  }> {
    return {
      data: this.resolve().data[0] ?? null,
      error: null,
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

/*
 * The real client, with one method replaced so the session it would
 * have created is recorded instead of sent. The clients map caches
 * per mode, so the service's own getStripeClient("test") returns
 * this same instance.
 *
 * Manual capture is asserted off the recorded object too: this
 * build must not touch it, and reading it from the same place the
 * cancel URL comes from proves it.
 */
const stripe = getStripeClient("test");

stripe.checkout.sessions.create = (async (
  params: Record<string, unknown>,
) => {
  sessionParams = params;

  return {
    id: "cs_test_cancel_url",
    url: "https://checkout.stripe.test/session",
    payment_intent: null,
  };
}) as unknown as typeof stripe.checkout.sessions.create;

const cancelUrl = (): string =>
  String(sessionParams?.cancel_url ?? "");

beforeEach(() => {
  sessionParams = null;
  invalidateSettingsCache();

  db.consultations = [
    {
      id: CONSULTATION_ID,
      client_profile_id: CLIENT_PROFILE,
      consultant_id: CONSULTANT_ID,
      booking_source: "standard",
      status: "draft",
      price_cents: 15_000,
      currency: "usd",
      stripe_payment_intent_id: null,
      stripe_mode: null,
      created_at: minutesAgo(2),
    },
  ];

  db.consultation_intake = [
    {
      consultation_id: CONSULTATION_ID,
      email: "client@example.test",
      full_name: "A Client",
    },
  ];

  db.consultants = [
    {
      id: CONSULTANT_ID,
      profile_id: "profile-1",
      is_active: true,
      consultant_slug: "omar-sherrer",
      direct_booking_enabled: true,
      direct_booking_price_cents: 20_000,
    },
  ];

  db.app_settings = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      consultation_price_cents: 15_000,
      consultation_currency: "usd",
      consultation_duration_minutes: 60,
      stripe_mode: "test",
      support_email: "support@example.test",
      default_timezone: "UTC",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  ];
});

const makeDirect = (): void => {
  db.consultations[0]!.booking_source =
    "direct_booking";
  db.consultations[0]!.price_cents = 20_000;
};

describe("Standard booking cancel URL", () => {
  it("returns the visitor to the consultation page", async () => {
    const result = await createStripeCheckout(
      CONSULTATION_ID,
    );

    assert.equal(result.ok, true);

    assert.equal(
      cancelUrl(),
      `${APP_URL}/consultation?booking=cancelled&cid=${CONSULTATION_ID}`,
    );
  });

  it("carries booking=cancelled and the consultation id", async () => {
    await createStripeCheckout(CONSULTATION_ID);

    /* Asserted as a parsed URL, not by substring. */
    const parsed = new URL(cancelUrl());

    assert.equal(parsed.pathname, "/consultation");
    assert.equal(
      parsed.searchParams.get("booking"),
      "cancelled",
    );
    assert.equal(
      parsed.searchParams.get("cid"),
      CONSULTATION_ID,
    );
  });
});

describe("Direct booking cancel URL", () => {
  it("returns the visitor to the consultant's own page", async () => {
    makeDirect();

    const result = await createStripeCheckout(
      CONSULTATION_ID,
    );

    assert.equal(result.ok, true);

    assert.equal(
      cancelUrl(),
      `${APP_URL}/omar-sherrer?booking=cancelled&cid=${CONSULTATION_ID}`,
    );

    const parsed = new URL(cancelUrl());

    assert.equal(parsed.pathname, "/omar-sherrer");
    assert.equal(
      parsed.searchParams.get("booking"),
      "cancelled",
    );
    assert.equal(
      parsed.searchParams.get("cid"),
      CONSULTATION_ID,
    );
  });

  it("takes the slug from the consultant's stored row", async () => {
    makeDirect();

    /*
     * The stored slug is what the URL must use — never a value
     * re-derived from the consultant's name. Regenerating would
     * reproduce the generator's collision suffixes and could point
     * at a different consultant entirely: john-smith when the
     * booking belongs to john-smith-2.
     */
    db.consultants[0]!.consultant_slug =
      "omar-sherrer-2";

    await createStripeCheckout(
      CONSULTATION_ID,
    );

    assert.equal(
      new URL(cancelUrl()).pathname,
      "/omar-sherrer-2",
    );
  });

  it("still uses the consultant's page when their booking page is off", async () => {
    makeDirect();
    db.consultants[0]!.direct_booking_enabled =
      false;

    await createStripeCheckout(
      CONSULTATION_ID,
    );

    /*
     * The consultation was created while the page was live. The
     * slug still names the right consultant, and sending the
     * visitor to the generic page instead would be a different
     * kind of wrong.
     */
    assert.equal(
      new URL(cancelUrl()).pathname,
      "/omar-sherrer",
    );
  });

  it("refuses checkout when a direct booking has no slug", async () => {
    makeDirect();
    db.consultants[0]!.consultant_slug = null;

    const result = await createStripeCheckout(
      CONSULTATION_ID,
    );

    /*
     * This state should not exist — activation generates a slug and
     * neither write path can null it. Refusing beats falling back
     * to the generic page: creating a payment session on top of a
     * data integrity problem hides the problem behind a successful
     * checkout.
     */
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "INTERNAL_ERROR",
    );

    /* And no Stripe session was created at all. */
    assert.equal(sessionParams, null);
  });
});

describe("The server is the only authority", () => {
  it("has nowhere for a caller to put a cancel URL", async () => {
    makeDirect();

    /*
     * createStripeCheckout takes ONE argument, and it is a
     * consultation id. There is no object, no options bag and no
     * optional field through which a cancel URL, a slug or a
     * booking source could arrive - which is the strongest form
     * this guarantee can take, because it is not a check that
     * could be removed.
     *
     * Asserted on the function itself so a later edit that added
     * an options parameter fails here rather than becoming an open
     * redirect.
     */
    assert.equal(createStripeCheckout.length, 1);

    await createStripeCheckout(CONSULTATION_ID);

    /* The URL is the consultant's, derived from stored records. */
    assert.equal(
      cancelUrl(),
      `${APP_URL}/omar-sherrer?booking=cancelled&cid=${CONSULTATION_ID}`,
    );
  });

  it("ignores a booking source the request cannot supply anyway", async () => {
    /*
     * The source is read off the consultation row. A standard
     * booking whose consultant HAS a slug still returns to the
     * generic page, because the row says standard - the slug's
     * existence is not what decides it.
     */
    assert.equal(
      db.consultants[0]!.consultant_slug,
      "omar-sherrer",
    );

    await createStripeCheckout(CONSULTATION_ID);

    assert.equal(
      new URL(cancelUrl()).pathname,
      "/consultation",
    );
  });

  it("leaves the success URL and manual capture untouched", async () => {
    await createStripeCheckout(
      CONSULTATION_ID,
    );

    /*
     * This build is cancel routing only. Both of these are read
     * from the same recorded session, so a change to either would
     * fail here.
     */
    assert.equal(
      sessionParams?.success_url,
      `${APP_URL}/login?payment=success&redirect=${encodeURIComponent(
        "/dashboard",
      )}`,
    );

    assert.equal(
      (
        sessionParams?.payment_intent_data as {
          capture_method?: string;
        }
      )?.capture_method,
      "manual",
    );
  });
});
