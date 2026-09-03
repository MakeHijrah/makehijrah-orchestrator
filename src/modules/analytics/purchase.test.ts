/*
 * GA4 server-side purchase event tests.
 *
 * Nothing leaves the process: global fetch is replaced with a
 * recorder, so these assert the exact Measurement Protocol
 * payload without contacting Google.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://analytics-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_analytics",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_analytics",
  STRIPE_LIVE_SECRET_KEY: "sk_live_analytics",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_analytics",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_REDIRECT_URI: "https://example.test/oauth/callback",
  APP_URL: "https://app.example.test",
  OAUTH_STATE_SECRET: "test-oauth-state-secret-of-sufficient-length",
  MANDRILL_API_KEY: "test-mandrill-key",
  MANDRILL_FROM_EMAIL: "no-reply@example.test",
  MANDRILL_FROM_NAME: "Make Hijrah Test",
  /* Configured, so the sender is live for these tests. */
  GA4_MEASUREMENT_ID: "G-JY3T983V3R",
  GA4_API_SECRET: "test-measurement-protocol-secret",
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] ??= value;
}

const {
  sendConsultationPurchaseEvent,
  shouldSendPurchaseEvent,
} = await import("./purchase.service.js");

const CONSULTATION = "77777777-7777-4777-8777-777777777777";
const CONSULTANT = "44444444-4444-4444-8444-444444444444";

type Captured = {
  url: string;
  body: Record<string, unknown>;
};

let captured: Captured[] = [];
let nextResponse: { ok: boolean; status: number } = {
  ok: true,
  status: 204,
};
let shouldThrow = false;

globalThis.fetch = (async (
  input: unknown,
  init?: { body?: string },
) => {
  if (shouldThrow) {
    throw new Error("network down");
  }

  captured.push({
    url: String(input),
    body: JSON.parse(init?.body ?? "{}"),
  });

  return {
    ok: nextResponse.ok,
    status: nextResponse.status,
    statusText: "",
  };
}) as unknown as typeof fetch;

const purchaseParams = (): Record<string, unknown> =>
  (
    (captured[0]?.body.events as Array<{
      params: Record<string, unknown>;
    }>)?.[0] ?? { params: {} }
  ).params;

const send = (
  overrides: Partial<{
    gaClientId: string | null;
    consultantId: string | null;
    consultantName: string | null;
    destination: string | null;
    amountMinor: number;
    currency: string;
  }> = {},
) =>
  sendConsultationPurchaseEvent({
    consultationId: CONSULTATION,
    amountMinor: overrides.amountMinor ?? 15_000,
    currency: overrides.currency ?? "usd",
    gaClientId:
      overrides.gaClientId === undefined
        ? "1234567890.1234567890"
        : overrides.gaClientId,
    consultantId:
      overrides.consultantId === undefined
        ? CONSULTANT
        : overrides.consultantId,
    consultantName:
      overrides.consultantName === undefined
        ? "Aisha Rahman"
        : overrides.consultantName,
    destination:
      overrides.destination === undefined
        ? "Egypt"
        : overrides.destination,
  });

beforeEach(() => {
  captured = [];
  nextResponse = { ok: true, status: 204 };
  shouldThrow = false;
});

describe("GA4 purchase: when it fires", () => {
  it("fires on capture, on the delivery that did the work", () => {
    assert.equal(
      shouldSendPurchaseEvent({
        eventType: "payment_intent.succeeded",
        consultationId: CONSULTATION,
        processed: true,
        alreadyProcessed: false,
      }),
      true,
    );
  });

  it("does not fire on authorization", () => {
    /*
     * The locked rule: a consultation can be authorized and then
     * declined or timed out and never captured, so authorization
     * is not revenue.
     */
    assert.equal(
      shouldSendPurchaseEvent({
        eventType:
          "payment_intent.amount_capturable_updated",
        consultationId: CONSULTATION,
        processed: true,
        alreadyProcessed: false,
      }),
      false,
    );
  });

  it("does not fire on a redelivery", () => {
    /*
     * GA4 does not reliably discard a duplicate purchase, so a
     * replayed webhook would book the revenue twice.
     */
    assert.equal(
      shouldSendPurchaseEvent({
        eventType: "payment_intent.succeeded",
        consultationId: CONSULTATION,
        processed: true,
        alreadyProcessed: true,
      }),
      false,
    );
  });

  it("does not fire for a refund or a cancellation", () => {
    for (const eventType of [
      "charge.refunded",
      "payment_intent.canceled",
    ]) {
      assert.equal(
        shouldSendPurchaseEvent({
          eventType,
          consultationId: CONSULTATION,
          processed: true,
          alreadyProcessed: false,
        }),
        false,
        `${eventType} must not report a purchase`,
      );
    }
  });

  it("does not fire for a non-consultation payment", () => {
    assert.equal(
      shouldSendPurchaseEvent({
        eventType: "payment_intent.succeeded",
        consultationId: null,
        processed: true,
        alreadyProcessed: false,
      }),
      false,
    );
  });
});

