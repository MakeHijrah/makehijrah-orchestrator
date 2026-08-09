/*
 * Draft preparation and slot compensation.
 *
 * These tests exist because of a live outage. Migration 045
 * replaced create_draft_consultation and changed its return
 * contract from five columns to two. The orchestrator reads
 * hold_expires_at off that row and turns it into the TTL of the
 * Redis checkout capability; a missing column read as undefined,
 * Date.parse gave NaN, the TTL was refused, and every booking
 * answered 500 — AFTER inserting a consultation that then held
 * its slot forever, because nothing in the system reclaims an
 * abandoned draft.
 *
 * Both halves of that failure are asserted here:
 *
 *   the SHAPE the repository consumes, so a contract change is
 *   caught at the boundary rather than three files away; and
 *
 *   the COMPENSATION, so a failure after the insert releases the
 *   slot instead of consuming a consultant's calendar one retry
 *   at a time.
 *
 * The stubs deliberately reproduce the real RPC's row, including
 * the broken two-column form. A stub that only ever returned what
 * the code expected is what let this ship.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://draft-preparation-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_draft_preparation",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_draft_preparation",
  STRIPE_LIVE_SECRET_KEY: "sk_live_draft_preparation",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_draft_preparation",
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
const { redis } = await import("../../lib/redis.js");
const { createDraftConsultationSchema } = await import(
  "./draft.schema.js"
);
const { prepareDraftConsultation } = await import(
  "./draft-preparation.service.js"
);
const { createHash } = await import("node:crypto");
const { default: Fastify } = await import("fastify");
const { registerDraftConsultationRoute } = await import(
  "./draft.route.js"
);

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_PROFILE = "22222222-2222-4222-8222-222222222222";
const COUNTRY_ID = "99999999-9999-4999-8999-999999999999";
const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const SUPERSEDED_ID = "77777777-7777-4777-8777-777777777777";
const SUPERSEDED_TOKEN = "token-for-the-superseded-draft";

type RpcCall = {
  name: string;
  args: Record<string, unknown>;
};

let rpcCalls: RpcCall[] = [];
let redisSets: Array<{ key: string; ttl: unknown }> = [];

/*
 * How the draft RPC behaves this run.
 *
 *   "restored"  the five-column contract migration 046 restores
 *   "broken"    the two-column contract migration 045 shipped
 *   "duplicate" the unique index refusing a taken slot
 */
let draftRpcMode:
  | "restored"
  | "broken"
  | "duplicate" = "restored";

/* Whether abandon_draft_consultation itself works this run. */
let cleanupMode: "works" | "fails" = "works";

/* Whether the Redis capability write works this run. */
let redisMode: "works" | "fails" = "works";

/* Whether releasing the superseded draft works this run. */
let releaseMode: "works" | "fails" = "works";

let capabilities = new Map<string, string>();

const installStubs = (): void => {
  rpcCalls = [];
  redisSets = [];
  draftRpcMode = "restored";
  cleanupMode = "works";
  redisMode = "works";
  releaseMode = "works";

  supabaseAdmin.rpc = (async (
    name: string,
    args: Record<string, unknown>,
  ) => {
    rpcCalls.push({ name, args });

    if (name === "create_draft_consultation") {
      if (draftRpcMode === "duplicate") {
        return {
          data: null,
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "unique_reserved_consultant_slot"',
            details: null,
            hint: null,
          },
        };
      }

      if (draftRpcMode === "broken") {
        /*
         * Exactly what migration 045 returned. The row is real and
         * the consultation exists; four of the five columns simply
         * are not there.
         */
        return {
          data: [
            {
              consultation_id: CONSULTATION_ID,
              created_at:
                "2032-03-10T09:00:00.000Z",
            },
          ],
          error: null,
        };
      }

      return {
        data: [
          {
            consultation_id: CONSULTATION_ID,
            consultation_status: "draft",
            hold_expires_at:
              new Date(
                Date.now() + 30 * 60 * 1000,
              ).toISOString(),
            consultation_price_cents:
              args.p_price_cents,
            consultation_currency:
              args.p_currency,
          },
        ],
        error: null,
      };
    }

    if (name === "abandon_draft_consultation") {
      if (cleanupMode === "fails") {
        return {
          data: null,
          error: {
            code: "57014",
            message: "statement timeout",
            details: null,
            hint: null,
          },
        };
      }

      return {
        data: [
          {
            consultation_id:
              args.p_consultation_id,
            cancelled: true,
            reason: "cancelled",
          },
        ],
        error: null,
      };
    }

    return { data: null, error: { message: "unknown rpc" } };
  }) as unknown as typeof supabaseAdmin.rpc;

  redis.set = (async (
    key: string,
    _value: string,
    _mode: string,
    ttl: number,
  ) => {
    if (redisMode === "fails") {
      throw new Error(
        "Connection is closed.",
      );
    }

    redisSets.push({ key, ttl });

    return "OK";
  }) as unknown as typeof redis.set;

  /*
   * The capability store for the draft being superseded, keyed the
   * way the real one is: sha256 of the token, naming exactly one
   * consultation.
   */
  capabilities = new Map([
    [
      `booking-checkout:${createHash("sha256")
        .update(SUPERSEDED_TOKEN)
        .digest("hex")}`,
      SUPERSEDED_ID,
    ],
  ]);

  redis.get = (async (key: string) => {
    const consultationId =
      capabilities.get(key);

    return consultationId
      ? JSON.stringify({
          consultation_id: consultationId,
        })
      : null;
  }) as unknown as typeof redis.get;

  redis.del = (async (key: string) => {
    if (releaseMode === "fails") {
      return 0;
    }

    return capabilities.delete(key) ? 1 : 0;
  }) as unknown as typeof redis.del;
};

