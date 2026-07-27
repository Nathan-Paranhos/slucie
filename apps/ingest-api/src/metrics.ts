import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry
} from "prom-client";

export interface IngestMetrics {
  readonly registry: Registry;
  readonly requests: Counter<"provider" | "outcome">;
  readonly duration: Histogram<"provider" | "outcome">;
  readonly bodyBytes: Histogram<"provider">;
  readonly redisFailures: Counter<"policy">;
  readonly databaseErrors: Counter<"operation">;
  readonly internalErrors: Counter<"component">;
}

export function createMetrics(): IngestMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "sluice_ingest_" });

  return {
    registry,
    requests: new Counter({
      name: "sluice_webhook_requests_total",
      help: "Webhook requests by provider and terminal outcome",
      labelNames: ["provider", "outcome"],
      registers: [registry]
    }),
    duration: new Histogram({
      name: "sluice_webhook_duration_seconds",
      help: "End-to-end webhook ingestion duration",
      labelNames: ["provider", "outcome"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry]
    }),
    bodyBytes: new Histogram({
      name: "sluice_webhook_body_bytes",
      help: "Raw webhook request body size",
      labelNames: ["provider"],
      buckets: [256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576],
      registers: [registry]
    }),
    redisFailures: new Counter({
      name: "sluice_rate_limit_redis_failures_total",
      help: "Redis rate-limit failures by configured policy",
      labelNames: ["policy"],
      registers: [registry]
    }),
    databaseErrors: new Counter({
      name: "sluice_ingest_database_errors_total",
      help: "Database errors in the ingestion path by operation",
      labelNames: ["operation"],
      registers: [registry]
    }),
    internalErrors: new Counter({
      name: "sluice_ingest_internal_errors_total",
      help: "Non-database internal errors in the ingestion path",
      labelNames: ["component"],
      registers: [registry]
    })
  };
}
