/*
 * Draft consultation: what the browser may and may not decide.
 * Amendment 011.
 *
 * A direct booking is created through the SAME endpoint as any
 * other booking. That is deliberate — there is no second booking
 * system — and it means the endpoint now decides three things it
 * did not decide before: which consultant, at what price, from
 * which source. All three are settled on the server, and these
 * tests are about the two places that decision could be subverted:
 *
 *   the SCHEMA, which is where a supplied price, booking_source,
 *   commission or split ceases to exist; and
 *
 *   the REPOSITORY, which is where the consultant id and the
 *   booking source are bound to the RPC call.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://draft-direct-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_draft_direct",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_draft_direct",
  STRIPE_LIVE_SECRET_KEY: "sk_live_draft_direct",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_draft_direct",
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

const { supabaseAdmin } = await import("../../lib/supabase.js");
const { createDraftConsultationSchema } = await import(
  "./draft.schema.js"
);
const { createDraftConsultationRecord } = await import(
  "./draft.repository.js"
);

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const ATTACKER_CONSULTANT_ID =
  "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
const CLIENT_PROFILE = "22222222-2222-4222-8222-222222222222";
const COUNTRY_ID = "99999999-9999-4999-8999-999999999999";

const baseBody = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  country_id: COUNTRY_ID,
  start_at: "2032-03-10T09:00:00.000Z",
  client_timezone: "Europe/Istanbul",
  intake: {
    full_name: "A Client",
    email: "client@example.test",
    phone_whatsapp: null,
    answers: {
      consultation_summary: "Moving with two children.",
      client_gender: "female",
      preferred_consultant_gender: "female",
    },
  },
  ...extra,
});

describe("Draft request body", () => {
  it("accepts a consultant id, as it always has", () => {
    const parsed = createDraftConsultationSchema.safeParse(
      baseBody({ consultant_id: CONSULTANT_ID }),
    );

    assert.equal(parsed.success, true);
    assert.equal(
      parsed.success && parsed.data.consultant_id,
      CONSULTANT_ID,
    );
    assert.equal(
      parsed.success && parsed.data.consultant_slug,
      undefined,
    );
  });

  it("accepts a booking link instead", () => {
    const parsed = createDraftConsultationSchema.safeParse(
      baseBody({ consultant_slug: "aisha-rahman" }),
    );

    assert.equal(parsed.success, true);
    assert.equal(
      parsed.success && parsed.data.consultant_slug,
      "aisha-rahman",
    );
  });

  it("refuses a request that names no consultant", () => {
    assert.equal(
      createDraftConsultationSchema.safeParse(baseBody())
        .success,
      false,
    );
  });

  it("refuses a consultant id ALONGSIDE a booking link", () => {
    /*
     * The attack this closes: quote one consultant's page and book
     * another's calendar at the first one's price. Refused rather
     * than resolved by precedence, because a precedence rule is
     * something a later edit can invert without anyone noticing.
     */
    const parsed = createDraftConsultationSchema.safeParse(
      baseBody({
        consultant_slug: "aisha-rahman",
        consultant_id: ATTACKER_CONSULTANT_ID,
      }),
    );

    assert.equal(parsed.success, false);
  });

  it("strips a supplied price, source, commission or split", () => {
    const parsed = createDraftConsultationSchema.safeParse(
      baseBody({
        consultant_slug: "aisha-rahman",
        price_cents: 1,
        currency: "eur",
        booking_source: "direct_booking",
        commission_bps: 0,
        consultant_amount_minor: 999_999,
        platform_amount_minor: 0,
        premium_bps: 10_000,
        effective_direct_booking_price_cents: 1,
      }),
    );

    assert.equal(parsed.success, true);

    /*
     * They do not survive parsing at all, so no later check has to
     * remember to ignore them. Nothing downstream ever sees a
     * field it would have to be careful about.
     */
    const keys = Object.keys(
      parsed.success ? parsed.data : {},
    );

    for (const forbidden of [
      "price_cents",
      "currency",
      "booking_source",
      "commission_bps",
      "consultant_amount_minor",
      "platform_amount_minor",
      "premium_bps",
      "effective_direct_booking_price_cents",
    ]) {
      assert.equal(
        keys.includes(forbidden),
        false,
        `${forbidden} survived parsing`,
      );
    }
  });
});

