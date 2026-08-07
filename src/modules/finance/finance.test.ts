/*
 * Financial write path tests. Phase 1 finance build.
 *
 * Nothing external is contacted. Supabase is an in-memory fake,
 * including fakes for all seven migration 035 RPCs that reproduce
 * their contracts: the same FINANCE_* markers, the same
 * idempotency, the same allocation and release behaviour, and the
 * same refusal to touch a paid payout.
 *
 * Those fakes are not guesses. Each one mirrors behaviour that
 * was executed against PostgreSQL 16 before it was written here,
 * which is what lets these tests assert the real contract without
 * a database.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://finance-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_finance",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_finance",
  STRIPE_LIVE_SECRET_KEY: "sk_live_finance",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_finance",
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
const { registerConsultantPayoutRoute } = await import(
  "./consultant-payout.route.js"
);
const { registerAdminFinanceRoutes } = await import(
  "./admin-finance.route.js"
);
const {
  syncConsultationEarning,
  reverseConsultationEarning,
} = await import("./finance.service.js");

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CONSULTANT_PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
const CLIENT_PROFILE = "22222222-2222-4222-8222-222222222222";
const ADMIN_PROFILE = "33333333-3333-4333-8333-333333333333";

const CONSULTANT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CONSULTANT_ID = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";

const CAPTURED_ONLY = "55555555-5555-4555-8555-555555555555";
const COMPLETED_UNCAPTURED = "66666666-6666-4666-8666-666666666666";
const COMPLETED_CAPTURED = "77777777-7777-4777-8777-777777777777";

const COMMISSION_BPS = 5000;

type Row = Record<string, unknown>;

const db: {
  profiles: Row[];
  consultants: Row[];
  consultations: Row[];
  app_settings: Row[];
  consultant_ledger_entries: Row[];
  payouts: Row[];
  payout_allocations: Row[];
} = {
  profiles: [],
  consultants: [],
  consultations: [],
  app_settings: [],
  consultant_ledger_entries: [],
  payouts: [],
  payout_allocations: [],
};

const tableRows = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

let idCounter = 0;
const nextId = (): string => {
  idCounter += 1;
  const suffix = String(idCounter).padStart(12, "0");
  return `99999999-9999-4999-8999-${suffix}`;
};

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
    this.filters.push((row) => row[column] === value);
    return this;
  }

  private rows(): Row[] {
    return tableRows(this.table).filter((row) =>
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
    const profile = db.profiles.find((row) => row.id === token);
    if (!profile) {
      return {
        data: { user: null },
        error: { message: "invalid token" },
      };
    }
    return { data: { user: { id: profile.id } }, error: null };
  },
} as unknown as typeof supabaseAdmin.auth;

const fail = (marker: string) => ({
  data: null,
  error: { message: `${marker}: raised by fake`, code: "P0001" },
});

const ok = (row: Row) => ({ data: [row], error: null });

const isAdmin = (profileId: unknown): boolean =>
  db.profiles.some(
    (row) => row.id === profileId && row.role === "admin",
  );

const consultationEarning = (consultationId: unknown): Row | undefined =>
  db.consultant_ledger_entries.find(
    (row) =>
      row.entry_type === "earning" &&
      row.source_type === "consultation" &&
      row.source_id === consultationId &&
      row.source_component === "full",
  );

const isAllocated = (entryId: unknown): boolean =>
  db.payout_allocations.some(
    (row) => row.ledger_entry_id === entryId,
  );

/*
 * Faithful in-memory stand-in for migration 035. Same markers,
 * same ordering, same idempotency.
 */
