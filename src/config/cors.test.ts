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
import {
  buildCorsOptions,
  parseAllowedOrigins,
} from "./cors.js";

const APP_URL =
  "https://hijrah-consultation.lovable.app";

/* The production frontend domain. */
const NETWORK_ORIGIN =
  "https://hijrah.network";

/* Any origin other than the approved ones. */
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
    appUrl?: string;
    additionalOrigins?: string;
  } = {},
): Promise<{
  statusCode: number;
  allowOrigin?: string;
  allowHeaders: string;
  allowMethods: string;
  allowCredentials: string;
}> => {
  const app = Fastify({ logger: false });

  try {
    await app.register(
      cors,
      buildCorsOptions(
        options.appUrl ?? APP_URL,
        options.additionalOrigins,
      ),
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
      allowCredentials: header(
        "access-control-allow-credentials",
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

/*
 * The production frontend moved to hijrah.network while the
 * Lovable domain stayed served. A single allowed origin left one
 * of them blocked in the browser despite a 200 from the route,
 * which is the failure these tests cover.
 */
describe("CORS production origins", () => {
  it("allows https://hijrah.network", async () => {
    const result = await preflight(
      NETWORK_ORIGIN,
    );

    assert.ok(
      result.statusCode < 300,
      `expected a successful preflight, received ${result.statusCode}`,
    );

    assert.equal(
      result.allowOrigin,
      NETWORK_ORIGIN,
    );
  });

  it("keeps https://hijrah-consultation.lovable.app allowed", async () => {
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
  });

  it("allows both frontends even when APP_URL names neither", async () => {
    for (const origin of [
      NETWORK_ORIGIN,
      APP_URL,
    ]) {
      const result = await preflight(
        origin,
        {
          appUrl:
            "https://staging.example.test",
        },
      );

      assert.equal(
        result.allowOrigin,
        origin,
        `expected ${origin} to stay allowed`,
      );
    }
  });

  it("rejects an unknown origin", async () => {
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

  it("rejects a lookalike of an allowed origin", async () => {
    for (const origin of [
      "https://hijrah.network.example.test",
      "http://hijrah.network",
      "https://evil-hijrah.network",
    ]) {
      const result =
        await preflight(origin);

      assert.notEqual(
        result.allowOrigin,
        origin,
        `expected ${origin} to be rejected`,
      );

      assert.notEqual(
        result.allowOrigin,
        "*",
      );
    }
  });

  it("returns the requesting origin on an OPTIONS preflight for each frontend", async () => {
    for (const origin of [
      NETWORK_ORIGIN,
      APP_URL,
    ]) {
      const result = await preflight(
        origin,
        {
          url: "/api/consultant/profile",
          method: "PUT",
          headers:
            "authorization,content-type",
        },
      );

      assert.ok(
        result.statusCode < 300,
        `expected a successful preflight for ${origin}, received ${result.statusCode}`,
      );

      assert.equal(
        result.allowOrigin,
        origin,
      );

      assert.ok(
        result.allowMethods.includes(
          "put",
        ),
        `expected PUT to be allowed for ${origin}`,
      );
    }
  });

  it("keeps credentials supported for both frontends", async () => {
    for (const origin of [
      NETWORK_ORIGIN,
      APP_URL,
    ]) {
      const result =
        await preflight(origin);

      assert.equal(
        result.allowCredentials,
        "true",
        `expected credentials to stay supported for ${origin}`,
      );
    }
  });

  it("keeps every allowed method and header for hijrah.network", async () => {
    const result = await preflight(
      NETWORK_ORIGIN,
    );

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

    for (const header of [
      "authorization",
      "content-type",
      "stripe-signature",
      "idempotency-key",
    ]) {
      assert.ok(
        result.allowHeaders.includes(
          header,
        ),
        `expected ${header} to remain allowed`,
      );
    }
  });

  it("allows an extra origin supplied by configuration", async () => {
    const extra =
      "https://preview.hijrah.network";

    const allowed = await preflight(
      extra,
      { additionalOrigins: extra },
    );

    assert.equal(
      allowed.allowOrigin,
      extra,
    );

    /* Configuration widens the list, it does not replace it. */
    const network = await preflight(
      NETWORK_ORIGIN,
      { additionalOrigins: extra },
    );

    assert.equal(
      network.allowOrigin,
      NETWORK_ORIGIN,
    );
  });
});

describe("parseAllowedOrigins", () => {
  it("reads several origins from one delimited value", () => {
    assert.deepEqual(
      parseAllowedOrigins(
        "https://a.example.test, https://b.example.test\nhttps://c.example.test",
      ),
      [
        "https://a.example.test",
        "https://b.example.test",
        "https://c.example.test",
      ],
    );
  });

  it("drops empty entries and duplicates", () => {
    assert.deepEqual(
      parseAllowedOrigins(
        " , https://a.example.test, ,https://a.example.test",
        "https://a.example.test",
        undefined,
      ),
      ["https://a.example.test"],
    );
  });

  it("ignores a trailing slash, which an Origin header never carries", () => {
    assert.deepEqual(
      parseAllowedOrigins(
        "https://hijrah.network/",
      ),
      ["https://hijrah.network"],
    );
  });

  it("returns nothing for an absent value", () => {
    assert.deepEqual(
      parseAllowedOrigins(
        undefined,
        "",
      ),
      [],
    );
  });
});
