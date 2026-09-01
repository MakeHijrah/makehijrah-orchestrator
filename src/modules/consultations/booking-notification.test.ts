/*
 * Consultant "you have a new booking" notification tests.
 *
 * Nothing external is contacted. Supabase and Redis are replaced
 * with in-memory fakes, and Mandrill is intercepted at the fetch
 * boundary so the real lib/mandrill.ts payload builder runs. That
 * is what lets these tests assert on the exact outgoing tag,
 * recipient and body rather than on a mocked call signature.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://booking-notification-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_SECRET_KEY: "sk_test_booking_notification",
  STRIPE_WEBHOOK_SECRET: "whsec_booking_notification",
  STRIPE_TEST_SECRET_KEY: "sk_test_booking_notification",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_booking_notification",
  STRIPE_LIVE_SECRET_KEY: "sk_live_booking_notification",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_booking_notification",
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
const {
  BOOKING_NOTIFICATION_DUE_SET,
  processBookingNotification,
  scheduleBookingNotification,
} = await import("./booking-notification.service.js");

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const CONSULTANT_ROW_ID = "77777777-7777-4777-8777-777777777777";
const CONSULTANT_PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const COUNTRY_ID = "88888888-8888-4888-8888-888888888888";

type Row = Record<string, unknown>;

type FakeDatabase = {
  consultations: Row[];
  consultants: Row[];
  profiles: Row[];
  consultation_intake: Row[];
  countries: Row[];
};

const db: FakeDatabase = {
  consultations: [],
  consultants: [],
  profiles: [],
  consultation_intake: [],
  countries: [],
};

const tableRows = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

type DbFailure = {
  table: string;
  remaining: number;
};

let dbFailures: DbFailure[] = [];

const takeDbFailure = (table: string): boolean => {
  const match = dbFailures.find(
    (failure) => failure.table === table && failure.remaining > 0,
  );

  if (!match) {
    return false;
  }

  match.remaining -= 1;

  return true;
};

const dbError = {
  code: "XX000",
  message: "forced test failure",
  details: null,
  hint: null,
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

  private matchedRows(): Row[] {
    return tableRows(this.table).filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    if (takeDbFailure(this.table)) {
      return { data: null, error: dbError };
    }

    return { data: this.matchedRows()[0] ?? null, error: null };
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

/*
 * Redis fake. Only the operations this service actually uses are
 * implemented, so an unimplemented one fails the test rather than
 * silently succeeding.
 */
const store = new Map<string, string>();
const dueSet = new Map<string, number>();

let redisWritesFail = false;

type MultiOp = () => void;

class FakeMulti {
  private readonly ops: MultiOp[] = [];
  private readonly results: Array<[unknown, unknown]> = [];

  set(
    key: string,
    value: string,
    _ex: string,
    _ttl: number,
    nx?: string,
  ): this {
    this.ops.push(() => {
      if (nx === "NX" && store.has(key)) {
        this.results.push([null, null]);

        return;
      }

      store.set(key, value);
      this.results.push([null, "OK"]);
    });

    return this;
  }

  del(key: string): this {
    this.ops.push(() => {
      this.results.push([null, store.delete(key) ? 1 : 0]);
    });

    return this;
  }

  zadd(
    key: string,
    nx: string,
    score: number,
    member: string,
  ): this {
    this.ops.push(() => {
      assert.equal(key, BOOKING_NOTIFICATION_DUE_SET);
      assert.equal(nx, "NX");

      if (dueSet.has(member)) {
        this.results.push([null, 0]);

        return;
      }

      dueSet.set(member, score);
      this.results.push([null, 1]);
    });

    return this;
  }

  async exec(): Promise<Array<[unknown, unknown]> | null> {
    if (redisWritesFail) {
      throw new Error("forced Redis failure");
    }

    for (const op of this.ops) {
      op();
    }

    return this.results;
  }
}

redis.multi = (() => new FakeMulti()) as unknown as typeof redis.multi;

redis.exists = (async (key: string) =>
  store.has(key) ? 1 : 0) as unknown as typeof redis.exists;

redis.get = (async (key: string) =>
  store.get(key) ?? null) as unknown as typeof redis.get;