const fakeRpc = async (
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: Row[] | null; error: unknown }> => {
  switch (name) {
    case "record_consultation_earning": {
      const consultation = db.consultations.find(
        (row) => row.id === args.p_consultation_id,
      );

      if (!consultation) {
        return fail("FINANCE_CONSULTATION_NOT_FOUND");
      }

      const existing = consultationEarning(
        args.p_consultation_id,
      );

      /* Checked before capture, so a repeat call stays a no-op. */
      if (existing) {
        return ok({
          entry_id: existing.id,
          created: false,
          gross_amount_minor: existing.gross_amount_minor,
          consultant_amount_minor:
            existing.consultant_amount_minor,
          platform_amount_minor: existing.platform_amount_minor,
          commission_bps: existing.commission_bps,
          currency: existing.currency,
          available_at: existing.available_at,
        });
      }

      if (!consultation.captured_at) {
        return fail("FINANCE_CONSULTATION_NOT_CAPTURED");
      }

      const gross = consultation.price_cents as number;

      if (!gross || gross <= 0) {
        return fail("FINANCE_CONSULTATION_AMOUNT_INVALID");
      }

      const bps = db.app_settings[0]
        ?.consultation_consultant_commission_bps as
        | number
        | undefined;

      if (bps === undefined) {
        return fail("FINANCE_SETTINGS_MISSING");
      }

      const consultantAmount = Math.round((gross * bps) / 10000);

      const entry: Row = {
        id: nextId(),
        consultant_id: consultation.consultant_id,
        entry_type: "earning",
        source_type: "consultation",
        source_id: consultation.id,
        source_component: "full",
        gross_amount_minor: gross,
        consultant_amount_minor: consultantAmount,
        platform_amount_minor: gross - consultantAmount,
        commission_bps: bps,
        commission_basis: "standard_50_50",
        currency: consultation.currency,
        available_at: null,
        reverses_entry_id: null,
        memo: null,
      };

      db.consultant_ledger_entries.push(entry);

      return ok({
        entry_id: entry.id,
        created: true,
        gross_amount_minor: entry.gross_amount_minor,
        consultant_amount_minor: entry.consultant_amount_minor,
        platform_amount_minor: entry.platform_amount_minor,
        commission_bps: entry.commission_bps,
        currency: entry.currency,
        available_at: null,
      });
    }

    case "release_consultation_earning": {
      const consultation = db.consultations.find(
        (row) => row.id === args.p_consultation_id,
      );

      if (!consultation) {
        return fail("FINANCE_CONSULTATION_NOT_FOUND");
      }

      const entry = consultationEarning(
        args.p_consultation_id,
      );

      if (!entry) {
        return ok({
          entry_id: null,
          released: false,
          reason: "no_entry",
          available_at: null,
        });
      }

      if (entry.available_at) {
        return ok({
          entry_id: entry.id,
          released: false,
          reason: "already_available",
          available_at: entry.available_at,
        });
      }

      if (!consultation.captured_at) {
        return ok({
          entry_id: entry.id,
          released: false,
          reason: "not_captured",
          available_at: null,
        });
      }

      if (
        consultation.status !== "completed" ||
        !consultation.completed_at
      ) {
        return ok({
          entry_id: entry.id,
          released: false,
          reason: "not_completed",
          available_at: null,
        });
      }

      const now = new Date().toISOString();
      entry.available_at = now;

      return ok({
        entry_id: entry.id,
        released: true,
        reason: "released",
        available_at: now,
      });
    }

    case "reverse_ledger_entry": {
      const reason = String(args.p_reason ?? "").trim();

      if (!reason) {
        return fail("FINANCE_REASON_REQUIRED");
      }

      const original = db.consultant_ledger_entries.find(
        (row) => row.id === args.p_entry_id,
      );

      if (!original) {
        return fail("FINANCE_ENTRY_NOT_FOUND");
      }

      if (original.entry_type !== "earning") {
        return fail("FINANCE_ENTRY_NOT_REVERSIBLE");
      }

      const alreadyReversed = db.consultant_ledger_entries
        .filter(
          (row) =>
            row.entry_type === "reversal" &&
            row.reverses_entry_id === original.id,
        )
        .reduce(
          (sum, row) => sum - (row.gross_amount_minor as number),
          0,
        );

      const remaining =
        (original.gross_amount_minor as number) - alreadyReversed;

      if (remaining <= 0) {
        return fail("FINANCE_REVERSAL_EXCEEDS_ORIGINAL");
      }

      const portion =
        (args.p_gross_amount_minor as number | null) ?? remaining;

      if (portion <= 0) {
        return fail("FINANCE_REVERSAL_AMOUNT_INVALID");
      }

      if (portion > remaining) {
        return fail("FINANCE_REVERSAL_EXCEEDS_ORIGINAL");
      }

      const fullUntouched =
        portion === original.gross_amount_minor &&
        alreadyReversed === 0;

      const consultantAmount = fullUntouched
        ? (original.consultant_amount_minor as number)
        : Math.round(
            (portion * (original.commission_bps as number)) / 10000,
          );

      const reversal: Row = {
        id: nextId(),
        consultant_id: original.consultant_id,
        entry_type: "reversal",
        source_type: original.source_type,
        source_id: original.source_id,
        source_component: original.source_component,
        gross_amount_minor: -portion,
        consultant_amount_minor: -consultantAmount,
        platform_amount_minor: -(portion - consultantAmount),
        commission_bps: original.commission_bps,
        commission_basis: original.commission_basis,
        currency: original.currency,
        /* The reversal inherits the original's availability. */
        available_at: original.available_at
          ? new Date().toISOString()
          : null,
        reverses_entry_id: original.id,
        memo: reason,
      };

      db.consultant_ledger_entries.push(reversal);

      return ok({
        entry_id: reversal.id,
        reverses_entry_id: original.id,
        gross_amount_minor: reversal.gross_amount_minor,
        consultant_amount_minor: reversal.consultant_amount_minor,
        platform_amount_minor: reversal.platform_amount_minor,
        currency: reversal.currency,
        available_at: reversal.available_at,
      });
    }

    /*
     * Mirrors migration 035 part C2: find the consultation's
     * earning in the database and delegate the arithmetic to
     * reverse_ledger_entry, so no caller has to read the ledger.
     */
    case "reverse_consultation_earning": {
      const original = consultationEarning(
        args.p_consultation_id,
      );

      if (!original) {
        return ok({
          entry_id: null,
          reversed: false,
          reason: "no_entry",
          consultant_amount_minor: null,
        });
      }

      const result = await fakeRpc("reverse_ledger_entry", {
        p_entry_id: original.id,
        p_reason: args.p_reason,
        p_gross_amount_minor: args.p_gross_amount_minor,
      });

      if (result.error) {
        const message = String(
          (result.error as { message?: string }).message ?? "",
        );

        if (
          message.startsWith(
            "FINANCE_REVERSAL_EXCEEDS_ORIGINAL",
          )
        ) {
          return ok({
            entry_id: original.id,
            reversed: false,
            reason: "already_reversed",
            consultant_amount_minor: null,
          });
        }

        return result;
      }

      const reversal = result.data![0]!;

      return ok({
        entry_id: reversal.entry_id,
        reversed: true,
        reason: "reversed",
        consultant_amount_minor:
          reversal.consultant_amount_minor,
      });
    }

    case "create_ledger_adjustment": {
      const amount = args.p_amount_minor as number | null;

      if (amount === null || amount === 0) {
        return fail("FINANCE_ADJUSTMENT_AMOUNT_INVALID");
      }

      const memo = String(args.p_memo ?? "").trim();

      if (!memo) {
        return fail("FINANCE_REASON_REQUIRED");
      }

      const currency = String(args.p_currency ?? "")
        .trim()
        .toLowerCase();

      if (!/^[a-z]{3}$/.test(currency)) {
        return fail("FINANCE_CURRENCY_INVALID");
      }

      if (
        !db.consultants.some(
          (row) => row.id === args.p_consultant_id,
        )
      ) {
        return fail("FINANCE_CONSULTANT_NOT_FOUND");
      }

      if (!isAdmin(args.p_admin_profile_id)) {
        return fail("FINANCE_ADMIN_REQUIRED");
      }

      const now = new Date().toISOString();

      const entry: Row = {
        id: nextId(),
        consultant_id: args.p_consultant_id,
        entry_type: "adjustment",
        source_type: "manual",
        source_id: null,
        source_component: "full",
        gross_amount_minor: amount,
        consultant_amount_minor: amount,
        platform_amount_minor: 0,
        commission_bps: null,
        commission_basis: "manual",
        currency,
        available_at: now,
        reverses_entry_id: null,
        created_by_admin_profile_id: args.p_admin_profile_id,
        memo,
        created_at: now,
      };

      db.consultant_ledger_entries.push(entry);

      return ok({
        entry_id: entry.id,
        consultant_id: entry.consultant_id,
        consultant_amount_minor: entry.consultant_amount_minor,
        currency: entry.currency,
        memo: entry.memo,
        available_at: entry.available_at,
        created_at: entry.created_at,
      });
    }

    case "request_consultant_payout": {
      const currency = String(args.p_currency ?? "")
        .trim()
        .toLowerCase();

      if (!/^[a-z]{3}$/.test(currency)) {
        return fail("FINANCE_CURRENCY_INVALID");
      }

      if (
        !db.consultants.some(
          (row) => row.id === args.p_consultant_id,
        )
      ) {
        return fail("FINANCE_CONSULTANT_NOT_FOUND");
      }

      if (
        db.payouts.some(
          (row) =>
            row.consultant_id === args.p_consultant_id &&
            row.currency === currency &&
            (row.status === "requested" ||
              row.status === "approved"),
        )
      ) {
        return fail("FINANCE_PAYOUT_ALREADY_OPEN");
      }

      const eligible = db.consultant_ledger_entries.filter(
        (row) =>
          row.consultant_id === args.p_consultant_id &&
          row.currency === currency &&
          row.available_at !== null &&
          !isAllocated(row.id),
      );

      if (eligible.length === 0) {
        return fail("FINANCE_NO_AVAILABLE_EARNINGS");
      }

      const total = eligible.reduce(
        (sum, row) => sum + (row.consultant_amount_minor as number),
        0,
      );

      if (total <= 0) {
        return fail("FINANCE_BALANCE_NOT_POSITIVE");
      }

      const now = new Date().toISOString();

      const payout: Row = {
        id: nextId(),
        consultant_id: args.p_consultant_id,
        status: "requested",
        currency,
        requested_amount_minor: total,
        paid_amount_minor: null,
        destination_note: args.p_destination_note ?? null,
        external_reference: null,
        admin_note: null,
        requested_at: now,
        approved_at: null,
        paid_at: null,
        rejected_at: null,
        cancelled_at: null,
        decided_by_admin_profile_id: null,
      };

      db.payouts.push(payout);

      for (const entry of eligible) {
        db.payout_allocations.push({
          payout_id: payout.id,
          ledger_entry_id: entry.id,
        });
      }

      return ok({
        payout_id: payout.id,
        status: payout.status,
        currency: payout.currency,
        requested_amount_minor: payout.requested_amount_minor,
        entry_count: eligible.length,
        requested_at: payout.requested_at,
      });
    }

    case "decide_payout": {
      const decision = args.p_decision as string;

      if (!["approve", "reject", "cancel"].includes(decision)) {
        return fail("FINANCE_DECISION_INVALID");
      }

      if (!isAdmin(args.p_admin_profile_id)) {
        return fail("FINANCE_ADMIN_REQUIRED");
      }

      const payout = db.payouts.find(
        (row) => row.id === args.p_payout_id,
      );

      if (!payout) {
        return fail("FINANCE_PAYOUT_NOT_FOUND");
      }

      if (payout.status === "paid") {
        return fail("FINANCE_PAYOUT_ALREADY_PAID");
      }

      if (
        payout.status !== "requested" &&
        payout.status !== "approved"
      ) {
        return fail("FINANCE_PAYOUT_NOT_OPEN");
      }

      const now = new Date().toISOString();
      let released = 0;

      if (decision === "approve") {
        if (payout.status === "approved") {
          return fail("FINANCE_PAYOUT_NOT_OPEN");
        }

        /* Allocations are untouched: approved stays reserved. */
        payout.status = "approved";
        payout.approved_at = now;
        payout.decided_by_admin_profile_id =
          args.p_admin_profile_id;
      } else {
        const before = db.payout_allocations.length;

        db.payout_allocations = db.payout_allocations.filter(
          (row) => row.payout_id !== payout.id,
        );

        released = before - db.payout_allocations.length;

        payout.status =
          decision === "reject" ? "rejected" : "cancelled";
        payout.decided_by_admin_profile_id =
          args.p_admin_profile_id;

        if (decision === "reject") {
          payout.rejected_at = now;
        } else {
          payout.cancelled_at = now;
        }
      }

      payout.admin_note = args.p_note ?? payout.admin_note;

      return ok({
        payout_id: payout.id,
        status: payout.status,
        currency: payout.currency,
        requested_amount_minor: payout.requested_amount_minor,
        released_entry_count: released,
        approved_at: payout.approved_at,
        rejected_at: payout.rejected_at,
        cancelled_at: payout.cancelled_at,
      });
    }

    case "mark_payout_paid": {
      const amount = args.p_paid_amount_minor as number | null;

      if (amount === null || amount <= 0) {
        return fail("FINANCE_PAID_AMOUNT_INVALID");
      }

      const reference = String(
        args.p_external_reference ?? "",
      ).trim();

      if (!reference) {
        return fail("FINANCE_REFERENCE_REQUIRED");
      }

      if (!isAdmin(args.p_admin_profile_id)) {
        return fail("FINANCE_ADMIN_REQUIRED");
      }

      const payout = db.payouts.find(
        (row) => row.id === args.p_payout_id,
      );

      if (!payout) {
        return fail("FINANCE_PAYOUT_NOT_FOUND");
      }

      if (payout.status === "paid") {
        return fail("FINANCE_PAYOUT_ALREADY_PAID");
      }

      if (payout.status !== "approved") {
        return fail("FINANCE_PAYOUT_NOT_APPROVED");
      }

      payout.status = "paid";
      payout.paid_amount_minor = amount;
      payout.paid_at =
        (args.p_paid_at as string | null) ??
        new Date().toISOString();
      payout.external_reference = reference;
      payout.decided_by_admin_profile_id =
        args.p_admin_profile_id;

      return ok({
        payout_id: payout.id,
        status: payout.status,
        currency: payout.currency,
        requested_amount_minor: payout.requested_amount_minor,
        paid_amount_minor: payout.paid_amount_minor,
        paid_at: payout.paid_at,
        external_reference: payout.external_reference,
      });
    }

    default:
      return { data: null, error: { message: "unknown rpc" } };
  }
};

