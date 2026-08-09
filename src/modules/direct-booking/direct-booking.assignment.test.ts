/*
 * Default slug generation and backfill. Amendment 012.
 *
 * A consultant no longer chooses their own booking link, so one has
 * to be derived for them — from the name the platform already
 * publishes, through the same normalizer every other slug goes
 * through, and never twice for the same consultant.
 *
 * Two rules carry the whole design, and both are asserted here:
 *
 *   a slug is assigned only when there is none, so a link never
 *   moves on its own; and
 *
 *   GENERATED defaults may suffix while ADMIN-entered ones may not,
 *   because nobody asked for john-smith-2 but somebody did type
 *   what they typed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://slug-assignment-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_slug",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_slug",
  STRIPE_LIVE_SECRET_KEY: "sk_live_slug",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_slug",
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
const {
  buildDefaultSlugCandidates,
  buildRandomSlugCandidate,
  buildSlugBase,
  buildSlugCandidate,
  SLUG_MAX_LENGTH,
} = await import("./direct-booking.slug.js");
const {
  assignDefaultSlugIfMissing,
  backfillConsultantSlugs,
} = await import("./direct-booking.assignment.service.js");

type Row = Record<string, unknown>;

const db: { consultants: Row[]; profiles: Row[] } = {
  consultants: [],
  profiles: [],
};

const consultant = (overrides: Row = {}): Row => ({
  id: `id-${db.consultants.length + 1}`,
  profile_id: `profile-${db.consultants.length + 1}`,
  display_name: "John Smith",
  consultant_slug: null,
  is_active: true,
  ...overrides,
});

/*
 * A fake that honours the parts of the query that carry the safety
 * argument: `.is('consultant_slug', null)` on the claim, and the
 * unique index. A stub that ignored either would make the
 * never-overwrite tests meaningless.
 */
