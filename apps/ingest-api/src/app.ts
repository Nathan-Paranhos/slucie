import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest
} from "fastify";
import type { AppConfig } from "./config.js";
import {
  DatabaseOperationError,
  type Database,
  type IngestOutcome
} from "./db.js";
import type { IngestMetrics } from "./metrics.js";
import {
  getProviderAdapter,
  normalizeProviderName,
  ProviderRequestError,
  type HeaderBag,
  type ProviderName
} from "./providers/index.js";
import {
  RateLimitUnavailableError,
  type RateLimitDecision,
  type RateLimitRule
} from "./rate-limit.js";
import { decryptSource } from "./source-config.js";
import { constantTimeTextEqual } from "./providers/utils.js";

interface RateLimiter {
  consume(sourceId: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

interface RedisHealth {
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

export interface AppDependencies {
  readonly config: AppConfig;
  readonly database: Database;
  readonly rateLimiter: RateLimiter;
  readonly redis: RedisHealth;
  readonly metrics: IngestMetrics;
}

interface WebhookParams {
  readonly provider: string;
  readonly endpointKey: string;
}

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

function publicRequestSerializer(request: FastifyRequest): Record<string, unknown> {
  const url = request.url.replace(
    /^(\/v1\/webhooks\/[^/?]+\/)[^/?]+/,
    "$1[redacted]"
  );
  return {
    id: request.id,
    method: request.method,
    url,
    remoteAddress: request.ip
  };
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sanitizedHeaders(request: {
  readonly headers: HeaderBag;
}): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const allowed = ["content-type", "user-agent", "x-request-id", "x-product-origin"];
  for (const name of allowed) {
    const value = headerValue(request.headers, name);
    if (value !== undefined) {
      result[name] = value.slice(0, 512);
    }
  }
  return result;
}

function contentType(request: { readonly headers: HeaderBag }): string {
  return (headerValue(request.headers, "content-type") ?? "application/json")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "application/json";
}

function resultOutcome(result: IngestOutcome): string {
  return result;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database, rateLimiter, redis, metrics } = dependencies;
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: config.webhookBodyLimitBytes,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['asaas-access-token']",
          "req.headers['x-authenticity-token']",
          "req.headers['x-signature']",
          "req.headers['stripe-signature']",
          "req.headers['x-webhook-signature']",
          "headers.authorization",
          "secret",
          "payload",
          "rawBody",
          "*.secret",
          "*.payload"
        ],
        censor: "[redacted]"
      },
      serializers: {
        req: publicRequestSerializer,
        res: (reply) => ({
          statusCode: (reply as { statusCode?: number }).statusCode ?? 0
        })
      }
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    global: true
  });

  const webhookStartedAt = new WeakMap<FastifyRequest, bigint>();
  const webhookMetricsRecorded = new WeakSet<FastifyRequest>();
  const isWebhookRequest = (request: FastifyRequest): boolean =>
    request.url.startsWith("/v1/webhooks/");
  const recordWebhookMetrics = (
    request: FastifyRequest,
    provider: ProviderName | "unknown",
    outcome: string
  ): void => {
    if (webhookMetricsRecorded.has(request)) return;
    webhookMetricsRecorded.add(request);
    metrics.requests.inc({ provider, outcome });
    const startedAt = webhookStartedAt.get(request) ?? process.hrtime.bigint();
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    metrics.duration.observe({ provider, outcome }, seconds);
  };

  app.addHook("onRequest", (request, _reply, done) => {
    if (isWebhookRequest(request)) {
      webhookStartedAt.set(request, process.hrtime.bigint());
    }
    done();
  });

  // No JSON parser runs before authentication. The exact bytes received are retained.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;.*)?$/i,
    { parseAs: "buffer", bodyLimit: config.webhookBodyLimitBytes },
    (_request, body, done) => done(null, body)
  );

  app.get("/health/live", () => ({
    status: "ok",
    service: "sluice-ingest-api"
  }));

  app.get("/health/ready", async (_request, reply) => {
    const [postgresReady, redisResult] = await Promise.all([
      database.isReady(),
      redis
        .ping()
        .then(() => true)
        .catch(() => false)
    ]);
    const redisRequired = config.redisFailurePolicy === "closed";
    const ready = postgresReady && (redisResult || !redisRequired);
    return reply.code(ready ? 200 : 503).send({
      status: ready ? (redisResult ? "ok" : "degraded") : "not_ready",
      checks: {
        postgres: postgresReady ? "ok" : "failed",
        redis: redisResult ? "ok" : redisRequired ? "failed" : "degraded_fail_open"
      }
    });
  });

  app.get("/metrics", async (request, reply) => {
    if (config.metricsBearerToken !== undefined) {
      const authorization = headerValue(request.headers, "authorization") ?? "";
      const expected = `Bearer ${config.metricsBearerToken}`;
      if (!constantTimeTextEqual(authorization, expected)) {
        return reply.code(401).send({ error: "unauthorized", requestId: request.id });
      }
    }
    return reply
      .header("content-type", metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });

  app.post<{
    Params: WebhookParams;
    Querystring: Record<string, string | string[] | undefined>;
    Body: Buffer;
  }>(
    "/v1/webhooks/:provider/:endpointKey",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "endpointKey"],
          properties: {
            provider: {
              type: "string",
              minLength: 1,
              maxLength: 32,
              pattern: "^[a-z][a-z0-9_-]*$"
            },
            endpointKey: { type: "string", pattern: UUID_PATTERN }
          }
        }
      }
    },
    async (request, reply) => {
      let metricProvider: ProviderName | "unknown" = "unknown";
      let secret: Buffer | undefined;

      const finishMetrics = (outcome: string): void => {
        recordWebhookMetrics(request, metricProvider, outcome);
      };

      try {
        if (config.nodeEnv === "production" && request.protocol !== "https") {
          finishMetrics("https_required");
          return reply.code(400).send({
            error: "https_required",
            requestId: request.id
          });
        }

        const requestedProvider = normalizeProviderName(request.params.provider);
        if (requestedProvider === undefined) {
          finishMetrics("unknown_provider");
          return reply.code(404).send({ error: "not_found", requestId: request.id });
        }
        metricProvider = requestedProvider;

        if (!Buffer.isBuffer(request.body)) {
          finishMetrics("unsupported_media_type");
          return reply.code(415).send({
            error: "application_json_required",
            requestId: request.id
          });
        }
        metrics.bodyBytes.observe(
          { provider: metricProvider },
          request.body.byteLength
        );

        const encryptedSource = await database.resolveSource(request.params.endpointKey);
        if (
          encryptedSource === undefined ||
          encryptedSource.provider !== requestedProvider
        ) {
          finishMetrics("source_not_found");
          return reply.code(404).send({ error: "not_found", requestId: request.id });
        }

        const source = decryptSource(encryptedSource, config.masterKeys);
        secret = source.secret;
        if (
          source.maxBodyBytes !== undefined &&
          request.body.byteLength > source.maxBodyBytes
        ) {
          finishMetrics("body_too_large");
          return reply.code(413).send({
            error: "payload_too_large",
            requestId: request.id
          });
        }

        const adapter = getProviderAdapter(source.provider);
        adapter.authenticate({
          rawBody: request.body,
          headers: request.headers,
          query: request.query,
          secret,
          providerConfig: source.config.provider,
          toleranceSeconds:
            source.config.signatureToleranceSeconds ?? config.signatureToleranceSeconds
        });

        const rateLimit = source.rateLimitPerMinute ?? config.defaultRateLimit;
        let rateDecision: RateLimitDecision;
        try {
          rateDecision = await rateLimiter.consume(source.sourceId, {
            limit: rateLimit,
            windowSeconds: 60
          });
        } catch (error) {
          if (!(error instanceof RateLimitUnavailableError)) throw error;
          metrics.redisFailures.inc({ policy: config.redisFailurePolicy });
          request.log.error({ err: error, sourceId: source.sourceId }, "rate limiter unavailable");
          finishMetrics("rate_limiter_unavailable");
          return reply
            .header("retry-after", "5")
            .code(503)
            .send({ error: "temporarily_unavailable", requestId: request.id });
        }
        reply.header("ratelimit-limit", String(rateLimit));
        reply.header("ratelimit-remaining", String(rateDecision.remaining));
        if (rateDecision.retryAfterSeconds > 0) {
          reply.header("ratelimit-reset", String(rateDecision.retryAfterSeconds));
        }
        if (!rateDecision.enforced) {
          metrics.redisFailures.inc({ policy: config.redisFailurePolicy });
          request.log.warn(
            { sourceId: source.sourceId },
            "rate limiter failed open by configured policy"
          );
        }
        if (!rateDecision.allowed) {
          finishMetrics("rate_limited");
          return reply
            .header("retry-after", String(rateDecision.retryAfterSeconds))
            .code(429)
            .send({ error: "rate_limited", requestId: request.id });
        }

        const event = adapter.parse(
          request.body,
          request.query,
          source.config.provider
        );
        const retentionDays =
          source.rawPayloadRetentionDays ?? 90;
        const purgeAfter = new Date(Date.now() + retentionDays * 86_400_000);
        const masterKey = config.masterKeys.get(config.activeKeyVersion);
        if (masterKey === undefined) {
          throw new Error("active encryption key is unavailable");
        }

        const persisted = await database.persistWebhook({
          tenantId: source.tenantId,
          sourceId: source.sourceId,
          externalEventId: event.externalEventId,
          eventType: event.eventType,
          rawBody: request.body,
          contentType: contentType({ headers: request.headers }),
          sanitizedHeaders: sanitizedHeaders({ headers: request.headers }),
          purgeAfter,
          jobType: source.config.job.type,
          priority: source.config.job.priority,
          maxAttempts: source.config.job.maxAttempts,
          keyVersion: config.activeKeyVersion,
          masterKey,
          requestId: request.id
        });

        if (persisted.outcome === "conflict") {
          request.log.warn(
            {
              sourceId: source.sourceId,
              eventId: persisted.eventId,
              reason: "external_id_payload_hash_conflict"
            },
            "webhook quarantined"
          );
          finishMetrics(resultOutcome(persisted.outcome));
          return reply.code(409).send({
            received: false,
            quarantined: true,
            requestId: request.id
          });
        }

        finishMetrics(resultOutcome(persisted.outcome));
        return reply.code(200).send({
          received: true,
          duplicate: persisted.outcome === "duplicate",
          requestId: request.id
        });
      } catch (error) {
        if (error instanceof ProviderRequestError) {
          const statusCode = error.kind === "schema" ? 400 : 401;
          finishMetrics(error.kind);
          request.log.info(
            { provider: metricProvider, failureKind: error.kind },
            "webhook rejected"
          );
          return reply.code(statusCode).send({
            error:
              error.kind === "schema"
                ? "invalid_payload"
                : error.kind === "replay"
                  ? "stale_signature"
                  : "invalid_signature",
            requestId: request.id
          });
        }

        if (error instanceof DatabaseOperationError) {
          metrics.databaseErrors.inc({ operation: error.operation });
        } else {
          metrics.internalErrors.inc({ component: "application" });
        }
        finishMetrics("internal_error");
        request.log.error({ err: error }, "webhook ingestion failed");
        return reply
          .header("retry-after", "5")
          .code(503)
          .send({ error: "temporarily_unavailable", requestId: request.id });
      } finally {
        secret?.fill(0);
      }
    }
  );

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled request error");
    } else {
      request.log.info({ statusCode }, "request rejected");
    }
    if (isWebhookRequest(request)) {
      const params = request.params as Partial<WebhookParams>;
      const provider =
        typeof params.provider === "string"
          ? normalizeProviderName(params.provider) ?? "unknown"
          : "unknown";
      const outcome =
        statusCode === 413
          ? "body_too_large"
          : statusCode === 415
            ? "unsupported_media_type"
            : statusCode >= 500
              ? "internal_error"
              : "invalid_request";
      recordWebhookMetrics(request, provider, outcome);
    }
    void reply.code(statusCode).send({
      error:
        statusCode === 413
          ? "payload_too_large"
          : statusCode === 415
            ? "application_json_required"
            : statusCode >= 500
              ? "internal_error"
              : "invalid_request",
      requestId: request.id
    });
  });

  app.addHook("onClose", async () => {
    await Promise.allSettled([database.close(), redis.quit()]);
  });

  return app;
}
