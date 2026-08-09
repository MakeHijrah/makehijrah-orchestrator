/*
 * Draft slot lifecycle: superseding and expiry.
 *
 * A draft consultation IS the slot hold — unique_reserved_consultant_
 * slot covers 'draft' — and until this build there were two ways for
 * one to be held forever:
 *
 *   a visitor went back and picked a different time, and nothing
 *   told the server the first draft was dead; and
 *
 *   a visitor closed the tab, and nothing ever expired the draft,
 *   because the expire-drafts job named in API_CONTRACT section 5
 *   was specified, indexed for, and never written until migration
 *   047 and the worker beside it.
 *
 * Both are closed here. The security question in the first is
 * whether a browser can release a draft it does not hold, and these
 * tests answer it from the attacker's side: a guessed id, a token
 * for a different consultation, and a booking that has advanced
 * past draft are each tried and each refused.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://draft-lifecycle-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_draft_lifecycle",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_draft_lifecycle",
  STRIPE_LIVE_SECRET_KEY: "sk_live_draft_lifecycle",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_draft_lifecycle",
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

const { createHash } = await import("node:crypto");
const { supabaseAdmin } = await import("../../lib/supabase.js");
const { redis } = await import("../../lib/redis.js");
const { DRAFT_HOLD_MINUTES } = await import("./draft-hold.js");
const {
  isSameSlot,
  releaseSupersededDraft,
  resolveSupersededDraft,
} = await import("./draft-supersede.service.js");
const { expireStaleDraftConsultations } = await import(
  "./draft-expiry.service.js"
);

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CONSULTANT_ID = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";

const DRAFT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAFT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADVANCED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UNKNOWN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const TOKEN_A = "token-for-draft-a";
const TOKEN_C = "token-for-draft-c";
const TOKEN_ADVANCED = "token-for-advanced";

const SLOT_A = "2033-01-10T09:00:00.000Z";
const SLOT_B = "2033-01-10T11:00:00.000Z";

type Row = Record<string, unknown>;

const db: { consultations: Row[] } = {
  consultations: [],
};

/*
 * The Redis capability store, reproduced faithfully: the key is a
 * sha256 of the token and the value names one consultation. That
 * binding is the authorisation, so a stub that ignored it would
 * make the security tests below meaningless.
 */
let capabilities = new Map<string, string>();

const capabilityKey = (token: string): string =>
  `booking-checkout:${createHash("sha256")
    .update(token)
    .digest("hex")}`;

let rpcCalls: Array<{
  name: string;
  args: Record<string, unknown>;
}> = [];

let expireRpcFails = false;

const minutesAgo = (minutes: number): string =>
  new Date(
    Date.now() - minutes * 60 * 1000,
  ).toISOString();

