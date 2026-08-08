/*
 * Post-purchase service instructions tests. Migration 042.
 *
 * Nothing external is contacted; Supabase and Stripe are in-memory
 * fakes. The Stripe fake reproduces the fields the verification
 * actually reads — livemode, payment_status, metadata,
 * client_reference_id — because those four are the whole security
 * argument for the webhook-independent path.
 *
 * The single most important assertion in this file is that a SENT
 * RECOMMENDATION ALONE DOES NOT REVEAL INSTRUCTIONS. Everything
 * else guards the edges of that rule.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://instructions-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_instructions",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_instructions",
  STRIPE_LIVE_SECRET_KEY: "sk_live_instructions",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_instructions",
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
const { getStripeClient } = await import("../../lib/stripe.js");
const { redis } = await import("../../lib/redis.js");
const { registerServiceInstructionsRoute } = await import(
  "./service-instructions.route.js"
);
const { registerServiceCheckoutRoute } = await import(
  "../services/service-checkout.route.js"
);

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CLIENT_PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT_PROFILE = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
const CONSULTANT_PROFILE = "22222222-2222-4222-8222-222222222222";
const ADMIN_PROFILE = "33333333-3333-4333-8333-333333333333";

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";

const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_SERVICE_ID = "56565656-5656-4656-8656-565656565656";
const UNRELATED_SERVICE_ID = "57575757-5757-4757-8757-575757575757";
const RECURRING_SERVICE_ID = "58585858-5858-4858-8858-585858585858";

const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_CONSULTATION_ID = "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a";

const STORED_HTML =
  '<p>Welcome. <a href="https://example.test" rel="noopener noreferrer nofollow" target="_blank">Book your call</a>.</p>';

type Row = Record<string, unknown>;

const db: {
  profiles: Row[];
  consultants: Row[];
  services: Row[];
  consultations: Row[];
  service_recommendations: Row[];
  service_requests: Row[];
  service_purchases: Row[];
  app_settings: Row[];
} = {
  profiles: [],
  consultants: [],
  services: [],
  consultations: [],
  service_recommendations: [],
  service_requests: [],
  service_purchases: [],
  app_settings: [],
};

/* ------------------------------------------- Supabase fake -- */

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
    if (column.includes(".")) {
      const [, joined] = column.split(".");

      this.filters.push((row) => {
        const linked = db.consultations.find(
          (c) => c.id === row.consultation_id,
        );

        return linked?.[joined!] === value;
      });

      return this;
    }

    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) =>
      values.includes(row[column]),
    );
    return this;
  }

  order(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  private rows(): Row[] {
    return (
      (db as unknown as Record<string, Row[] | undefined>)[
        this.table
      ] ?? []
    ).filter((row) =>
      this.filters.every((matches) => matches(row)),
    );
  }

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

/* ---------------------------------------------- Stripe fake -- */

const stripeSessions = new Map<string, Row>();
const createdSessions: Array<Record<string, unknown>> = [];

const stripe = getStripeClient("test");

stripe.checkout.sessions.retrieve = (async (
  id: string,
) => {
  const session = stripeSessions.get(id);

  if (!session) {
    /* What Stripe does for an id that is not ours. */
    throw new Error(`No such checkout session: ${id}`);
  }

  return session;
}) as unknown as typeof stripe.checkout.sessions.retrieve;

stripe.checkout.sessions.create = (async (
  params: Record<string, unknown>,
) => {
  createdSessions.push(params);

  return {
    id: `cs_test_created${createdSessions.length}`,
    url: "https://checkout.stripe.test/session",
  };
}) as unknown as typeof stripe.checkout.sessions.create;

const redisStore = new Map<string, string>();
redis.get = (async (key: string) =>
  redisStore.get(key) ?? null) as unknown as typeof redis.get;
redis.set = (async (key: string, value: string) => {
  redisStore.set(key, value);
  return "OK";
}) as unknown as typeof redis.set;
redis.del = (async (key: string) => {
  redisStore.delete(key);
  return 1;
}) as unknown as typeof redis.del;

/*
 * A Checkout Session as our own checkout endpoint would have
 * created it. Every test that needs an INVALID session overrides
 * exactly one field, so each assertion names the single thing
 * that made the session unacceptable.
 */
const trustedSession = (
  overrides: Row = {},
): Row => ({
  id: "cs_test_trusted",
  object: "checkout.session",
  livemode: false,
  status: "complete",
  payment_status: "paid",
  client_reference_id: CLIENT_PROFILE,
  metadata: {
    makehijrah_service_id: SERVICE_ID,
    makehijrah_client_profile_id: CLIENT_PROFILE,
    makehijrah_consultation_id: CONSULTATION_ID,
    application: "makehijrah-orchestrator",
    environment: "staging",
  },
  ...overrides,
});

/* ---------------------------------------------------- the app -- */

const app = Fastify();
await registerServiceInstructionsRoute(app);
await registerServiceCheckoutRoute(app);
await app.ready();

const get = async (
  url: string,
  token: string | null,
): Promise<{
  statusCode: number;
  json: () => { ok: boolean; data?: Row; error?: Row };
}> => {
  const response = await app.inject({
    method: "GET",
    url,
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
  });

  return {
    statusCode: response.statusCode,
    json: () =>
      response.json() as {
        ok: boolean;
        data?: Row;
        error?: Row;
      },
  };
};

const post = async (
  url: string,
  body: unknown,
  token: string | null,
): Promise<{
  statusCode: number;
  json: () => { ok: boolean; data?: Row; error?: Row };
}> => {
  const response = await app.inject({
    method: "POST",
    url,
    payload: body ?? {},
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
  });

  return {
    statusCode: response.statusCode,
    json: () =>
      response.json() as {
        ok: boolean;
        data?: Row;
        error?: Row;
      },
  };
};

const instructionsUrl = (
  consultationId = CONSULTATION_ID,
  serviceId = SERVICE_ID,
  sessionId?: string,
): string =>
  `/api/consultations/${consultationId}/services/${serviceId}/instructions` +
  (sessionId ? `?session_id=${sessionId}` : "");

const addPurchase = (overrides: Row = {}): void => {
  db.service_purchases.push({
    id: "99999999-9999-4999-8999-000000000001",
    service_id: SERVICE_ID,
    client_profile_id: CLIENT_PROFILE,
    consultation_id: CONSULTATION_ID,
    status: "paid",
    ...overrides,
  });
};

beforeEach(() => {
  createdSessions.length = 0;
  stripeSessions.clear();
  redisStore.clear();

  db.profiles = [
    { id: CLIENT_PROFILE, role: "client" },
    { id: OTHER_CLIENT_PROFILE, role: "client" },
    { id: CONSULTANT_PROFILE, role: "consultant" },
    { id: ADMIN_PROFILE, role: "admin" },
  ];

  db.consultants = [
    { id: CONSULTANT_ID, profile_id: CONSULTANT_PROFILE },
  ];

  db.services = [
    {
      id: SERVICE_ID,
      name: "Visa Pack",
      is_active: true,
      billing_type: "one_time",
      price_cents: 9_999,
      currency: "usd",
      stripe_price_id: "price_one",
      consultant_commission_bps: 4_500,
      post_purchase_instructions_html: STORED_HTML,
    },
    {
      id: OTHER_SERVICE_ID,
      name: "Other Service",
      is_active: true,
      billing_type: "one_time",
      price_cents: 5_000,
      currency: "usd",
      stripe_price_id: "price_other",
      post_purchase_instructions_html:
        "<p>Other instructions.</p>",
    },
    {
      id: UNRELATED_SERVICE_ID,
      name: "Unrelated Service",
      is_active: true,
      billing_type: "one_time",
      price_cents: 5_000,
      currency: "usd",
      stripe_price_id: "price_unrelated",
      post_purchase_instructions_html:
        "<p>Secret delivery.</p>",
    },
    {
      id: RECURRING_SERVICE_ID,
      name: "Retainer",
      is_active: true,
      billing_type: "recurring",
      recurring_interval: "month",
      price_cents: 20_000,
      currency: "usd",
      stripe_price_id: "price_sub",
      post_purchase_instructions_html:
        "<p>Retainer onboarding.</p>",
    },
  ];

  db.consultations = [
    {
      id: CONSULTATION_ID,
      client_profile_id: CLIENT_PROFILE,
      consultant_id: CONSULTANT_ID,
    },
    {
      id: OTHER_CONSULTATION_ID,
      client_profile_id: OTHER_CLIENT_PROFILE,
      consultant_id: CONSULTANT_ID,
    },
  ];

  db.service_recommendations = [
    {
      id: "rec-1",
      consultation_id: CONSULTATION_ID,
      service_id: SERVICE_ID,
      recommended_by_consultant_id: CONSULTANT_ID,
      status: "sent",
      sent_at: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "rec-2",
      consultation_id: CONSULTATION_ID,
      service_id: OTHER_SERVICE_ID,
      recommended_by_consultant_id: CONSULTANT_ID,
      status: "sent",
      sent_at: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "rec-3",
      consultation_id: CONSULTATION_ID,
      service_id: RECURRING_SERVICE_ID,
      recommended_by_consultant_id: CONSULTANT_ID,
      status: "sent",
      sent_at: "2026-08-01T10:00:00.000Z",
    },
  ];

  db.service_requests = [];
  db.service_purchases = [];

  db.app_settings = [
    {
      id: "88888888-8888-4888-8888-888888888888",
      stripe_mode: "test",
      consultation_price_cents: 15_000,
      consultation_currency: "usd",
      consultation_duration_minutes: 60,
    },
  ];
});

describe("Service instructions: access through a recorded purchase", () => {
  it("returns instructions for a paid purchase", async () => {
    addPurchase({ status: "paid" });

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data!.service_id,
      SERVICE_ID,
    );
    assert.equal(
      response.json().data!.service_name,
      "Visa Pack",
    );
    assert.ok(
      String(
        response.json().data!
          .post_purchase_instructions_html,
      ).includes("Book your call"),
    );
  });

  it("returns instructions for a fulfilled purchase", async () => {
    addPurchase({ status: "fulfilled" });

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);
  });

  it("still returns instructions after a refund", async () => {
    addPurchase({ status: "refunded" });

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      200,
      "a refund reverses money, not the record that the client was once entitled to read this",
    );
  });

  it("refuses a cancelled purchase", async () => {
    addPurchase({ status: "cancelled" });

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });

  it("returns instructions for a deactivated service that was purchased", async () => {
    db.services[0]!.is_active = false;
    addPurchase();

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      200,
      "withdrawing a catalogue entry must not withdraw what somebody already owns",
    );
  });

  it("returns null instructions when the admin has written none", async () => {
    db.services[0]!.post_purchase_instructions_html = null;
    addPurchase();

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data!
        .post_purchase_instructions_html,
      null,
    );
  });

  it("re-sanitizes the stored HTML on the way out", async () => {
    /* As if the row had been edited in the SQL editor. */
    db.services[0]!.post_purchase_instructions_html =
      '<p>ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>';
    addPurchase();

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    const html = String(
      response.json().data!
        .post_purchase_instructions_html,
    );

    assert.ok(!/script/i.test(html));
    assert.ok(!/javascript:/i.test(html));
    assert.ok(html.includes("ok"));
  });
});

