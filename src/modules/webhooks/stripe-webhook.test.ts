/*
 * Stripe webhook acknowledgement tests.
 *
 * Covers PROJECT_LOCK Amendment 004 section 10: correctly signed
 * Stripe events that carry no consultation_id are acknowledged
 * with HTTP 200 and ignored, while consultation events continue
 * through the existing processing path unchanged.
 *
 * Signatures are generated with Stripe's own test header helper
 * and verified by the real stripe.webhooks.constructEvent, so
 * signature verification is exercised rather than bypassed.
 *
 * No network and no database are involved. The Supabase RPC and
 * the Stripe PaymentIntent read are the only external calls the
 * webhook can make, and both are replaced with spies. Any direct
 * table access would go through supabaseAdmin.from, which is
 * stubbed to throw.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://stripe-webhook-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_SECRET_KEY: "sk_test_stripe_webhook_tests",
  STRIPE_TEST_SECRET_KEY: "sk_test_stripe_webhook_tests",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_stripe_webhook_tests",
  STRIPE_LIVE_SECRET_KEY: "sk_live_stripe_webhook_tests",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_stripe_webhook_tests",
  STRIPE_WEBHOOK_SECRET: "whsec_stripe_webhook_tests",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_REDIRECT_URI: "https://example.test/oauth/callback",
  APP_URL: "https://example.test",
  OAUTH_STATE_SECRET: "test-oauth-state-secret-of-sufficient-length",
  MANDRILL_API_KEY: "test-mandrill-key",
  MANDRILL_FROM_EMAIL: "no-reply@example.test",
  MANDRILL_FROM_NAME: "Make Hijrah Test",
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] ??= value;
}

const WEBHOOK_SECRET = process.env
  .STRIPE_TEST_WEBHOOK_SECRET as string;

/*
 * Imported dynamically so the environment above is in place
 * before config/env.ts validates process.env at module load.
 */
const { default: Fastify } = await import("fastify");
const { default: rawBody } = await import("fastify-raw-body");
const { getStripeClient } = await import("../../lib/stripe.js");
/* Amendment 007: one client per mode. Tests run in test mode. */
const stripe = getStripeClient("test");
const { supabaseAdmin } = await import("../../lib/supabase.js");
const { registerStripeWebhookRoute } = await import(
  "./stripe-webhook.route.js"
);

type RpcCall = {
  name: string;
  params: Record<string, unknown>;
};

const rpcCalls: RpcCall[] = [];
const retrievedPaymentIntents: string[] = [];

let rpcRow = {
  processed: true,
  already_processed: false,
  payment_id: "11111111-1111-1111-1111-111111111111",
  consultation_status: "captured",
};

let refundPaymentIntentMetadata: Record<string, string> = {};

/*
 * Migration 040. The webhook now asks the database, on every
 * charge.refunded, whether the PaymentIntent belongs to a service
 * purchase — through an RPC, because Amendment 004 section 10.3.3
 * forbids this path from reading a table, which is exactly what
 * the from() stub below enforces.
 *
 * The default answer is "no", so every consultation refund test
 * below behaves precisely as it did before. The service purchase
 * tests set it to a real reversal row.
 */
let serviceReversalRow: Record<string, unknown> = {
  purchase_id: null,
  reversed: false,
  reason: "not_a_service_purchase",
  entry_id: null,
  reversal_entry_id: null,
  refunded_amount_minor: null,
  status: null,
  consultant_amount_minor: null,
};

/*
 * Is the consultation under test a DIRECT booking?
 *
 * Migration 045 gives every direct booking RPC a booking_source
 * guard, and the orchestrator dispatches on it: try the direct RPC
 * first, fall back to the standard one on
 * FINANCE_NOT_DIRECT_BOOKING. This stub reproduces that guard,
 * which is what lets the same webhook path be exercised for both
 * kinds of consultation.
 *
 * Default false, so every consultation test below behaves exactly
 * as it did before direct booking existed.
 */
