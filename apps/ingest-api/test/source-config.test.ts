import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptEnvelope, serializeEnvelope } from "../src/crypto/envelope.js";
import {
  decryptSource,
  encryptSourceContext,
  parseProviderSourceRuntimeConfig,
  parseSourceRuntimeConfig
} from "../src/source-config.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";

describe("source runtime configuration", () => {
  it("accepts a nullable database config envelope for providers with defaults", () => {
    const masterKey = randomBytes(32);
    const secretCiphertext = Buffer.from(
      serializeEnvelope(
        encryptEnvelope(
          Buffer.from("source-secret"),
          encryptSourceContext("secret", tenantId, sourceId),
          1,
          masterKey
        )
      ),
      "utf8"
    );

    const source = decryptSource(
      {
        tenantId,
        sourceId,
        provider: "asaas",
        secretCiphertext,
        configCiphertext: undefined,
        keyVersion: 1,
        rateLimitPerMinute: 600,
        maxBodyBytes: 1_048_576,
        rawPayloadRetentionDays: 90
      },
      new Map([[1, masterKey]])
    );

    expect(source.config).toEqual({
      schemaVersion: 1,
      job: {
        type: "webhook.process",
        priority: 100,
        maxAttempts: 8
      }
    });
    source.secret.fill(0);
  });

  it("matches the database limits for job priority and schema version", () => {
    expect(() =>
      parseSourceRuntimeConfig({ job: { priority: 1_001 } })
    ).toThrow();
    expect(() => parseSourceRuntimeConfig({ schemaVersion: 2 })).toThrow();
  });

  it.each([
    "webhook.process",
    "process_webhook",
    "deliver_event",
    "reconcile_provider"
  ] as const)("accepts the worker-supported job type %s", (type) => {
    expect(parseSourceRuntimeConfig({ job: { type } }).job.type).toBe(type);
  });

  it("rejects a syntactically valid job type without a worker handler", () => {
    expect(() =>
      parseSourceRuntimeConfig({ job: { type: "custom.webhook" } })
    ).toThrow();
  });

  it("requires provider-specific Pix authentication configuration", () => {
    expect(() => parseProviderSourceRuntimeConfig("pix", {})).toThrow();
  });
});