describe("Service instructions: a recommendation is not payment", () => {
  it("refuses a sent recommendation with no payment at all", async () => {
    /* The recommendation exists; nothing else does. */
    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      404,
      "an admin offering a service is not the client having bought it",
    );
    assert.equal(
      response.json().data,
      undefined,
    );
  });

  it("refuses a purchase belonging to a different consultation", async () => {
    addPurchase({
      consultation_id: OTHER_CONSULTATION_ID,
    });

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });

  it("refuses a purchase belonging to a different client", async () => {
    addPurchase({
      client_profile_id: OTHER_CLIENT_PROFILE,
    });

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });
});

describe("Service instructions: ownership and enumeration", () => {
  it("refuses another client's consultation", async () => {
    db.service_recommendations.push({
      id: "rec-other",
      consultation_id: OTHER_CONSULTATION_ID,
      service_id: SERVICE_ID,
      recommended_by_consultant_id: CONSULTANT_ID,
      status: "sent",
      sent_at: "2026-08-01T10:00:00.000Z",
    });

    db.service_purchases.push({
      id: "99999999-9999-4999-8999-000000000009",
      service_id: SERVICE_ID,
      client_profile_id: OTHER_CLIENT_PROFILE,
      consultation_id: OTHER_CONSULTATION_ID,
      status: "paid",
    });

    const response = await get(
      instructionsUrl(OTHER_CONSULTATION_ID),
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      404,
      "client A must not read client B's consultation, even for a service A was also recommended",
    );
  });

  it("refuses a service unrelated to the consultation", async () => {
    addPurchase();

    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        UNRELATED_SERVICE_ID,
      ),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });

  it("refuses an unknown service and an unknown consultation identically", async () => {
    const unknownService = await get(
      instructionsUrl(
        CONSULTATION_ID,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
      CLIENT_PROFILE,
    );

    const unknownConsultation = await get(
      instructionsUrl(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        SERVICE_ID,
      ),
      CLIENT_PROFILE,
    );

    assert.equal(unknownService.statusCode, 404);
    assert.equal(unknownConsultation.statusCode, 404);
    assert.deepEqual(
      unknownService.json().error,
      unknownConsultation.json().error,
      "the difference between 'no such thing' and 'not yours' is itself information",
    );
  });

  it("refuses a consultant, an admin and an anonymous caller", async () => {
    addPurchase();

    for (const token of [
      CONSULTANT_PROFILE,
      ADMIN_PROFILE,
    ]) {
      const response = await get(
        instructionsUrl(),
        token,
      );

      assert.equal(response.statusCode, 403);
    }

    const anonymous = await get(
      instructionsUrl(),
      null,
    );

    assert.equal(anonymous.statusCode, 401);
  });

  it("returns exactly three fields", async () => {
    addPurchase();

    const response = await get(
      instructionsUrl(),
      CLIENT_PROFILE,
    );

    assert.deepEqual(
      Object.keys(response.json().data!).sort(),
      [
        "post_purchase_instructions_html",
        "service_id",
        "service_name",
      ],
      "no price, Stripe identifier, commission or purchase may leak into this response",
    );
  });
});

