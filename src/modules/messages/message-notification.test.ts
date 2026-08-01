/*
 * Direct message email notification tests.
 *
 * Nothing external is contacted. Supabase and Redis are replaced
 * with in-memory fakes, and Mandrill is intercepted at the fetch
 * boundary so the real lib/mandrill.ts payload builder runs. That
 * is what lets these tests assert on the exact outgoing tag and
 * metadata rather than on a mocked call signature.
 *
 * Consultation-message behaviour is re-asserted here as a
 * regression guard: it must be byte-identical to what it was
 * before direct messages existed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://message-notification-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_SECRET_KEY: "sk_test_message_notification",
  STRIPE_WEBHOOK_SECRET: "whsec_message_notification",
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
const { redis } = await import("../../lib/redis.js");
const { registerMessageNotificationRoute } = await import(
  "./message-notification.route.js"
);
const {
  processMessageNotification,
  scheduleMessageNotification,
  MESSAGE_NOTIFICATION_DUE_SET,
} = await import("./message-notification.service.js");

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ADMIN_ID = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
const CONSULTANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CONSULTANT_ID = "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const STRANGER_ID = "44444444-4444-4444-8444-444444444444";

const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
const CONSULTATION_ID = "66666666-6666-4666-8666-666666666666";
const CONSULTANT_ROW_ID = "77777777-7777-4777-8777-777777777777";

type Row = Record<string, unknown>;

type FakeDatabase = {
  messages: Row[];
  profiles: Row[];
  consultations: Row[];
  consultants: Row[];
  consultation_intake: Row[];
};

const db: FakeDatabase = {
  messages: [],
  profiles: [],
  consultations: [],
  consultants: [],
  consultation_intake: [],
};

const tableRows = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

type DbFailure = {
  table: string;
  op: "select" | "update";
  remaining: number;
};

let dbFailures: DbFailure[] = [];

const takeDbFailure = (
  table: string,
  op: DbFailure["op"],
): boolean => {
  const match = dbFailures.find(
    (failure) =>
      failure.table === table &&
      failure.op === op &&
      failure.remaining > 0,
  );

  if (!match) {
    return false;
  }

  match.remaining -= 1;

  return true;
};

type UpdateCall = {
  table: string;
  values: Row | null;
  matched: number;
};

let updateCalls: UpdateCall[] = [];

const dbError = {
  code: "XX000",
  message: "forced test failure",
  details: null,
  hint: null,
};

class FakeQuery {
  private readonly table: string;
  private readonly filters: Array<(row: Row) => boolean> = [];
  private values: Row | null = null;
  private op: "select" | "update" = "select";

  constructor(table: string) {
    this.table = table;
  }

  select(): this {
    return this;
  }

  update(values: Row): this {
    this.op = "update";
    this.values = values;

    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);

    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] ?? null) === value);

    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));

    return this;
  }

  private matchedRows(): Row[] {
    return tableRows(this.table).filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
  }

  private async run(): Promise<{ data: unknown; error: unknown }> {
    if (takeDbFailure(this.table, this.op)) {
      return { data: null, error: dbError };
    }

    if (this.op === "update") {
      const matched = this.matchedRows();

      for (const row of matched) {
        Object.assign(row, this.values ?? {});
      }

      updateCalls.push({
        table: this.table,
        values: this.values,
        matched: matched.length,
      });

      return { data: null, error: null };
    }

    return { data: this.matchedRows(), error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const result = await this.run();

    if (result.error) {
      return { data: null, error: result.error };
    }

    const rows = result.data as Row[];

    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1, TResult2 = never>(
    onFulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected);
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

/*
 * Auth tokens are the caller's profile id, so a test can act as
 * any participant without minting real JWTs.
 */
supabaseAdmin.auth = {
  getUser: async (token: string) => {
    const profile = db.profiles.find((row) => row.id === token);

    if (!profile) {
      return { data: { user: null }, error: { message: "invalid token" } };
    }

    return { data: { user: { id: profile.id } }, error: null };
  },
} as unknown as typeof supabaseAdmin.auth;

const dueSet = new Map<string, number>();

