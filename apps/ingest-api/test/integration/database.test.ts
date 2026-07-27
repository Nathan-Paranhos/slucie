import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import {
  decryptEnvelope,
  encryptEnvelope,
  parseEnvelope,
  serializeEnvelope
} from "../../src/crypto/envelope.js";
import { PostgresDatabase } from "../../src/db.js";
import { encryptSourceContext } from "../../src/source-config.js";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const testAdminDatabaseUrl = process.env["TEST_DATABASE_ADMIN_URL"];
const { Client } = pg;

function testConfig(databaseUrl: string, masterKey: Buffer): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8080,
    trustProxy: false,
    databaseUrl,
    databaseSsl: false,
    databaseSslCaFile: undefined,
    redisUrl: "redis://127.0.0.1:6379",
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
    metricsBearerToken: undefined
  };
}

describe.skipIf(testDatabaseUrl === undefined)("Postgres contract", () => {
  it("connects and exposes the source resolver function", async () => {
    const config = testConfig(testDatabaseUrl as string, randomBytes(32));
    const database = new PostgresDatabase(config);
    try {
      expect(await database.isReady()).toBe(true);
      await expect(
        database.resolveSource("00000000-0000-4000-8000-000000000000")
      ).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it.skipIf(testAdminDatabaseUrl === undefined)(
    "persists event and job atomically using the exact migration signature",
    async () => {
      const tenantId = randomUUID();
      const sourceId = randomUUID();
      const endpointKey = randomUUID();
      const masterKey = randomBytes(32);
      const secret = Buffer.from("integration-source-secret", "utf8");
      const rawBody = Buffer.from(
        '{"id":"evt-integration","event":"PAYMENT_CREATED","amount":123}',
        "utf8"
      );
      const externalEventId = "evt-integration";
      const secretEnvelope = Buffer.from(
        serializeEnvelope(
          encryptEnvelope(
            secret,
            encryptSourceContext("secret", tenantId, sourceId),
            1,
            masterKey
          )
        ),
        "utf8"
      );
      const admin = new Client({
        connectionString: testAdminDatabaseUrl as string,
        application_name: "sluice-ingest-integration-admin"
      });
      const database = new PostgresDatabase(
        testConfig(testDatabaseUrl as string, masterKey)
      );
      let adminConnected = false;

      try {
        await admin.connect();
        adminConnected = true;
        await admin.query(
          `INSERT INTO sluice.tenants (id, slug, name)
           VALUES ($1::uuid, $2::text, $3::text)`,
          [tenantId, `integration-${tenantId}`, "Ingest integration test"]
        );
        await admin.query(
          `INSERT INTO sluice.webhook_sources (
             id, tenant_id, endpoint_key, provider, name,
             signing_secret_envelope, config_envelope, key_version
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'asaas', 'integration',
             $4::bytea, NULL, 1
           )`,
          [sourceId, tenantId, endpointKey, secretEnvelope]
        );

        const source = await database.resolveSource(endpointKey);
        expect(source).toMatchObject({
          tenantId,
          sourceId,
          provider: "asaas",
          configCiphertext: undefined,
          keyVersion: 1
        });

        const persistInput = {
          tenantId,
          sourceId,
          externalEventId,
          eventType: "PAYMENT_CREATED",
          rawBody,
          contentType: "application/json",
          sanitizedHeaders: { "content-type": "application/json" },
          purgeAfter: new Date(Date.now() + 90 * 86_400_000),
          jobType: "webhook.process",
          priority: 100,
          maxAttempts: 8,
          keyVersion: 1,
          masterKey,
          requestId: randomUUID()
        };
        const inserted = await database.persistWebhook(persistInput);
        const duplicate = await database.persistWebhook({
          ...persistInput,
          requestId: randomUUID()
        });
        const conflict = await database.persistWebhook({
          ...persistInput,
          rawBody: Buffer.from(
            '{"id":"evt-integration","event":"PAYMENT_CREATED","amount":999}',
            "utf8"
          ),
          requestId: randomUUID()
        });

        expect(inserted.outcome).toBe("inserted");
        expect(inserted.jobId).toBeDefined();
        expect(duplicate).toEqual({
          outcome: "duplicate",
          eventId: inserted.eventId,
          jobId: inserted.jobId
        });
        expect(conflict).toEqual({
          outcome: "conflict",
          eventId: inserted.eventId,
          jobId: undefined
        });

        const stored = await admin.query<{
          raw_body_envelope: Buffer;
          schema_version: number;
          event_count: string;
          job_count: string;
        }>(
          `SELECT
             event.raw_body_envelope,
             event.schema_version,
             (SELECT count(*)::text
                FROM sluice.webhook_events
               WHERE tenant_id = $1::uuid) AS event_count,
             (SELECT count(*)::text
                FROM sluice.jobs
               WHERE tenant_id = $1::uuid) AS job_count
           FROM sluice.webhook_events AS event
           WHERE event.tenant_id = $1::uuid
             AND event.id = $2::uuid`,
          [tenantId, inserted.eventId]
        );
        const storedEvent = stored.rows[0];
        expect(storedEvent).toBeDefined();
        expect(storedEvent?.schema_version).toBe(1);
        expect(storedEvent?.event_count).toBe("1");
        expect(storedEvent?.job_count).toBe("1");

        const externalIdHash = createHash("sha256")
          .update(tenantId, "utf8")
          .update("\0", "utf8")
          .update(sourceId, "utf8")
          .update("\0", "utf8")
          .update(externalEventId, "utf8")
          .digest("hex");
        const decryptedBody = decryptEnvelope(
          parseEnvelope(storedEvent?.raw_body_envelope),
          `webhook-event-body:${tenantId}:${sourceId}:${externalIdHash}`,
          new Map([[1, masterKey]])
        );
        expect(decryptedBody).toEqual(rawBody);
        decryptedBody.fill(0);
      } finally {
        await database.close().catch(() => undefined);
        if (adminConnected) {
          await admin.query(
            "DELETE FROM sluice.jobs WHERE tenant_id = $1::uuid",
            [tenantId]
          ).catch(() => undefined);
          await admin.query(
            "DELETE FROM sluice.webhook_events WHERE tenant_id = $1::uuid",
            [tenantId]
          ).catch(() => undefined);
          await admin.query(
            "DELETE FROM sluice.webhook_sources WHERE tenant_id = $1::uuid",
            [tenantId]
          ).catch(() => undefined);
          // The ingestion function writes an intentionally append-only audit
          // record whose tenant FK prevents full fixture deletion. Integration
          // tests therefore require a disposable database; leave that evidence
          // intact instead of disabling the audit protection trigger.
        }
        await admin.end().catch(() => undefined);
        secret.fill(0);
        secretEnvelope.fill(0);
        masterKey.fill(0);
      }
    }
  );
});