supabaseAdmin.rpc =
  fakeRpc as unknown as typeof supabaseAdmin.rpc;

const app = Fastify({ logger: false });
await registerConsultantPayoutRoute(app);
await registerAdminFinanceRoutes(app);
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

const availableBalance = (
  consultantId: string,
  currency: string,
): number =>
  db.consultant_ledger_entries
    .filter(
      (row) =>
        row.consultant_id === consultantId &&
        row.currency === currency &&
        row.available_at !== null &&
        !isAllocated(row.id),
    )
    .reduce(
      (sum, row) => sum + (row.consultant_amount_minor as number),
      0,
    );

beforeEach(() => {
  idCounter = 0;

  db.profiles = [
    {
      id: CONSULTANT_PROFILE,
      role: "consultant",
      email: "consultant@example.test",
    },
    {
      id: OTHER_PROFILE,
      role: "consultant",
      email: "other@example.test",
    },
    {
      id: CLIENT_PROFILE,
      role: "client",
      email: "client@example.test",
    },
    {
      id: ADMIN_PROFILE,
      role: "admin",
      email: "admin@example.test",
    },
  ];

  db.consultants = [
    { id: CONSULTANT_ID, profile_id: CONSULTANT_PROFILE },
    { id: OTHER_CONSULTANT_ID, profile_id: OTHER_PROFILE },
  ];

  db.app_settings = [
    {
      consultation_price_cents: 15_000,
      consultation_consultant_commission_bps: COMMISSION_BPS,
    },
  ];

  db.consultations = [
    {
      id: CAPTURED_ONLY,
      consultant_id: CONSULTANT_ID,
      status: "captured",
      price_cents: 15_000,
      currency: "usd",
      captured_at: "2026-08-01T10:00:00.000Z",
      completed_at: null,
    },
    {
      id: COMPLETED_UNCAPTURED,
      consultant_id: CONSULTANT_ID,
      status: "completed",
      price_cents: 15_000,
      currency: "usd",
      captured_at: null,
      completed_at: "2026-08-01T12:00:00.000Z",
    },
    {
      id: COMPLETED_CAPTURED,
      consultant_id: CONSULTANT_ID,
      status: "completed",
      price_cents: 15_000,
      currency: "usd",
      captured_at: "2026-08-01T10:00:00.000Z",
      completed_at: "2026-08-01T12:00:00.000Z",
    },
  ];

  db.consultant_ledger_entries = [];
  db.payouts = [];
  db.payout_allocations = [];
});