type ZaddCall = {
  nx: boolean;
  score: number;
  member: string;
};

let zaddCalls: ZaddCall[] = [];

redis.zadd = (async (key: string, ...args: unknown[]) => {
  assert.equal(key, MESSAGE_NOTIFICATION_DUE_SET);

  const nx = args[0] === "NX";
  const offset = nx ? 1 : 0;
  const score = Number(args[offset]);
  const member = String(args[offset + 1]);

  zaddCalls.push({ nx, score, member });

  if (nx && dueSet.has(member)) {
    return 0;
  }

  dueSet.set(member, score);

  return 1;
}) as unknown as typeof redis.zadd;

type MandrillPayload = {
  message: {
    subject: string;
    html: string;
    text: string;
    tags: string[];
    metadata?: Record<string, string>;
    to: Array<{ email: string; name?: string }>;
  };
};

let mandrillRequests: MandrillPayload[] = [];
let mandrillMode: "ok" | "rejected" | "http_error" = "ok";

globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
  mandrillRequests.push(
    JSON.parse(String(init.body)) as MandrillPayload,
  );

  if (mandrillMode === "http_error") {
    return new Response("upstream failure", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }

  if (mandrillMode === "rejected") {
    return new Response(
      JSON.stringify([
        {
          email: "recipient@example.test",
          status: "rejected",
          reject_reason: "hard-bounce",
          _id: "mandrill-1",
        },
      ]),
      { status: 200 },
    );
  }

  return new Response(
    JSON.stringify([
      {
        email: "recipient@example.test",
        status: "sent",
        _id: "mandrill-1",
      },
    ]),
    { status: 200 },
  );
}) as unknown as typeof fetch;

const profile = (
  id: string,
  role: string,
  fullName: string | null,
  email: string | null,
): Row => ({
  id,
  role,
  full_name: fullName,
  email,
});

const directMessage = (overrides: Row = {}): Row => ({
  id: MESSAGE_ID,
  consultation_id: null,
  sender_profile_id: CONSULTANT_ID,
  recipient_profile_id: ADMIN_ID,
  body: "  Salaam,\n\n  a direct   question about a client.  ",
  created_at: "2026-07-29T10:00:00.000Z",
  read_at: null,
  email_notification_sent_at: null,
  ...overrides,
});

const consultationMessage = (overrides: Row = {}): Row => ({
  id: MESSAGE_ID,
  consultation_id: CONSULTATION_ID,
  sender_profile_id: CONSULTANT_ID,
  recipient_profile_id: CLIENT_ID,
  body: "An update on your consultation.",
  created_at: "2026-07-29T10:00:00.000Z",
  read_at: null,
  email_notification_sent_at: null,
  ...overrides,
});

const buildApp = async () => {
  const app = Fastify();

  await registerMessageNotificationRoute(app);

  return app;
};

