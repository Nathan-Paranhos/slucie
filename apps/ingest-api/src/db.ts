import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { AppConfig } from "./config.js";
import { encryptEnvelope, serializeEnvelope } from "./crypto/envelope.js";
import { isProviderName } from "./providers/index.js";
import type { EncryptedSourceRecord } from "./source-config.js";

const { Pool } = pg;

interface SourceRow {
  readonly source_id: string;
  readonly tenant_id: string;
  readonly provider: string;
  readonly signing_secret_envelope: Buffer;
  readonly config_envelope: Buffer | null;
  readonly key_version: number;
  readonly rate_limit_per_minute: number | null;
  readonly max_body_bytes: number | null;
  readonly raw_payload_retention_days: number | null;
}

interface IngestFunctionRow {
  readonly outcome: string;
  readonly event_id: string;
  readonly job_id: string | null;
}

export type IngestOutcome = "inserted" | "duplicate" | "conflict";
export type DatabaseOperation = "resolve_source" | "persist_webhook";

export class DatabaseOperationError extends Error {
  public constructor(
    public readonly operation: DatabaseOperation,
    cause: unknown
  ) {
    super(`database operation failed: ${operation}`, { cause });
    this.name = "DatabaseOperationError";
  }
}

export interface PersistWebhookInput {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly rawBody: Buffer;
  readonly contentType: string;
  readonly sanitizedHeaders: Readonly<Record<string, string>>;
  readonly purgeAfter: Date;
  readonly jobType: string;
  readonly priority: number;
  readonly maxAttempts: number;
  readonly keyVersion: number;
  readonly masterKey: Buffer;
  readonly requestId: string;
}

export interface PersistWebhookResult {
  readonly outcome: IngestOutcome;
  readonly eventId: string;
  readonly jobId: string | undefined;
}

export interface Database {
  resolveSource(endpointKey: string): Promise<EncryptedSourceRecord | undefined>;
  persistWebhook(input: PersistWebhookInput): Promise<PersistWebhookResult>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

function payloadContext(
  type: "body" | "external-id",
  tenantId: string,
  sourceId: string,
  externalIdHash: Buffer
): string {
  return `webhook-event-${type}:${tenantId}:${sourceId}:${externalIdHash.toString("hex")}`;
}

export class PostgresDatabase implements Database {
  private readonly pool: pg.Pool;

  public constructor(config: AppConfig) {
    const ssl = config.databaseSsl
      ? {
          rejectUnauthorized: true,
          ca: config.databaseSslCaFile
            ? readFileSync(config.databaseSslCaFile, "utf8")
            : undefined
        }
      : false;
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      statement_timeout: config.dbStatementTimeoutMs,
      application_name: "sluice-ingest-api",
      options: "-c timezone=UTC",
      ssl
    });
  }

  public async resolveSource(
    endpointKey: string
  ): Promise<EncryptedSourceRecord | undefined> {
    try {
      const result = await this.pool.query<SourceRow>(
        "SELECT * FROM sluice.resolve_webhook_source($1::uuid)",
        [endpointKey]
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;

      if (!isProviderName(row.provider)) {
        throw new Error("database returned an unsupported webhook source provider");
      }
      return {
        sourceId: row.source_id,
        tenantId: row.tenant_id,
        provider: row.provider,
        secretCiphertext: row.signing_secret_envelope,
        configCiphertext: row.config_envelope ?? undefined,
        keyVersion: row.key_version,
        rateLimitPerMinute: row.rate_limit_per_minute ?? undefined,
        maxBodyBytes: row.max_body_bytes ?? undefined,
        rawPayloadRetentionDays: row.raw_payload_retention_days ?? undefined
      };
    } catch (error) {
      throw new DatabaseOperationError("resolve_source", error);
    }
  }

  public async persistWebhook(
    input: PersistWebhookInput
  ): Promise<PersistWebhookResult> {
    const externalEventIdHash = createHash("sha256")
      .update(input.tenantId, "utf8")
      .update("\0", "utf8")
      .update(input.sourceId, "utf8")
      .update("\0", "utf8")
      .update(input.externalEventId, "utf8")
      .digest();
    const payloadHash = createHash("sha256").update(input.rawBody).digest();

    const externalIdEnvelope = Buffer.from(
      serializeEnvelope(
        encryptEnvelope(
          Buffer.from(input.externalEventId, "utf8"),
          payloadContext(
            "external-id",
            input.tenantId,
            input.sourceId,
            externalEventIdHash
          ),
          input.keyVersion,
          input.masterKey
        )
      ),
      "utf8"
    );
    const bodyEnvelope = Buffer.from(
      serializeEnvelope(
        encryptEnvelope(
          input.rawBody,
          payloadContext("body", input.tenantId, input.sourceId, externalEventIdHash),
          input.keyVersion,
          input.masterKey
        )
      ),
      "utf8"
    );
    const idempotencyKey = `${input.sourceId}:${externalEventIdHash.toString("hex")}`;

    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [input.requestId]);
      const result = await client.query<IngestFunctionRow>(
        `SELECT outcome, event_id::text, job_id::text
           FROM sluice.ingest_event_and_enqueue(
             p_tenant_id => $1::uuid,
             p_source_id => $2::uuid,
             p_external_event_id_hash => $3::bytea,
             p_external_event_id_ciphertext => $4::bytea,
             p_provider_event_type => $5::text,
             p_payload_hash => $6::bytea,
             p_raw_body_ciphertext => $7::bytea,
             p_key_version => $8::integer,
             p_content_type => $9::text,
             p_sanitized_headers => $10::jsonb,
             p_purge_after => $11::timestamptz,
             p_job_type => $12::text,
             p_idempotency_key => $13::text,
             p_priority => $14::smallint,
             p_max_attempts => $15::smallint
           )`,
        [
          input.tenantId,
          input.sourceId,
          externalEventIdHash,
          externalIdEnvelope,
          input.eventType,
          payloadHash,
          bodyEnvelope,
          input.keyVersion,
          input.contentType,
          JSON.stringify(input.sanitizedHeaders),
          input.purgeAfter,
          input.jobType,
          idempotencyKey,
          input.priority,
          input.maxAttempts
        ]
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        !["inserted", "duplicate", "conflict"].includes(row.outcome)
      ) {
        throw new Error("ingestion function returned an invalid result");
      }
      await client.query("COMMIT");
      return {
        outcome: row.outcome as IngestOutcome,
        eventId: row.event_id,
        jobId: row.job_id ?? undefined
      };
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw new DatabaseOperationError("persist_webhook", error);
    } finally {
      externalIdEnvelope.fill(0);
      bodyEnvelope.fill(0);
      client?.release();
    }
  }

  public async isReady(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