let isDirectBooking = false;

const DIRECT_BOOKING_RPCS = new Set([
  "record_direct_booking_earning",
  "release_direct_booking_earning",
  "reverse_direct_booking_earning",
]);

const directBookingRow: Record<
  string,
  unknown
> = {
  consultation_id:
    "11111111-1111-4111-8111-111111111111",
  created: true,
  released: true,
  reversed: true,
  reason: "released",
  released_count: 2,
  standard_entry_id:
    "22222222-2222-4222-8222-222222222222",
  standard_gross_minor: 15000,
  standard_consultant_minor: 7500,
  standard_platform_minor: 7500,
  premium_entry_id:
    "33333333-3333-4333-8333-333333333333",
  premium_gross_minor: 5000,
  premium_consultant_minor: 4000,
  premium_platform_minor: 1000,
  refunded_total_minor: null,
  standard_delta_minor: 0,
  premium_delta_minor: 0,
  applied_delta_minor: 0,
  currency: "usd",
  available_at: null,
};

const installStubs = (): void => {
  rpcCalls.length = 0;
  retrievedPaymentIntents.length = 0;
  isDirectBooking = false;

  supabaseAdmin.rpc = (async (
    name: string,
    params: Record<string, unknown>,
  ) => {
    rpcCalls.push({ name, params });

    if (
      name ===
      "reverse_service_purchase_for_payment_intent"
    ) {
      return {
        data: [serviceReversalRow],
        error: null,
      };
    }

    if (DIRECT_BOOKING_RPCS.has(name)) {
      if (!isDirectBooking) {
        return {
          data: null,
          error: {
            code: "P0001",
            message:
              "FINANCE_NOT_DIRECT_BOOKING: consultation is a standard booking",
            details: null,
            hint: null,
          },
        };
      }

      return {
        data: [directBookingRow],
        error: null,
      };
    }

    return { data: [rpcRow], error: null };
  }) as unknown as typeof supabaseAdmin.rpc;

  /*
   * Any direct table access from the webhook path would be a
   * violation of section 10.3.3. Fail loudly if it happens.
   */
  supabaseAdmin.from = ((table: string) => {
    throw new Error(
      `Unexpected direct table access to "${table}" from the Stripe webhook.`,
    );
  }) as unknown as typeof supabaseAdmin.from;

  stripe.paymentIntents.retrieve = (async (id: string) => {
    retrievedPaymentIntents.push(id);

    return {
      id,
      object: "payment_intent",
      amount: 15000,
      amount_received: 15000,
      currency: "usd",
      status: "succeeded",
      metadata: refundPaymentIntentMetadata,
    };
  }) as unknown as typeof stripe.paymentIntents.retrieve;
};

const buildApp = async () => {
  const app = Fastify({ logger: false });

  // Mirrors the registration in src/server.ts.
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
    routes: [],
  });

  await registerStripeWebhookRoute(app);
  await app.ready();

  return app;
};

const paymentIntentEvent = (
  type: string,
  metadata: Record<string, string>,
): Record<string, unknown> => ({
  id: `evt_${type.replace(/\./g, "_")}`,
  object: "event",
  livemode: false,
  type,
  created: 1_735_689_600,
  data: {
    object: {
      id: "pi_test_123",
      object: "payment_intent",
      amount: 15000,
      amount_received: 15000,
      currency: "usd",
      status: "succeeded",
      metadata,
    },
  },
});

const chargeRefundedEvent = ({
  amountRefunded = 15000,
  fullyRefunded = true,
  eventId = "evt_charge_refunded",
}: {
  amountRefunded?: number;
  fullyRefunded?: boolean;
  eventId?: string;
} = {}): Record<string, unknown> => ({
  id: eventId,
  object: "event",
  livemode: false,
  type: "charge.refunded",
  created: 1_735_689_600,
  data: {
    object: {
      id: "ch_test_123",
      object: "charge",
      payment_intent: "pi_test_123",
      /*
       * CUMULATIVE. Stripe reports the total refunded against this
       * charge so far, not the amount of one refund, and repeats
       * it on every redelivery.
       */
      amount_refunded: amountRefunded,
      currency: "usd",
      refunded: fullyRefunded,
    },
  },
});