const parsedDraft = (
  extra: Record<string, unknown>,
) => {
  const parsed = createDraftConsultationSchema.safeParse({
    country_id: COUNTRY_ID,
    start_at: "2032-03-10T09:00:00.000Z",
    client_timezone: "Europe/Istanbul",
    intake: {
      full_name: "A Client",
      email: "client@example.test",
      phone_whatsapp: null,
      answers: {
        consultation_summary:
          "Moving with two children.",
        client_gender: "female",
        preferred_consultant_gender: "female",
      },
    },
    ...extra,
  });

  assert.equal(parsed.success, true);

  if (!parsed.success) {
    throw new Error("unreachable");
  }

  return parsed.data;
};

const prepare = (
  overrides: Partial<{
    priceCents: number;
    bookingSource: "standard" | "direct_booking";
    extra: Record<string, unknown>;
    supersedes: {
      consultationId: string;
      checkoutToken: string;
    } | null;
  }> = {},
) =>
  prepareDraftConsultation({
    clientProfileId: CLIENT_PROFILE,
    scheduledEndAt: "2032-03-10T10:00:00.000Z",
    consultantId: CONSULTANT_ID,
    priceCents: overrides.priceCents ?? 9_700,
    currency: "usd",
    bookingSource:
      overrides.bookingSource ?? "standard",
    draft: parsedDraft(
      overrides.extra ?? {
        consultant_id: CONSULTANT_ID,
      },
    ),
    supersedes:
      overrides.supersedes ?? null,
  });

const supersedeClaim = {
  consultationId: SUPERSEDED_ID,
  checkoutToken: SUPERSEDED_TOKEN,
};

const abandonCalls = (): RpcCall[] =>
  rpcCalls.filter(
    (call) =>
      call.name === "abandon_draft_consultation",
  );

const cleanupCalls = (): RpcCall[] =>
  rpcCalls.filter(
    (call) =>
      call.name === "abandon_draft_consultation",
  );

beforeEach(() => {
  installStubs();
});

describe("Draft RPC contract", () => {
  it("consumes the restored five-column shape", async () => {
    const result = await prepare();

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.equal(
      result.draft.consultationId,
      CONSULTATION_ID,
    );
    assert.equal(result.draft.status, "draft");
    assert.equal(result.draft.priceCents, 9_700);
    assert.equal(result.draft.currency, "usd");
    assert.ok(result.draft.holdExpiresAt);
    assert.ok(result.checkoutToken);

    /*
     * And hold_expires_at really did become the capability's TTL.
     * A thirty-minute hold is a TTL a little under 1800 seconds.
     */
    assert.equal(redisSets.length, 1);
    assert.ok(
      (redisSets[0]!.ttl as number) > 1_700 &&
        (redisSets[0]!.ttl as number) <= 1_800,
      `TTL was ${redisSets[0]!.ttl}`,
    );
  });

  it("refuses the broken two-column shape instead of failing four files later", async () => {
    draftRpcMode = "broken";

    const result = await prepare();

    assert.equal(result.ok, false);

    if (result.ok) {
      return;
    }

    assert.equal(result.code, "INTERNAL_ERROR");
    assert.equal(
      result.cause,
      "draft_contract_mismatch",
    );

    /*
     * The whole point: the row that WAS created does not keep
     * holding its slot. This is the shape migration 045 shipped,
     * and it consumed every slot a consultant had.
     */
    assert.equal(
      result.cleanup.attempted,
      true,
    );
    assert.equal(result.cleanup.released, true);
    assert.equal(
      result.cleanup.consultationId,
      CONSULTATION_ID,
    );

    /* No capability was written for an unusable row. */
    assert.equal(redisSets.length, 0);
  });
});

