import Fastify from "fastify";
import { redis } from "./lib/redis.js";

const app = Fastify({
  logger: true,
});

app.get("/health", async (_request, reply) => {
  try {
    const redisResponse = await redis.ping();

    return {
      ok: true,
      service: "makehijrah-orchestrator",
      redis: redisResponse === "PONG" ? "connected" : "unexpected-response",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    app.log.error(error);

    return reply.status(503).send({
      ok: false,
      service: "makehijrah-orchestrator",
      redis: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }
});

const port = Number(process.env.PORT ?? 3000);

const start = async (): Promise<void> => {
  try {
    await redis.connect();

    await app.listen({
      port,
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
