/*
 * Cross-origin configuration for the browser frontend.
 *
 * A browser rejects a preflight whenever a header it intends to
 * send is missing from Access-Control-Allow-Headers, so every
 * request header the frontend sends has to be listed here.
 * POST /api/admin/services requires an Idempotency-Key header
 * (Amendment 004 section 14.3.7), which makes it one of them.
 *
 * More than one browser frontend is served in production, so the
 * allowed origin is a list rather than a single value. Every
 * approved origin is named explicitly and the matching one is
 * echoed back; no wildcard is issued, which credentialed
 * requests would reject anyway.
 *
 * Kept in its own module so a test can assert the exact options
 * the server registers: src/server.ts connects Redis and starts
 * listening on import, so it cannot be loaded from a test.
 */

import type { FastifyCorsOptions } from "@fastify/cors";

export const ALLOWED_METHODS = [
  "GET",
  "POST",
  /*
   * PUT is required by PUT /api/consultant/profile (Amendment
   * 008). Without it a browser rejects the preflight before the
   * request ever reaches the route, so the endpoint appears
   * broken from the frontend while responding normally to curl.
   */
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export const ALLOWED_REQUEST_HEADERS =
  [
    "Authorization",
    "Content-Type",
    "Stripe-Signature",
    "Idempotency-Key",
  ] as const;

/*
 * The browser frontends served in production.
 *
 * hijrah.network is the current production domain; the Lovable
 * domain stays allowed because it is still served and linked.
 * Both are listed here rather than left to configuration alone
 * so a deployment cannot lose a live frontend by way of an
 * unset environment variable: an origin missing from this list
 * turns valid 200 responses into browser-blocked requests.
 */
export const PRODUCTION_FRONTEND_ORIGINS = [
  "https://hijrah.network",
  "https://hijrah-consultation.lovable.app",
] as const;

/*
 * An Origin header never carries a trailing slash, so a
 * configured value written as https://example.test/ would never
 * match one. Normalising here keeps that spelling working.
 */
const normalizeOrigin = (
  value: string,
): string =>
  value.trim().replace(/\/+$/, "");

/*
 * Accepts origins as separate arguments or as one delimited
 * string, which is how an environment variable carries a list:
 * commas, whitespace and newlines all separate entries. Empty
 * entries are dropped and duplicates collapse, preserving the
 * order first seen.
 */
export const parseAllowedOrigins = (
  ...sources: readonly (
    | string
    | undefined
    | null
  )[]
): string[] => {
  const origins: string[] = [];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    for (const entry of source.split(
      /[\s,]+/,
    )) {
      const origin =
        normalizeOrigin(entry);

      if (
        origin.length > 0 &&
        !origins.includes(origin)
      ) {
        origins.push(origin);
      }
    }
  }

  return origins;
};

/*
 * The approved origins: the production frontends, the caller's
 * APP_URL (which differs per environment) and any additional
 * origins supplied by configuration. Anything else is refused,
 * and no wildcard is ever returned, so credentialed requests
 * from an unknown origin stay blocked.
 */
export const buildCorsOptions = (
  appUrl: string,
  additionalOrigins?: string | undefined,
): FastifyCorsOptions => ({
  origin: parseAllowedOrigins(
    ...PRODUCTION_FRONTEND_ORIGINS,
    appUrl,
    additionalOrigins,
  ),
  methods: [...ALLOWED_METHODS],
  allowedHeaders: [
    ...ALLOWED_REQUEST_HEADERS,
  ],
  credentials: true,
});