describe("Slot compensation", () => {
  it("releases the slot when the checkout capability fails", async () => {
    redisMode = "fails";

    const result = await prepare();

    assert.equal(result.ok, false);

    if (result.ok) {
      return;
    }

    assert.equal(result.code, "INTERNAL_ERROR");
    assert.equal(
      result.cause,
      "checkout_capability_failed",
    );
    assert.equal(
      result.message,
      "The booking could not be prepared for payment.",
    );

    assert.deepEqual(
      cleanupCalls().map(
        (call) => call.args.p_consultation_id,
      ),
      [CONSULTATION_ID],
    );

    assert.equal(result.cleanup.released, true);
  });

  it("cleans up ONLY the consultation that request created", async () => {
    redisMode = "fails";

    await prepare();

    /*
     * One call, naming one id. The RPC additionally matches on
     * status = 'draft', so even this call cannot touch a booking
     * that has advanced — but the orchestrator must not be asking
     * about anything else in the first place.
     */
    assert.equal(cleanupCalls().length, 1);
    assert.equal(
      cleanupCalls()[0]!.args
        .p_consultation_id,
      CONSULTATION_ID,
    );
  });

  it("does not let a failed cleanup replace the original error", async () => {
    redisMode = "fails";
    cleanupMode = "fails";

    const result = await prepare();

    assert.equal(result.ok, false);

    if (result.ok) {
      return;
    }

    /*
     * The client hears about the failure that stopped their
     * booking, not about the cleanup of it. A cleanup problem is
     * an operational matter — that slot is now stuck and the log
     * says so — and it must not change the answer.
     */
    assert.equal(result.code, "INTERNAL_ERROR");
    assert.equal(
      result.message,
      "The booking could not be prepared for payment.",
    );
    assert.equal(
      result.cause,
      "checkout_capability_failed",
    );

    assert.equal(
      result.cleanup.attempted,
      true,
    );
    assert.equal(
      result.cleanup.released,
      false,
    );
    assert.equal(
      result.cleanup.reason,
      "cleanup_failed",
    );
  });

  it("never cleans up when preparation succeeded", async () => {
    const result = await prepare();

    assert.equal(result.ok, true);
    assert.deepEqual(cleanupCalls(), []);
  });

  it("never cleans up when the slot was already taken", async () => {
    draftRpcMode = "duplicate";

    const result = await prepare();

    assert.equal(result.ok, false);

    if (result.ok) {
      return;
    }

    /*
     * A 23505 means the insert was REFUSED, so no row of ours
     * exists. The consultation occupying that slot belongs to
     * somebody else, and cancelling it would be cancelling their
     * booking.
     */
    assert.equal(result.code, "SLOT_TAKEN");
    assert.equal(
      result.cause,
      "draft_slot_taken",
    );
    assert.equal(
      result.cleanup.attempted,
      false,
    );
    assert.deepEqual(cleanupCalls(), []);
  });
});

describe("Booking source is unaffected", () => {
  it("still records a generic booking as standard", async () => {
    const result = await prepare();

    assert.equal(result.ok, true);

    const call = rpcCalls.find(
      (entry) =>
        entry.name === "create_draft_consultation",
    )!;

    assert.equal(
      call.args.p_booking_source,
      "standard",
    );
    assert.equal(call.args.p_price_cents, 9_700);
  });

  it("still records a direct booking as direct_booking", async () => {
    const result = await prepare({
      bookingSource: "direct_booking",
      priceCents: 20_000,
      extra: { consultant_slug: "aisha-rahman" },
    });

    assert.equal(result.ok, true);

    const call = rpcCalls.find(
      (entry) =>
        entry.name === "create_draft_consultation",
    )!;

    assert.equal(
      call.args.p_booking_source,
      "direct_booking",
    );
    assert.equal(
      call.args.p_price_cents,
      20_000,
    );
    assert.equal(
      call.args.p_consultant_id,
      CONSULTANT_ID,
    );
  });
});