describe("Draft record", () => {
  let rpcCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];

  beforeEach(() => {
    rpcCalls = [];

    supabaseAdmin.rpc = (async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      rpcCalls.push({ name, args });

      return {
        data: [
          {
            consultation_id:
              "66666666-6666-4666-8666-666666666666",
            consultation_status: "draft",
            hold_expires_at:
              "2032-03-10T09:15:00.000Z",
            consultation_price_cents:
              args.p_price_cents,
            consultation_currency: args.p_currency,
          },
        ],
        error: null,
      };
    }) as unknown as typeof supabaseAdmin.rpc;
  });

  const parsedBody = (
    extra: Record<string, unknown>,
  ) => {
    const parsed = createDraftConsultationSchema.safeParse(
      baseBody(extra),
    );

    assert.equal(parsed.success, true);

    return parsed.success ? parsed.data : never();
  };

  const never = (): never => {
    throw new Error("unreachable");
  };

  it("writes the source and price the SERVER decided", async () => {
    const result =
      await createDraftConsultationRecord({
        clientProfileId: CLIENT_PROFILE,
        scheduledEndAt: "2032-03-10T10:00:00.000Z",
        consultantId: CONSULTANT_ID,
        priceCents: 20_000,
        currency: "usd",
        bookingSource: "direct_booking",
        draft: parsedBody({
          consultant_slug: "aisha-rahman",
        }),
      });

    assert.equal(result.ok, true);

    const call = rpcCalls[0]!;

    assert.equal(
      call.name,
      "create_draft_consultation",
    );
    assert.equal(
      call.args.p_booking_source,
      "direct_booking",
    );
    assert.equal(call.args.p_price_cents, 20_000);
    assert.equal(
      call.args.p_consultant_id,
      CONSULTANT_ID,
    );
  });

  it("takes the consultant from the caller, never from the body", async () => {
    /*
     * The body here carries no consultant id at all — a direct
     * booking's request cannot. The id passed to the RPC is the
     * one the route resolved from the published page.
     */
    await createDraftConsultationRecord({
      clientProfileId: CLIENT_PROFILE,
      scheduledEndAt: "2032-03-10T10:00:00.000Z",
      consultantId: CONSULTANT_ID,
      priceCents: 20_000,
      currency: "usd",
      bookingSource: "direct_booking",
      draft: parsedBody({
        consultant_slug: "aisha-rahman",
      }),
    });

    assert.equal(
      rpcCalls[0]!.args.p_consultant_id,
      CONSULTANT_ID,
    );

    assert.notEqual(
      rpcCalls[0]!.args.p_consultant_id,
      ATTACKER_CONSULTANT_ID,
    );
  });

  it("still marks an ordinary booking standard", async () => {
    await createDraftConsultationRecord({
      clientProfileId: CLIENT_PROFILE,
      scheduledEndAt: "2032-03-10T10:00:00.000Z",
      consultantId: CONSULTANT_ID,
      priceCents: 15_000,
      currency: "usd",
      bookingSource: "standard",
      draft: parsedBody({
        consultant_id: CONSULTANT_ID,
      }),
    });

    assert.equal(
      rpcCalls[0]!.args.p_booking_source,
      "standard",
    );
    assert.equal(
      rpcCalls[0]!.args.p_price_cents,
      15_000,
    );
  });

  it("reports a double booking as SLOT_TAKEN, unchanged", async () => {
    /*
     * The double-booking protection is the exclusion the draft RPC
     * has always enforced, and a direct booking goes through the
     * same one — it is an ordinary consultation on the same
     * calendar. A regression that gave direct bookings their own
     * path would show up here.
     */
    supabaseAdmin.rpc = (async () => ({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "uq_consultations_consultant_slot"',
      },
    })) as unknown as typeof supabaseAdmin.rpc;

    const result =
      await createDraftConsultationRecord({
        clientProfileId: CLIENT_PROFILE,
        scheduledEndAt: "2032-03-10T10:00:00.000Z",
        consultantId: CONSULTANT_ID,
        priceCents: 20_000,
        currency: "usd",
        bookingSource: "direct_booking",
        draft: parsedBody({
          consultant_slug: "aisha-rahman",
        }),
      });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "SLOT_TAKEN",
    );
  });
});
