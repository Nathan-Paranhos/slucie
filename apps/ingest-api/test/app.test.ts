import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { DatabaseOperationError, type PersistWebhookInput } from "../src/db.js";
import { encryptEnvelope, serializeEnvelope } from "../src/crypto/envelope.js";
import { createMetrics } from "../src/metrics.js";
import { encryptSourceContext } from "../src/source-config.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const endpointKey = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";

function envelopeBytes(
  plaintext: Buffer,
  context: string,
  masterKey: Buffer
): Buffer {
  return Buffer.from(
    serializeEnvelope(encryptEnvelope(plaintext, context, 1, masterKey)),
    "utf8"
  );
}

function createDependencies(
  overrides: Partial<AppDependencies["database"]> = {},
  configOverrides: Partial<AppConfig> = {}
) {
  const masterKey = randomBytes(32);
  const secret = Buffer.from("asaas-test-token", "utf8");
  const persistWebhook = vi.fn((input: PersistWebhookInput) => {
    void input;
    return Promise.resolve({
      outcome: "inserted" as const,
      eventId,
      jobId
    });
  });
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8080,
    trustProxy: false,
    databaseUrl: "postgres://unused",
    databaseSsl: false,
    databaseSslCaFile: undefined,
    redisUrl: "redis://unused",
    redisFailurePolicy: "closed",
    webhookBodyLimitBytes: 1_048_576,
    defaultRateLimit: 120,
    defaultRateWindowSeconds: 60,
    signatureToleranceSeconds: 300,
    dbPoolMax: 2,
    dbStatementTimeoutMs: 2_000,
    shutdownGraceMs: 2_000,
    masterKeys: new Map([[1, masterKey]]),
    activeKeyVersion: 1,
    metricsBearerToken: undefined,
    ...configOverrides
  };
  const resolveSource = vi.fn(() =>
    Promise.resolve({
      tenantId,
      sourceId,
      provider: "asaas" as const,
      secretCiphertext: envelopeBytes(
        secret,
        encryptSourceContext("secret", tenantId, sourceId),
        masterKey
      ),
      configCiphertext: undefined,
      keyVersion: 1,
      rateLimitPerMinute: 600,
      maxBodyBytes: 32_768,
      rawPayloadRetentionDays: 90
    })
  );
  const database: AppDependencies["database"] = {
    resolveSource,
    persistWebhook,
    isReady: vi.fn(() => Promise.resolve(true)),
    close: vi.fn(() => Promise.resolve()),
    ...overrides
  };

  return {
    dependencies: {
      config,
      database,
      rateLimiter: {
        consume: vi.fn(() =>
          Promise.resolve({
            allowed: true,
            enforced: true,
            remaining: 599,
            retryAfterSeconds: 60
          })
        )
      },
      redis: {
        ping: vi.fn(() => Promise.resolve("PONG")),
        quit: vi.fn(() => Promise.resolve("OK"))
      },
      metrics: createMetrics()
    },
    persistWebhook,
    resolveSource
  };
}

describe("webhook HTTP boundary", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("authenticates and persists the exact raw JSON bytes", async () => {
    const { dependencies, persistWebhook } = createDependencies();
    app = await buildApp(dependencies);
    const payload = '{\n  "id": 42, "event": "PAYMENT_CREATED", "note": "ação"\n}';

    const response = await app.inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${endpointKey}`,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "asaas-access-token": "asaas-test-token"
      },
      payload: Buffer.from(payload, "utf8")
    });

    expect(response.statusCode).toBe(200);
    expect(persistWebhook).toHaveBeenCalledOnce();
    expect(persistWebhook.mock.calls[0]?.[0].rawBody).toEqual(
      Buffer.from(payload, "utf8")
    );
  });

  it("records database failures separately from application failures", async () => {
    const { dependencies } = createDependencies({
      resolveSource: vi.fn(() =>
        Promise.reject(
          new DatabaseOperationError("resolve_source", new Error("offline"))
        )
      )
    });
    app = await buildApp(dependencies);

    const response = await app.inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${endpointKey}`,
      headers: {
        "content-type": "application/json",
        "asaas-access-token": "asaas-test-token"
      },
      payload: '{"id":42,"event":"PAYMENT_CREATED"}'
    });
    const metricText = await dependencies.metrics.registry.metrics();

    expect(response.statusCode).toBe(503);
    expect(metricText).toContain(
      'sluice_ingest_database_errors_total{operation="resolve_source"} 1'
    );
    expect(metricText).toContain(
      'sluice_webhook_requests_total{provider="asaas",outcome="internal_error"} 1'
    );
  });

  it("rejects malformed endpoint UUIDs before any database lookup and meters them", async () => {
    const { dependencies, resolveSource } = createDependencies();
    app = await buildApp(dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/asaas/not-a-uuid",
      headers: {
        "content-type": "application/json",
        "asaas-access-token": "asaas-test-token"
      },
      payload: '{"id":42,"event":"PAYMENT_CREATED"}'
    });
    const metricText = await dependencies.metrics.registry.metrics();

    expect(response.statusCode).toBe(400);
    expect(resolveSource).not.toHaveBeenCalled();
    expect(metricText).toContain(
      'sluice_webhook_requests_total{provider="asaas",outcome="invalid_request"} 1'
    );
  });

  it("returns a metered 404 for an unknown provider", async () => {
    const { dependencies, resolveSource } = createDependencies();
    app = await buildApp(dependencies);

    const response = await app.inject({
      method: "POST",
      url: `/v1/webhooks/unknown/${endpointKey}`,
      headers: { "content-type": "application/json" },
      payload: "{}"
    });
    const metricText = await dependencies.metrics.registry.metrics();

    expect(response.statusCode).toBe(404);
    expect(resolveSource).not.toHaveBeenCalled();
    expect(metricText).toContain(
      'sluice_webhook_requests_total{provider="unknown",outcome="unknown_provider"} 1'
    );
  });

  it("exposes health probes without dependencies on the webhook parser", async () => {
    const { dependencies } = createDependencies();
    app = await buildApp(dependencies);

    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({
      status: "ok",
      service: "sluice-ingest-api"
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ok",
      checks: { postgres: "ok", redis: "ok" }
    });
  });

  it("requires HTTPS in production and honors a trusted proxy protocol", async () => {
    const untrusted = createDependencies({}, { nodeEnv: "production" });
    app = await buildApp(untrusted.dependencies);
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${endpointKey}`,
      headers: {
        "content-type": "application/json",
        "asaas-access-token": "asaas-test-token"
      },
      payload: '{"id":42,"event":"PAYMENT_CREATED"}'
    });
    expect(rejected.statusCode).toBe(400);
    expect(untrusted.resolveSource).not.toHaveBeenCalled();
    await app.close();

    const trusted = createDependencies(
      {},
      { nodeEnv: "production", trustProxy: true }
    );
    app = await buildApp(trusted.dependencies);
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${endpointKey}`,
      headers: {
        "content-type": "application/json",
        "asaas-access-token": "asaas-test-token",
        "x-forwarded-proto": "https"
      },
      payload: '{"id":42,"event":"PAYMENT_CREATED"}',
      remoteAddress: "127.0.0.1"
    });
    expect(accepted.statusCode).toBe(200);
  });
});