describe("Superseding, and its ordering", () => {
  it("releases the previous draft only after the new one is usable", async () => {
    const result = await prepare({
      supersedes: supersedeClaim,
    });

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.equal(
      result.supersede.attempted,
      true,
    );
    assert.equal(
      result.supersede.released,
      true,
    );
    assert.equal(
      result.supersede.consultationId,
      SUPERSEDED_ID,
    );

    /* The old draft's capability is consumed, not left live. */
    assert.equal(capabilities.size, 0);

    /*
     * And the ordering, read off the call log: the replacement was
     * inserted, its capability written, and only then was the old
     * draft cancelled.
     */
    assert.equal(
      rpcCalls[0]!.name,
      "create_draft_consultation",
    );
    assert.equal(redisSets.length, 1);
    assert.deepEqual(
      abandonCalls().map(
        (call) => call.args.p_consultation_id,
      ),
      [SUPERSEDED_ID],
    );
  });

  it("leaves the previous draft intact when the new one cannot be created", async () => {
    draftRpcMode = "duplicate";

    const result = await prepare({
      supersedes: supersedeClaim,
    });

    assert.equal(result.ok, false);

    /*
     * The visitor still holds their original booking. Releasing it
     * first and then failing would have left them with nothing,
     * and with a slot somebody else can now take.
     */
    assert.deepEqual(abandonCalls(), []);
    assert.equal(capabilities.size, 1);
  });

  it("leaves the previous draft intact when the new one has no capability", async () => {
    redisMode = "fails";

    const result = await prepare({
      supersedes: supersedeClaim,
    });

    assert.equal(result.ok, false);

    /*
     * One abandon call, and it is for the REPLACEMENT — migration
     * 046's compensation releasing the row it just created. The
     * superseded draft is untouched.
     */
    assert.deepEqual(
      abandonCalls().map(
        (call) => call.args.p_consultation_id,
      ),
      [CONSULTATION_ID],
    );

    assert.equal(capabilities.size, 1);
  });

  it("leaves the previous draft intact when the new row is unusable", async () => {
    draftRpcMode = "broken";

    const result = await prepare({
      supersedes: supersedeClaim,
    });

    assert.equal(result.ok, false);

    assert.deepEqual(
      abandonCalls().map(
        (call) => call.args.p_consultation_id,
      ),
      [CONSULTATION_ID],
    );

    assert.equal(capabilities.size, 1);
  });

  it("still returns the new booking when releasing the old one fails", async () => {
    releaseMode = "fails";

    const result = await prepare({
      supersedes: supersedeClaim,
    });

    /*
     * The replacement succeeded, so the visitor is told it
     * succeeded. The old draft keeps its slot until the expiry
     * worker reclaims it within thirty minutes — that backstop is
     * what lets this path fail safely instead of failing loudly.
     */
    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.equal(
      result.draft.consultationId,
      CONSULTATION_ID,
    );
    assert.ok(result.checkoutToken);
    assert.equal(
      result.supersede.attempted,
      true,
    );
    assert.equal(
      result.supersede.released,
      false,
    );
  });

  it("releases nothing when no previous draft was claimed", async () => {
    const result = await prepare();

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.supersede.attempted,
      false,
    );
    assert.deepEqual(abandonCalls(), []);
  });
});

describe("Public draft rate limit", () => {
  it("is still five per minute", async () => {
    /*
     * Read off the REGISTERED route rather than the source, so a
     * change to the config is caught here. This build deliberately
     * added no anti-abuse controls: the protections are that
     * superseded holds are released immediately and abandoned ones
     * expire at thirty minutes.
     */
    const app = Fastify();

    let draftRouteConfig: unknown = null;

    app.addHook("onRoute", (route) => {
      if (
        route.url ===
          "/api/consultations/draft" &&
        route.method === "POST"
      ) {
        draftRouteConfig = (
          route.config as
            | { rateLimit?: unknown }
            | undefined
        )?.rateLimit;
      }
    });

    await registerDraftConsultationRoute(app);
    await app.ready();

    assert.deepEqual(draftRouteConfig, {
      max: 5,
      timeWindow: "1 minute",
    });

    await app.close();
  });
});
