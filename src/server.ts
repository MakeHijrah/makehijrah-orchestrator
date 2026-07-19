import Fastify from "fastify";
import { env } from "./config/env.js";
import { redis } from "./lib/redis.js";
import { supabaseAdmin } from "./lib/supabase.js";

const app = Fastify({
  logger: true,
});

app.get("/health", async (_request, reply) => {
  try {
    const redisResponse = await redis.ping();

    const { error: supabaseError } = await supabaseAdmin
      .from("countries")
      .select("id", {
        count: "exact",
        head: true,
      });

    if (supabaseError) {
      throw new Error(`Supabase health check failed: ${supabaseError.message}`);
    }

    return {
      ok: true,
      service: "makehijrah-orchestrator",
      redis: redisResponse === "PONG" ? "connected" : "unexpected-response",
      supabase: "connected",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    app.log.error(error);

    return reply.status(503).send({
      ok: false,
      service: "makehijrah-orchestrator",
      redis: redis.status === "ready" ? "connected" : "disconnected",
      supabase: "disconnected",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  }
});

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
