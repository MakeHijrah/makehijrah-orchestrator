/*
 * CORS preflight contract for the browser frontend.
 *
 * The app under test registers the same options src/server.ts
 * registers, so these assertions describe deployed behaviour
 * rather than a copy of the configuration. Nothing external is
 * contacted: requests are injected, never sent over a socket.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { buildCorsOptions } from "./cors.js";

const APP_URL =
  "https://hijrah-consultation.lovable.app";

/* Any origin other than the single approved one. */
const FOREIGN_ORIGIN =
  "https://not-the-frontend.example.test";

/*
 * The exact header set the admin service catalog sends on
 * create: POST /api/admin/services carries a bearer token, a
 * JSON body and an Idempotency-Key.
 */
const REQUESTED_HEADERS =
  "authorization,content-type,idempotency-key";

const preflight = async (
  origin: string,
  options: {
    url?: string;
    method?: string;
    headers?: string;
  } = {},
): Promise<{
  statusCode: number;
  allowOrigin?: string;
  allowHeaders: string;
  allowMethods: string;
}> => {
  const app = Fastify({ logger: false });

  try {
    await app.register(
      cors,
      buildCorsOptions(APP_URL),
    );

    app.post(
      "/api/admin/services",
      async () => ({ ok: true }),
    );

    app.put(
      "/api/consultant/profile",
      async () => ({ ok: true }),
    );

    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url:
        options.url ??
        "/api/admin/services",
      headers: {
        origin,
        "access-control-request-method":
          options.method ?? "POST",
        "access-control-request-headers":
          options.headers ??
          REQUESTED_HEADERS,
      },
    });

    const header = (
      name: string,
    ): string =>
      String(
        response.headers[name] ?? "",
      ).toLowerCase();

    const allowOrigin =
      response.headers[
        "access-control-allow-origin"
      ];

    return {
      statusCode: response.statusCode,
      ...(typeof allowOrigin === "string"
        ? { allowOrigin }
        : {}),
      allowHeaders: header(
        "access-control-allow-headers",
      ),
      allowMethods: header(
        "access-control-allow-methods",
      ),
    };
  } finally {
    await app.close();
  }
};

describe("CORS preflight", () => {
  it("allows a create preflight carrying authorization, content-type and idempotency-key", async () => {
    const result =
      await preflight(APP_URL);

    assert.ok(
      result.statusCode < 300,
      `expected a successful preflight, received ${result.statusCode}`,
    );

    assert.equal(
      result.allowOrigin,
      APP_URL,
    );

    /*
     * Without this the browser blocks the create request before
     * it is sent, which is the failure this test exists for.
     */
    assert.ok(
      result.allowHeaders.includes(
        "idempotency-key",
      ),
    );
  });

  it("keeps the previously allowed request headers", async () => {
    const result =
      await preflight(APP_URL);

    for (const header of [
      "authorization",
      "content-type",
      "stripe-signature",
    ]) {
      assert.ok(
        result.allowHeaders.includes(
          header,
        ),
        `expected ${header} to remain allowed`,
      );
    }
  });

  it("allows PUT, which the consultant profile endpoint requires", async () => {
    const result = await preflight(APP_URL);

    assert.ok(
      result.allowMethods.includes("put"),
      `expected PUT to be allowed, received "${result.allowMethods}"`,
    );
  });

  it("allows a PUT preflight for /api/consultant/profile", async () => {
    const result = await preflight(APP_URL, {
      url: "/api/consultant/profile",
      method: "PUT",
      headers: "authorization,content-type",
    });

    assert.ok(
      result.statusCode < 300,
      `expected a successful preflight, received ${result.statusCode}`,
    );

    assert.equal(result.allowOrigin, APP_URL);

    assert.ok(
      result.allowMethods.includes("put"),
      "PUT must appear in the allowed methods",
    );

    for (const header of [
      "authorization",
      "content-type",
    ]) {
      assert.ok(
        result.allowHeaders.includes(header),
        `expected ${header} to be allowed for the profile preflight`,
      );
    }
  });

  it("does not widen the origin policy for the profile preflight", async () => {
    const result = await preflight(FOREIGN_ORIGIN, {
      url: "/api/consultant/profile",
      method: "PUT",
      headers: "authorization,content-type",
    });

    assert.notEqual(result.allowOrigin, FOREIGN_ORIGIN);
    assert.notEqual(result.allowOrigin, "*");
  });

  it("keeps every previously allowed method allowed", async () => {
    const result =
      await preflight(APP_URL);

    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
    ]) {
      assert.ok(
        result.allowMethods.includes(
          method,
        ),
        `expected ${method.toUpperCase()} to remain allowed`,
      );
    }
  });

  it("never returns an unapproved origin as allowed", async () => {
    const result = await preflight(
      FOREIGN_ORIGIN,
    );

    assert.notEqual(
      result.allowOrigin,
      FOREIGN_ORIGIN,
    );

    assert.notEqual(
      result.allowOrigin,
      "*",
    );
  });
});