type MandrillPayload = {
  message: {
    subject: string;
    html: string;
    text: string;
    tags: string[];
    to: Array<{ email: string; name?: string }>;
  };
};

let mandrillRequests: MandrillPayload[] = [];
let mandrillMode: "ok" | "http_error" = "ok";

globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
  mandrillRequests.push(JSON.parse(String(init.body)) as MandrillPayload);

  if (mandrillMode === "http_error") {
    return new Response("upstream failure", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }

  return new Response(
    JSON.stringify([
      { email: "consultant@example.test", status: "sent", _id: "mandrill-1" },
    ]),
    { status: 200 },
  );
}) as unknown as typeof fetch;

const lastEmail = (): MandrillPayload["message"] => {
  assert.equal(
    mandrillRequests.length,
    1,
    "expected exactly one Mandrill send",
  );

  return mandrillRequests[0]!.message;
};

const isQueued = (): boolean => dueSet.has(CONSULTATION_ID);

beforeEach(() => {
  store.clear();
  dueSet.clear();
  mandrillRequests = [];
  mandrillMode = "ok";
  dbFailures = [];
  redisWritesFail = false;

  db.consultations = [
    {
      id: CONSULTATION_ID,
      consultant_id: CONSULTANT_ROW_ID,
      country_id: COUNTRY_ID,
      status: "pending_acceptance",
      scheduled_start_at: "2026-08-01T10:00:00.000Z",
      payment_authorized_at: "2026-07-29T10:00:00.000Z",
      price_cents: 15000,
      currency: "usd",
    },
  ];
  db.consultants = [
    { id: CONSULTANT_ROW_ID, profile_id: CONSULTANT_PROFILE_ID },
  ];
  db.profiles = [
    {
      id: CONSULTANT_PROFILE_ID,
      full_name: "Aisha Consultant",
      email: "consultant@example.test",
    },
  ];
  db.consultation_intake = [
    { consultation_id: CONSULTATION_ID, full_name: "Yusuf Client" },
  ];
  db.countries = [{ id: COUNTRY_ID, name: "Türkiye" }];
});

describe("Booking notification: scheduling", () => {
  it("queues the consultation on first schedule", async () => {
    const result = await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.notification,
      "scheduled",
    );
    assert.equal(isQueued(), true);
  });

  it("reports already_scheduled on a Stripe redelivery and keeps the original queue position", async () => {
    await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });

    const firstScore = dueSet.get(CONSULTATION_ID);

    const result = await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(
      result.ok && result.notification,
      "already_scheduled",
    );
    assert.equal(dueSet.size, 1);
    assert.equal(dueSet.get(CONSULTATION_ID), firstScore);
  });

  it("reports already_sent and queues nothing once the notification is done", async () => {
    await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });

    await processBookingNotification(CONSULTATION_ID);

    dueSet.clear();

    const result = await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(
      result.ok && result.notification,
      "already_sent",
    );
    assert.equal(isQueued(), false);
  });

  it("reports an internal error rather than throwing when Redis is unavailable", async () => {
    redisWritesFail = true;

    const result = await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "INTERNAL_ERROR");
  });
});

describe("Booking notification: the email", () => {
  beforeEach(async () => {
    await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });
  });

  it("emails the consultant's own profile address once", async () => {
    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, "sent");

    const message = lastEmail();

    assert.deepEqual(message.to, [
      {
        email: "consultant@example.test",
        name: "Aisha Consultant",
        type: "to",
      },
    ]);
    assert.deepEqual(message.tags, [
      "consultation-booked-consultant",
    ]);
  });

  it("carries the client name, time, topic and fee", async () => {
    await processBookingNotification(CONSULTATION_ID);

    const message = lastEmail();

    assert.match(message.subject, /Türkiye/);
    assert.match(message.text, /Yusuf Client/);
    assert.match(message.text, /1 Aug 2026, 10:00 UTC/);
    assert.match(message.text, /Topic: Türkiye/);
    assert.match(message.text, /Session fee: 150\.00 USD/);
    assert.match(message.text, /within 48 hours/);
    assert.match(
      message.text,
      /https:\/\/app\.example\.test\/consultant/,
    );

    assert.match(message.html, /Yusuf Client/);
    assert.match(message.html, /150\.00 USD/);
  });

  it("describes a general consultation as general information", async () => {
    db.consultations[0]!.country_id = null;

    await processBookingNotification(CONSULTATION_ID);

    const message = lastEmail();

    assert.equal(message.subject, "New booking to accept");
    assert.match(message.text, /Topic: General information/);
  });

  it("still notifies when the intake row is missing", async () => {
    db.consultation_intake = [];

    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok && result.outcome, "sent");
    assert.match(lastEmail().text, /A client has booked a consultation/);
  });

  it("escapes HTML in the client name", async () => {
    db.consultation_intake[0]!.full_name = "<script>x</script>";

    await processBookingNotification(CONSULTATION_ID);

    const message = lastEmail();

    assert.ok(!message.html.includes("<script>"));
    assert.match(message.html, /&lt;script&gt;/);
  });
});