describe("Consultation earnings", () => {
  it("creates the earning once, at 50% of gross", async () => {
    const outcome = await syncConsultationEarning(CAPTURED_ONLY);

    assert.equal(outcome.recorded, true);
    assert.equal(db.consultant_ledger_entries.length, 1);

    const entry = db.consultant_ledger_entries[0]!;

    assert.equal(entry.gross_amount_minor, 15_000);
    assert.equal(entry.consultant_amount_minor, 7_500);
    assert.equal(entry.platform_amount_minor, 7_500);
    assert.equal(entry.commission_bps, COMMISSION_BPS);
    assert.equal(entry.commission_basis, "standard_50_50");
  });

  it("does not double-credit when called again", async () => {
    const first = await syncConsultationEarning(CAPTURED_ONLY);
    const second = await syncConsultationEarning(CAPTURED_ONLY);
    const third = await syncConsultationEarning(CAPTURED_ONLY);

    assert.equal(first.recorded, true);
    assert.equal(second.recorded, false);
    assert.equal(third.recorded, false);

    assert.equal(db.consultant_ledger_entries.length, 1);

    assert.equal(
      db.consultant_ledger_entries.reduce(
        (sum, row) =>
          sum + (row.consultant_amount_minor as number),
        0,
      ),
      7_500,
    );
  });

  it("creates the earning pending, not available", async () => {
    await syncConsultationEarning(CAPTURED_ONLY);

    assert.equal(
      db.consultant_ledger_entries[0]!.available_at,
      null,
    );
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      0,
    );
  });

  it("does not release, or even create, without capture", async () => {
    const outcome = await syncConsultationEarning(
      COMPLETED_UNCAPTURED,
    );

    assert.equal(outcome.recorded, false);
    assert.equal(outcome.released, false);
    assert.equal(outcome.reason, "not_captured");

    /*
     * The rule that matters: completion alone never credits.
     * complete_consultation accepts a consultation in
     * 'confirmed', where no money has been taken.
     */
    assert.equal(db.consultant_ledger_entries.length, 0);
  });

  it("releases only when completed and captured", async () => {
    const outcome = await syncConsultationEarning(
      COMPLETED_CAPTURED,
    );

    assert.equal(outcome.recorded, true);
    assert.equal(outcome.released, true);
    assert.equal(outcome.reason, "released");

    assert.notEqual(
      db.consultant_ledger_entries[0]!.available_at,
      null,
    );
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      7_500,
    );
  });

  it("releases in either order of capture and completion", async () => {
    /* Captured first, completed later. */
    await syncConsultationEarning(CAPTURED_ONLY);
    assert.equal(availableBalance(CONSULTANT_ID, "usd"), 0);

    const consultation = db.consultations.find(
      (row) => row.id === CAPTURED_ONLY,
    )!;
    consultation.status = "completed";
    consultation.completed_at = "2026-08-01T13:00:00.000Z";

    const outcome = await syncConsultationEarning(CAPTURED_ONLY);

    assert.equal(outcome.recorded, false);
    assert.equal(outcome.released, true);
    assert.equal(availableBalance(CONSULTANT_ID, "usd"), 7_500);
  });

  it("releasing twice does not credit twice", async () => {
    await syncConsultationEarning(COMPLETED_CAPTURED);
    const again = await syncConsultationEarning(
      COMPLETED_CAPTURED,
    );

    assert.equal(again.released, false);
    assert.equal(again.reason, "already_available");
    assert.equal(availableBalance(CONSULTANT_ID, "usd"), 7_500);
  });
});

