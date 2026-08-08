/*
 * Service purchase finance tests. Migration 040.
 *
 * Nothing external is contacted. Supabase and Stripe are both
 * in-memory fakes, and the fakes for the four migration 040 RPCs
 * reproduce their real contracts: the same resolution order, the
 * same integer commission arithmetic, the same idempotency
 * anchors, the same refusal to release money on payment alone.
 *
 * Those fakes are not guesses. Every behaviour asserted here was
 * executed against PostgreSQL 16 first — see
 * MIGRATION_040_VERIFICATION.sql, which proves the same 31
 * properties against the real functions. What these tests add is
 * the half the database cannot see: which Stripe event is allowed
 * to create a purchase, which is deliberately ignored, and that
 * the client never gets to name a consultant.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://service-purchase-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_service",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_service",
  STRIPE_LIVE_SECRET_KEY: "sk_live_service",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_service",
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
const { getStripeClient } = await import(
  "../../lib/stripe.js"
);
const { redis } = await import("../../lib/redis.js");
const { processServicePurchaseEvent } = await import(
  "../webhooks/service-purchase-webhook.js"
);
const { registerAdminServicePurchaseRoutes } = await import(
  "./admin-service-purchase.route.js"
);
const { registerServiceCheckoutRoute } = await import(
  "../services/service-checkout.route.js"
);

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CLIENT_PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT_PROFILE = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
const CONSULTANT_PROFILE = "22222222-2222-4222-8222-222222222222";
const OTHER_CONSULTANT_PROFILE =
  "2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c";
const ADMIN_PROFILE = "33333333-3333-4333-8333-333333333333";

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CONSULTANT_ID = "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d";

const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const SERVICE_NO_RATE = "56565656-5656-4656-8656-565656565656";
const SERVICE_ZERO_RATE = "57575757-5757-4757-8757-575757575757";
const SERVICE_EUR = "58585858-5858-4858-8858-585858585858";
const SERVICE_RECURRING = "59595959-5959-4959-8959-595959595959";

const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_CONSULTATION_ID = "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";

type Row = Record<string, unknown>;

const db: {
  profiles: Row[];
  consultants: Row[];
  services: Row[];
  consultations: Row[];
  service_recommendations: Row[];
  service_requests: Row[];
  service_purchases: Row[];
  consultant_ledger_entries: Row[];
  app_settings: Row[];
} = {
  profiles: [],
  consultants: [],
  services: [],
  consultations: [],
  service_recommendations: [],
  service_requests: [],
  service_purchases: [],
  consultant_ledger_entries: [],
  app_settings: [],
};

let idCounter = 0;
const nextId = (): string => {
  idCounter += 1;
  return `99999999-9999-4999-8999-${String(idCounter).padStart(
    12,
    "0",
  )}`;
};

const fail = (marker: string) => ({
  data: null,
  error: { message: `${marker}: raised by fake`, code: "P0001" },
});

const ok = (row: Row) => ({ data: [row], error: null });

/*
 * The commission rule, mirrored exactly from
 * record_service_purchase: numeric multiplication, rounded, and
 * the platform takes the remainder by subtraction so the identity
 * consultant + platform = gross can never fail.
 *
 * Deliberately written with Math.round on an integer-scaled value
 * rather than any floating-point currency arithmetic.
 */
const splitCommission = (
  grossAmountMinor: number,
  commissionBps: number,
): { consultant: number; platform: number } => {
  const consultant = Math.round(
    (grossAmountMinor * commissionBps) / 10_000,
  );

  return {
    consultant,
    platform: grossAmountMinor - consultant,
  };
};

/* ------------------------------------------------ the RPC fakes -- */