class FakeQuery {
  private readonly table: string;
  private columns: string[] = [];
  private readonly filters: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;
  private max: number | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(columns?: string): this {
    this.columns = (columns ?? "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);

    return this;
  }

  update(values: Row): this {
    this.patch = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push(
      (row) => row[column] === value,
    );

    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push(
      (row) => row[column] !== value,
    );

    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push(
      (row) => (row[column] ?? null) === value,
    );

    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.max = count;
    return this;
  }

  private rows(): Row[] {
    return (
      (db as unknown as Record<string, Row[] | undefined>)[
        this.table
      ] ?? []
    );
  }

  private matched(): Row[] {
    return this.rows().filter((row) =>
      this.filters.every((matches) => matches(row)),
    );
  }

  private resolve(): {
    data: Row[];
    error: unknown;
  } {
    if (this.patch) {
      const targets = this.matched();
      const patch = this.patch;

      /* The unique index, reproduced. */
      if (
        typeof patch.consultant_slug === "string"
      ) {
        const clash = this.rows().find(
          (row) =>
            row.consultant_slug ===
              patch.consultant_slug &&
            !targets.includes(row),
        );

        if (clash) {
          return {
            data: [],
            error: {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "uq_consultants_slug"',
            },
          };
        }
      }

      for (const row of targets) {
        Object.assign(row, patch);
      }

      return { data: targets, error: null };
    }

    let rows = this.matched();

    if (this.max !== null) {
      rows = rows.slice(0, this.max);
    }

    return { data: rows, error: null };
  }

  async maybeSingle(): Promise<{
    data: Row | null;
    error: unknown;
  }> {
    const result = this.resolve();

    return {
      data: result.error
        ? null
        : (result.data[0] ?? null),
      error: result.error,
    };
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
    return Promise.resolve(
      this.resolve(),
    ).then(onFulfilled, onRejected);
  }
}

supabaseAdmin.from = ((table: string) =>
  new FakeQuery(table)) as unknown as typeof supabaseAdmin.from;

const slugOf = (id: string): unknown =>
  db.consultants.find((row) => row.id === id)
    ?.consultant_slug;

beforeEach(() => {
  db.consultants = [];
  db.profiles = [];
});

describe("Slug base derivation", () => {
  it("turns a full name into a readable link", () => {
    assert.equal(
      buildSlugBase("Abu Mansur Omar Sherrer"),
      "abu-mansur-omar-sherrer",
    );
  });

  it("normalizes case and spacing", () => {
    assert.equal(
      buildSlugBase("  JOHN   SMITH  "),
      "john-smith",
    );
  });

  it("treats punctuation as a separator", () => {
    /*
     * A run of punctuation is one hyphen, never two, and never a
     * leading or trailing one.
     */
    assert.equal(
      buildSlugBase("O'Brien"),
      "o-brien",
    );

    assert.equal(
      buildSlugBase("Dr. Yusuf Al-Amin, PhD"),
      "dr-yusuf-al-amin-phd",
    );
  });

  it("uses the existing normalizer for diacritics", () => {
    /*
     * Decomposed and stripped, not hyphenated: Ålesund is alesund,
     * not a-lesund. Nothing is percent-encoded — this value goes
     * in a path segment somebody has to type.
     */
    assert.equal(
      buildSlugBase("Ålesund"),
      "alesund",
    );

    assert.equal(
      buildSlugBase("Aïsha Rahman"),
      "aisha-rahman",
    );
  });

  it("reports a name that reduces to nothing", () => {
    assert.equal(buildSlugBase("!!!"), null);
    assert.equal(buildSlugBase(""), null);
    assert.equal(buildSlugBase(null), null);
  });

  it("never emits a base longer than the column allows", () => {
    const base = buildSlugBase(
      "Abdul ".repeat(30),
    )!;

    assert.ok(
      base.length <= SLUG_MAX_LENGTH,
      `base was ${base.length} characters`,
    );

    assert.ok(!base.endsWith("-"));
  });
});

describe("Slug candidates", () => {
  it("numbers from two upward", () => {
    /*
     * The first consultant of a name holds the unsuffixed link, so
     * "-1" would name nobody.
     */
    assert.equal(
      buildSlugCandidate({
        base: "john-smith",
        attempt: 1,
      }),
      "john-smith",
    );

    assert.equal(
      buildSlugCandidate({
        base: "john-smith",
        attempt: 2,
      }),
      "john-smith-2",
    );

    assert.equal(
      buildSlugCandidate({
        base: "john-smith",
        attempt: 3,
      }),
      "john-smith-3",
    );
  });

  it("truncates the base so the suffix still fits", () => {
    const base = "a".repeat(SLUG_MAX_LENGTH);

    const candidate = buildSlugCandidate({
      base,
      attempt: 12,
    });

    assert.ok(
      candidate.length <= SLUG_MAX_LENGTH,
      `candidate was ${candidate.length} characters`,
    );

    assert.ok(candidate.endsWith("-12"));
  });

  it("does not leave a doubled hyphen when it truncates", () => {
    /*
     * Truncating "john-smith-jones" mid-word could leave a
     * trailing hyphen, and "john-" + "-2" is a doubled hyphen the
     * database's format check would refuse.
     */
    const base = `${"ab-".repeat(25)}c`;

    const candidate = buildSlugCandidate({
      base,
      attempt: 5,
    });

    assert.ok(!candidate.includes("--"));
    assert.match(
      candidate,
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
    );
  });

  it("skips a reserved base rather than refusing it", () => {
    /*
     * A consultant genuinely called "Admin" gets admin-2, not a
     * failed activation. This is the one place suffixing happens
     * without anybody being asked.
     */
    const candidates =
      buildDefaultSlugCandidates("Admin");

    assert.equal(
      candidates.includes("admin"),
      false,
    );

    assert.equal(candidates[0], "admin-2");
  });

  it("skips a base that is too short to stand alone", () => {
    const candidates =
      buildDefaultSlugCandidates("Jo");

    assert.equal(candidates.includes("jo"), false);
    assert.equal(candidates[0], "jo-2");
  });

  it("gives a nameless consultant a usable random link", () => {
    const candidate = buildRandomSlugCandidate({
      base: null,
      random: "a1b2c3",
    });

    /* "consultant" alone is reserved; this is not. */
    assert.equal(
      candidate,
      "consultant-a1b2c3",
    );
  });
});

describe("Assigning a default slug", () => {
  it("assigns from the display name", async () => {
    db.consultants = [consultant()];

    const result =
      await assignDefaultSlugIfMissing({
        consultantId: "id-1",
      });

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.slug,
      "john-smith",
    );
    assert.equal(
      result.ok && result.assigned,
      true,
    );
    assert.equal(
      slugOf("id-1"),
      "john-smith",
    );
  });

  it("falls back to the authoritative profile name", async () => {
    db.consultants = [
      consultant({ display_name: null }),
    ];

    db.profiles = [
      {
        id: "profile-1",
        full_name: "Aisha Rahman",
      },
    ];

    const result =
      await assignDefaultSlugIfMissing({
        consultantId: "id-1",
      });

    /*
     * display_name is the public PROJECTION of profiles.full_name.
     * The authoritative field is a fallback, not a second name
     * authority — it is read only when the projection is empty.
     */
    assert.equal(
      result.ok && result.slug,
      "aisha-rahman",
    );
  });

  it("suffixes a duplicate, then suffixes again", async () => {
    db.consultants = [
      consultant({
        id: "id-1",
        consultant_slug: "john-smith",
      }),
      consultant({ id: "id-2" }),
      consultant({ id: "id-3" }),
    ];

    await assignDefaultSlugIfMissing({
      consultantId: "id-2",
    });

    await assignDefaultSlugIfMissing({
      consultantId: "id-3",
    });

    assert.equal(
      slugOf("id-2"),
      "john-smith-2",
    );
    assert.equal(
      slugOf("id-3"),
      "john-smith-3",
    );
  });

  it("never assigns a reserved name", async () => {
    db.consultants = [
      consultant({ display_name: "Dashboard" }),
    ];

    const result =
      await assignDefaultSlugIfMissing({
        consultantId: "id-1",
      });

    assert.equal(result.ok, true);
    assert.notEqual(
      result.ok && result.slug,
      "dashboard",
    );
    assert.equal(
      result.ok && result.slug,
      "dashboard-2",
    );
  });

  it("never overwrites a link that already exists", async () => {
    db.consultants = [
      consultant({
        consultant_slug: "chosen-by-an-admin",
      }),
    ];

    const result =
      await assignDefaultSlugIfMissing({
        consultantId: "id-1",
      });

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.slug,
      "chosen-by-an-admin",
    );
    assert.equal(
      result.ok && result.assigned,
      false,
    );
    assert.equal(
      slugOf("id-1"),
      "chosen-by-an-admin",
    );
  });