describe("Reversals", () => {
  it("creates a negative entry without touching the original", async () => {
    await syncConsultationEarning(COMPLETED_CAPTURED);

    const original = db.consultant_ledger_entries[0]!;
    const originalAmount = original.consultant_amount_minor;
    const originalAvailable = original.available_at;

    const outcome = await reverseConsultationEarning({
      consultationId: COMPLETED_CAPTURED,
      reason: "client refunded",
    });

    assert.equal(outcome.reversed, true);
    assert.equal(db.consultant_ledger_entries.length, 2);

    /* The original is byte for byte what it was. */
    assert.equal(
      original.consultant_amount_minor,
      originalAmount,
    );
    assert.equal(original.available_at, originalAvailable);
    assert.equal(original.entry_type, "earning");

    const reversal = db.consultant_ledger_entries[1]!;

    assert.equal(reversal.entry_type, "reversal");
    assert.equal(reversal.reverses_entry_id, original.id);
    assert.equal(reversal.consultant_amount_minor, -7_500);
    assert.equal(reversal.memo, "client refunded");

    assert.equal(availableBalance(CONSULTANT_ID, "usd"), 0);
  });

  it("does not reverse the same earning twice", async () => {
    await syncConsultationEarning(COMPLETED_CAPTURED);

    await reverseConsultationEarning({
      consultationId: COMPLETED_CAPTURED,
      reason: "refund",
    });

    const replay = await reverseConsultationEarning({
      consultationId: COMPLETED_CAPTURED,
      reason: "refund",
    });

    assert.equal(replay.reversed, false);
    assert.equal(replay.reason, "already_reversed");
    assert.equal(db.consultant_ledger_entries.length, 2);
  });

  it("is a no-op for a consultation that never earned", async () => {
    const outcome = await reverseConsultationEarning({
      consultationId: COMPLETED_UNCAPTURED,
      reason: "refund",
    });

    assert.equal(outcome.reversed, false);
    assert.equal(outcome.reason, "no_entry");
    assert.equal(db.consultant_ledger_entries.length, 0);
  });

  it("lets the balance go negative after a paid-out earning is reversed", async () => {
    await syncConsultationEarning(COMPLETED_CAPTURED);

    const request = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );
    const payoutId = request.json().data!.payout_id as string;

    await post(
      `/api/admin/payouts/${payoutId}/approve`,
      {},
      ADMIN_PROFILE,
    );
    await post(
      `/api/admin/payouts/${payoutId}/paid`,
      {
        paid_amount_minor: 7_500,
        external_reference: "WISE-1",
      },
      ADMIN_PROFILE,
    );

    await reverseConsultationEarning({
      consultationId: COMPLETED_CAPTURED,
      reason: "chargeback after payout",
    });

    /*
     * The paid earning stays allocated and spent; the reversal is
     * unallocated and negative, so the balance owed is negative
     * and the next earning offsets it.
     */
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      -7_500,
    );
  });
});