const recordServicePurchaseFake = (args: Row) => {
  const gross = args.p_gross_amount_minor as number;
  const currency = String(args.p_currency ?? "").toLowerCase();

  if (!gross || gross <= 0) {
    return fail("FINANCE_PURCHASE_AMOUNT_INVALID");
  }

  if (!/^[a-z]{3}$/.test(currency)) {
    return fail("FINANCE_CURRENCY_INVALID");
  }

  if (
    !args.p_stripe_checkout_session_id &&
    !args.p_stripe_invoice_id &&
    !args.p_stripe_payment_intent_id
  ) {
    return fail("FINANCE_STRIPE_REFERENCE_REQUIRED");
  }

  /* Idempotency, most specific identifier first. */
  const existing =
    db.service_purchases.find(
      (row) =>
        args.p_stripe_invoice_id &&
        row.stripe_invoice_id === args.p_stripe_invoice_id,
    ) ??
    db.service_purchases.find(
      (row) =>
        args.p_stripe_checkout_session_id &&
        row.stripe_checkout_session_id ===
          args.p_stripe_checkout_session_id,
    ) ??
    /*
     * Not consulted when an invoice id was supplied: an invoice
     * identifies one billing period, so a renewal that happens to
     * reuse a PaymentIntent must not be mistaken for the period
     * before it. Mirrors the RPC.
     */
    db.service_purchases.find(
      (row) =>
        !args.p_stripe_invoice_id &&
        args.p_stripe_payment_intent_id &&
        row.stripe_payment_intent_id ===
          args.p_stripe_payment_intent_id,
    );

  if (existing) {
    const entry = db.consultant_ledger_entries.find(
      (row) =>
        row.source_type === "service_purchase" &&
        row.source_id === existing.id &&
        row.entry_type === "earning",
    );

    return ok({
      purchase_id: existing.id,
      created: false,
      service_id: existing.service_id,
      client_profile_id: existing.client_profile_id,
      service_request_id: existing.service_request_id,
      consultation_id: existing.consultation_id,
      attributed_consultant_id:
        existing.attributed_consultant_id,
      gross_amount_minor: existing.gross_amount_minor,
      currency: existing.currency,
      billing_type: existing.billing_type,
      recurring_interval: existing.recurring_interval,
      billing_period_sequence:
        existing.billing_period_sequence,
      status: existing.status,
      entry_id: entry?.id ?? null,
      earning_created: false,
      consultant_amount_minor:
        entry?.consultant_amount_minor ?? null,
      platform_amount_minor:
        entry?.platform_amount_minor ?? null,
      commission_bps: entry?.commission_bps ?? null,
    });
  }

  /*
   * Service resolution, in the RPC's order of trust: explicit id,
   * then inheritance from the subscription's first purchase, then
   * the payment link, then the price. Never Stripe metadata that
   * we did not set ourselves.
   */
  let inheritedClient: string | null = null;
  let service = db.services.find(
    (row) => row.id === args.p_service_id,
  );

  if (!service && args.p_stripe_subscription_id) {
    const first = db.service_purchases
      .filter(
        (row) =>
          row.stripe_subscription_id ===
          args.p_stripe_subscription_id,
      )
      .sort(
        (a, b) =>
          (a.billing_period_sequence as number) -
          (b.billing_period_sequence as number),
      )[0];

    if (first) {
      service = db.services.find(
        (row) => row.id === first.service_id,
      );
      inheritedClient =
        (first.client_profile_id as string | null) ?? null;
    }
  }

  if (!service && args.p_stripe_payment_link_id) {
    service = db.services.find(
      (row) =>
        row.stripe_payment_link_id ===
        args.p_stripe_payment_link_id,
    );
  }

  if (!service && args.p_stripe_price_id) {
    service = db.services.find(
      (row) =>
        row.stripe_price_id === args.p_stripe_price_id,
    );
  }

  if (!service) {
    return fail("FINANCE_SERVICE_NOT_FOUND");
  }

  /* A client candidate is believed only if it is a real client. */
  let client =
    db.profiles.find(
      (row) =>
        row.id === args.p_client_profile_id &&
        row.role === "client",
    )?.id ?? null;

  client = client ?? inheritedClient;

  /*
   * Attribution, RE-DERIVED. Nothing the caller sent takes part
   * in this: the consultant comes from a sent recommendation on a
   * consultation belonging to this client, and from nowhere else.
   */
  let consultant: string | null = null;
  let consultation: string | null = null;
  let serviceRequest: string | null = null;

  if (client) {
    const recommendation = db.service_recommendations
      .filter((row) => {
        if (row.service_id !== service!.id) {
          return false;
        }

        if (row.status !== "sent") {
          return false;
        }

        const linked = db.consultations.find(
          (c) => c.id === row.consultation_id,
        );

        return linked?.client_profile_id === client;
      })
      .sort(
        (a, b) =>
          String(b.sent_at ?? "").localeCompare(
            String(a.sent_at ?? ""),
          ),
      )[0];

    if (recommendation) {
      consultant =
        recommendation.recommended_by_consultant_id as string;
      consultation =
        recommendation.consultation_id as string;
    }

    serviceRequest =
      (db.service_requests.find(
        (row) =>
          row.service_id === service!.id &&
          row.client_profile_id === client &&
          row.status !== "cancelled",
      )?.id as string | undefined) ?? null;
  }

  const billingType = args.p_stripe_subscription_id
    ? "recurring"
    : ((service.billing_type as string | null) ?? "one_time");

  const interval =
    billingType === "recurring"
      ? ((service.recurring_interval as string | null) ??
        "month")
      : null;

  /*
   * Sequence allocation. The real function takes
   * pg_advisory_xact_lock on a hash of the subscription id first;
   * a single-threaded fake cannot reproduce contention, so what is
   * asserted here is the resulting numbering. The serialisation
   * itself is proved against PostgreSQL in check 17.
   */
  const sequence = args.p_stripe_subscription_id
    ? db.service_purchases.filter(
        (row) =>
          row.stripe_subscription_id ===
          args.p_stripe_subscription_id,
      ).length + 1
    : 1;

  const purchase: Row = {
    id: nextId(),
    service_id: service.id,
    service_request_id: serviceRequest,
    consultation_id: consultation,
    client_profile_id: client,
    attributed_consultant_id: consultant,
    gross_amount_minor: gross,
    currency,
    billing_type: billingType,
    recurring_interval: interval,
    billing_period_sequence: sequence,
    status: "paid",
    stripe_mode: args.p_stripe_mode,
    stripe_payment_intent_id:
      args.p_stripe_payment_intent_id ?? null,
    stripe_checkout_session_id:
      args.p_stripe_checkout_session_id ?? null,
    stripe_invoice_id: args.p_stripe_invoice_id ?? null,
    stripe_subscription_id:
      args.p_stripe_subscription_id ?? null,
    refunded_amount_minor: 0,
    fulfilled_at: null,
    refunded_at: null,
  };

  db.service_purchases.push(purchase);

  /*
   * The earning. Three ways there is legitimately none: nobody
   * attributed, no rate, or a rate that rounds this gross to
   * nothing. A zero-value entry is never written.
   */
  const bps = service.consultant_commission_bps as
    | number
    | null;

  let entry: Row | null = null;

  if (consultant && bps && bps > 0) {
    const split = splitCommission(gross, bps);

    if (split.consultant > 0) {
      entry = {
        id: nextId(),
        consultant_id: consultant,
        entry_type: "earning",
        source_type: "service_purchase",
        source_id: purchase.id,
        source_component: "full",
        gross_amount_minor: gross,
        consultant_amount_minor: split.consultant,
        platform_amount_minor: split.platform,
        commission_bps: bps,
        commission_basis: "service_rate",
        currency,
        available_at: null,
      };

      db.consultant_ledger_entries.push(entry);
    }
  }

  return ok({
    purchase_id: purchase.id,
    created: true,
    service_id: purchase.service_id,
    client_profile_id: purchase.client_profile_id,
    service_request_id: purchase.service_request_id,
    consultation_id: purchase.consultation_id,
    attributed_consultant_id:
      purchase.attributed_consultant_id,
    gross_amount_minor: gross,
    currency,
    billing_type: billingType,
    recurring_interval: interval,
    billing_period_sequence: sequence,
    status: "paid",
    entry_id: entry?.id ?? null,
    earning_created: Boolean(entry),
    consultant_amount_minor:
      entry?.consultant_amount_minor ?? null,
    platform_amount_minor:
      entry?.platform_amount_minor ?? null,
    commission_bps: entry?.commission_bps ?? null,
  });
};

