/*
 * Cross-origin configuration for the browser frontend.
 *
 * A browser rejects a preflight whenever a header it intends to
 * send is missing from Access-Control-Allow-Headers, so every
 * request header the frontend sends has to be listed here.
 * POST /api/admin/services requires an Idempotency-Key header
 * (Amendment 004 section 14.3.7), which makes it one of them.
 *
 * Kept in its own module so a test can assert the exact options
 * the server registers: src/server.ts connects Redis and starts
 * listening on import, so it cannot be loaded from a test.
 */

import type { FastifyCorsOptions } from "@fastify/cors";

export const ALLOWED_METHODS = [
  "GET",
  "POST",
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
 * A single approved origin, supplied by the caller rather than
 * read here, so the allowed origin stays environment-driven and
 * this module has no configuration to load.
 */
export const buildCorsOptions = (
  appUrl: string,
): FastifyCorsOptions => ({
  origin: appUrl,
  methods: [...ALLOWED_METHODS],
  allowedHeaders: [
    ...ALLOWED_REQUEST_HEADERS,
  ],
  credentials: true,
});
