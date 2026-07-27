import { Redis } from "ioredis";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./db.js";
import { createMetrics } from "./metrics.js";
import { RedisRateLimiter } from "./rate-limit.js";

function writeStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      time: new Date().toISOString(),
      service: "sluice-ingest-api",
      message
    })}\n`
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new PostgresDatabase(config);
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    retryStrategy: (attempt: number) => Math.min(attempt * 100, 2_000)
  });
  redis.on("error", () => {
    // Request-path logging and readiness expose failures without leaking Redis URLs.
  });
  const rateLimiter = new RedisRateLimiter(redis, config.redisFailurePolicy);
  const app = await buildApp({
    config,
    database,
    redis,
    rateLimiter,
    metrics: createMetrics()
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "graceful shutdown started");

    const forceExit = setTimeout(() => {
      app.log.fatal({ signal }, "graceful shutdown deadline exceeded");
      process.exit(1);
    }, config.shutdownGraceMs);
    forceExit.unref();

    try {
      await app.close();
      clearTimeout(forceExit);
      app.log.info({ signal }, "graceful shutdown complete");
    } catch (error) {
      clearTimeout(forceExit);
      app.log.error({ err: error, signal }, "graceful shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  writeStartupError(error);
  process.exitCode = 1;
});