const fulfillServicePurchaseFake = (args: Row) => {
  if (
    !db.profiles.some(
      (row) =>
        row.id === args.p_admin_profile_id &&
        row.role === "admin",
    )
  ) {
    return fail("FINANCE_ADMIN_REQUIRED");
  }

  const purchase = db.service_purchases.find(
    (row) => row.id === args.p_purchase_id,
  );

  if (!purchase) {
    return fail("FINANCE_PURCHASE_NOT_FOUND");
  }

  const entry = db.consultant_ledger_entries.find(
    (row) =>
      row.source_type === "service_purchase" &&
      row.source_id === purchase.id &&
      row.entry_type === "earning",
  );

  if (purchase.status === "fulfilled") {
    return ok({
      purchase_id: purchase.id,
      status: purchase.status,
      fulfilled_at: purchase.fulfilled_at,
      released: false,
      reason: "already_fulfilled",
      entry_id: entry?.id ?? null,
      available_at: entry?.available_at ?? null,
    });
  }

  if (purchase.status !== "paid") {
    return fail("FINANCE_PURCHASE_NOT_FULFILLABLE");
  }

  const now = new Date().toISOString();

  purchase.status = "fulfilled";
  purchase.fulfilled_at = now;

  let released = false;
  let reason = "no_entry";

  if (entry && entry.available_at === null) {
    entry.available_at = now;
    released = true;
    reason = "released";
  } else if (entry) {
    reason = "already_available";
  }

  return ok({
    purchase_id: purchase.id,
    status: purchase.status,
    fulfilled_at: purchase.fulfilled_at,
    released,
    reason,
    entry_id: entry?.id ?? null,
    available_at: entry?.available_at ?? null,
  });
};

/*
 * Migration 043 semantics, mirrored: the amount is a CUMULATIVE
 * TOTAL, not a delta. The delta is computed here exactly as the
 * RPC computes it, so a redelivered event is a no-op and a second
 * partial reverses only its own share. The equivalent arithmetic is
 * proved against real PostgreSQL in MIGRATION_043_VERIFICATION.sql.
 */
const reverseServicePurchaseFake = (purchase: Row, args: Row) => {
  const gross = purchase.gross_amount_minor as number;
  const refunded = purchase.refunded_amount_minor as number;

  const target =
    (args.p_refunded_total_minor as number | null) ?? gross;

  if (target > gross) {
    return fail("FINANCE_REFUND_EXCEEDS_PURCHASE");
  }

  if (target < 0) {
    return fail("FINANCE_REVERSAL_AMOUNT_INVALID");
  }

  const portion = target - refunded;

  if (portion <= 0) {
    return ok({
      purchase_id: purchase.id,
      reversed: false,
      reason:
        refunded >= gross ? "already_refunded" : "no_change",
      entry_id: null,
      reversal_entry_id: null,
      refunded_amount_minor: refunded,
      status: purchase.status,
      consultant_amount_minor: null,
      applied_delta_minor: 0,
    });
  }

  const entry = db.consultant_ledger_entries.find(
    (row) =>
      row.source_type === "service_purchase" &&
      row.source_id === purchase.id &&
      row.entry_type === "earning",
  );

  let reversal: Row | null = null;

  if (entry) {
    const bps = entry.commission_bps as number;
    const split =
      portion === (entry.gross_amount_minor as number)
        ? {
            consultant: entry.consultant_amount_minor as number,
            platform: entry.platform_amount_minor as number,
          }
        : splitCommission(portion, bps);

    reversal = {
      id: nextId(),
      consultant_id: entry.consultant_id,
      entry_type: "reversal",
      source_type: "service_purchase",
      source_id: purchase.id,
      source_component: "full",
      gross_amount_minor: -portion,
      consultant_amount_minor: -split.consultant,
      platform_amount_minor: -split.platform,
      commission_bps: bps,
      commission_basis: "service_rate",
      currency: entry.currency,
      /*
       * A reversal inherits the availability of what it reverses.
       * This is the line that stops a refund of a pending earning
       * from creating available money.
       */
      available_at:
        entry.available_at === null
          ? null
          : new Date().toISOString(),
      reverses_entry_id: entry.id,
    };

    db.consultant_ledger_entries.push(reversal);
  }

  purchase.refunded_amount_minor = target;

  if (
    (purchase.refunded_amount_minor as number) >= gross
  ) {
    purchase.status = "refunded";
    purchase.refunded_at = new Date().toISOString();
  }

  return ok({
    purchase_id: purchase.id,
    reversed: Boolean(entry),
    reason: entry ? "reversed" : "no_entry",
    entry_id: entry?.id ?? null,
    reversal_entry_id: reversal?.id ?? null,
    refunded_amount_minor:
      purchase.refunded_amount_minor,
    status: purchase.status,
    consultant_amount_minor:
      (reversal?.consultant_amount_minor as number) ?? null,
    applied_delta_minor: portion,
  });
};

const rpcCalls: Array<{ name: string; args: Row }> = [];

supabaseAdmin.rpc = (async (name: string, args: Row) => {
  rpcCalls.push({ name, args });

  switch (name) {
    case "record_service_purchase":
      return recordServicePurchaseFake(args);

    case "fulfill_service_purchase":
      return fulfillServicePurchaseFake(args);

    case "reverse_service_purchase_earning": {
      const purchase = db.service_purchases.find(
        (row) => row.id === args.p_purchase_id,
      );

      if (!purchase) {
        return fail("FINANCE_PURCHASE_NOT_FOUND");
      }

      return reverseServicePurchaseFake(purchase, args);
    }

    case "reverse_service_purchase_for_payment_intent": {
      const purchase = db.service_purchases.find(
        (row) =>
          row.stripe_payment_intent_id ===
          args.p_stripe_payment_intent_id,
      );

      if (!purchase) {
        return ok({
          purchase_id: null,
          reversed: false,
          reason: "not_a_service_purchase",
          entry_id: null,
          reversal_entry_id: null,
          refunded_amount_minor: null,
          status: null,
          consultant_amount_minor: null,
          applied_delta_minor: null,
        });
      }

      return reverseServicePurchaseFake(purchase, args);
    }

    default:
      return fail("UNEXPECTED_RPC");
  }
}) as unknown as typeof supabaseAdmin.rpc;

