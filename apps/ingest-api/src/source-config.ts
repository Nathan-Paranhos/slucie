import { z } from "zod";
import { decryptEnvelope, parseEnvelope } from "./crypto/envelope.js";
import type { ProviderName } from "./providers/index.js";
import { pixAdapterConfigSchema } from "./providers/pix.js";

const sourceRuntimeConfigSchema = z
  .object({
    // ingest_event_and_enqueue currently persists schema_version=1 through the
    // table default. Reject a future version until the SQL function supports it.
    schemaVersion: z.literal(1).default(1),
    signatureToleranceSeconds: z.number().int().min(30).max(3_600).optional(),
    job: z
      .object({
        type: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/).default("webhook.process"),
        priority: z.number().int().min(0).max(1_000).default(100),
        maxAttempts: z.number().int().min(1).max(100).default(8)
      })
      .strict()
      .default({
        type: "webhook.process",
        priority: 100,
        maxAttempts: 8
      }),
    provider: z.unknown().optional()
  })
  .strict();

export type SourceRuntimeConfig = z.infer<typeof sourceRuntimeConfigSchema>;

export function parseSourceRuntimeConfig(input: unknown): SourceRuntimeConfig {
  return sourceRuntimeConfigSchema.parse(input);
}

export function parseProviderSourceRuntimeConfig(
  provider: ProviderName,
  input: unknown
): SourceRuntimeConfig {
  const config = parseSourceRuntimeConfig(input);
  if (provider === "pix") {
    pixAdapterConfigSchema.parse(config.provider);
  }
  return config;
}

export interface EncryptedSourceRecord {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly provider: ProviderName;
  readonly secretCiphertext: Buffer;
  readonly configCiphertext: Buffer | undefined;
  readonly keyVersion: number;
  readonly rateLimitPerMinute: number | undefined;
  readonly maxBodyBytes: number | undefined;
  readonly rawPayloadRetentionDays: number | undefined;
}

export interface DecryptedSource {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly provider: ProviderName;
  readonly secret: Buffer;
  readonly config: SourceRuntimeConfig;
  readonly rateLimitPerMinute: number | undefined;
  readonly maxBodyBytes: number | undefined;
  readonly rawPayloadRetentionDays: number | undefined;
}

function sourceContext(
  type: "secret" | "config",
  tenantId: string,
  sourceId: string
): string {
  return `webhook-source-${type}:${tenantId}:${sourceId}`;
}

export function decryptSource(
  source: EncryptedSourceRecord,
  masterKeys: ReadonlyMap<number, Buffer>
): DecryptedSource {
  const secretEnvelope = parseEnvelope(source.secretCiphertext);
  if (secretEnvelope.kid !== source.keyVersion) {
    throw new Error("webhook source key version does not match its encrypted envelopes");
  }

  const secret = decryptEnvelope(
    secretEnvelope,
    sourceContext("secret", source.tenantId, source.sourceId),
    masterKeys
  );
  let configBytes: Buffer | undefined;
  try {
    let configInput: unknown = {};
    if (source.configCiphertext !== undefined) {
      const configEnvelope = parseEnvelope(source.configCiphertext);
      if (configEnvelope.kid !== source.keyVersion) {
        throw new Error(
          "webhook source key version does not match its encrypted envelopes"
        );
      }
      configBytes = decryptEnvelope(
        configEnvelope,
        sourceContext("config", source.tenantId, source.sourceId),
        masterKeys
      );
      configInput = JSON.parse(configBytes.toString("utf8")) as unknown;
    }
    const config = parseProviderSourceRuntimeConfig(source.provider, configInput);
    return {
      sourceId: source.sourceId,
      tenantId: source.tenantId,
      provider: source.provider,
      secret,
      config,
      rateLimitPerMinute: source.rateLimitPerMinute,
      maxBodyBytes: source.maxBodyBytes,
      rawPayloadRetentionDays: source.rawPayloadRetentionDays
    };
  } catch (error) {
    secret.fill(0);
    throw error;
  } finally {
    configBytes?.fill(0);
  }
}

export function encryptSourceContext(
  type: "secret" | "config",
  tenantId: string,
  sourceId: string
): string {
  return sourceContext(type, tenantId, sourceId);
}