describe("Admin adjustments", () => {
  it("requires a memo", async () => {
    const response = await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: 500,
        currency: "usd",
        memo: "   ",
      },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.json().error!.code,
      "VALIDATION_ERROR",
    );
    assert.equal(db.consultant_ledger_entries.length, 0);
  });

  it("requires a non-zero amount", async () => {
    const response = await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: 0,
        currency: "usd",
        memo: "nothing",
      },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 400);
    assert.equal(db.consultant_ledger_entries.length, 0);
  });

  it("records a signed credit attributed to the admin", async () => {
    const response = await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: 2_500,
        currency: "usd",
        memo: "goodwill",
      },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 201);

    const entry = db.consultant_ledger_entries[0]!;

    assert.equal(entry.entry_type, "adjustment");
    assert.equal(entry.consultant_amount_minor, 2_500);
    assert.equal(entry.memo, "goodwill");
    assert.equal(
      entry.created_by_admin_profile_id,
      ADMIN_PROFILE,
    );
    /* Immediately withdrawable: a correction nobody can use is not one. */
    assert.notEqual(entry.available_at, null);
  });

  it("records a debit that reduces the balance", async () => {
    await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: 2_500,
        currency: "usd",
        memo: "credit",
      },
      ADMIN_PROFILE,
    );

    await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: -1_000,
        currency: "usd",
        memo: "debit",
      },
      ADMIN_PROFILE,
    );

    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      1_500,
    );
  });

  it("rejects an unknown consultant", async () => {
    const response = await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: "88888888-8888-4888-8888-888888888888",
        amount_minor: 500,
        currency: "usd",
        memo: "who",
      },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });
});