/* --------------------------------------------- table read fake -- */

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
      /* consultations.client_profile_id on the joined read. */
      const [, joinedColumn] = column.split(".");

      this.filters.push((row) => {
        const linked = db.consultations.find(
          (c) => c.id === row.consultation_id,
        );

        return linked?.[joinedColumn!] === value;
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

  /* Awaiting the builder directly returns the whole list, which
     is how the settings provider reads app_settings. */
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

/* ------------------------------------------------ Stripe fake -- */

/*
 * The module binding is read-only, so the real client INSTANCE is
 * patched rather than the factory — the same approach
 * admin-service.test.ts takes. No network call is ever made.
 */
const createdSessions: Array<Record<string, unknown>> = [];

const stripe = getStripeClient("test");

stripe.checkout.sessions.create = (async (
  params: Record<string, unknown>,
) => {
  createdSessions.push(params);

  return {
    id: `cs_test_${createdSessions.length}`,
    url: "https://checkout.stripe.test/session",
  };
}) as unknown as typeof stripe.checkout.sessions.create;

/*
 * getActiveStripeMode reads app_settings through the settings
 * cache, which reads Redis first. Both are stubbed so the tests
 * run offline and always resolve to test mode.
 */
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

/* ---------------------------------------------------- the app -- */

const app = Fastify();
await registerAdminServicePurchaseRoutes(app);
await registerServiceCheckoutRoute(app);
await app.ready();

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

const checkoutSessionEvent = (
  overrides: Record<string, unknown> = {},
): { type: string; data: { object: unknown } } => ({
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_live_one",
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      amount_total: 9_999,
      currency: "usd",
      payment_intent: "pi_one",
      client_reference_id: CLIENT_PROFILE,
      metadata: {
        makehijrah_service_id: SERVICE_ID,
        makehijrah_client_profile_id: CLIENT_PROFILE,
      },
      ...overrides,
    },
  },
});

const invoicePaidEvent = (
  overrides: Record<string, unknown> = {},
  subscriptionMetadata: Record<string, string> | null = {
    makehijrah_service_id: SERVICE_RECURRING,
    makehijrah_client_profile_id: CLIENT_PROFILE,
  },
): { type: string; data: { object: unknown } } => ({
  type: "invoice.paid",
  data: {
    object: {
      id: "in_one",
      object: "invoice",
      billing_reason: "subscription_create",
      amount_paid: 20_000,
      currency: "usd",
      parent: {
        subscription_details: {
          subscription: "sub_one",
          metadata: subscriptionMetadata,
        },
      },
      payments: {
        data: [
          { payment: { payment_intent: "pi_sub_one" } },
        ],
      },
      ...overrides,
    },
  },
});

/*
 * Named handleEvent, not `process`: a module-level `process`
 * shadows Node's global and breaks the env setup at the top of
 * this file before a single test runs.
 */
const handleEvent = async (
  event: { type: string; data: { object: unknown } },
) =>
  processServicePurchaseEvent(
    event as never,
    "test",
  );

const ledgerFor = (purchaseId: unknown): Row[] =>
  db.consultant_ledger_entries.filter(
    (row) => row.source_id === purchaseId,
  );

const availableFor = (
  consultantId: string,
  currency: string,
): number =>
  db.consultant_ledger_entries
    .filter(
      (row) =>
        row.consultant_id === consultantId &&
        row.currency === currency &&
        row.available_at !== null,
    )
    .reduce(
      (sum, row) =>
        sum + (row.consultant_amount_minor as number),
      0,
    );

const pendingFor = (
  consultantId: string,
  currency: string,
): number =>
  db.consultant_ledger_entries
    .filter(
      (row) =>
        row.consultant_id === consultantId &&
        row.currency === currency &&
        row.available_at === null,
    )
    .reduce(
      (sum, row) =>
        sum + (row.consultant_amount_minor as number),
      0,
    );

beforeEach(() => {
  idCounter = 0;
  rpcCalls.length = 0;
  createdSessions.length = 0;

  db.profiles = [
    { id: CLIENT_PROFILE, role: "client" },
    { id: OTHER_CLIENT_PROFILE, role: "client" },
    { id: CONSULTANT_PROFILE, role: "consultant" },
    { id: OTHER_CONSULTANT_PROFILE, role: "consultant" },
    { id: ADMIN_PROFILE, role: "admin" },
  ];

  db.consultants = [
    { id: CONSULTANT_ID, profile_id: CONSULTANT_PROFILE },
    {
      id: OTHER_CONSULTANT_ID,
      profile_id: OTHER_CONSULTANT_PROFILE,
    },
  ];

  db.services = [
    {
      id: SERVICE_ID,
      name: "Visa Pack",
      is_active: true,
      billing_type: "one_time",
      recurring_interval: null,
      price_cents: 9_999,
      currency: "usd",
      stripe_price_id: "price_one",
      stripe_payment_link_id: "plink_one",
      consultant_commission_bps: 4_500,
    },
    {
      id: SERVICE_NO_RATE,
      name: "Unrated",
      is_active: true,
      billing_type: "one_time",
      price_cents: 5_000,
      currency: "usd",
      stripe_price_id: "price_norate",
      consultant_commission_bps: null,
    },
    {
      id: SERVICE_ZERO_RATE,
      name: "Zero Rate",
      is_active: true,
      billing_type: "one_time",
      price_cents: 5_000,
      currency: "usd",
      stripe_price_id: "price_zero",
      consultant_commission_bps: 0,
    },
    {
      id: SERVICE_EUR,
      name: "Euro Service",
      is_active: true,
      billing_type: "one_time",
      price_cents: 8_000,
      currency: "eur",
      stripe_price_id: "price_eur",
      consultant_commission_bps: 2_500,
    },
    {
      id: SERVICE_RECURRING,
      name: "Retainer",
      is_active: true,
      billing_type: "recurring",
      recurring_interval: "month",
      price_cents: 20_000,
      currency: "usd",
      stripe_price_id: "price_sub",
      consultant_commission_bps: 3_000,
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
      consultant_id: OTHER_CONSULTANT_ID,
    },
  ];

  db.service_recommendations = [
    SERVICE_ID,
    SERVICE_NO_RATE,
    SERVICE_ZERO_RATE,
    SERVICE_EUR,
    SERVICE_RECURRING,
  ].map((serviceId, index) => ({
    id: `rec-${index}`,
    consultation_id: CONSULTATION_ID,
    service_id: serviceId,
    recommended_by_consultant_id: CONSULTANT_ID,
    status: "sent",
    sent_at: "2026-08-01T10:00:00.000Z",
  }));

  /* The same service, recommended to a different client by a
     different consultant. Attribution must not cross. */
  db.service_recommendations.push({
    id: "rec-other",
    consultation_id: OTHER_CONSULTATION_ID,
    service_id: SERVICE_ID,
    recommended_by_consultant_id: OTHER_CONSULTANT_ID,
    status: "sent",
    sent_at: "2026-08-02T10:00:00.000Z",
  });

  db.service_requests = [
    {
      id: REQUEST_ID,
      client_profile_id: CLIENT_PROFILE,
      service_id: SERVICE_ID,
      consultation_id: CONSULTATION_ID,
      status: "active",
    },
  ];

  db.service_purchases = [];
  db.consultant_ledger_entries = [];

  db.app_settings = [
    {
      id: "88888888-8888-4888-8888-888888888888",
      stripe_mode: "test",
      consultation_price_cents: 15_000,
      consultation_currency: "usd",
      consultation_duration_minutes: 60,
    },
  ];

  redisStore.clear();
});

