/*
 * Blog manager invitations.
 *
 * The problem being solved: an admin could grant blog access to an
 * email address that had no account, and that person could never
 * get one. The frontend signs in with shouldCreateUser: false and
 * there is no public sign-up, so account creation needs the
 * service role and therefore has to happen here.
 *
 * Supabase (PostgREST and the Auth admin API) and Mandrill are all
 * replaced with in-memory fakes. Mandrill is intercepted at the
 * fetch boundary so the real lib/mandrill.ts payload builder runs
 * and the assertions are on the actual outgoing email.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://blog-invite-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_SECRET_KEY: "sk_test_blog_invite",
  STRIPE_WEBHOOK_SECRET: "whsec_blog_invite",
  STRIPE_TEST_SECRET_KEY: "sk_test_blog_invite",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_blog_invite",
  STRIPE_LIVE_SECRET_KEY: "sk_live_blog_invite",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_blog_invite",
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
const { registerBlogManagerInviteRoute } = await import(
  "./blog-manager-invite.route.js"
);

/* Variant bits must be 8, 9, a or b for a valid v4 UUID. */
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const CONSULTANT_ID = "33333333-3333-4333-8333-333333333333";

const EXISTING_EMAIL = "already@example.test";
const NEW_EMAIL = "brand.new@example.test";

type Row = Record<string, unknown>;

type FakeDatabase = {
  profiles: Row[];
  blog_managers: Row[];
};

const db: FakeDatabase = { profiles: [], blog_managers: [] };

type AuthUser = { id: string; email: string };

let authUsers: AuthUser[] = [];
let createUserCalls: string[] = [];
let createUserFails = false;
let listUsersFails = false;
let uniqueViolationOnce = false;

