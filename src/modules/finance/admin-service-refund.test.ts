/*
 * Admin service purchase refund tests.
 *
 * The property most of this file exists to protect is a negative
 * one: the endpoint INITIATES a refund and records no accounting.
 * Several tests therefore assert on what did NOT happen — no
 * finance RPC called, no row mutated, no status moved — because a
 * future edit that "helpfully" updates the purchase would look
 * harmless and would quietly give MakeHijrah two sources of truth
 * for the same refund.
 *
 * The cumulative webhook behaviour that migration 043 fixed is
 * proved against real PostgreSQL in MIGRATION_043_VERIFICATION.sql;
 * what is asserted here is that the orchestrator passes Stripe's
 * cumulative total through as a total.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://admin-refund-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_admin_refund",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_admin_refund",
  STRIPE_LIVE_SECRET_KEY: "sk_live_admin_refund",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_admin_refund",
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
const { registerAdminServicePurchaseRoutes } = await import(
  "./admin-service-purchase.route.js"
);
const { processServicePurchaseEvent } = await import(
  "../webhooks/service-purchase-webhook.js"
);

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const ADMIN_PROFILE = "33333333-3333-4333-8333-333333333333";
const CLIENT_PROFILE = "11111111-1111-4111-8111-111111111111";
const CONSULTANT_PROFILE = "22222222-2222-4222-8222-222222222222";

const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const PURCHASE_ID = "99999999-9999-4999-8999-000000000001";
const RECURRING_PURCHASE_ID =
  "99999999-9999-4999-8999-000000000002";

type Row = Record<string, unknown>;

const db: {
  profiles: Row[];
  service_purchases: Row[];
} = { profiles: [], service_purchases: [] };

/* Every RPC the endpoint might call, so "calls none" is provable. */
const rpcCalls: Array<{ name: string; args: Row }> = [];
const updates: Array<{ table: string; patch: Row }> = [];

class FakeQuery {
  private readonly table: string;
  private readonly filters: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(): this {
    return this;
  }