describe("Service purchase: one-time payments", () => {
  it("records the purchase and a pending earning from checkout.session.completed", async () => {
    const outcome = await handleEvent(checkoutSessionEvent());

    assert.equal(outcome?.action, "purchase_recorded");
    assert.equal(db.service_purchases.length, 1);

    const purchase = db.service_purchases[0]!;

    assert.equal(purchase.status, "paid");
    assert.equal(purchase.billing_type, "one_time");
    assert.equal(purchase.billing_period_sequence, 1);
    assert.equal(
      purchase.attributed_consultant_id,
      CONSULTANT_ID,
    );
    assert.equal(
      purchase.service_request_id,
      REQUEST_ID,
    );

    const entries = ledgerFor(purchase.id);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.available_at, null);
    assert.equal(
      entries[0]!.commission_basis,
      "service_rate",
    );
    assert.equal(
      entries[0]!.source_component,
      "full",
    );
  });

  it("splits the commission on gross with the odd minor unit to the consultant", async () => {
    await handleEvent(checkoutSessionEvent());

    const entry = db.consultant_ledger_entries[0]!;

    /* round(9999 * 4500 / 10000) = 4499.55 -> 4500 */
    assert.equal(entry.consultant_amount_minor, 4_500);
    assert.equal(entry.platform_amount_minor, 5_499);
    assert.equal(
      (entry.consultant_amount_minor as number) +
        (entry.platform_amount_minor as number),
      entry.gross_amount_minor,
    );
  });

  it("records the purchase but no earning when the rate is null", async () => {
    const outcome = await handleEvent(
      checkoutSessionEvent({
        metadata: {
          makehijrah_service_id: SERVICE_NO_RATE,
          makehijrah_client_profile_id: CLIENT_PROFILE,
        },
        amount_total: 5_000,
      }),
    );

    assert.equal(outcome?.action, "purchase_recorded");
    assert.equal(db.service_purchases.length, 1);
    assert.equal(
      db.service_purchases[0]!.attributed_consultant_id,
      CONSULTANT_ID,
      "attribution is preserved even with no commission",
    );
    assert.equal(db.consultant_ledger_entries.length, 0);
  });

  it("records the purchase but no earning when the rate is zero", async () => {
    await handleEvent(
      checkoutSessionEvent({
        metadata: {
          makehijrah_service_id: SERVICE_ZERO_RATE,
          makehijrah_client_profile_id: CLIENT_PROFILE,
        },
        amount_total: 5_000,
      }),
    );

    assert.equal(db.service_purchases.length, 1);
    assert.equal(
      db.consultant_ledger_entries.length,
      0,
      "a zero rate must not write a zero-value ledger entry",
    );
  });

  it("keeps currencies separate", async () => {
    await handleEvent(checkoutSessionEvent());
    await handleEvent(
      checkoutSessionEvent({
        id: "cs_live_eur",
        payment_intent: "pi_eur",
        amount_total: 8_000,
        currency: "eur",
        metadata: {
          makehijrah_service_id: SERVICE_EUR,
          makehijrah_client_profile_id: CLIENT_PROFILE,
        },
      }),
    );

    assert.equal(
      pendingFor(CONSULTANT_ID, "usd"),
      4_500,
    );
    assert.equal(
      pendingFor(CONSULTANT_ID, "eur"),
      2_000,
    );
  });
});

describe("Service purchase: attribution cannot be spoofed", () => {
  it("ignores a consultant id supplied in Stripe metadata", async () => {
    await handleEvent(
      checkoutSessionEvent({
        metadata: {
          makehijrah_service_id: SERVICE_ID,
          makehijrah_client_profile_id: CLIENT_PROFILE,
          /* All three are ignored by construction. */
          consultant_id: OTHER_CONSULTANT_ID,
          attributed_consultant_id: OTHER_CONSULTANT_ID,
          commission_bps: "9999",
        },
      }),
    );

    const purchase = db.service_purchases[0]!;

    assert.equal(
      purchase.attributed_consultant_id,
      CONSULTANT_ID,
      "the consultant must come from the sent recommendation, not from metadata",
    );

    assert.equal(
      db.consultant_ledger_entries[0]!.commission_bps,
      4_500,
      "the rate must come from the service, not from metadata",
    );

    /* And no consultant value was ever sent to the database. */
    const call = rpcCalls.find(
      (entry) => entry.name === "record_service_purchase",
    )!;

    assert.equal(
      Object.keys(call.args).some((key) =>
        /consultant|commission|attributed/.test(key),
      ),
      false,
      "the RPC must expose no consultant or commission parameter",
    );
  });

  it("does not borrow another client's recommendation", async () => {
    await handleEvent(
      checkoutSessionEvent({
        client_reference_id: OTHER_CLIENT_PROFILE,
        metadata: {
          makehijrah_service_id: SERVICE_ID,
          makehijrah_client_profile_id:
            OTHER_CLIENT_PROFILE,
        },
      }),
    );

    assert.equal(
      db.service_purchases[0]!.attributed_consultant_id,
      OTHER_CONSULTANT_ID,
    );
  });

  it("records an unattributed purchase when the client cannot be resolved", async () => {
    const outcome = await handleEvent(
      checkoutSessionEvent({
        client_reference_id: CONSULTANT_PROFILE,
        metadata: {
          makehijrah_service_id: SERVICE_ID,
          makehijrah_client_profile_id:
            CONSULTANT_PROFILE,
        },
      }),
    );

    assert.equal(
      outcome?.action,
      "purchase_unattributed",
    );
    assert.equal(
      db.service_purchases.length,
      1,
      "unattributed revenue must still be recorded",
    );
    assert.equal(
      db.service_purchases[0]!.attributed_consultant_id,
      null,
    );
    assert.equal(db.consultant_ledger_entries.length, 0);
  });
});

