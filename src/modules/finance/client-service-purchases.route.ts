import type { FastifyInstance } from "fastify";

import {
  sendError,
  sendSuccess,
} from "../../lib/api-response.js";
import { requireRole } from "../../lib/auth.js";
import { listServicePurchasesForClient } from "./client-service-purchases.service.js";

/*
 * GET /api/me/service-purchases — client
 *
 * The client's own service purchases, newest first. This is the
 * ONLY way a client ever sees a row of public.service_purchases:
 * that table's RLS names the attributed consultant and an admin
 * and nobody else, and this endpoint does not change it. The
 * service role reads the rows and the projection in the service
 * layer decides what leaves the building.
 *
 * `me` is the whole parameter surface. There is no client id in
 * the path, no filter in the query, and no body — so a client
 * cannot ask for somebody else's purchases, and there is no field
 * a later edit could start trusting.
 *
 * Client only. A consultant reads their attributed purchases
 * through RLS already; an admin reads everything the same way.
 * Neither needs this endpoint, and granting them a "me" route
 * that resolves to nothing would be a confusing surface rather
 * than a useful one.
 */
export const registerClientServicePurchasesRoute =
  async (
    app: FastifyInstance,
  ): Promise<void> => {
    app.get(
      "/api/me/service-purchases",
      {
        config: {
          rateLimit: {
            max: 60,
            timeWindow: "1 minute",
          },
        },
      },
      async (request, reply) => {
        const authentication =
          await requireRole(request, [
            "client",
          ]);

        if (!authentication.ok) {
          return sendError(
            reply,
            authentication.statusCode,
            authentication.code,
            authentication.message,
          );
        }

        const result =
          await listServicePurchasesForClient({
            clientProfileId:
              authentication.profile.id,
          });

        if (!result.ok) {
          return sendError(
            reply,
            500,
            result.code,
            result.message,
          );
        }

        return sendSuccess(reply, {
          purchases: result.purchases,
        });
      },
    );
  };