let idCounter = 0;
const nextId = (): string => {
  idCounter += 1;

  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(idCounter).padStart(12, "0")}`;
};

const tableRows = (table: string): Row[] =>
  (db as unknown as Record<string, Row[] | undefined>)[table] ?? [];

const dbError = (code: string, message: string) => ({
  code,
  message,
  details: null,
  hint: null,
});

class FakeQuery {
  private readonly table: string;
  private readonly filters: Array<(row: Row) => boolean> = [];
  private op: "select" | "insert" | "update" = "select";
  private values: Row | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(): this {
    return this;
  }

  insert(values: Row): this {
    this.op = "insert";
    this.values = values;

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

  private matched(): Row[] {
    return tableRows(this.table).filter((row) =>
      this.filters.every((f) => f(row)),
    );
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    if (this.op === "insert") {
      const normalized = String(
        this.values?.email ?? "",
      )
        .trim()
        .toLowerCase();

      /* The unique index on lower(btrim(email)). */
      const clash = tableRows(this.table).some(
        (row) =>
          String(row.email ?? "").trim().toLowerCase() ===
          normalized,
      );

      if (clash || uniqueViolationOnce) {
        uniqueViolationOnce = false;

        return {
          data: null,
          error: dbError(
            "23505",
            'duplicate key value violates unique constraint "uq_blog_managers_email"',
          ),
        };
      }

      const row: Row = {
        id: nextId(),
        granted_at: "2026-09-01T12:00:00.000Z",
        note: null,
        ...this.values,
      };

      tableRows(this.table).push(row);

      return { data: row, error: null };
    }

    if (this.op === "update") {
      const rows = this.matched();

      for (const row of rows) {
        Object.assign(row, this.values ?? {});
      }

      return { data: rows[0] ?? null, error: null };
    }

    return { data: this.matched()[0] ?? null, error: null };
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
  admin: {
    listUsers: async () => {
      if (listUsersFails) {
        return {
          data: { users: [] },
          error: { message: "listUsers failed", status: 500 },
        };
      }

      return { data: { users: authUsers }, error: null };
    },
    createUser: async ({ email }: { email: string }) => {
      createUserCalls.push(email);

      if (createUserFails) {
        return {
          data: { user: null },
          error: {
            message: "createUser failed",
            status: 500,
          },
        };
      }

      const user = { id: nextId(), email };

      authUsers.push(user);

      /* handle_new_user creates the profile row. */
      db.profiles.push({
        id: user.id,
        role: "client",
        full_name: null,
        email,
      });

      return { data: { user }, error: null };
    },
  },
} as unknown as typeof supabaseAdmin.auth;

type MandrillPayload = {
  message: {
    subject: string;
    html: string;
    text: string;
    tags: string[];
    to: Array<{ email: string }>;
  };
};

let mandrillRequests: MandrillPayload[] = [];
let mandrillFails = false;

globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
  mandrillRequests.push(
    JSON.parse(String(init.body)) as MandrillPayload,
  );

  if (mandrillFails) {
    return new Response("upstream failure", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }

  return new Response(
    JSON.stringify([
      { email: "x@example.test", status: "sent", _id: "m-1" },
    ]),
    { status: 200 },
  );
}) as unknown as typeof fetch;

const post = async (
  body: unknown,
  token: string | null = ADMIN_ID,
) => {
  const app = Fastify();

  await registerBlogManagerInviteRoute(app);

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/blog-managers/invite",
      headers: token
        ? { authorization: `Bearer ${token}` }
        : {},
      payload: body as Record<string, unknown>,
    });

    return {
      statusCode: response.statusCode,
      body: response.json() as {
        ok: boolean;
        data?: { blog_manager: Record<string, unknown> };
        error?: {
          code: string;
          message: string;
          details?: { reason?: string };
        };
      },
    };
  } finally {
    await app.close();
  }
};

beforeEach(() => {
  idCounter = 0;
  db.blog_managers = [];
  db.profiles = [
    { id: ADMIN_ID, role: "admin", email: "admin@example.test" },
    { id: CLIENT_ID, role: "client", email: "client@example.test" },
    {
      id: CONSULTANT_ID,
      role: "consultant",
      email: "consultant@example.test",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      role: "client",
      email: EXISTING_EMAIL,
    },
  ];
  authUsers = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      email: EXISTING_EMAIL,
    },
  ];
  createUserCalls = [];
  createUserFails = false;
  listUsersFails = false;
  uniqueViolationOnce = false;
  mandrillRequests = [];
  mandrillFails = false;
});

describe("Blog manager invite: access control", () => {
  it("refuses a consultant", async () => {
    const response = await post(
      { email: NEW_EMAIL },
      CONSULTANT_ID,
    );

    assert.equal(response.statusCode, 403);
    assert.equal(response.body.ok, false);
    assert.equal(db.blog_managers.length, 0);
    assert.deepEqual(createUserCalls, []);
  });

  it("refuses an ordinary client", async () => {
    const response = await post({ email: NEW_EMAIL }, CLIENT_ID);

    assert.equal(response.statusCode, 403);
    assert.equal(db.blog_managers.length, 0);
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await post({ email: NEW_EMAIL }, null);

    assert.equal(response.statusCode, 401);
    assert.equal(response.body.ok, false);
    assert.equal(db.blog_managers.length, 0);
    assert.deepEqual(createUserCalls, []);
  });
});

describe("Blog manager invite: validation", () => {
  for (const email of [
    "not-an-email",
    "no-domain@",
    "@no-local.test",
    "spaces in@example.test",
    "trailing@dot.",
  ]) {
    it(`rejects ${JSON.stringify(email)} with a reason`, async () => {
      const response = await post({ email });

      assert.equal(response.statusCode, 400);
      assert.equal(
        response.body.error?.code,
        "VALIDATION_ERROR",
      );
      assert.ok(response.body.error?.details?.reason);
      assert.equal(db.blog_managers.length, 0);
      assert.deepEqual(createUserCalls, []);
    });
  }

  it("rejects an unknown field, because the schema is strict", async () => {
    const response = await post({
      email: NEW_EMAIL,
      role: "admin",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(
      response.body.error?.details?.reason,
      "invalid_body",
    );
  });
});

describe("Blog manager invite: a brand-new address", () => {
  it("creates the auth account", async () => {
    const response = await post({ email: NEW_EMAIL });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(createUserCalls, [NEW_EMAIL]);
  });

  it("grants access linked to the new profile", async () => {
    const response = await post({ email: NEW_EMAIL });

    const grant = response.body.data?.blog_manager;
    const created = authUsers.find(
      (user) => user.email === NEW_EMAIL,
    );

    assert.equal(db.blog_managers.length, 1);
    assert.equal(grant?.email, NEW_EMAIL);
    assert.equal(grant?.profile_id, created?.id);
    assert.ok(grant?.granted_at);
  });

  it("reports account_created true", async () => {
    const response = await post({ email: NEW_EMAIL });

    assert.equal(
      response.body.data?.blog_manager.account_created,
      true,
    );
  });

  it("leaves the new account on role client", async () => {
    await post({ email: NEW_EMAIL });

    const created = authUsers.find(
      (user) => user.email === NEW_EMAIL,
    );
    const profile = db.profiles.find(
      (row) => row.id === created?.id,
    );

    assert.equal(profile?.role, "client");
  });

  it("records the granting admin", async () => {
    await post({ email: NEW_EMAIL });

    assert.equal(db.blog_managers[0]?.granted_by, ADMIN_ID);
  });

  it("normalises the address before storing it", async () => {
    const response = await post({
      email: "  MiXeD.Case@Example.TEST  ",
    });

    assert.equal(
      response.body.data?.blog_manager.email,
      "mixed.case@example.test",
    );
    assert.deepEqual(createUserCalls, [
      "mixed.case@example.test",
    ]);
  });

  it("stores an optional note", async () => {
    const response = await post({
      email: NEW_EMAIL,
      note: "Writes the relocation guides",
    });

    assert.equal(
      response.body.data?.blog_manager.note,
      "Writes the relocation guides",
    );
  });
});

describe("Blog manager invite: an existing account", () => {
  it("does not create a second auth user", async () => {
    await post({ email: EXISTING_EMAIL });

    assert.deepEqual(createUserCalls, []);
    assert.equal(authUsers.length, 1);
  });

  it("reports account_created false", async () => {
    const response = await post({ email: EXISTING_EMAIL });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.body.data?.blog_manager.account_created,
      false,
    );
  });

  it("links the grant to the existing profile", async () => {
    const response = await post({ email: EXISTING_EMAIL });

    assert.equal(
      response.body.data?.blog_manager.profile_id,
      "44444444-4444-4444-8444-444444444444",
    );
  });
});

describe("Blog manager invite: idempotency", () => {
  it("succeeds when the same address is invited twice", async () => {
    const first = await post({ email: NEW_EMAIL });
    const second = await post({ email: NEW_EMAIL });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.ok, true);
  });

  it("does not create a duplicate grant row", async () => {
    await post({ email: NEW_EMAIL });
    await post({ email: NEW_EMAIL });

    assert.equal(db.blog_managers.length, 1);
  });

  it("does not create a duplicate account on the second invite", async () => {
    await post({ email: NEW_EMAIL });
    await post({ email: NEW_EMAIL });

    assert.deepEqual(createUserCalls, [NEW_EMAIL]);
    assert.equal(
      authUsers.filter((u) => u.email === NEW_EMAIL).length,
      1,
    );
  });

  it("re-sends the email on the second invite", async () => {
    await post({ email: NEW_EMAIL });
    await post({ email: NEW_EMAIL });

    assert.equal(mandrillRequests.length, 2);
  });

  it("treats a differently-cased address as the same grant", async () => {
    await post({ email: NEW_EMAIL });
    await post({ email: NEW_EMAIL.toUpperCase() });

    assert.equal(db.blog_managers.length, 1);
  });

  it("keeps the original granted_at across a re-invite", async () => {
    const first = await post({ email: NEW_EMAIL });
    const second = await post({ email: NEW_EMAIL });

    assert.equal(
      second.body.data?.blog_manager.granted_at,
      first.body.data?.blog_manager.granted_at,
    );
    assert.equal(
      second.body.data?.blog_manager.id,
      first.body.data?.blog_manager.id,
    );
  });

  it("survives a concurrent insert losing the unique index race", async () => {
    /*
     * Two admins pressing invite at the same instant: the insert
     * loses on uq_blog_managers_email and must resolve to the row
     * that won, not surface a 23505.
     */
    db.blog_managers.push({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      email: NEW_EMAIL,
      profile_id: null,
      granted_by: ADMIN_ID,
      granted_at: "2026-08-01T00:00:00.000Z",
      note: null,
    });
    uniqueViolationOnce = true;

    const response = await post({ email: NEW_EMAIL });

    assert.equal(response.statusCode, 200);
    assert.equal(db.blog_managers.length, 1);
  });
});

describe("Blog manager invite: the email", () => {
  it("links to the login page with the blog admin redirect", async () => {
    await post({ email: NEW_EMAIL });

    const message = mandrillRequests[0]!.message;
    const expected =
      "https://app.example.test/login?redirect=%2Fblog%2Fadmin";

    assert.ok(message.html.includes(expected));
    assert.ok(message.text.includes(expected));
  });

  it("goes to the invited address and is tagged", async () => {
    await post({ email: NEW_EMAIL });

    const message = mandrillRequests[0]!.message;

    assert.equal(message.to[0]?.email, NEW_EMAIL);
    assert.deepEqual(message.tags, ["blog-manager-invite"]);
  });

  it("says a code will be sent and never implies a password", async () => {
    await post({ email: NEW_EMAIL });

    const message = mandrillRequests[0]!.message;

    assert.match(message.text, /send you a code/);
    assert.match(message.text, /Make Hijrah blog/);
    assert.ok(!/\bpassword\b/i.test(message.text.replace(/no password to set/i, "")));
  });

  it("still grants access when the send fails", async () => {
    mandrillFails = true;

    const response = await post({ email: NEW_EMAIL });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(
      response.body.data?.blog_manager.email_sent,
      false,
    );
    assert.equal(
      response.body.data?.blog_manager.account_created,
      true,
    );
    assert.equal(db.blog_managers.length, 1);
  });

  it("reports email_sent true on a good send", async () => {
    const response = await post({ email: NEW_EMAIL });

    assert.equal(
      response.body.data?.blog_manager.email_sent,
      true,
    );
  });
});

describe("Blog manager invite: failures leak nothing", () => {
  it("returns a reason, not Supabase text, when account creation fails", async () => {
    createUserFails = true;

    const response = await post({ email: NEW_EMAIL });

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error?.code, "INTERNAL_ERROR");
    assert.equal(
      response.body.error?.details?.reason,
      "account_creation_failed",
    );
    assert.equal(db.blog_managers.length, 0);
  });

  it("returns a reason when the account lookup fails", async () => {
    listUsersFails = true;

    const response = await post({ email: NEW_EMAIL });

    assert.equal(response.statusCode, 500);
    assert.equal(
      response.body.error?.details?.reason,
      "account_lookup_failed",
    );
  });

  it("carries no raw database text in any response", async () => {
    const responses = [];

    createUserFails = true;
    responses.push(await post({ email: NEW_EMAIL }));

    createUserFails = false;
    listUsersFails = true;
    responses.push(await post({ email: NEW_EMAIL }));

    listUsersFails = false;
    responses.push(await post({ email: "not-an-email" }));
    responses.push(await post({ email: NEW_EMAIL }));

    for (const response of responses) {
      const body = JSON.stringify(response.body);

      assert.ok(
        !/duplicate key|violates|constraint|SQLSTATE|23505|PGRST|pg_|at Object\./i.test(
          body,
        ),
        `raw database text leaked: ${body}`,
      );
    }
  });
});