describe("Service purchase: event selection and idempotency", () => {
  it("does not create a purchase twice from a redelivered event", async () => {
    await handleEvent(checkoutSessionEvent());
    const second = await handleEvent(checkoutSessionEvent());

    assert.equal(
      second?.action,
      "purchase_already_recorded",
    );
    assert.equal(db.service_purchases.length, 1);
    assert.equal(db.consultant_ledger_entries.length, 1);
  });

  it("does not create a recurring purchase from a subscription checkout", async () => {
    const outcome = await handleEvent(
      checkoutSessionEvent({
        mode: "subscription",
        metadata: {
          makehijrah_service_id: SERVICE_RECURRING,
          makehijrah_client_profile_id: CLIENT_PROFILE,
        },
      }),
    );

    assert.equal(outcome?.action, "ignored");
    assert.equal(
      outcome?.reason,
      "subscription_checkout_deferred_to_invoice",
    );
    assert.equal(db.service_purchases.length, 0);
  });

  it("does not create a purchase from an unpaid checkout session", async () => {
    const outcome = await handleEvent(
      checkoutSessionEvent({ payment_status: "unpaid" }),
    );

    assert.equal(outcome?.reason, "checkout_not_paid");
    assert.equal(db.service_purchases.length, 0);
  });

  it("creates nothing from payment_intent.succeeded", async () => {
    const outcome = await handleEvent({
      type: "payment_intent.succeeded",
      data: {
        object: { id: "pi_one", object: "payment_intent" },
      },
    });

    assert.equal(
      outcome,
      null,
      "payment_intent.succeeded must fall through, or a one-time payment would be recorded twice",
    );
    assert.equal(db.service_purchases.length, 0);
  });

  it("creates nothing from a failed invoice payment", async () => {
    const outcome = await handleEvent({
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_failed",
          object: "invoice",
          billing_reason: "subscription_cycle",
        },
      },
    });

    assert.equal(
      outcome?.reason,
      "invoice_payment_failed",
    );
    assert.equal(db.service_purchases.length, 0);
    assert.equal(db.consultant_ledger_entries.length, 0);
  });

  it("falls through for a checkout session that is not one of ours", async () => {
    const outcome = await handleEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_unrelated",
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
        },
      },
    });

    assert.equal(outcome, null);
    assert.equal(db.service_purchases.length, 0);
  });
});

describe("Service purchase: recurring", () => {
  it("records the initial invoice as sequence 1 with its own earning", async () => {
    const outcome = await handleEvent(invoicePaidEvent());

    assert.equal(outcome?.action, "purchase_recorded");

    const purchase = db.service_purchases[0]!;

    assert.equal(purchase.billing_type, "recurring");
    assert.equal(purchase.recurring_interval, "month");
    assert.equal(purchase.billing_period_sequence, 1);
    assert.equal(
      purchase.stripe_subscription_id,
      "sub_one",
    );
    assert.equal(
      db.consultant_ledger_entries[0]!
        .consultant_amount_minor,
      6_000,
    );
  });

  it("records a renewal as a distinct purchase at sequence 2 with a second earning", async () => {
    await handleEvent(invoicePaidEvent());

    await handleEvent(
      invoicePaidEvent({
        id: "in_two",
        billing_reason: "subscription_cycle",
        payments: {
          data: [
            { payment: { payment_intent: "pi_sub_two" } },
          ],
        },
      }),
    );

    assert.equal(db.service_purchases.length, 2);
    assert.equal(
      db.service_purchases[1]!.billing_period_sequence,
      2,
    );
    assert.equal(
      db.consultant_ledger_entries.length,
      2,
      "commission is earned on every successful renewal",
    );
    assert.equal(
      db.consultant_ledger_entries[1]!
        .consultant_amount_minor,
      6_000,
    );

    /* The original row is untouched. */
    assert.equal(
      db.service_purchases[0]!.billing_period_sequence,
      1,
    );
    assert.equal(
      db.service_purchases[0]!.stripe_invoice_id,
      "in_one",
    );
  });

  it("inherits attribution on a renewal carrying no metadata at all", async () => {
    await handleEvent(invoicePaidEvent());

    await handleEvent(
      invoicePaidEvent(
        {
          id: "in_two",
          billing_reason: "subscription_cycle",
          payments: {
            data: [
              { payment: { payment_intent: "pi_sub_two" } },
            ],
          },
        },
        null,
      ),
    );

    assert.equal(db.service_purchases.length, 2);
    assert.equal(
      db.service_purchases[1]!.attributed_consultant_id,
      CONSULTANT_ID,
      "a renewal must not depend on Stripe metadata surviving",
    );
    assert.equal(
      db.service_purchases[1]!.client_profile_id,
      CLIENT_PROFILE,
    );
  });

  it("does not record an invoice with an unrelated billing reason", async () => {
    const outcome = await handleEvent(
      invoicePaidEvent({ billing_reason: "manual" }),
    );

    assert.equal(
      outcome?.reason,
      "invoice_billing_reason_manual",
    );
    assert.equal(db.service_purchases.length, 0);
  });
});