  it("does not regenerate when the name changes", async () => {
    db.consultants = [consultant()];

    await assignDefaultSlugIfMissing({
      consultantId: "id-1",
    });

    db.consultants[0]!.display_name =
      "Somebody Else";

    await assignDefaultSlugIfMissing({
      consultantId: "id-1",
    });

    /*
     * A link that moved when a name changed would break every
     * card, signature and post already carrying it.
     */
    assert.equal(
      slugOf("id-1"),
      "john-smith",
    );
  });

  it("reports a consultant with no usable name", async () => {
    db.consultants = [
      consultant({ display_name: "!!!" }),
    ];

    db.profiles = [
      { id: "profile-1", full_name: null },
    ];

    const result =
      await assignDefaultSlugIfMissing({
        consultantId: "id-1",
      });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "NO_USABLE_NAME",
    );

    assert.equal(slugOf("id-1"), null);
  });

  it("reports an unknown consultant", async () => {
    const result =
      await assignDefaultSlugIfMissing({
        consultantId: "nobody",
      });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.code,
      "CONSULTANT_NOT_FOUND",
    );
  });

  it("falls back to a random tail when the readable ones run out", async () => {
    /*
     * Twenty John Smiths already hold every readable candidate.
     * The twenty-first still gets a link rather than a failure.
     */
    db.consultants = [
      consultant({
        id: "id-1",
        consultant_slug: "john-smith",
      }),
    ];

    for (let n = 2; n <= 20; n += 1) {
      db.consultants.push(
        consultant({
          id: `id-${n}`,
          consultant_slug: `john-smith-${n}`,
        }),
      );
    }

    db.consultants.push(
      consultant({ id: "id-late" }),
    );

    const result =
      await assignDefaultSlugIfMissing({
        consultantId: "id-late",
      });

    assert.equal(result.ok, true);

    const slug = result.ok ? result.slug : "";

    assert.ok(
      slug.startsWith("john-smith-"),
      `unexpected slug ${slug}`,
    );
    assert.ok(slug.length <= SLUG_MAX_LENGTH);
    assert.match(
      slug,
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
    );
  });
});

describe("Backfill", () => {
  it("assigns only to active consultants with no link", async () => {
    db.consultants = [
      consultant({
        id: "has-one",
        consultant_slug: "already-here",
      }),
      consultant({
        id: "needs-one",
        display_name: "Aisha Rahman",
      }),
      consultant({
        id: "inactive",
        display_name: "Not Activated",
        is_active: false,
      }),
    ];

    const result =
      await backfillConsultantSlugs();

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.deepEqual(
      result.outcomes.map(
        (outcome) => outcome.consultantId,
      ),
      ["needs-one"],
    );

    assert.equal(
      slugOf("needs-one"),
      "aisha-rahman",
    );

    /* Untouched, both of them. */
    assert.equal(
      slugOf("has-one"),
      "already-here",
    );
    assert.equal(slugOf("inactive"), null);
  });

  it("is idempotent", async () => {
    db.consultants = [
      consultant({
        id: "needs-one",
        display_name: "Aisha Rahman",
      }),
    ];

    const first =
      await backfillConsultantSlugs();

    const second =
      await backfillConsultantSlugs();

    assert.equal(
      first.ok && first.outcomes.length,
      1,
    );
    assert.equal(
      second.ok && second.outcomes.length,
      0,
    );

    assert.equal(
      slugOf("needs-one"),
      "aisha-rahman",
    );
  });

  it("does not enable direct booking", async () => {
    db.consultants = [
      consultant({
        id: "needs-one",
        display_name: "Aisha Rahman",
        direct_booking_enabled: false,
      }),
    ];

    await backfillConsultantSlugs();

    /*
     * A link is an address, not a decision to publish. Switching
     * a page live stays the consultant's.
     */
    assert.equal(
      db.consultants[0]!.direct_booking_enabled,
      false,
    );
  });

  it("keeps going past a consultant it cannot name", async () => {
    db.consultants = [
      consultant({
        id: "nameless",
        display_name: "!!!",
      }),
      consultant({
        id: "fine",
        display_name: "Aisha Rahman",
      }),
    ];

    db.profiles = [
      { id: "profile-1", full_name: null },
    ];

    const result =
      await backfillConsultantSlugs();

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    /*
     * One bad row must not abandon the rest — a run that stopped
     * would have to be restarted by hand, and the failure is
     * reported either way.
     */
    assert.equal(
      result.outcomes.find(
        (outcome) =>
          outcome.consultantId === "nameless",
      )?.status,
      "failed",
    );

    assert.equal(
      slugOf("fine"),
      "aisha-rahman",
    );
  });
});