const post = async (
  messageId: string,
  token: string | null,
) => {
  const app = await buildApp();

  try {
    return await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/notification`,
      headers: token
        ? { authorization: `Bearer ${token}` }
        : {},
    });
  } finally {
    await app.close();
  }
};

const lastEmail = (): MandrillPayload["message"] => {
  assert.equal(
    mandrillRequests.length,
    1,
    "expected exactly one Mandrill send",
  );

  return mandrillRequests[0]!.message;
};

beforeEach(() => {
  db.messages = [];
  db.consultations = [
    {
      id: CONSULTATION_ID,
      client_profile_id: CLIENT_ID,
      consultant_id: CONSULTANT_ROW_ID,
      scheduled_start_at: "2026-08-01T10:00:00.000Z",
    },
  ];
  db.consultants = [
    { id: CONSULTANT_ROW_ID, profile_id: CONSULTANT_ID },
  ];
  db.consultation_intake = [];
  db.profiles = [
    profile(ADMIN_ID, "admin", "Dave Admin", "admin@example.test"),
    profile(
      OTHER_ADMIN_ID,
      "admin",
      "Second Admin",
      "admin2@example.test",
    ),
    profile(
      CONSULTANT_ID,
      "consultant",
      "Aisha Consultant",
      "consultant@example.test",
    ),
    profile(
      OTHER_CONSULTANT_ID,
      "consultant",
      "Yusuf Consultant",
      "consultant2@example.test",
    ),
    profile(CLIENT_ID, "client", "Sara Client", "client@example.test"),
    profile(STRANGER_ID, "client", "Stranger", "stranger@example.test"),
  ];

  dbFailures = [];
  updateCalls = [];
  zaddCalls = [];
  dueSet.clear();
  mandrillRequests = [];
  mandrillMode = "ok";
});

describe("Direct message notification: route authorization", () => {
  it("lets an admin schedule a direct message they sent", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: CONSULTANT_ID,
      }),
    ];

    const response = await post(MESSAGE_ID, ADMIN_ID);

    assert.equal(response.statusCode, 200);

    const payload = response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.data.notification, "scheduled");
    assert.equal(zaddCalls.length, 1);
  });

  it("refuses an admin scheduling a message sent by someone else", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: CONSULTANT_ID,
        recipient_profile_id: OTHER_ADMIN_ID,
      }),
    ];

    const response = await post(MESSAGE_ID, ADMIN_ID);

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "FORBIDDEN");
    assert.equal(zaddCalls.length, 0);
  });

  it("still lets a consultant schedule their own direct message", async () => {
    db.messages = [directMessage()];

    const response = await post(MESSAGE_ID, CONSULTANT_ID);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.notification, "scheduled");
  });

  it("rejects an unauthenticated caller", async () => {
    db.messages = [directMessage()];

    const response = await post(MESSAGE_ID, null);

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "UNAUTHORIZED");
    assert.equal(zaddCalls.length, 0);
  });

  it("returns NOT_FOUND for a message that does not exist", async () => {
    const response = await post(MESSAGE_ID, ADMIN_ID);

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "NOT_FOUND");
  });
});

describe("Direct message notification: pairing validation", () => {
  const expectPermanentFailure = async () => {
    const result = await processMessageNotification(MESSAGE_ID);

    assert.deepEqual(result, {
      ok: true,
      action: "remove",
      outcome: "permanent_failure",
    });

    assert.equal(mandrillRequests.length, 0);
    assert.equal(updateCalls.length, 0);
  };

  it("accepts consultant to admin", async () => {
    db.messages = [directMessage()];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.equal(result.ok, true);
    assert.equal(
      (result as { outcome: string }).outcome,
      "sent",
    );
  });

  it("accepts admin to consultant", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: CONSULTANT_ID,
      }),
    ];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.equal(result.ok, true);
    assert.equal(
      (result as { outcome: string }).outcome,
      "sent",
    );
  });

  it("rejects client participation as recipient", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: CLIENT_ID,
      }),
    ];

    await expectPermanentFailure();
  });

  it("rejects client participation as sender", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: CLIENT_ID,
        recipient_profile_id: ADMIN_ID,
      }),
    ];

    await expectPermanentFailure();
  });

  it("rejects consultant to consultant", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: CONSULTANT_ID,
        recipient_profile_id: OTHER_CONSULTANT_ID,
      }),
    ];

    await expectPermanentFailure();
  });

  it("rejects admin to admin", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: OTHER_ADMIN_ID,
      }),
    ];

    await expectPermanentFailure();
  });

  it("rejects a self-send", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: ADMIN_ID,
      }),
    ];

    await expectPermanentFailure();
  });

  it("rejects a missing recipient profile", async () => {
    db.profiles = db.profiles.filter((row) => row.id !== ADMIN_ID);
    db.messages = [directMessage()];

    await expectPermanentFailure();
  });

  it("rejects a missing sender profile", async () => {
    db.profiles = db.profiles.filter(
      (row) => row.id !== CONSULTANT_ID,
    );
    db.messages = [directMessage()];

    await expectPermanentFailure();
  });

  it("rejects an unsupported role pair", async () => {
    db.profiles = db.profiles.map((row) =>
      row.id === ADMIN_ID ? { ...row, role: "moderator" } : row,
    );
    db.messages = [directMessage()];

    await expectPermanentFailure();
  });

  it("retries rather than discarding when the profile lookup fails", async () => {
    db.messages = [directMessage()];
    dbFailures = [{ table: "profiles", op: "select", remaining: 1 }];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.equal(result.ok, false);
    assert.equal(
      (result as { action: string }).action,
      "retry",
    );
    assert.equal(mandrillRequests.length, 0);
  });
});

describe("Direct message notification: email content", () => {
  it("uses the direct-message tag", async () => {
    db.messages = [directMessage()];

    await processMessageNotification(MESSAGE_ID);

    assert.deepEqual(lastEmail().tags, ["direct-message"]);
  });

  it("sends a consultant to admin message to /admin/messages", async () => {
    db.messages = [directMessage()];

    await processMessageNotification(MESSAGE_ID);

    const email = lastEmail();

    assert.equal(
      email.subject,
      "A MakeHijrah consultant sent you a message",
    );
    assert.equal(email.to[0]!.email, "admin@example.test");
    assert.ok(
      email.text.includes(
        "https://app.example.test/login?redirect=%2Fadmin%2Fmessages",
      ),
      email.text,
    );
    assert.ok(email.text.includes("Aisha Consultant sent you a new message."));
  });

  it("sends an admin to consultant message to /consultant/messages", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: CONSULTANT_ID,
      }),
    ];

    await processMessageNotification(MESSAGE_ID);

    const email = lastEmail();

    assert.equal(
      email.subject,
      "MakeHijrah Administration sent you a message",
    );
    assert.equal(email.to[0]!.email, "consultant@example.test");
    assert.ok(
      email.text.includes(
        "https://app.example.test/login?redirect=%2Fconsultant%2Fmessages",
      ),
      email.text,
    );
  });

  it("never uses the admin's personal name as the sender label", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: CONSULTANT_ID,
      }),
    ];

    await processMessageNotification(MESSAGE_ID);

    const email = lastEmail();

    assert.ok(
      email.text.includes(
        "MakeHijrah Administration sent you a new message.",
      ),
    );
    assert.ok(!email.text.includes("Dave Admin"));
    assert.ok(!email.html.includes("Dave Admin"));
  });

  it("falls back to a generic consultant label when no name is recorded", async () => {
    db.profiles = db.profiles.map((row) =>
      row.id === CONSULTANT_ID ? { ...row, full_name: null } : row,
    );
    db.messages = [directMessage()];

    await processMessageNotification(MESSAGE_ID);

    assert.ok(
      lastEmail().text.includes(
        "A MakeHijrah consultant sent you a new message.",
      ),
    );
  });

  it("encodes the protected redirect path", async () => {
    db.messages = [directMessage()];

    await processMessageNotification(MESSAGE_ID);

    const email = lastEmail();

    assert.ok(email.text.includes("/login?redirect=%2Fadmin%2Fmessages"));
    assert.ok(!email.text.includes("/login?redirect=/admin/messages"));
  });

  it("reuses the whitespace-normalized escaped preview", async () => {
    db.messages = [
      directMessage({
        body: "  Salaam,\n\n  a direct   question <script>  ",
      }),
    ];

    await processMessageNotification(MESSAGE_ID);

    const email = lastEmail();

    assert.ok(
      email.text.includes("Salaam, a direct question <script>"),
    );
    assert.ok(email.html.includes("&lt;script&gt;"));
    assert.ok(!email.html.includes("<script>"));
  });

  it("suppresses delivery when the recipient has no usable email", async () => {
    db.profiles = db.profiles.map((row) =>
      row.id === ADMIN_ID ? { ...row, email: null } : row,
    );
    db.messages = [directMessage()];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.deepEqual(result, {
      ok: true,
      action: "remove",
      outcome: "permanent_failure",
    });
    assert.equal(mandrillRequests.length, 0);
  });
});

describe("Direct message notification: Mandrill metadata", () => {
  it("carries exactly message_id, sender_role and recipient_role", async () => {
    db.messages = [directMessage()];

    await processMessageNotification(MESSAGE_ID);

    const metadata = lastEmail().metadata;

    assert.deepEqual(metadata, {
      message_id: MESSAGE_ID,
      sender_role: "consultant",
      recipient_role: "admin",
    });

    assert.deepEqual(Object.keys(metadata ?? {}).sort(), [
      "message_id",
      "recipient_role",
      "sender_role",
    ]);
  });

  it("reverses the roles for an admin sender", async () => {
    db.messages = [
      directMessage({
        sender_profile_id: ADMIN_ID,
        recipient_profile_id: CONSULTANT_ID,
      }),
    ];

    await processMessageNotification(MESSAGE_ID);

    assert.deepEqual(lastEmail().metadata, {
      message_id: MESSAGE_ID,
      sender_role: "admin",
      recipient_role: "consultant",
    });
  });

  it("never leaks the body, a consultation id, an email or a name", async () => {
    db.messages = [
      directMessage({ body: "SENSITIVE-BODY-MARKER" }),
    ];

    await processMessageNotification(MESSAGE_ID);

    const serialized = JSON.stringify(lastEmail().metadata);

    assert.ok(!serialized.includes("SENSITIVE-BODY-MARKER"));
    assert.ok(!serialized.includes("consultation"));
    assert.ok(!serialized.includes("null"));
    assert.ok(!serialized.includes("@"));
    assert.ok(!serialized.includes("Aisha"));
  });

  it("omits metadata entirely for consultation messages", async () => {
    db.messages = [consultationMessage()];

    await processMessageNotification(MESSAGE_ID);

    assert.equal(
      Object.prototype.hasOwnProperty.call(lastEmail(), "metadata"),
      false,
    );
  });
});

describe("Direct message notification: idempotency and delivery", () => {
  it("schedules with NX so duplicate requests do not queue twice", async () => {
    db.messages = [directMessage()];

    const first = await scheduleMessageNotification({
      messageId: MESSAGE_ID,
      senderProfileId: CONSULTANT_ID,
    });

    const second = await scheduleMessageNotification({
      messageId: MESSAGE_ID,
      senderProfileId: CONSULTANT_ID,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(zaddCalls.length, 2);
    assert.ok(zaddCalls.every((call) => call.nx));
    assert.equal(dueSet.size, 1);
    assert.equal(dueSet.get(MESSAGE_ID), Date.parse("2026-07-29T10:01:30.000Z"));
  });

  it("suppresses scheduling when the message is already read", async () => {
    db.messages = [
      directMessage({ read_at: "2026-07-29T10:00:30.000Z" }),
    ];

    const result = await scheduleMessageNotification({
      messageId: MESSAGE_ID,
      senderProfileId: CONSULTANT_ID,
    });

    assert.deepEqual(result, {
      ok: true,
      messageId: MESSAGE_ID,
      notification: "suppressed",
    });
    assert.equal(zaddCalls.length, 0);
  });

  it("does not send when the message was read during the delay", async () => {
    db.messages = [
      directMessage({ read_at: "2026-07-29T10:01:00.000Z" }),
    ];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.deepEqual(result, {
      ok: true,
      action: "remove",
      outcome: "read",
    });
    assert.equal(mandrillRequests.length, 0);
    assert.equal(updateCalls.length, 0);
  });

  it("sends an unread direct message exactly once", async () => {
    db.messages = [directMessage()];

    const first = await processMessageNotification(MESSAGE_ID);
    const second = await processMessageNotification(MESSAGE_ID);

    assert.equal(
      (first as { outcome: string }).outcome,
      "sent",
    );
    assert.equal(
      (second as { outcome: string }).outcome,
      "already_sent",
    );
    assert.equal(mandrillRequests.length, 1);
  });

  it("writes email_notification_sent_at only after a successful send", async () => {
    db.messages = [directMessage()];

    await processMessageNotification(MESSAGE_ID);

    assert.equal(updateCalls.length, 1);

    const call = updateCalls[0]!;

    assert.equal(call.table, "messages");
    assert.deepEqual(Object.keys(call.values ?? {}), [
      "email_notification_sent_at",
    ]);
    assert.equal(call.matched, 1);
    assert.ok(db.messages[0]!.email_notification_sent_at);
  });

  it("does not mark sent when Mandrill rejects the recipient", async () => {
    mandrillMode = "rejected";
    db.messages = [directMessage()];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.equal(result.ok, false);
    assert.equal(
      (result as { action: string }).action,
      "retry",
    );
    assert.equal(updateCalls.length, 0);
    assert.equal(db.messages[0]!.email_notification_sent_at, null);
  });

  it("does not mark sent when the Mandrill request fails", async () => {
    mandrillMode = "http_error";
    db.messages = [directMessage()];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.equal(result.ok, false);
    assert.equal(
      (result as { action: string }).action,
      "retry",
    );
    assert.equal(updateCalls.length, 0);
    assert.equal(db.messages[0]!.email_notification_sent_at, null);
  });

  it("guards the sent-timestamp update on unread and unsent", async () => {
    db.messages = [directMessage()];

    await processMessageNotification(MESSAGE_ID);

    /*
     * The update matched while unread and unmarked. Re-running it
     * against the now-marked row must match nothing, which is what
     * makes a concurrent second worker harmless.
     */
    updateCalls = [];
    db.messages[0]!.email_notification_sent_at = "2026-07-29T10:02:00.000Z";

    const repeat = await processMessageNotification(MESSAGE_ID);

    assert.equal(
      (repeat as { outcome: string }).outcome,
      "already_sent",
    );
    assert.equal(updateCalls.length, 0);
  });
});

describe("Consultation message notification: unchanged", () => {
  it("still uses the consultation-message tag and consultation portal link", async () => {
    db.messages = [consultationMessage()];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.equal(
      (result as { outcome: string }).outcome,
      "sent",
    );

    const email = lastEmail();

    assert.deepEqual(email.tags, ["consultation-message"]);
    assert.equal(
      email.subject,
      "You have a new MakeHijrah message",
    );
    assert.ok(
      email.text.includes(
        `login?redirect=%2Fdashboard%2Fconsultation%2F${CONSULTATION_ID}`,
      ),
      email.text,
    );
  });

  it("still routes a consultant recipient to the consultant consultation page", async () => {
    db.messages = [
      consultationMessage({
        sender_profile_id: CLIENT_ID,
        recipient_profile_id: CONSULTANT_ID,
      }),
    ];

    await processMessageNotification(MESSAGE_ID);

    assert.ok(
      lastEmail().text.includes(
        `login?redirect=%2Fconsultant%2Fconsultation%2F${CONSULTATION_ID}`,
      ),
    );
  });

  it("still falls back to the client intake email", async () => {
    db.profiles = db.profiles.map((row) =>
      row.id === CLIENT_ID ? { ...row, email: null, full_name: null } : row,
    );
    db.consultation_intake = [
      {
        consultation_id: CONSULTATION_ID,
        full_name: "Intake Name",
        email: "intake@example.test",
      },
    ];
    db.messages = [consultationMessage()];

    await processMessageNotification(MESSAGE_ID);

    const email = lastEmail();

    assert.equal(email.to[0]!.email, "intake@example.test");
    assert.ok(email.text.includes("Assalamu alaikum Intake Name,"));
  });

  it("still rejects a non-participant recipient", async () => {
    db.messages = [
      consultationMessage({
        recipient_profile_id: STRANGER_ID,
      }),
    ];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.deepEqual(result, {
      ok: true,
      action: "remove",
      outcome: "permanent_failure",
    });
    assert.equal(mandrillRequests.length, 0);
  });

  it("still suppresses a consultation message read during the delay", async () => {
    db.messages = [
      consultationMessage({ read_at: "2026-07-29T10:01:00.000Z" }),
    ];

    const result = await processMessageNotification(MESSAGE_ID);

    assert.deepEqual(result, {
      ok: true,
      action: "remove",
      outcome: "read",
    });
    assert.equal(mandrillRequests.length, 0);
  });

  it("still lets a client schedule their own consultation message", async () => {
    db.messages = [
      consultationMessage({
        sender_profile_id: CLIENT_ID,
        recipient_profile_id: CONSULTANT_ID,
      }),
    ];

    const response = await post(MESSAGE_ID, CLIENT_ID);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.notification, "scheduled");
  });
});