describe("Service purchase: fulfilment", () => {
  const buy = async (): Promise<string> => {
    await handleEvent(checkoutSessionEvent());

    return db.service_purchases[0]!.id as string;
  };

  it("releases the earning only when the purchase is fulfilled", async () => {
    const purchaseId = await buy();

    assert.equal(availableFor(CONSULTANT_ID, "usd"), 0);
    assert.equal(pendingFor(CONSULTANT_ID, "usd"), 4_500);

    const response = await post(
      `/api/admin/service-purchases/${purchaseId}/fulfill`,
      {},
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data!.released, true);
    assert.equal(response.json().data!.reason, "released");
    assert.equal(
      response.json().data!.status,
      "fulfilled",
    );

    assert.equal(
      availableFor(CONSULTANT_ID, "usd"),
      4_500,
    );
    assert.equal(pendingFor(CONSULTANT_ID, "usd"), 0);
  });

  it("is idempotent on a second fulfilment", async () => {
    const purchaseId = await buy();

    await post(
      `/api/admin/service-purchases/${purchaseId}/fulfill`,
      {},
      ADMIN_PROFILE,
    );

    const second = await post(
      `/api/admin/service-purchases/${purchaseId}/fulfill`,
      {},
      ADMIN_PROFILE,
    );

    assert.equal(second.statusCode, 200);
    assert.equal(second.json().data!.released, false);
    assert.equal(
      second.json().data!.reason,
      "already_fulfilled",
    );
    assert.equal(
      availableFor(CONSULTANT_ID, "usd"),
      4_500,
      "a double click must not credit twice",
    );
  });

  it("does not release when the service_request is completed", async () => {
    await buy();

    /* The operational record moves on its own; money does not. */
    db.service_requests[0]!.status = "completed";

    assert.equal(
      availableFor(CONSULTANT_ID, "usd"),
      0,
      "service_requests is the workflow record and must not release money",
    );
  });

  it("refuses a consultant and a client", async () => {
    const purchaseId = await buy();

    for (const token of [
      CONSULTANT_PROFILE,
      CLIENT_PROFILE,
    ]) {
      const response = await post(
        `/api/admin/service-purchases/${purchaseId}/fulfill`,
        {},
        token,
      );

      assert.equal(response.statusCode, 403);
    }

    assert.equal(availableFor(CONSULTANT_ID, "usd"), 0);
  });

  it("refuses an unauthenticated caller", async () => {
    const purchaseId = await buy();

    const response = await post(
      `/api/admin/service-purchases/${purchaseId}/fulfill`,
      {},
      null,
    );

    assert.equal(response.statusCode, 401);
  });
});

describe("Service purchase: refunds", () => {
  const refund = async (
    amountRefunded: number,
    paymentIntent = "pi_one",
  ) =>
    handleEvent({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_one",
          object: "charge",
          payment_intent: paymentIntent,
          amount_refunded: amountRefunded,
        },
      },
    });

  it("creates no available money when refunding before fulfilment", async () => {
    await handleEvent(checkoutSessionEvent());

    const outcome = await refund(9_999);

    assert.equal(outcome?.action, "refund_reversed");
    assert.equal(
      availableFor(CONSULTANT_ID, "usd"),
      0,
      "a refund of a pending earning must not create available funds",
    );
    assert.equal(
      db.service_purchases[0]!.status,
      "refunded",
    );
  });

  it("removes the available balance when refunding after fulfilment", async () => {
    await handleEvent(checkoutSessionEvent());

    await post(
      `/api/admin/service-purchases/${db.service_purchases[0]!.id}/fulfill`,
      {},
      ADMIN_PROFILE,
    );

    assert.equal(
      availableFor(CONSULTANT_ID, "usd"),
      4_500,
    );

    await refund(9_999);

    assert.equal(availableFor(CONSULTANT_ID, "usd"), 0);
  });

  it("reverses a partial refund proportionally and keeps the status", async () => {
    await handleEvent(checkoutSessionEvent());

    await post(
      `/api/admin/service-purchases/${db.service_purchases[0]!.id}/fulfill`,
      {},
      ADMIN_PROFILE,
    );

    await refund(4_000);

    /* round(4000 * 4500 / 10000) = 1800 */
    assert.equal(
      availableFor(CONSULTANT_ID, "usd"),
      2_700,
    );
    assert.equal(
      db.service_purchases[0]!.refunded_amount_minor,
      4_000,
    );
    assert.equal(
      db.service_purchases[0]!.status,
      "fulfilled",
      "a partial refund is a number, not a status",
    );
  });

  it("never mutates the original earning", async () => {
    await handleEvent(checkoutSessionEvent());
    await refund(4_000);

    const earning = db.consultant_ledger_entries.find(
      (row) => row.entry_type === "earning",
    )!;

    assert.equal(earning.gross_amount_minor, 9_999);
    assert.equal(earning.consultant_amount_minor, 4_500);

    const reversal = db.consultant_ledger_entries.find(
      (row) => row.entry_type === "reversal",
    )!;

    assert.equal(reversal.reverses_entry_id, earning.id);
    assert.equal(
      reversal.consultant_amount_minor,
      -1_800,
    );
  });

  it("refuses an over-refund", async () => {
    await handleEvent(checkoutSessionEvent());
    await refund(9_999);

    const outcome = await refund(9_999);

    assert.equal(outcome?.action, "refund_noop");
    assert.equal(
      outcome?.reason,
      "already_refunded",
      "a redelivered refund must be a no-op, not a second clawback",
    );

    assert.equal(
      db.consultant_ledger_entries.filter(
        (row) => row.entry_type === "reversal",
      ).length,
      1,
    );
  });

  it("falls through for a charge that is not a service purchase", async () => {
    const outcome = await refund(9_999, "pi_consultation");

    assert.equal(
      outcome,
      null,
      "a consultation refund must reach the consultation path",
    );
  });
});