describe("GA4 purchase: the payload", () => {
  it("posts to the Measurement Protocol with the measurement id", async () => {
    const outcome = await send();

    assert.equal(outcome.sent, true);
    assert.equal(captured.length, 1);

    const url = captured[0]!.url;

    assert.ok(
      url.startsWith(
        "https://www.google-analytics.com/mp/collect",
      ),
      url,
    );
    assert.ok(url.includes("measurement_id=G-JY3T983V3R"));
    assert.ok(
      url.includes(
        "api_secret=test-measurement-protocol-secret",
      ),
    );
  });

  it("names the event purchase and carries the transaction id", async () => {
    await send();

    const body = captured[0]!.body as {
      events: Array<{ name: string }>;
    };

    assert.equal(body.events[0]!.name, "purchase");
    assert.equal(
      purchaseParams().transaction_id,
      CONSULTATION,
    );
  });

  it("converts minor units to major and upper-cases the currency", async () => {
    await send({ amountMinor: 15_000, currency: "usd" });

    assert.equal(purchaseParams().value, 150);
    assert.equal(purchaseParams().currency, "USD");
  });

  it("reports an odd amount without floating-point drift", async () => {
    await send({ amountMinor: 15_001 });

    assert.equal(purchaseParams().value, 150.01);
  });

  it("carries the consultant and destination as the item", async () => {
    await send();

    const items = purchaseParams().items as Array<
      Record<string, unknown>
    >;

    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      item_id: CONSULTANT,
      item_name: "Aisha Rahman",
      item_category: "Egypt",
      price: 150,
      quantity: 1,
    });
  });

  it("omits the item entirely when no consultant was recorded", async () => {
    await send({ consultantId: null });

    assert.equal(purchaseParams().items, undefined);
  });

  it("omits an absent name or destination rather than faking one", async () => {
    await send({
      consultantName: null,
      destination: null,
    });

    const items = purchaseParams().items as Array<
      Record<string, unknown>
    >;

    assert.deepEqual(items[0], {
      item_id: CONSULTANT,
      price: 150,
      quantity: 1,
    });
  });

  it("uses the browser client id when checkout captured one", async () => {
    await send({ gaClientId: "1234567890.1234567890" });

    assert.equal(
      captured[0]!.body.client_id,
      "1234567890.1234567890",
    );
    assert.equal(
      purchaseParams().ga_client_id_source,
      "browser",
    );
  });

  it("falls back to a stable id when the browser sent none", async () => {
    const first = await send({ gaClientId: null });
    const firstId = captured[0]!.body.client_id;

    captured = [];
    await send({ gaClientId: null });

    assert.equal(first.clientIdSource, "server_fallback");
    assert.equal(
      purchaseParams().ga_client_id_source,
      "server_fallback",
    );

    /*
     * Stable, not random: a second send for the same
     * consultation must not open a second phantom session.
     */
    assert.equal(captured[0]!.body.client_id, firstId);
  });

  it("does not send an advertising signal or a user id", async () => {
    await send();

    assert.equal(
      captured[0]!.body.non_personalized_ads,
      true,
    );
    assert.equal(captured[0]!.body.user_id, undefined);
  });
});

describe("GA4 purchase: failure is never the caller's problem", () => {
  it("reports a rejected request without throwing", async () => {
    nextResponse = { ok: false, status: 400 };

    const outcome = await send();

    assert.equal(outcome.sent, false);
    assert.equal(outcome.reason, "send_failed");
  });

  it("reports a network failure without throwing", async () => {
    shouldThrow = true;

    const outcome = await send();

    assert.equal(outcome.sent, false);
    assert.equal(outcome.reason, "send_failed");
  });

  it("refuses to report a non-positive amount", async () => {
    const outcome = await send({ amountMinor: 0 });

    assert.equal(outcome.sent, false);
    assert.equal(outcome.reason, "invalid_amount");
    assert.equal(captured.length, 0);
  });
});
