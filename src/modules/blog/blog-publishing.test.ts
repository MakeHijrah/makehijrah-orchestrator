/*
 * Scheduled blog publishing: the orchestrator-side wrapper only.
 *
 * publish_due_blog_posts() itself -- the predicate, the
 * published_at rule, the idempotency a periodic worker depends on
 * -- is proven against real PostgreSQL in
 * MIGRATION_056_VERIFICATION.sql, Part 2. This file tests the thin
 * TypeScript layer around it: that the service calls the RPC by
 * name with no arguments, maps its result correctly, and that the
 * worker's cycle calls the service and does not throw when the RPC
 * fails.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "staging",
  SUPABASE_URL: "https://blog-publishing-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  STRIPE_TEST_SECRET_KEY: "sk_test_blog",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_blog",
  STRIPE_LIVE_SECRET_KEY: "sk_live_blog",
  STRIPE_LIVE_WEBHOOK_SECRET: "whsec_live_blog",
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
const { publishDueBlogPosts } = await import(
  "./blog-publishing.service.js"
);
const { runBlogPublishingCycleForTest } = await import(
  "./blog-publishing.worker.js"
);

type RpcCall = { name: string; args: unknown };

let rpcCalls: RpcCall[] = [];
let nextResult: { data: unknown; error: unknown } = {
  data: 0,
  error: null,
};

supabaseAdmin.rpc = (async (
  name: string,
  args?: unknown,
) => {
  rpcCalls.push({ name, args });
  return nextResult;
}) as unknown as typeof supabaseAdmin.rpc;

/*
 * Stubbed rather than left to reach a real Redis, matching this
 * repo's established convention for testing a worker's cycle lock
 * (draft-preparation.test.ts, service-instructions.test.ts). The
 * lock is an optimisation the worker's own correctness does not
 * depend on -- see blog-publishing.worker.ts -- so these tests
 * exercise the RPC-calling behaviour, not the lock itself.
 */
redis.set = (async () =>
  "OK") as unknown as typeof redis.set;
redis.eval = (async () =>
  1) as unknown as typeof redis.eval;

beforeEach(() => {
  rpcCalls = [];
  nextResult = { data: 0, error: null };
});

describe("publishDueBlogPosts", () => {
  it("calls publish_due_blog_posts with no arguments", async () => {
    await publishDueBlogPosts();

    assert.equal(rpcCalls.length, 1);
    assert.equal(
      rpcCalls[0]!.name,
      "publish_due_blog_posts",
    );
    assert.equal(rpcCalls[0]!.args, undefined);
  });

  it("reports the published count the RPC returns", async () => {
    nextResult = { data: 3, error: null };

    const result = await publishDueBlogPosts();

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.publishedCount,
      3,
    );
  });

  it("reports zero when nothing was due", async () => {
    nextResult = { data: 0, error: null };

    const result = await publishDueBlogPosts();

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.publishedCount,
      0,
    );
  });

  it("reports failure without throwing when the RPC errors", async () => {
    nextResult = {
      data: null,
      error: { message: "permission denied", code: "42501" },
    };

    const result = await publishDueBlogPosts();

    assert.equal(result.ok, false);
    assert.equal(
      !result.ok && result.message,
      "permission denied",
    );
  });

  it("treats a non-numeric RPC result as zero rather than throwing", async () => {
    /* Defensive: the RPC always returns an integer, but the
     * service must not crash the worker cycle if that ever
     * changes. */
    nextResult = { data: null, error: null };

    const result = await publishDueBlogPosts();

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.publishedCount,
      0,
    );
  });
});

describe("blog publishing worker cycle", () => {
  it("calls the RPC exactly once per cycle", async () => {
    await runBlogPublishingCycleForTest();

    const publishCalls = rpcCalls.filter(
      (call) => call.name === "publish_due_blog_posts",
    );

    assert.equal(publishCalls.length, 1);
  });

  it("does not throw when the RPC reports an error", async () => {
    nextResult = {
      data: null,
      error: { message: "connection reset", code: "08006" },
    };

    await assert.doesNotReject(async () => {
      await runBlogPublishingCycleForTest();
    });
  });
});