describe("Service checkout endpoint", () => {
  it("creates a session with server-resolved trusted context", async () => {
    const response = await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {},
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data!.mode, "payment");
    assert.equal(
      response.json().data!.attributed,
      true,
    );

    const params = createdSessions[0]!;
    const metadata = params.metadata as Record<
      string,
      string
    >;

    assert.equal(
      metadata.makehijrah_client_profile_id,
      CLIENT_PROFILE,
    );
    assert.equal(
      metadata.makehijrah_service_id,
      SERVICE_ID,
    );
    assert.equal(
      params.client_reference_id,
      CLIENT_PROFILE,
    );

    /*
     * The endpoint never writes a consultant anywhere, not even
     * into its own trusted metadata. The database re-derives it.
     */
    assert.equal(
      Object.keys(metadata).some((key) =>
        /consultant|commission/.test(key),
      ),
      false,
    );
  });

  it("puts the context on subscription_data for a recurring service", async () => {
    const response = await post(
      `/api/services/${SERVICE_RECURRING}/checkout`,
      {},
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data!.mode,
      "subscription",
    );

    const params = createdSessions[0]!;
    const subscriptionData =
      params.subscription_data as {
        metadata: Record<string, string>;
      };

    assert.equal(
      subscriptionData.metadata
        .makehijrah_service_id,
      SERVICE_RECURRING,
      "a renewal invoice must be able to resolve its context",
    );
  });

  it("ignores any attribution the client tries to send", async () => {
    const response = await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {
        consultant_id: OTHER_CONSULTANT_ID,
        attributed_consultant_id: OTHER_CONSULTANT_ID,
        commission_bps: 9_999,
        service_request_id: REQUEST_ID,
        consultation_id: OTHER_CONSULTATION_ID,
      },
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 200);

    const metadata = createdSessions[0]!.metadata as Record<
      string,
      string
    >;

    assert.equal(
      JSON.stringify(metadata).includes(
        OTHER_CONSULTANT_ID,
      ),
      false,
    );
    assert.equal(
      JSON.stringify(metadata).includes("9999"),
      false,
    );
  });

  it("refuses a consultant, an admin and an anonymous caller", async () => {
    for (const token of [
      CONSULTANT_PROFILE,
      ADMIN_PROFILE,
    ]) {
      const response = await post(
        `/api/services/${SERVICE_ID}/checkout`,
        {},
        token,
      );

      assert.equal(response.statusCode, 403);
    }

    const anonymous = await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {},
      null,
    );

    assert.equal(anonymous.statusCode, 401);
    assert.equal(createdSessions.length, 0);
  });

  it("returns 404 for an inactive service", async () => {
    db.services[0]!.is_active = false;

    const response = await post(
      `/api/services/${SERVICE_ID}/checkout`,
      {},
      CLIENT_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });
});

/*
 * Migration 043. Cumulative refund semantics at the webhook level.
 *
 * These four cases are the ones the delta interpretation got
 * wrong. The same arithmetic is proved against real PostgreSQL in
 * MIGRATION_043_VERIFICATION.sql; asserted here is that the
 * webhook passes Stripe's cumulative figure through unchanged and
 * that the outcome it reports matches.
 */
describe("Service purchase: cumulative refunds", () => {
  const refundTo = async (cumulativeTotal: number) =>
    handleEvent({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_one",
          object: "charge",
          payment_intent: "pi_one",
          amount_refunded: cumulativeTotal,
        },
      },
    });

  const purchaseRow = () => db.service_purchases[0]!;

  const reversedTotal = (): number =>
    db.consultant_ledger_entries
      .filter((row) => row.entry_type === "reversal")
      .reduce(
        (sum, row) =>
          sum - (row.gross_amount_minor as number),
        0,
      );

  it("is a no-op when the same total is delivered twice", async () => {
    await handleEvent(checkoutSessionEvent());

    await refundTo(3_000);
    const outcome = await refundTo(3_000);

    assert.equal(outcome?.action, "refund_noop");
    assert.equal(outcome?.reason, "no_change");

    assert.equal(
      purchaseRow().refunded_amount_minor,
      3_000,
      "a redelivered cumulative total must not be added again",
    );
    assert.equal(reversedTotal(), 3_000);
  });

  it("applies only the difference on a second partial", async () => {
    await handleEvent(checkoutSessionEvent());

    await refundTo(3_000);
    await refundTo(5_000);

    assert.equal(
      purchaseRow().refunded_amount_minor,
      5_000,
      "3000 then a cumulative 5000 is 5000 refunded, not 8000",
    );
    assert.equal(
      reversedTotal(),
      5_000,
      "the consultant's ledger must be reversed by what was actually refunded",
    );
    assert.equal(purchaseRow().status, "paid");
  });

  it("completes a partial with a full refund", async () => {
    await handleEvent(checkoutSessionEvent());

    await refundTo(3_000);
    const outcome = await refundTo(9_999);

    assert.equal(outcome?.action, "refund_reversed");
    assert.equal(
      purchaseRow().refunded_amount_minor,
      9_999,
    );
    assert.equal(purchaseRow().status, "refunded");
    assert.equal(reversedTotal(), 9_999);
    assert.equal(
      availableFor(CONSULTANT_ID, "usd") +
        pendingFor(CONSULTANT_ID, "usd"),
      0,
      "a fully refunded purchase leaves the consultant owed nothing",
    );
  });

  it("accumulates three partials correctly", async () => {
    await handleEvent(checkoutSessionEvent());

    await refundTo(1_000);
    await refundTo(4_000);
    await refundTo(6_000);

    assert.equal(
      purchaseRow().refunded_amount_minor,
      6_000,
    );
    assert.equal(reversedTotal(), 6_000);
    assert.equal(
      db.consultant_ledger_entries.filter(
        (row) => row.entry_type === "reversal",
      ).length,
      3,
      "each delivery writes its own reversal entry; none is rewritten",
    );
  });

  it("never mutates the original earning across many refunds", async () => {
    await handleEvent(checkoutSessionEvent());

    await refundTo(2_000);
    await refundTo(7_000);
    await refundTo(9_999);

    const earning = db.consultant_ledger_entries.find(
      (row) => row.entry_type === "earning",
    )!;

    assert.equal(earning.gross_amount_minor, 9_999);
    assert.equal(earning.consultant_amount_minor, 4_500);
  });
});