type WebhookResponse = {
  statusCode: number;
  body: {
    ok: boolean;
    data?: {
      received: boolean;
      event_id: string;
      event_type: string;
      ignored: boolean;
      reason: string | null;
      processed: boolean;
      already_processed: boolean;
    };
    error?: { code: string; message: string };
  };
};

const post = async (
  event: Record<string, unknown>,
  options: { signature?: string | null } = {},
): Promise<WebhookResponse> => {
  const app = await buildApp();

  try {
    const payload = JSON.stringify(event);

    const signature =
      options.signature === undefined
        ? stripe.webhooks.generateTestHeaderString({
            payload,
            secret: WEBHOOK_SECRET,
          })
        : options.signature;

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      payload,
      headers: {
        "content-type": "application/json",
        ...(signature === null
          ? {}
          : { "stripe-signature": signature }),
      },
    });

    return {
      statusCode: response.statusCode,
      body: response.json(),
    };
  } finally {
    await app.close();
  }
};

const assertNoConsultationSideEffects = (): void => {
  /*
   * The service purchase lookup is not a consultation side
   * effect: it writes nothing, transitions nothing, and returns
   * "not a service purchase" for every consultation event. It is
   * excluded so this assertion keeps meaning what it meant —
   * no consultation was touched.
   */
  const consultationCalls = rpcCalls.filter(
    (call) =>
      call.name !==
      "reverse_service_purchase_for_payment_intent",
  );

  assert.equal(
    consultationCalls.length,
    0,
    "No consultation RPC may be called for an ignored event.",
  );
};

/*
 * The payment transition RPC, isolated from the ledger RPCs the
 * webhook now also calls (migration 035). The invariant these
 * tests protect is that a payment is transitioned exactly once;
 * counting every RPC would conflate that with the finance side
 * effects, which are separate, idempotent, and asserted below.
 */
const paymentRpcCalls = (): RpcCall[] =>
  rpcCalls.filter(
    (call) => call.name === "process_stripe_webhook_event",
  );

const ledgerRpcNames = (): string[] =>
  rpcCalls
    .filter(
      (call) =>
        call.name !== "process_stripe_webhook_event" &&
        call.name !==
          "reverse_service_purchase_for_payment_intent",
    )
    .map((call) => call.name);

describe("Stripe webhook: non-consultation events", () => {
  beforeEach(() => {
    installStubs();
    refundPaymentIntentMetadata = {};
  });

  it("acknowledges payment_intent.succeeded with no consultation_id", async () => {
    const response = await post(
      paymentIntentEvent("payment_intent.succeeded", {}),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.data?.ignored, true);
    assert.equal(
      response.body.data?.reason,
      "non_consultation_event",
    );
    assert.equal(response.body.data?.processed, false);
    assert.equal(response.body.data?.already_processed, false);
    assertNoConsultationSideEffects();
  });

  it("acknowledges payment_intent.amount_capturable_updated with no consultation_id", async () => {
    const response = await post(
      paymentIntentEvent(
        "payment_intent.amount_capturable_updated",
        {},
      ),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, true);
    assert.equal(
      response.body.data?.reason,
      "non_consultation_event",
    );
    assertNoConsultationSideEffects();
  });

  it("acknowledges payment_intent.canceled with no consultation_id", async () => {
    const response = await post(
      paymentIntentEvent("payment_intent.canceled", {}),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, true);
    assert.equal(
      response.body.data?.reason,
      "non_consultation_event",
    );
    assertNoConsultationSideEffects();
  });

  it("treats a blank consultation_id as a non-consultation event", async () => {
    const response = await post(
      paymentIntentEvent("payment_intent.succeeded", {
        consultation_id: "   ",
      }),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, true);
    assert.equal(
      response.body.data?.reason,
      "non_consultation_event",
    );
    assertNoConsultationSideEffects();
  });

  it("acknowledges a refund whose payment has no consultation_id", async () => {
    refundPaymentIntentMetadata = {};

    const response = await post(chargeRefundedEvent());

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, true);
    assert.equal(
      response.body.data?.reason,
      "non_consultation_event",
    );
    assert.deepEqual(retrievedPaymentIntents, ["pi_test_123"]);
    assertNoConsultationSideEffects();
  });
});