  update(patch: Row): this {
    this.patch = patch;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
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

  private applyUpdate(): { error: unknown } {
    if (!this.patch) {
      return { error: null };
    }

    updates.push({
      table: this.table,
      patch: this.patch,
    });

    for (const row of this.rows()) {
      Object.assign(row, this.patch);
    }

    return { error: null };
  }

  async maybeSingle(): Promise<{
    data: Row | null;
    error: unknown;
  }> {
    if (this.patch) {
      this.applyUpdate();
    }

    return { data: this.rows()[0] ?? null, error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          data: Row[] | null;
          error: unknown;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    if (this.patch) {
      this.applyUpdate();

      return Promise.resolve({
        data: null,
        error: null,
      }).then(onFulfilled, onRejected);
    }

    return Promise.resolve({
      data: this.rows(),
      error: null,
    }).then(onFulfilled, onRejected);
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

supabaseAdmin.rpc = (async (name: string, args: Row) => {
  rpcCalls.push({ name, args });
  return { data: [], error: null };
}) as unknown as typeof supabaseAdmin.rpc;

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

/* ---------------------------------------------- Stripe fakes -- */

type RefundCall = {
  params: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
};

const refundCalls: RefundCall[] = [];
const invoicePaymentCalls: Record<string, unknown>[] = [];

let refundShouldFail = false;
let invoicePaymentsResponse: {
  data: Array<Record<string, unknown>>;
} = { data: [] };

const testStripe = getStripeClient("test");
const liveStripe = getStripeClient("live");

const stubStripe = (
  stripe: ReturnType<typeof getStripeClient>,
  label: "test" | "live",
): void => {
  stripe.refunds.create = (async (
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    refundCalls.push({
      params: { ...params, __mode: label },
      options,
    });

    if (refundShouldFail) {
      throw new Error("Stripe declined the refund");
    }

    return { id: `re_${label}_${refundCalls.length}` };
  }) as unknown as typeof stripe.refunds.create;

  stripe.invoicePayments.list = (async (
    params: Record<string, unknown>,
  ) => {
    invoicePaymentCalls.push({
      ...params,
      __mode: label,
    });

    return invoicePaymentsResponse;
  }) as unknown as typeof stripe.invoicePayments.list;
};

stubStripe(testStripe, "test");
stubStripe(liveStripe, "live");

const redisStore = new Map<string, string>();

redis.set = (async (
  key: string,
  value: string,
  ..._rest: unknown[]
) => {
  const nx = _rest.includes("NX");

  if (nx && redisStore.has(key)) {
    return null;
  }

  redisStore.set(key, value);
  return "OK";
}) as unknown as typeof redis.set;

redis.del = (async (key: string) => {
  redisStore.delete(key);
  return 1;
}) as unknown as typeof redis.del;

redis.get = (async (key: string) =>
  redisStore.get(key) ?? null) as unknown as typeof redis.get;

/* ---------------------------------------------------- the app -- */

const app = Fastify();
await registerAdminServicePurchaseRoutes(app);
await app.ready();

const refund = async (
  body: unknown,
  token: string | null = ADMIN_PROFILE,
  purchaseId: string = PURCHASE_ID,
): Promise<{
  statusCode: number;
  json: () => { ok: boolean; data?: Row; error?: Row };
}> => {
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/service-purchases/${purchaseId}/refund`,
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

const purchaseRow = (overrides: Row = {}): Row => ({
  id: PURCHASE_ID,
  service_id: SERVICE_ID,
  client_profile_id: CLIENT_PROFILE,
  gross_amount_minor: 10_000,
  refunded_amount_minor: 0,
  currency: "usd",
  status: "paid",
  stripe_mode: "test",
  stripe_payment_intent_id: "pi_stored",
  stripe_invoice_id: null,
  ...overrides,
});

const snapshot = (row: Row): string =>
  JSON.stringify(row);

beforeEach(() => {
  rpcCalls.length = 0;
  updates.length = 0;
  refundCalls.length = 0;
  invoicePaymentCalls.length = 0;
  refundShouldFail = false;
  invoicePaymentsResponse = { data: [] };
  redisStore.clear();

  db.profiles = [
    { id: ADMIN_PROFILE, role: "admin" },
    { id: CLIENT_PROFILE, role: "client" },
    { id: CONSULTANT_PROFILE, role: "consultant" },
  ];

  db.service_purchases = [purchaseRow()];
});

describe("Admin refund: happy paths", () => {
  it("submits a full refund for the remaining amount", async () => {
    db.service_purchases = [
      purchaseRow({ refunded_amount_minor: 2_500 }),
    ];

    const response = await refund({ type: "full" });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data!.refund_submitted,
      true,
    );
    assert.equal(
      response.json().data!.amount_minor,
      7_500,
      "full means the REMAINING balance, not the gross",
    );
    assert.equal(
      response.json().data!.currency,
      "usd",
    );
    assert.match(
      String(response.json().data!.stripe_refund_id),
      /^re_/,
    );

    assert.equal(refundCalls.length, 1);
    assert.equal(
      refundCalls[0]!.params.amount,
      7_500,
    );
  });

  it("submits a partial refund", async () => {
    const response = await refund({
      type: "partial",
      amount_minor: 500,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data!.amount_minor,
      500,
    );
    assert.equal(refundCalls[0]!.params.amount, 500);
  });

  it("uses the stored PaymentIntent", async () => {
    await refund({ type: "full" });

    assert.equal(
      refundCalls[0]!.params.payment_intent,
      "pi_stored",
    );
    assert.equal(
      invoicePaymentCalls.length,
      0,
      "a stored PaymentIntent needs no invoice lookup",
    );
  });

  it("includes the trusted metadata", async () => {
    await refund({ type: "full" });

    assert.deepEqual(refundCalls[0]!.params.metadata, {
      makehijrah_service_purchase_id: PURCHASE_ID,
      makehijrah_service_id: SERVICE_ID,
      makehijrah_client_profile_id: CLIENT_PROFILE,
    });
  });

  it("omits the client metadata key for an unattributed purchase", async () => {
    db.service_purchases = [
      purchaseRow({ client_profile_id: null }),
    ];

    await refund({ type: "full" });

    assert.deepEqual(refundCalls[0]!.params.metadata, {
      makehijrah_service_purchase_id: PURCHASE_ID,
      makehijrah_service_id: SERVICE_ID,
    });
  });

  it("includes an idempotency key derived from the purchase, amount and refunded total", async () => {
    db.service_purchases = [
      purchaseRow({ refunded_amount_minor: 2_500 }),
    ];

    await refund({ type: "partial", amount_minor: 1_000 });

    assert.equal(
      refundCalls[0]!.options?.idempotencyKey,
      `service-refund-${PURCHASE_ID}-1000-2500`,
    );
  });

  it("uses the purchase's recorded Stripe mode, not the global one", async () => {
    db.service_purchases = [
      purchaseRow({ stripe_mode: "live" }),
    ];

    await refund({ type: "full" });

    assert.equal(
      refundCalls[0]!.params.__mode,
      "live",
      "a purchase taken in live must refund against live regardless of the current mode",
    );
  });
});

describe("Admin refund: authorization", () => {
  it("refuses a client, a consultant and an anonymous caller", async () => {
    for (const token of [
      CLIENT_PROFILE,
      CONSULTANT_PROFILE,
    ]) {
      const response = await refund(
        { type: "full" },
        token,
      );

      assert.equal(response.statusCode, 403);
    }

    const anonymous = await refund(
      { type: "full" },
      null,
    );

    assert.equal(anonymous.statusCode, 401);
    assert.equal(refundCalls.length, 0);
  });
});

describe("Admin refund: request shape", () => {
  it("rejects every untrusted field", async () => {
    for (const body of [
      { type: "full", payment_intent_id: "pi_attacker" },
      { type: "full", charge_id: "ch_attacker" },
      { type: "full", stripe_invoice_id: "in_attacker" },
      { type: "full", client_profile_id: CLIENT_PROFILE },
      { type: "full", consultant_id: CONSULTANT_PROFILE },
      { type: "full", service_id: SERVICE_ID },
      { type: "full", currency: "eur" },
      { type: "full", commission_bps: 9_999 },
      { type: "full", amount_minor: 1 },
      { type: "full", metadata: { x: "y" } },
      { type: "partial", amount_minor: 500, charge_id: "ch_x" },
    ]) {
      const response = await refund(body);

      assert.equal(
        response.statusCode,
        400,
        `accepted an untrusted field: ${JSON.stringify(body)}`,
      );
    }

    assert.equal(refundCalls.length, 0);
  });

  it("rejects a malformed or missing type", async () => {
    for (const body of [
      {},
      { type: "whole" },
      { type: "partial" },
      { type: "partial", amount_minor: "500" },
      { type: "partial", amount_minor: 5.5 },
    ]) {
      assert.equal(
        (await refund(body)).statusCode,
        400,
        `accepted ${JSON.stringify(body)}`,
      );
    }
  });

  it("rejects zero and negative amounts", async () => {
    for (const amount of [0, -1, -500]) {
      const response = await refund({
        type: "partial",
        amount_minor: amount,
      });

      assert.equal(response.statusCode, 400);
    }

    assert.equal(refundCalls.length, 0);
  });
});

describe("Admin refund: validation against stored values", () => {
  it("refuses an amount above the remaining balance", async () => {
    db.service_purchases = [
      purchaseRow({ refunded_amount_minor: 8_000 }),
    ];

    const response = await refund({
      type: "partial",
      amount_minor: 2_001,
    });

    assert.equal(response.statusCode, 409);
    assert.equal(refundCalls.length, 0);
  });

  it("refuses an already fully refunded purchase", async () => {
    db.service_purchases = [
      purchaseRow({
        refunded_amount_minor: 10_000,
        status: "refunded",
      }),
    ];

    const response = await refund({ type: "full" });

    assert.equal(response.statusCode, 409);
    assert.equal(refundCalls.length, 0);
  });

  it("refuses a cancelled purchase", async () => {
    db.service_purchases = [
      purchaseRow({ status: "cancelled" }),
    ];

    assert.equal(
      (await refund({ type: "full" })).statusCode,
      409,
    );
    assert.equal(refundCalls.length, 0);
  });

  it("returns 404 for an unknown purchase", async () => {
    const response = await refund(
      { type: "full" },
      ADMIN_PROFILE,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    assert.equal(response.statusCode, 404);
    assert.equal(refundCalls.length, 0);
  });

  it("refuses when the Stripe mode is missing or unconfigured", async () => {
    db.service_purchases = [
      purchaseRow({ stripe_mode: null }),
    ];

    const response = await refund({ type: "full" });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().error!.code,
      "STRIPE_MODE_NOT_CONFIGURED",
    );
    assert.equal(refundCalls.length, 0);
  });
});

describe("Admin refund: PaymentIntent resolution", () => {
  it("resolves and persists a PaymentIntent from the stored invoice", async () => {
    db.service_purchases = [
      purchaseRow({
        id: RECURRING_PURCHASE_ID,
        stripe_payment_intent_id: null,
        stripe_invoice_id: "in_recurring",
      }),
    ];

    invoicePaymentsResponse = {
      data: [
        {
          id: "inpay_1",
          invoice: "in_recurring",
          status: "paid",
          payment: {
            type: "payment_intent",
            payment_intent: "pi_from_invoice",
          },
        },
      ],
    };

    const response = await refund(
      { type: "full" },
      ADMIN_PROFILE,
      RECURRING_PURCHASE_ID,
    );

    assert.equal(response.statusCode, 200);

    assert.equal(
      invoicePaymentCalls[0]!.invoice,
      "in_recurring",
    );

    /* Persisted BEFORE the refund, so the later webhook can find
       this purchase by PaymentIntent. */
    assert.deepEqual(
      updates.map((entry) => entry.patch),
      [{ stripe_payment_intent_id: "pi_from_invoice" }],
    );

    assert.equal(
      db.service_purchases[0]!.stripe_payment_intent_id,
      "pi_from_invoice",
    );

    assert.equal(
      refundCalls[0]!.params.payment_intent,
      "pi_from_invoice",
    );
  });

  it("ignores an invoice payment belonging to another invoice", async () => {
    db.service_purchases = [
      purchaseRow({
        id: RECURRING_PURCHASE_ID,
        stripe_payment_intent_id: null,
        stripe_invoice_id: "in_recurring",
      }),
    ];

    invoicePaymentsResponse = {
      data: [
        {
          id: "inpay_other",
          invoice: "in_someone_else",
          status: "paid",
          payment: {
            type: "payment_intent",
            payment_intent: "pi_foreign",
          },
        },
      ],
    };

    const response = await refund(
      { type: "full" },
      ADMIN_PROFILE,
      RECURRING_PURCHASE_ID,
    );

    assert.equal(response.statusCode, 409);
    assert.equal(refundCalls.length, 0);
    assert.equal(updates.length, 0);
  });

  it("ignores an invoice payment that is not a payment_intent", async () => {
    db.service_purchases = [
      purchaseRow({
        id: RECURRING_PURCHASE_ID,
        stripe_payment_intent_id: null,
        stripe_invoice_id: "in_recurring",
      }),
    ];

    invoicePaymentsResponse = {
      data: [
        {
          id: "inpay_charge",
          invoice: "in_recurring",
          status: "paid",
          payment: {
            type: "charge",
            charge: "ch_only",
          },
        },
      ],
    };

    assert.equal(
      (
        await refund(
          { type: "full" },
          ADMIN_PROFILE,
          RECURRING_PURCHASE_ID,
        )
      ).statusCode,
      409,
    );
    assert.equal(refundCalls.length, 0);
  });

  it("refuses when neither a PaymentIntent nor an invoice exists", async () => {
    db.service_purchases = [
      purchaseRow({
        stripe_payment_intent_id: null,
        stripe_invoice_id: null,
      }),
    ];

    const response = await refund({ type: "full" });

    assert.equal(response.statusCode, 409);
    assert.match(
      String(response.json().error!.message),
      /Stripe Dashboard/,
    );
    assert.equal(refundCalls.length, 0);
    assert.equal(invoicePaymentCalls.length, 0);
  });

  it("refuses when the invoice resolves to nothing", async () => {
    db.service_purchases = [
      purchaseRow({
        stripe_payment_intent_id: null,
        stripe_invoice_id: "in_empty",
      }),
    ];

    invoicePaymentsResponse = { data: [] };

    assert.equal(
      (await refund({ type: "full" })).statusCode,
      409,
    );
    assert.equal(
      refundCalls.length,
      0,
      "an unresolvable payment reference must never reach refunds.create",
    );
  });
});

describe("Admin refund: it records no accounting", () => {
  it("calls no finance RPC at all", async () => {
    await refund({ type: "partial", amount_minor: 500 });

    assert.deepEqual(
      rpcCalls,
      [],
      "the webhook is the sole financial recorder; this endpoint must not reverse, fulfil or adjust anything",
    );
  });

  it("does not move refunded_amount_minor or the status", async () => {
    const before = snapshot(db.service_purchases[0]!);

    await refund({ type: "partial", amount_minor: 500 });

    assert.equal(
      snapshot(db.service_purchases[0]!),
      before,
      "the purchase row must be untouched until charge.refunded arrives",
    );

    assert.deepEqual(updates, []);
  });

  it("returns no local status or refunded total", async () => {
    const response = await refund({ type: "full" });

    assert.deepEqual(
      Object.keys(response.json().data!).sort(),
      [
        "amount_minor",
        "currency",
        "purchase_id",
        "refund_submitted",
        "stripe_refund_id",
      ],
      "returning a status would let the UI render a refund MakeHijrah has not recorded",
    );
  });

  it("mutates nothing when Stripe fails", async () => {
    refundShouldFail = true;

    const before = snapshot(db.service_purchases[0]!);

    const response = await refund({ type: "full" });

    assert.equal(response.statusCode, 502);
    assert.equal(
      snapshot(db.service_purchases[0]!),
      before,
    );
    assert.deepEqual(rpcCalls, []);
    assert.deepEqual(updates, []);
  });
});

describe("Admin refund: duplicate submission", () => {
  it("refuses a second identical submission in flight", async () => {
    const first = await refund({
      type: "partial",
      amount_minor: 500,
    });

    const second = await refund({
      type: "partial",
      amount_minor: 500,
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
    assert.equal(
      second.json().error!.code,
      "CONFLICT",
    );

    assert.equal(
      refundCalls.length,
      1,
      "two identical submissions must not create two Stripe refunds",
    );
  });

  it("releases the claim when Stripe fails, so a retry is possible", async () => {
    refundShouldFail = true;
    await refund({ type: "partial", amount_minor: 500 });

    refundShouldFail = false;
    const retry = await refund({
      type: "partial",
      amount_minor: 500,
    });

    assert.equal(retry.statusCode, 200);
  });

  it("allows a deliberate second refund once the webhook has moved the total", async () => {
    await refund({ type: "partial", amount_minor: 500 });

    /* As the webhook would leave it. */
    db.service_purchases[0]!.refunded_amount_minor = 500;

    const second = await refund({
      type: "partial",
      amount_minor: 500,
    });

    assert.equal(second.statusCode, 200);
    assert.equal(refundCalls.length, 2);
    assert.notEqual(
      refundCalls[0]!.options?.idempotencyKey,
      refundCalls[1]!.options?.idempotencyKey,
      "the refunded-so-far discriminator must let a genuine second refund through",
    );
  });
});

describe("Admin refund: the webhook remains the recorder", () => {
  const chargeRefunded = (amountRefunded: number) =>
    processServicePurchaseEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_1",
            object: "charge",
            payment_intent: "pi_stored",
            amount_refunded: amountRefunded,
          },
        },
      } as never,
      "test",
    );

  it("passes Stripe's cumulative total through as a TOTAL", async () => {
    await chargeRefunded(5_000);

    const call = rpcCalls.find(
      (entry) =>
        entry.name ===
        "reverse_service_purchase_for_payment_intent",
    );

    assert.ok(call, "the reversal RPC was not called");

    assert.equal(
      call!.args.p_refunded_total_minor,
      5_000,
      "charge.amount_refunded is cumulative and must be passed as a total",
    );

    assert.equal(
      call!.args.p_gross_amount_minor,
      undefined,
      "the delta parameter must be gone; passing one would double-count a consultant's ledger",
    );

    assert.equal(
      call!.args.p_stripe_payment_intent_id,
      "pi_stored",
    );
  });

  it("is the only path that calls a reversal RPC", async () => {
    await refund({ type: "partial", amount_minor: 500 });

    assert.equal(
      rpcCalls.filter((entry) =>
        entry.name.includes("reverse"),
      ).length,
      0,
    );

    await chargeRefunded(500);

    assert.equal(
      rpcCalls.filter((entry) =>
        entry.name.includes("reverse"),
      ).length,
      1,
    );
  });
});