describe("Booking notification: idempotency and suppression", () => {
  beforeEach(async () => {
    await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });
  });

  it("sends exactly once however many times it is processed", async () => {
    const first = await processBookingNotification(CONSULTATION_ID);
    const second = await processBookingNotification(CONSULTATION_ID);

    assert.equal(first.ok && first.outcome, "sent");
    assert.equal(second.ok && second.outcome, "already_sent");
    assert.equal(mandrillRequests.length, 1);
  });

  it("suppresses the email when the consultant has already accepted", async () => {
    db.consultations[0]!.status = "confirmed";

    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok && result.action, "remove");
    assert.equal(result.ok && result.outcome, "permanent_failure");
    assert.equal(mandrillRequests.length, 0);
  });

  it("suppresses the email when the authorization was cancelled", async () => {
    db.consultations[0]!.status = "authorization_cancelled";

    await processBookingNotification(CONSULTATION_ID);

    assert.equal(mandrillRequests.length, 0);
  });

  it("does not revive a suppressed booking on a later Stripe redelivery", async () => {
    db.consultations[0]!.status = "declined";

    await processBookingNotification(CONSULTATION_ID);

    const rescheduled = await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });

    assert.equal(
      rescheduled.ok && rescheduled.notification,
      "already_sent",
    );
    assert.equal(mandrillRequests.length, 0);
  });

  it("suppresses the email when the payment is not authorized", async () => {
    db.consultations[0]!.payment_authorized_at = null;

    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok && result.outcome, "permanent_failure");
    assert.equal(mandrillRequests.length, 0);
  });

  it("suppresses the email when the consultant address is unusable", async () => {
    db.profiles[0]!.email = "not-an-address";

    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok && result.outcome, "permanent_failure");
    assert.equal(mandrillRequests.length, 0);
  });

  it("drops a job whose payload has expired", async () => {
    store.clear();

    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok && result.outcome, "permanent_failure");
    assert.equal(mandrillRequests.length, 0);
  });
});

describe("Booking notification: retry", () => {
  beforeEach(async () => {
    await scheduleBookingNotification({
      consultationId: CONSULTATION_ID,
    });
  });

  it("retries and later delivers when Mandrill fails", async () => {
    mandrillMode = "http_error";

    const failed = await processBookingNotification(CONSULTATION_ID);

    assert.equal(failed.ok, false);
    assert.equal(!failed.ok && failed.action, "retry");

    mandrillMode = "ok";
    mandrillRequests = [];

    const retried = await processBookingNotification(CONSULTATION_ID);

    assert.equal(retried.ok && retried.outcome, "sent");
    assert.equal(mandrillRequests.length, 1);
  });

  it("retries rather than suppresses when the consultation lookup fails", async () => {
    dbFailures = [{ table: "consultations", remaining: 1 }];

    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.action, "retry");
    assert.equal(mandrillRequests.length, 0);
  });

  it("retries rather than suppresses when the consultant profile lookup fails", async () => {
    dbFailures = [{ table: "profiles", remaining: 1 }];

    const result = await processBookingNotification(CONSULTATION_ID);

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.action, "retry");
    assert.equal(mandrillRequests.length, 0);
  });
});