describe("Payout requests", () => {
  const seedAvailable = async (): Promise<void> => {
    await syncConsultationEarning(COMPLETED_CAPTURED);
  };

  it("reserves every available entry and sums them server-side", async () => {
    await seedAvailable();
    await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: 2_500,
        currency: "usd",
        memo: "bonus",
      },
      ADMIN_PROFILE,
    );

    const response = await post(
      "/api/consultant/payouts",
      { currency: "usd", destination_note: "Wise account" },
      CONSULTANT_PROFILE,
    );

    assert.equal(response.statusCode, 201);

    const data = response.json().data!;

    assert.equal(data.status, "requested");
    assert.equal(data.requested_amount_minor, 10_000);
    assert.equal(data.entry_count, 2);

    assert.equal(db.payout_allocations.length, 2);
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      0,
    );
  });

  it("ignores any amount a client tries to supply", async () => {
    await seedAvailable();

    const response = await post(
      "/api/consultant/payouts",
      {
        currency: "usd",
        requested_amount_minor: 999_999,
        amount_minor: 999_999,
      },
      CONSULTANT_PROFILE,
    );

    assert.equal(response.statusCode, 201);
    assert.equal(
      response.json().data!.requested_amount_minor,
      7_500,
    );
  });

  it("cannot allocate the same earning to a second payout", async () => {
    await seedAvailable();

    const first = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );
    assert.equal(first.statusCode, 201);

    const second = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );

    assert.equal(second.statusCode, 409);
    assert.equal(db.payouts.length, 1);
    assert.equal(db.payout_allocations.length, 1);
  });

  it("refuses when nothing is available", async () => {
    const response = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );

    assert.equal(response.statusCode, 409);
    assert.equal(db.payouts.length, 0);
  });

  it("refuses a non-positive balance and lets a later earning offset it", async () => {
    await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: -1_000,
        currency: "usd",
        memo: "clawback",
      },
      ADMIN_PROFILE,
    );

    const refused = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );

    assert.equal(refused.statusCode, 409);

    await seedAvailable();

    const allowed = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );

    assert.equal(allowed.statusCode, 201);
    assert.equal(
      allowed.json().data!.requested_amount_minor,
      6_500,
    );
  });

  it("keeps currencies separate", async () => {
    await seedAvailable();
    await post(
      "/api/admin/finance/adjustments",
      {
        consultant_id: CONSULTANT_ID,
        amount_minor: 4_000,
        currency: "gbp",
        memo: "gbp work",
      },
      ADMIN_PROFILE,
    );

    const usd = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );
    const gbp = await post(
      "/api/consultant/payouts",
      { currency: "gbp" },
      CONSULTANT_PROFILE,
    );

    assert.equal(
      usd.json().data!.requested_amount_minor,
      7_500,
    );
    assert.equal(
      gbp.json().data!.requested_amount_minor,
      4_000,
    );
  });
});

describe("Payout decisions", () => {
  const openPayout = async (): Promise<string> => {
    await syncConsultationEarning(COMPLETED_CAPTURED);

    const response = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );

    return response.json().data!.payout_id as string;
  };

  it("approval preserves the reservation", async () => {
    const payoutId = await openPayout();

    const response = await post(
      `/api/admin/payouts/${payoutId}/approve`,
      { note: "checked" },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data!.status, "approved");
    assert.equal(
      response.json().data!.released_entry_count,
      0,
    );

    assert.equal(db.payout_allocations.length, 1);
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      0,
    );
  });

  it("rejection releases the allocations", async () => {
    const payoutId = await openPayout();

    const response = await post(
      `/api/admin/payouts/${payoutId}/reject`,
      { note: "wrong account" },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data!.status, "rejected");
    assert.equal(
      response.json().data!.released_entry_count,
      1,
    );

    assert.equal(db.payout_allocations.length, 0);
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      7_500,
    );
  });

  it("cancellation releases the allocations", async () => {
    const payoutId = await openPayout();

    await post(
      `/api/admin/payouts/${payoutId}/cancel`,
      {},
      ADMIN_PROFILE,
    );

    assert.equal(db.payout_allocations.length, 0);
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      7_500,
    );

    /* And a released balance can be requested again. */
    const again = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      CONSULTANT_PROFILE,
    );

    assert.equal(again.statusCode, 201);
  });

  it("marks an approved payout paid with a reference", async () => {
    const payoutId = await openPayout();

    await post(
      `/api/admin/payouts/${payoutId}/approve`,
      {},
      ADMIN_PROFILE,
    );

    const response = await post(
      `/api/admin/payouts/${payoutId}/paid`,
      {
        paid_amount_minor: 7_400,
        external_reference: "WISE-9912",
        note: "net of bank fee",
      },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 200);

    const data = response.json().data!;

    assert.equal(data.status, "paid");
    assert.equal(data.paid_amount_minor, 7_400);
    assert.equal(data.external_reference, "WISE-9912");
  });

  it("refuses to mark an unapproved payout paid", async () => {
    const payoutId = await openPayout();

    const response = await post(
      `/api/admin/payouts/${payoutId}/paid`,
      {
        paid_amount_minor: 7_500,
        external_reference: "WISE-1",
      },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 409);
    assert.equal(
      db.payouts[0]!.status,
      "requested",
    );
  });

  it("requires an external reference", async () => {
    const payoutId = await openPayout();

    await post(
      `/api/admin/payouts/${payoutId}/approve`,
      {},
      ADMIN_PROFILE,
    );

    const response = await post(
      `/api/admin/payouts/${payoutId}/paid`,
      {
        paid_amount_minor: 7_500,
        external_reference: "   ",
      },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 400);
    assert.equal(db.payouts[0]!.status, "approved");
  });

  it("cannot reopen a paid payout", async () => {
    const payoutId = await openPayout();

    await post(
      `/api/admin/payouts/${payoutId}/approve`,
      {},
      ADMIN_PROFILE,
    );
    await post(
      `/api/admin/payouts/${payoutId}/paid`,
      {
        paid_amount_minor: 7_500,
        external_reference: "WISE-1",
      },
      ADMIN_PROFILE,
    );

    for (const decision of [
      "approve",
      "reject",
      "cancel",
    ]) {
      const response = await post(
        `/api/admin/payouts/${payoutId}/${decision}`,
        {},
        ADMIN_PROFILE,
      );

      assert.equal(
        response.statusCode,
        409,
        `${decision} must be refused on a paid payout`,
      );
    }

    const repaid = await post(
      `/api/admin/payouts/${payoutId}/paid`,
      {
        paid_amount_minor: 1,
        external_reference: "WISE-2",
      },
      ADMIN_PROFILE,
    );

    assert.equal(repaid.statusCode, 409);

    assert.equal(db.payouts[0]!.status, "paid");
    assert.equal(db.payouts[0]!.paid_amount_minor, 7_500);
    /* The allocations were never released. */
    assert.equal(db.payout_allocations.length, 1);
  });

  it("returns 404 for an unknown payout", async () => {
    const response = await post(
      "/api/admin/payouts/88888888-8888-4888-8888-888888888888/approve",
      {},
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 404);
  });
});