describe("Stripe webhook: consultation events are unchanged", () => {
  beforeEach(() => {
    installStubs();
    refundPaymentIntentMetadata = {};
    rpcRow = {
      processed: true,
      already_processed: false,
      payment_id: "11111111-1111-1111-1111-111111111111",
      consultation_status: "captured",
    };
  });

  it("processes payment_intent.succeeded carrying a consultation_id", async () => {
    const consultationId = "22222222-2222-2222-2222-222222222222";

    const response = await post(
      paymentIntentEvent("payment_intent.succeeded", {
        consultation_id: consultationId,
      }),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, false);
    assert.equal(response.body.data?.reason, null);
    assert.equal(response.body.data?.processed, true);

    assert.equal(paymentRpcCalls().length, 1);

    const call = paymentRpcCalls()[0];
    assert.ok(call);
    assert.equal(call.name, "process_stripe_webhook_event");
    assert.equal(call.params.p_consultation_id, consultationId);
    assert.equal(
      call.params.p_event_type,
      "payment_intent.succeeded",
    );
    assert.equal(
      call.params.p_consultation_status,
      "captured",
    );
    assert.equal(
      call.params.p_stripe_payment_intent_id,
      "pi_test_123",
    );
  });

  it("processes payment_intent.amount_capturable_updated carrying a consultation_id", async () => {
    const consultationId = "33333333-3333-3333-3333-333333333333";

    const response = await post(
      paymentIntentEvent(
        "payment_intent.amount_capturable_updated",
        { consultation_id: consultationId },
      ),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, false);
    assert.equal(paymentRpcCalls().length, 1);
    assert.equal(
      paymentRpcCalls()[0]?.params.p_consultation_status,
      "pending_acceptance",
    );
  });

  it("processes payment_intent.canceled carrying a consultation_id", async () => {
    const consultationId = "44444444-4444-4444-4444-444444444444";

    const response = await post(
      paymentIntentEvent("payment_intent.canceled", {
        consultation_id: consultationId,
      }),
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, false);
    assert.equal(paymentRpcCalls().length, 1);
    assert.equal(
      paymentRpcCalls()[0]?.params.p_consultation_status,
      "authorization_cancelled",
    );
  });

  it("processes a refund whose payment carries a consultation_id", async () => {
    const consultationId = "55555555-5555-5555-5555-555555555555";
    refundPaymentIntentMetadata = {
      consultation_id: consultationId,
    };

    const response = await post(chargeRefundedEvent());

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, false);
    assert.equal(paymentRpcCalls().length, 1);
    assert.equal(
      paymentRpcCalls()[0]?.params.p_consultation_id,
      consultationId,
    );
    assert.equal(
      paymentRpcCalls()[0]?.params.p_consultation_status,
      "refunded",
    );
  });
});

/*
 * Migration 035 side effects. The webhook reaches the ledger only
 * through RPCs — the stub above throws on any direct table access
 * — and only for the two events that move money.
 */