const installStubs = (): void => {
  rpcCalls = [];
  expireRpcFails = false;

  capabilities = new Map([
    [capabilityKey(TOKEN_A), DRAFT_A],
    [capabilityKey(TOKEN_C), DRAFT_C],
    [capabilityKey(TOKEN_ADVANCED), ADVANCED],
  ]);

  db.consultations = [
    {
      id: DRAFT_A,
      consultant_id: CONSULTANT_ID,
      scheduled_start_at: SLOT_A,
      status: "draft",
      price_cents: 9_700,
      currency: "usd",
      created_at: minutesAgo(2),
      cancelled_at: null,
    },
    {
      id: DRAFT_C,
      consultant_id: OTHER_CONSULTANT_ID,
      scheduled_start_at: SLOT_B,
      status: "draft",
      price_cents: 9_700,
      currency: "usd",
      created_at: minutesAgo(2),
      cancelled_at: null,
    },
    {
      id: ADVANCED,
      consultant_id: CONSULTANT_ID,
      scheduled_start_at: "2033-02-01T09:00:00.000Z",
      status: "confirmed",
      price_cents: 9_700,
      currency: "usd",
      created_at: minutesAgo(120),
      cancelled_at: null,
    },
  ];

  redis.get = (async (key: string) => {
    const consultationId = capabilities.get(key);

    return consultationId
      ? JSON.stringify({
          consultation_id: consultationId,
        })
      : null;
  }) as unknown as typeof redis.get;

  redis.del = (async (key: string) =>
    capabilities.delete(key)
      ? 1
      : 0) as unknown as typeof redis.del;

  supabaseAdmin.from = ((table: string) => {
    const query = {
      _filters: [] as Array<(row: Row) => boolean>,
      _columns: [] as string[],
      select(columns?: string) {
        this._columns = (columns ?? "")
          .split(",")
          .map((column) => column.trim())
          .filter(Boolean);

        return this;
      },
      eq(column: string, value: unknown) {
        this._filters.push(
          (row) => row[column] === value,
        );

        return this;
      },
      async maybeSingle() {
        const rows = (
          table === "consultations"
            ? db.consultations
            : []
        ).filter((row) =>
          this._filters.every((matches) =>
            matches(row),
          ),
        );

        const row = rows[0];

        if (!row) {
          return { data: null, error: null };
        }

        if (this._columns.length === 0) {
          return { data: { ...row }, error: null };
        }

        const projected: Row = {};

        for (const column of this._columns) {
          projected[column] = row[column];
        }

        return { data: projected, error: null };
      },
    };

    return query;
  }) as unknown as typeof supabaseAdmin.from;

  supabaseAdmin.rpc = (async (
    name: string,
    args: Record<string, unknown>,
  ) => {
    rpcCalls.push({ name, args });

    if (name === "abandon_draft_consultation") {
      const row = db.consultations.find(
        (entry) =>
          entry.id === args.p_consultation_id,
      );

      /* The database's guard: id AND status = 'draft'. */
      if (!row) {
        return {
          data: [
            {
              consultation_id:
                args.p_consultation_id,
              cancelled: false,
              reason: "not_found",
            },
          ],
          error: null,
        };
      }

      if (row.status !== "draft") {
        return {
          data: [
            {
              consultation_id: row.id,
              cancelled: false,
              reason: "not_draft",
            },
          ],
          error: null,
        };
      }

      row.status = "cancelled";
      row.cancelled_at = new Date().toISOString();

      return {
        data: [
          {
            consultation_id: row.id,
            cancelled: true,
            reason: "cancelled",
          },
        ],
        error: null,
      };
    }

    if (
      name === "expire_stale_draft_consultations"
    ) {
      if (expireRpcFails) {
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

      const limit = Math.max(
        1,
        Math.min(
          (args.p_limit as number) ?? 200,
          1_000,
        ),
      );

      const cutoff =
        Date.now() -
        DRAFT_HOLD_MINUTES * 60 * 1000;

      /* status = 'draft' AND created_at <= cutoff, oldest first. */
      const stale = db.consultations
        .filter(
          (row) =>
            row.status === "draft" &&
            Date.parse(
              row.created_at as string,
            ) <= cutoff,
        )
        .sort(
          (a, b) =>
            Date.parse(a.created_at as string) -
            Date.parse(b.created_at as string),
        )
        .slice(0, limit);

      for (const row of stale) {
        row.status = "cancelled";
        row.cancelled_at =
          new Date().toISOString();
      }

      return {
        data: stale.map((row) => ({
          consultation_id: row.id,
          consultant_id: row.consultant_id,
          scheduled_start_at:
            row.scheduled_start_at,
        })),
        error: null,
      };
    }

    return {
      data: null,
      error: { message: "unknown rpc" },
    };
  }) as unknown as typeof supabaseAdmin.rpc;
};

const statusOf = (id: string): unknown =>
  db.consultations.find(
    (row) => row.id === id,
  )?.status;

const isSlotHeld = (
  consultantId: string,
  startAt: string,
): boolean =>
  db.consultations.some(
    (row) =>
      row.consultant_id === consultantId &&
      row.scheduled_start_at === startAt &&
      [
        "draft",
        "payment_authorized",
        "pending_acceptance",
        "confirmed",
        "captured",
      ].includes(row.status as string),
  );

beforeEach(() => {
  installStubs();
});

describe("Superseding a held draft", () => {
  it("resolves a claim backed by the right token", async () => {
    const resolved = await resolveSupersededDraft({
      consultationId: DRAFT_A,
      checkoutToken: TOKEN_A,
    });

    assert.equal(resolved.ok, true);

    if (!resolved.ok) {
      return;
    }

    assert.equal(
      resolved.draft.consultationId,
      DRAFT_A,
    );
    assert.equal(
      resolved.draft.consultantId,
      CONSULTANT_ID,
    );

    /* Resolving READS. Nothing has been released yet. */
    assert.equal(statusOf(DRAFT_A), "draft");
    assert.equal(rpcCalls.length, 0);
    assert.equal(
      capabilities.has(capabilityKey(TOKEN_A)),
      true,
    );
  });

  it("releases the draft and frees its slot", async () => {
    const release = await releaseSupersededDraft({
      consultationId: DRAFT_A,
      checkoutToken: TOKEN_A,
    });

    assert.equal(release.released, true);
    assert.equal(release.reason, "cancelled");

    assert.equal(statusOf(DRAFT_A), "cancelled");

    /*
     * 'cancelled' is outside unique_reserved_consultant_slot's
     * status list, so the slot is bookable immediately.
     */
    assert.equal(
      isSlotHeld(CONSULTANT_ID, SLOT_A),
      false,
    );
  });

  it("consumes the capability so it cannot be replayed", async () => {
    await releaseSupersededDraft({
      consultationId: DRAFT_A,
      checkoutToken: TOKEN_A,
    });

    assert.equal(
      capabilities.has(capabilityKey(TOKEN_A)),
      false,
    );

    /* And the token no longer resolves anything. */
    const again = await resolveSupersededDraft({
      consultationId: DRAFT_A,
      checkoutToken: TOKEN_A,
    });

    assert.equal(again.ok, false);
    assert.equal(
      again.ok === false && again.reason,
      "token_invalid",
    );
  });
});

describe("Supersede authorization", () => {
  it("refuses a consultation id with no token behind it", async () => {
    /*
     * The attack the design exists to stop: name somebody else's
     * consultation and hope the id is enough. It never is.
     */
    const resolved = await resolveSupersededDraft({
      consultationId: DRAFT_C,
      checkoutToken: "guessed-token",
    });

    assert.equal(resolved.ok, false);
    assert.equal(
      resolved.ok === false && resolved.reason,
      "token_invalid",
    );

    assert.equal(statusOf(DRAFT_C), "draft");
  });

  it("refuses a token belonging to a DIFFERENT consultation", async () => {
    /*
     * TOKEN_C is genuine — it is simply bound to draft C. Holding
     * one valid capability must not release another visitor's
     * draft.
     */
    const resolved = await resolveSupersededDraft({
      consultationId: DRAFT_A,
      checkoutToken: TOKEN_C,
    });

    assert.equal(resolved.ok, false);
    assert.equal(
      resolved.ok === false && resolved.reason,
      "token_invalid",
    );

    const release = await releaseSupersededDraft({
      consultationId: DRAFT_A,
      checkoutToken: TOKEN_C,
    });

    assert.equal(release.released, false);
    assert.equal(statusOf(DRAFT_A), "draft");
    assert.equal(statusOf(DRAFT_C), "draft");
  });

  it("refuses a consultation that has advanced past draft", async () => {
    /*
     * A genuine token for a genuine consultation — which is now
     * confirmed. A real booking is not disposable because its
     * token happens to still be in Redis.
     */
    const resolved = await resolveSupersededDraft({
      consultationId: ADVANCED,
      checkoutToken: TOKEN_ADVANCED,
    });

    assert.equal(resolved.ok, false);
    assert.equal(
      resolved.ok === false && resolved.reason,
      "not_draft",
    );

    /* And even a direct release cannot touch it. */
    const release = await releaseSupersededDraft({
      consultationId: ADVANCED,
      checkoutToken: TOKEN_ADVANCED,
    });

    assert.equal(release.released, false);
    assert.equal(release.reason, "not_draft");
    assert.equal(statusOf(ADVANCED), "confirmed");
  });

  it("refuses an unknown consultation", async () => {
    const resolved = await resolveSupersededDraft({
      consultationId: UNKNOWN,
      checkoutToken: TOKEN_A,
    });

    /*
     * The token is checked first, so a guessed id is refused
     * before any lookup happens — a caller learns nothing about
     * which consultation ids exist.
     */
    assert.equal(resolved.ok, false);
    assert.equal(
      resolved.ok === false && resolved.reason,
      "token_invalid",
    );
  });

  it("does not revive a draft whose hold has expired", async () => {
    const draft = db.consultations.find(
      (row) => row.id === DRAFT_A,
    )!;

    draft.created_at = minutesAgo(31);

    const resolved = await resolveSupersededDraft({
      consultationId: DRAFT_A,
      checkoutToken: TOKEN_A,
    });

    assert.equal(resolved.ok, false);
    assert.equal(
      resolved.ok === false && resolved.reason,
      "hold_expired",
    );
  });
});

describe("Same-slot reselection", () => {
  const heldDraft = {
    consultationId: DRAFT_A,
    consultantId: CONSULTANT_ID,
    scheduledStartAt: SLOT_A,
    status: "draft",
    priceCents: 9_700,
    currency: "usd",
    createdAt: minutesAgo(2),
    holdExpiresAt: new Date(
      Date.now() + 28 * 60 * 1000,
    ).toISOString(),
  };

  it("recognises the same slot however the timestamp is written", () => {
    assert.equal(
      isSameSlot({
        draft: heldDraft,
        consultantId: CONSULTANT_ID,
        startAt: SLOT_A,
      }),
      true,
    );

    /*
     * The request carries an ISO string and the database returns
     * its own rendering of the same instant. Compared as moments,
     * not as text.
     */
    assert.equal(
      isSameSlot({
        draft: {
          ...heldDraft,
          scheduledStartAt:
            "2033-01-10 09:00:00+00",
        },
        consultantId: CONSULTANT_ID,
        startAt: SLOT_A,
      }),
      true,
    );
  });

  it("does not treat a different time or consultant as the same slot", () => {
    assert.equal(
      isSameSlot({
        draft: heldDraft,
        consultantId: CONSULTANT_ID,
        startAt: SLOT_B,
      }),
      false,
    );

    assert.equal(
      isSameSlot({
        draft: heldDraft,
        consultantId: OTHER_CONSULTANT_ID,
        startAt: SLOT_A,
      }),
      false,
    );
  });
});

describe("Draft expiry", () => {
  it("expires a draft past its hold and frees the slot", async () => {
    const draft = db.consultations.find(
      (row) => row.id === DRAFT_A,
    )!;

    draft.created_at = minutesAgo(31);

    const result =
      await expireStaleDraftConsultations(200);

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.deepEqual(
      result.expired.map(
        (entry) => entry.consultationId,
      ),
      [DRAFT_A],
    );

    /* The worker logs these; they must be populated. */
    assert.equal(
      result.expired[0]!.consultantId,
      CONSULTANT_ID,
    );
    assert.equal(
      result.expired[0]!.scheduledStartAt,
      SLOT_A,
    );

    assert.equal(statusOf(DRAFT_A), "cancelled");
    assert.equal(
      isSlotHeld(CONSULTANT_ID, SLOT_A),
      false,
    );
  });

  it("leaves a draft inside its hold alone", async () => {
    const result =
      await expireStaleDraftConsultations(200);

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.expired.length,
      0,
    );

    assert.equal(statusOf(DRAFT_A), "draft");
    assert.equal(statusOf(DRAFT_C), "draft");
  });

  it("never touches a consultation past draft", async () => {
    const advanced = db.consultations.find(
      (row) => row.id === ADVANCED,
    )!;

    /* Two hours old, and confirmed. Age alone must not matter. */
    advanced.created_at = minutesAgo(120);

    await expireStaleDraftConsultations(200);

    assert.equal(statusOf(ADVANCED), "confirmed");
  });

  it("is idempotent across reruns", async () => {
    for (const row of db.consultations) {
      if (row.status === "draft") {
        row.created_at = minutesAgo(45);
      }
    }

    const first =
      await expireStaleDraftConsultations(200);

    const second =
      await expireStaleDraftConsultations(200);

    assert.equal(
      first.ok && first.expired.length,
      2,
    );
    assert.equal(
      second.ok && second.expired.length,
      0,
    );
  });

  it("reports a full batch so the worker keeps going", async () => {
    for (const row of db.consultations) {
      if (row.status === "draft") {
        row.created_at = minutesAgo(45);
      }
    }

    const limited =
      await expireStaleDraftConsultations(1);

    assert.equal(limited.ok, true);
    assert.equal(
      limited.ok && limited.expired.length,
      1,
    );
    assert.equal(
      limited.ok && limited.batchFull,
      true,
    );

    const rest =
      await expireStaleDraftConsultations(200);

    assert.equal(
      rest.ok && rest.expired.length,
      1,
    );
    assert.equal(rest.ok && rest.batchFull, false);
  });

  it("reports a failure rather than throwing", async () => {
    expireRpcFails = true;

    const result =
      await expireStaleDraftConsultations(200);

    assert.equal(result.ok, false);

    /* The worker is on a timer; the next tick retries. */
    assert.equal(statusOf(DRAFT_A), "draft");
  });
});