describe("Service instructions: verified Checkout Session", () => {
  it("grants access before service_purchases exists", async () => {
    stripeSessions.set(
      "cs_test_trusted",
      trustedSession(),
    );

    assert.equal(
      db.service_purchases.length,
      0,
      "precondition: the webhook has not landed",
    );

    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_trusted",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.ok(
      String(
        response.json().data!
          .post_purchase_instructions_html,
      ).includes("Book your call"),
    );
  });

  it("refuses an unpaid or incomplete session", async () => {
    for (const overrides of [
      { payment_status: "unpaid" },
      { payment_status: "no_payment_required" },
      { status: "open", payment_status: "unpaid" },
    ]) {
      stripeSessions.set(
        "cs_test_trusted",
        trustedSession(overrides),
      );

      const response = await get(
        instructionsUrl(
          CONSULTATION_ID,
          SERVICE_ID,
          "cs_test_trusted",
        ),
        CLIENT_PROFILE,
      );

      assert.equal(
        response.statusCode,
        404,
        `an unpaid session must not authorise: ${JSON.stringify(overrides)}`,
      );
    }
  });

  it("refuses a session naming another client", async () => {
    stripeSessions.set(
      "cs_test_trusted",
      trustedSession({
        metadata: {
          makehijrah_service_id: SERVICE_ID,
          makehijrah_client_profile_id:
            OTHER_CLIENT_PROFILE,
          makehijrah_consultation_id: CONSULTATION_ID,
        },
        client_reference_id: OTHER_CLIENT_PROFILE,
      }),
    );

    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_trusted",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });

  it("refuses a session naming another service", async () => {
    stripeSessions.set(
      "cs_test_trusted",
      trustedSession({
        metadata: {
          makehijrah_service_id: OTHER_SERVICE_ID,
          makehijrah_client_profile_id: CLIENT_PROFILE,
          makehijrah_consultation_id: CONSULTATION_ID,
        },
      }),
    );

    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_trusted",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      404,
      "a genuinely paid session for a different service proves nothing about this one",
    );
  });

  it("refuses a session naming another consultation", async () => {
    stripeSessions.set(
      "cs_test_trusted",
      trustedSession({
        metadata: {
          makehijrah_service_id: SERVICE_ID,
          makehijrah_client_profile_id: CLIENT_PROFILE,
          makehijrah_consultation_id:
            OTHER_CONSULTATION_ID,
        },
      }),
    );

    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_trusted",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });

  it("refuses a session with no MakeHijrah metadata", async () => {
    stripeSessions.set(
      "cs_test_trusted",
      trustedSession({ metadata: {} }),
    );

    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_trusted",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      404,
      "a session this orchestrator did not create carries none of the three keys it checks",
    );
  });

  it("refuses a live session while running in test mode", async () => {
    stripeSessions.set(
      "cs_test_trusted",
      trustedSession({ livemode: true }),
    );

    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_trusted",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });

  it("refuses a forged or unknown session id", async () => {
    /* Nothing registered: the fake throws, as Stripe would. */
    const response = await get(
      instructionsUrl(
        CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_forged",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });

  it("ignores a malformed session id rather than failing on it", async () => {
    addPurchase();

    const response = await get(
      `/api/consultations/${CONSULTATION_ID}/services/${SERVICE_ID}/instructions?session_id=not-a-session`,
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      200,
      "a junk session id must degrade to 'no session supplied', not break the recorded-purchase path",
    );
  });

  it("does not let a session authorise another client's consultation", async () => {
    stripeSessions.set(
      "cs_test_trusted",
      trustedSession({
        metadata: {
          makehijrah_service_id: SERVICE_ID,
          makehijrah_client_profile_id: CLIENT_PROFILE,
          makehijrah_consultation_id:
            OTHER_CONSULTATION_ID,
        },
      }),
    );

    const response = await get(
      instructionsUrl(
        OTHER_CONSULTATION_ID,
        SERVICE_ID,
        "cs_test_trusted",
      ),
      CLIENT_PROFILE,
    );

    assert.equal(
      response.statusCode,
      404,
      "ownership of the consultation is checked before the session is even consulted",
    );
  });
});

describe("Service checkout: return URLs", () => {
  it("returns an attributed buyer to their consultation", async () => {
    const response = await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {},
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);

    const params = createdSessions[0]!;
    const successUrl = String(params.success_url);
    const cancelUrl = String(params.cancel_url);

    assert.ok(
      successUrl.startsWith(
        `https://app.example.test/dashboard/consultation/${CONSULTATION_ID}`,
      ),
      `success URL was ${successUrl}`,
    );
    assert.ok(successUrl.includes("purchase=success"));
    assert.ok(
      successUrl.includes(`service=${SERVICE_ID}`),
    );

    assert.equal(
      cancelUrl,
      `https://app.example.test/dashboard/consultation/${CONSULTATION_ID}?purchase=cancelled`,
    );
  });

  it("keeps {CHECKOUT_SESSION_ID} as a literal Stripe placeholder", async () => {
    await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {},
      CLIENT_PROFILE,
    );

    const successUrl = String(
      createdSessions[0]!.success_url,
    );

    assert.ok(
      successUrl.endsWith(
        "&session_id={CHECKOUT_SESSION_ID}",
      ),
      `Stripe must be able to substitute the placeholder; got ${successUrl}`,
    );
    assert.ok(
      !successUrl.includes("%7B") &&
        !successUrl.includes("%7D"),
      "percent-encoding the braces would leave a literal that Stripe never replaces",
    );
  });

  it("falls back to the dashboard for an unattributed purchase", async () => {
    db.service_recommendations = [];

    const response = await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {},
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data!.attributed,
      false,
    );

    const successUrl = String(
      createdSessions[0]!.success_url,
    );

    assert.ok(
      successUrl.startsWith(
        "https://app.example.test/dashboard?purchase=success",
      ),
      `unattributed success URL was ${successUrl}`,
    );
    assert.ok(
      successUrl.includes(
        "&session_id={CHECKOUT_SESSION_ID}",
      ),
    );
    assert.ok(
      !successUrl.includes("/consultation/"),
      "there is no consultation to return to",
    );

    assert.equal(
      String(createdSessions[0]!.cancel_url),
      "https://app.example.test/dashboard?purchase=cancelled",
    );
  });

  it("ignores redirect and context fields a client tries to supply", async () => {
    const response = await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {
        success_url: "https://evil.test/win",
        cancel_url: "https://evil.test/lose",
        consultation_id: OTHER_CONSULTATION_ID,
        client_profile_id: OTHER_CLIENT_PROFILE,
        consultant_id: CONSULTANT_ID,
        service_request_id:
          "77777777-7777-4777-8777-777777777777",
      },
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);

    const params = createdSessions[0]!;
    const urls = `${params.success_url} ${params.cancel_url}`;

    assert.ok(!urls.includes("evil.test"));
    assert.ok(
      !urls.includes(OTHER_CONSULTATION_ID),
      "the consultation comes from the resolved recommendation, never from the body",
    );
    assert.ok(urls.includes(CONSULTATION_ID));
  });

  it("puts the consultation on a recurring checkout too", async () => {
    await post(
      `/api/services/${RECURRING_SERVICE_ID}/checkout`,
      {},
      CLIENT_PROFILE,
    );

    const params = createdSessions[0]!;

    assert.equal(params.mode, "subscription");
    assert.ok(
      String(params.success_url).includes(
        `/dashboard/consultation/${CONSULTATION_ID}`,
      ),
    );
  });
});
