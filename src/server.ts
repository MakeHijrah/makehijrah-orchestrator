import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { env } from "./config/env.js";
import { redis } from "./lib/redis.js";
import { supabaseAdmin } from "./lib/supabase.js";
import { registerAvailabilityRoute } from "./modules/availability/availability.route.js";
import {
  startAuthorizationTimeoutNotificationWorker,
  stopAuthorizationTimeoutNotificationWorker,
} from "./modules/consultations/authorization-timeout-notification.worker.js";
import {
  startAuthorizationTimeoutWorker,
  stopAuthorizationTimeoutWorker,
} from "./modules/consultations/authorization-timeout.worker.js";
import { registerAdminConsultantActivationRoutes } from "./modules/admin-consultants/admin-consultant-activation.route.js";
import { registerAdminConsultationCancelRoute } from "./modules/admin-consultations/admin-consultation-cancel.route.js";
import { registerAcceptanceRoute } from "./modules/consultations/acceptance.route.js";
import { registerCheckoutRoute } from "./modules/consultations/checkout.route.js";
import { registerCompletionRoute } from "./modules/consultations/completion.route.js";
import {
  startDeclineNotificationWorker,
  stopDeclineNotificationWorker,
} from "./modules/consultations/decline-notification.worker.js";
import { registerDeclineRoute } from "./modules/consultations/decline.route.js";
import { registerDraftConsultationRoute } from "./modules/consultations/draft.route.js";
import { registerInviteRoutes } from "./modules/invites/invite.route.js";
import { registerMessageNotificationRoute } from "./modules/messages/message-notification.route.js";
import {
  startMessageNotificationWorker,
  stopMessageNotificationWorker,
} from "./modules/messages/message-notification.worker.js";
import { registerOAuthRoutes } from "./modules/oauth/oauth.route.js";
import {
  startOAuthHealthAlertWorker,
  stopOAuthHealthAlertWorker,
} from "./modules/oauth/oauth-health-alert.worker.js";
import {
  startOAuthHealthWorker,
  stopOAuthHealthWorker,
} from "./modules/oauth/oauth-health.worker.js";
import { registerRecommendationSendRoute } from "./modules/recommendations/recommendation-send.route.js";
import { registerStripeWebhookRoute } from "./modules/webhooks/stripe-webhook.route.js";

const app = Fastify({
  logger: true,
  trustProxy: true,
});

await app.register(cors, {
  origin: env.APP_URL,
  methods: [
    "GET",
    "POST",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "Stripe-Signature",
  ],
  credentials: true,
});

await app.register(rateLimit, {
  global: false,
  redis,
  keyGenerator: (request) =>
    request.ip,
  errorResponseBuilder: (
    _request,
    context,
  ) => ({
    statusCode: 429,
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message:
        "Too many requests. Please try again shortly.",
      details: {
        limit: context.max,
        retry_after_seconds:
          Math.ceil(
            context.ttl / 1000,
          ),
      },
    },
  }),
});

await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: "utf8",
  runFirst: true,
  routes: [],
});

app.get(
  "/health",
  async (_request, reply) => {
    try {
      const redisResponse =
        await redis.ping();

      const {
        data: countries,
        error: supabaseError,
      } = await supabaseAdmin
        .from("countries")
        .select("id")
        .limit(1);

      if (supabaseError) {
        app.log.error(
          {
            supabaseError: {
              message:
                supabaseError.message,
              code:
                supabaseError.code,
              details:
                supabaseError.details,
              hint:
                supabaseError.hint,
              name:
                supabaseError.name,
            },
          },
          "Supabase query returned an error",
        );

        throw new Error(
          `Supabase health check failed: ${
            supabaseError.message ||
            supabaseError.code ||
            supabaseError.details ||
            "Unknown Supabase error"
          }`,
        );
      }

      return {
        ok: true,
        service:
          "makehijrah-orchestrator",
        redis:
          redisResponse === "PONG"
            ? "connected"
            : "unexpected-response",
        supabase: "connected",
        supabaseTestRows:
          countries?.length ?? 0,
        environment: env.NODE_ENV,
        timestamp:
          new Date().toISOString(),
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown health check error";

      app.log.error(
        {
          err: error,
          errorMessage: message,
        },
        "Health check failed",
      );

      return reply
        .status(503)
        .send({
          ok: false,
          service:
            "makehijrah-orchestrator",
          redis:
            redis.status ===
            "ready"
              ? "connected"
              : "disconnected",
          supabase:
            "disconnected",
          environment:
            env.NODE_ENV,
          timestamp:
            new Date()
              .toISOString(),
        });
    }
  },
);

await registerAvailabilityRoute(
  app,
);
await registerDraftConsultationRoute(
  app,
);
await registerCheckoutRoute(
  app,
);
await registerOAuthRoutes(
  app,
);
await registerAdminConsultationCancelRoute(
  app,
);
await registerAdminConsultantActivationRoutes(
  app,
);
await registerAcceptanceRoute(
  app,
);
await registerDeclineRoute(
  app,
);
await registerCompletionRoute(
  app,
);
await registerRecommendationSendRoute(
  app,
);
await registerMessageNotificationRoute(
  app,
);
await registerInviteRoutes(
  app,
);
await registerStripeWebhookRoute(
  app,
);

const start =
  async (): Promise<void> => {
    try {
      await redis.connect();

      await app.listen({
        port: env.PORT,
        host: "0.0.0.0",
      });

      startMessageNotificationWorker();
      startDeclineNotificationWorker();
      startAuthorizationTimeoutNotificationWorker();
      startAuthorizationTimeoutWorker();
      startOAuthHealthWorker();
      startOAuthHealthAlertWorker();
    } catch (error) {
      app.log.error(error);
      process.exit(1);
    }
  };

const shutdown =
  async (): Promise<void> => {
    await stopOAuthHealthAlertWorker();
    await stopOAuthHealthWorker();
    await stopAuthorizationTimeoutWorker();
    await stopAuthorizationTimeoutNotificationWorker();
    await stopDeclineNotificationWorker();
    await stopMessageNotificationWorker();

    await app.close();

    if (
      redis.status !== "end"
    ) {
      await redis.quit();
    }

    process.exit(0);
  };

process.on(
  "SIGTERM",
  shutdown,
);
process.on(
  "SIGINT",
  shutdown,
);

await start();
