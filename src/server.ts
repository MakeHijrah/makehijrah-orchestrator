import Fastify from "fastify";

const app = Fastify({
  logger: true,
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "makehijrah-orchestrator",
    timestamp: new Date().toISOString(),
  };
});

const port = Number(process.env.PORT ?? 3000);

const start = async (): Promise<void> => {
  try {
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
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await start();
