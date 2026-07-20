import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { redis } from "./lib/redis.js";
import { supabaseAdmin } from "./lib/supabase.js";
import { registerAvailabilityRoute } from "./modules/availability/availability.route.js";
import { registerOAuthRoutes } from "./modules/oauth/oauth.route.js";

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
  ],
  credentials: true,
});

await app.register(rateLimit, {
  global: false,
  redis,
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: (_request, context) => {
    const error = new Error(
      "Too many requests. Please try again shortly.",
    ) as Error & {
      statusCode: number;
      code: string;
      details: {
        limit: number;
        retry_after_seconds: number;
      };
    };

    error.statusCode = 429;
    error.code = "RATE_LIMITED";
    error.details = {
      limit: context.max,
      retry_after_seconds: Math.ceil(
        context.ttl / 1000,
      ),
    };

    return error;
  },
});

app.setErrorHandler((error, request, reply) => {
  const rateLimitError = error as Error & {
    statusCode?: number;
    code?: string;
    details?: unknown;
  };

  if (
    rateLimitError.statusCode === 429 &&
    rateLimitError.code === "RATE_LIMITED"
  ) {
    return reply.status(429).send({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message:
          "Too many requests. Please try again shortly.",
        details: rateLimitError.details,
      },
    });
  }

  request.log.error(
    {
      err: error,
    },
    "Unhandled request error",
  );

  return reply.status(
    rateLimitError.statusCode &&
      rateLimitError.statusCode >= 400
      ? rateLimitError.statusCode
      : 500,
  ).send({
    ok: false,
    error: {
      code:
        rateLimitError.code ??
        "INTERNAL_ERROR",
      message:
        rateLimitError.statusCode &&
        rateLimitError.statusCode < 500
          ? error.message
          : "An unexpected server error occurred.",
    },
  });
});

app.get("/health", async (_request, reply) => {
  try {
    const redisResponse = await redis.ping();

    const { data: countries, error: supabaseError } =
      await supabaseAdmin
        .from("countries")
        .select("id")
        .limit(1);

    if (supabaseError) {
      app.log.error(
        {
          supabaseError: {
            message: supabaseError.message,
            code: supabaseError.code,
            details: supabaseError.details,
            hint: supabaseError.hint,
            name: supabaseError.name,
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
      service: "makehijrah-orchestrator",
      redis:
        redisResponse === "PONG"
          ? "connected"
          : "unexpected-response",
      supabase: "connected",
      supabaseTestRows: countries?.length ?? 0,
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
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

    return reply.status(503).send({
      ok: false,
      service: "makehijrah-orchestrator",
      redis:
        redis.status === "ready"
          ? "connected"
          : "disconnected",
      supabase: "disconnected",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  }
});

await registerAvailabilityRoute(app);
await registerOAuthRoutes(app);

const start = async (): Promise<void> => {
  try {
    await redis.connect();

    await app.listen({
      port: env.PORT,
      host: "0.0.0.0",
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

const shutdown = async (): Promise<void> => {
  await app.close();

  if (redis.status !== "end") {
    await redis.quit();
  }

  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await start();