describe("Finance access control", () => {
  it("requests a payout for the caller, never for another consultant", async () => {
    await syncConsultationEarning(COMPLETED_CAPTURED);

    /*
     * The body names another consultant. The endpoint takes the
     * consultant from the bearer token, so the payout belongs to
     * the caller and the other consultant is untouched.
     */
    const response = await post(
      "/api/consultant/payouts",
      {
        currency: "usd",
        consultant_id: OTHER_CONSULTANT_ID,
      },
      CONSULTANT_PROFILE,
    );

    assert.equal(response.statusCode, 201);
    assert.equal(db.payouts.length, 1);
    assert.equal(
      db.payouts[0]!.consultant_id,
      CONSULTANT_ID,
    );
  });

  it("gives another consultant no access to the balance or its payout", async () => {
    await syncConsultationEarning(COMPLETED_CAPTURED);

    /* The other consultant has earned nothing. */
    const response = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      OTHER_PROFILE,
    );

    assert.equal(response.statusCode, 409);
    assert.equal(db.payouts.length, 0);
    assert.equal(
      availableBalance(CONSULTANT_ID, "usd"),
      7_500,
    );
  });

  it("refuses a client on every finance endpoint", async () => {
    const attempts: Array<[string, unknown]> = [
      ["/api/consultant/payouts", { currency: "usd" }],
      [
        "/api/admin/finance/adjustments",
        {
          consultant_id: CONSULTANT_ID,
          amount_minor: 500,
          currency: "usd",
          memo: "no",
        },
      ],
      [
        "/api/admin/payouts/88888888-8888-4888-8888-888888888888/approve",
        {},
      ],
      [
        "/api/admin/payouts/88888888-8888-4888-8888-888888888888/reject",
        {},
      ],
      [
        "/api/admin/payouts/88888888-8888-4888-8888-888888888888/cancel",
        {},
      ],
      [
        "/api/admin/payouts/88888888-8888-4888-8888-888888888888/paid",
        {
          paid_amount_minor: 1,
          external_reference: "X",
        },
      ],
    ];

    for (const [url, body] of attempts) {
      const response = await post(url, body, CLIENT_PROFILE);

      assert.equal(
        response.statusCode,
        403,
        `${url} must refuse a client`,
      );
    }

    assert.equal(db.consultant_ledger_entries.length, 0);
    assert.equal(db.payouts.length, 0);
  });

  it("refuses a consultant on the admin finance endpoints", async () => {
    const attempts: Array<[string, unknown]> = [
      [
        "/api/admin/finance/adjustments",
        {
          consultant_id: CONSULTANT_ID,
          amount_minor: 500,
          currency: "usd",
          memo: "self credit",
        },
      ],
      [
        "/api/admin/payouts/88888888-8888-4888-8888-888888888888/approve",
        {},
      ],
      [
        "/api/admin/payouts/88888888-8888-4888-8888-888888888888/paid",
        {
          paid_amount_minor: 1,
          external_reference: "X",
        },
      ],
    ];

    for (const [url, body] of attempts) {
      const response = await post(
        url,
        body,
        CONSULTANT_PROFILE,
      );

      assert.equal(
        response.statusCode,
        403,
        `${url} must refuse a consultant`,
      );
    }

    assert.equal(db.consultant_ledger_entries.length, 0);
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      null,
    );

    assert.equal(response.statusCode, 401);
  });

  it("refuses an admin acting as a consultant on the payout endpoint", async () => {
    const response = await post(
      "/api/consultant/payouts",
      { currency: "usd" },
      ADMIN_PROFILE,
    );

    assert.equal(response.statusCode, 403);
  });
});
