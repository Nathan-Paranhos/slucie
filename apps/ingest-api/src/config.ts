import { z } from "zod";

const boolString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    TRUST_PROXY: boolString,
    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: boolString,
    DATABASE_SSL_CA_FILE: z.string().default(""),
    REDIS_URL: z.string().min(1),
    REDIS_FAILURE_POLICY: z.enum(["closed", "open"]).default("closed"),
    WEBHOOK_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(16 * 1_024 * 1_024)
      .default(1_048_576),
    DEFAULT_RATE_LIMIT: z.coerce.number().int().positive().default(120),
    DEFAULT_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
    SLUICE_MASTER_KEYS: z.string().min(1),
    SLUICE_ACTIVE_KEY_VERSION: z.coerce.number().int().positive(),
    METRICS_BEARER_TOKEN: z.string().default("")
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && value.REDIS_FAILURE_POLICY === "open") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REDIS_FAILURE_POLICY"],
        message: "fail-open rate limiting in production must be an explicit deployment risk decision"
      });
    }
  });

export type RedisFailurePolicy = "closed" | "open";

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly trustProxy: boolean;
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
  readonly databaseSslCaFile: string | undefined;
  readonly redisUrl: string;
  readonly redisFailurePolicy: RedisFailurePolicy;
  readonly webhookBodyLimitBytes: number;
  readonly defaultRateLimit: number;
  readonly defaultRateWindowSeconds: number;
  readonly signatureToleranceSeconds: number;
  readonly dbPoolMax: number;
  readonly dbStatementTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly masterKeys: ReadonlyMap<number, Buffer>;
  readonly activeKeyVersion: number;
  readonly metricsBearerToken: string | undefined;
}

export function parseMasterKeyring(raw: string): ReadonlyMap<number, Buffer> {
  const keys = new Map<number, Buffer>();

  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new Error("SLUICE_MASTER_KEYS entries must be version:base64");
    }

    const version = Number(entry.slice(0, separator));
    const encoded = entry.slice(separator + 1);
    const key = Buffer.from(encoded, "base64");

    if (!Number.isSafeInteger(version) || version <= 0 || key.length !== 32) {
      throw new Error("each master key must have a positive integer version and decode to 32 bytes");
    }
    if (keys.has(version)) {
      throw new Error(`duplicate master key version: ${version}`);
    }
    keys.set(version, key);
  }

  return keys;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const masterKeys = parseMasterKeyring(parsed.SLUICE_MASTER_KEYS);

  if (!masterKeys.has(parsed.SLUICE_ACTIVE_KEY_VERSION)) {
    throw new Error("SLUICE_ACTIVE_KEY_VERSION is not present in SLUICE_MASTER_KEYS");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    trustProxy: parsed.TRUST_PROXY,
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL,
    databaseSslCaFile:
      parsed.DATABASE_SSL_CA_FILE.length > 0
        ? parsed.DATABASE_SSL_CA_FILE
        : undefined,
    redisUrl: parsed.REDIS_URL,
    redisFailurePolicy: parsed.REDIS_FAILURE_POLICY,
    webhookBodyLimitBytes: parsed.WEBHOOK_BODY_LIMIT_BYTES,
    defaultRateLimit: parsed.DEFAULT_RATE_LIMIT,
    defaultRateWindowSeconds: parsed.DEFAULT_RATE_WINDOW_SECONDS,
    signatureToleranceSeconds: parsed.SIGNATURE_TOLERANCE_SECONDS,
    dbPoolMax: parsed.DB_POOL_MAX,
    dbStatementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS,
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
    masterKeys,
    activeKeyVersion: parsed.SLUICE_ACTIVE_KEY_VERSION,
    metricsBearerToken:
      parsed.METRICS_BEARER_TOKEN.length > 0 ? parsed.METRICS_BEARER_TOKEN : undefined
  };
}