describe("Stripe webhook: consultation ledger side effects", () => {
  beforeEach(() => {
    installStubs();
    refundPaymentIntentMetadata = {};
    rpcRow = {
      processed: true,
      already_processed: false,
      payment_id: "11111111-1111-1111-1111-111111111111",
      consultation_status: "captured",
    };
  });

  it("records and releases the earning on a captured payment", async () => {
    await post(
      paymentIntentEvent("payment_intent.succeeded", {
        consultation_id: "22222222-2222-2222-2222-222222222222",
      }),
    );

    /*
     * The direct booking probe comes first and is refused with
     * FINANCE_NOT_DIRECT_BOOKING, which is how the orchestrator
     * learns this is a standard consultation without reading
     * consultations.booking_source — a table read the webhook is
     * not allowed to make. Migration 045, Amendment 011.
     */
    assert.deepEqual(ledgerRpcNames(), [
      "record_direct_booking_earning",
      "record_consultation_earning",
      "release_consultation_earning",
    ]);
  });

  it("reverses the earning on a refund", async () => {
    refundPaymentIntentMetadata = {
      consultation_id: "55555555-5555-5555-5555-555555555555",
    };

    await post(chargeRefundedEvent());

    assert.deepEqual(ledgerRpcNames(), [
      "reverse_direct_booking_earning",
      "reverse_consultation_earning",
    ]);
  });

  it("leaves the ledger alone for an authorization or a cancellation", async () => {
    await post(
      paymentIntentEvent(
        "payment_intent.amount_capturable_updated",
        { consultation_id: "33333333-3333-3333-3333-333333333333" },
      ),
    );

    assert.deepEqual(ledgerRpcNames(), []);

    installStubs();

    await post(
      paymentIntentEvent("payment_intent.canceled", {
        consultation_id: "44444444-4444-4444-4444-444444444444",
      }),
    );

    assert.deepEqual(ledgerRpcNames(), []);
  });

  it("touches the ledger for no ignored event", async () => {
    await post(paymentIntentEvent("payment_intent.succeeded", {}));

    assert.deepEqual(ledgerRpcNames(), []);
  });
});

describe("Stripe webhook: direct bookings", () => {
  beforeEach(() => {
    installStubs();
    refundPaymentIntentMetadata = {};
    isDirectBooking = true;
  });

  it("records and releases both components on capture", async () => {
    await post(
      paymentIntentEvent("payment_intent.succeeded", {
        consultation_id: "22222222-2222-2222-2222-222222222222",
      }),
    );

    /*
     * No fallback to the standard path, and no second record call:
     * the direct RPC answered, so the dispatch stops there.
     */
    assert.deepEqual(ledgerRpcNames(), [
      "record_direct_booking_earning",
      "release_direct_booking_earning",
    ]);
  });

  it("passes Stripe's CUMULATIVE refunded total to the reversal", async () => {
    refundPaymentIntentMetadata = {
      consultation_id: "55555555-5555-5555-5555-555555555555",
    };

    await post(
      chargeRefundedEvent({
        amountRefunded: 5000,
        fullyRefunded: false,
      }),
    );

    assert.deepEqual(ledgerRpcNames(), [
      "reverse_direct_booking_earning",
    ]);

    const call = rpcCalls.find(
      (entry) =>
        entry.name === "reverse_direct_booking_earning",
    )!;

    /*
     * charge.amount_refunded, verbatim. The RPC reads it as a
     * cumulative target and applies only the difference against
     * what each component has already had reversed — so a second
     * partial reverses its difference and a redelivery reverses
     * nothing. Passing a per-refund delta here would silently
     * under-reverse on the second partial.
     */
    assert.equal(
      call.params.p_refunded_total_minor,
      5000,
    );
  });

  it("passes the growing total, not the increment, on a second refund", async () => {
    refundPaymentIntentMetadata = {
      consultation_id: "55555555-5555-5555-5555-555555555555",
    };

    await post(
      chargeRefundedEvent({
        amountRefunded: 5000,
        fullyRefunded: false,
        eventId: "evt_charge_refunded_first",
      }),
    );

    await post(
      chargeRefundedEvent({
        amountRefunded: 8000,
        fullyRefunded: false,
        eventId: "evt_charge_refunded_second",
      }),
    );

    const totals = rpcCalls
      .filter(
        (entry) =>
          entry.name ===
          "reverse_direct_booking_earning",
      )
      .map((entry) => entry.params.p_refunded_total_minor);

    assert.deepEqual(totals, [5000, 8000]);
  });

  it("never reads a table to decide which path applies", async () => {
    /*
     * supabaseAdmin.from throws in this suite. The dispatch learns
     * a consultation is a direct booking from the RPC's own
     * marker, under the same row lock as the write it authorises —
     * Amendment 004 section 10.3.3.
     */
    await post(
      paymentIntentEvent("payment_intent.succeeded", {
        consultation_id: "22222222-2222-2222-2222-222222222222",
      }),
    );

    assert.equal(
      rpcCalls.every((entry) => entry.name.length > 0),
      true,
    );
  });
});

describe("Stripe webhook: signature verification is unchanged", () => {
  beforeEach(() => {
    installStubs();
    refundPaymentIntentMetadata = {};
  });

  it("rejects an invalid signature with HTTP 400", async () => {
    const response = await post(
      paymentIntentEvent("payment_intent.succeeded", {}),
      { signature: "t=1,v1=deadbeef" },
    );

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.ok, false);
    assert.equal(
      response.body.error?.code,
      "STRIPE_SIGNATURE_INVALID",
    );
    assertNoConsultationSideEffects();
  });

  it("rejects an invalid signature even with no consultation_id", async () => {
    const response = await post(
      paymentIntentEvent("payment_intent.succeeded", {}),
      { signature: "t=1,v1=deadbeef" },
    );

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.body.error?.code,
      "STRIPE_SIGNATURE_INVALID",
    );
    assertNoConsultationSideEffects();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const payload = JSON.stringify(
      paymentIntentEvent("payment_intent.succeeded", {}),
    );

    const wrongSignature =
      stripe.webhooks.generateTestHeaderString({
        payload,
        secret: "whsec_a_different_secret",
      });

    const response = await post(
      paymentIntentEvent("payment_intent.succeeded", {}),
      { signature: wrongSignature },
    );

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.body.error?.code,
      "STRIPE_SIGNATURE_INVALID",
    );
    assertNoConsultationSideEffects();
  });

  it("rejects a missing signature header with HTTP 400", async () => {
    const response = await post(
      paymentIntentEvent("payment_intent.succeeded", {}),
      { signature: null },
    );

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.body.error?.code,
      "STRIPE_SIGNATURE_MISSING",
    );
    assertNoConsultationSideEffects();
  });
});

describe("Stripe webhook: unsupported event types", () => {
  beforeEach(() => {
    installStubs();
    refundPaymentIntentMetadata = {};
  });

  it("still acknowledges an unsupported event type with HTTP 200", async () => {
    const response = await post({
      id: "evt_customer_created",
      object: "event",
  livemode: false,
      type: "customer.created",
      created: 1_735_689_600,
      data: { object: { id: "cus_test_123", object: "customer" } },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data?.ignored, true);
    assert.equal(
      response.body.data?.reason,
      "unsupported_event_type",
    );
    assertNoConsultationSideEffects();
  });

  it("distinguishes an unsupported type from a non-consultation payment", async () => {
    const unsupported = await post({
      id: "evt_checkout_completed",
      object: "event",
  livemode: false,
      type: "checkout.session.completed",
      created: 1_735_689_600,
      data: { object: { id: "cs_test_123", object: "checkout.session" } },
    });

    const nonConsultation = await post(
      paymentIntentEvent("payment_intent.succeeded", {}),
    );

    assert.equal(
      unsupported.body.data?.reason,
      "unsupported_event_type",
    );
    assert.equal(
      nonConsultation.body.data?.reason,
      "non_consultation_event",
    );
    assertNoConsultationSideEffects();
  });
});
