import { randomUUID } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { z } from "zod";
import { parseMasterKeyring } from "../config.js";
import { encryptEnvelope, serializeEnvelope } from "../crypto/envelope.js";
import {
  normalizeProviderName,
  providerRouteName,
  type ProviderName
} from "../providers/index.js";
import {
  encryptSourceContext,
  parseProviderSourceRuntimeConfig
} from "../source-config.js";

const { Client } = pg;
const uuidSchema = z.string().uuid();

interface Arguments {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly sourceId: string;
  readonly endpointKey: string;
  readonly provider: ProviderName;
  readonly name: string;
}

function flag(name: string): string | undefined {
  const position = process.argv.indexOf(`--${name}`);
  return position < 0 ? undefined : process.argv[position + 1];
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return value;
}

function parseArguments(): Arguments {
  const providerInput = requiredFlag("provider");
  const provider = normalizeProviderName(providerInput);
  if (provider === undefined) {
    throw new Error(
      "provider must be asaas, pagbank, mercado-pago, mercado_pago, stripe, or pix"
    );
  }
  return {
    tenantId: uuidSchema.parse(requiredFlag("tenant-id")),
    actorUserId: uuidSchema.parse(requiredFlag("actor-user-id")),
    sourceId: uuidSchema.parse(flag("source-id") ?? randomUUID()),
    endpointKey: uuidSchema.parse(flag("endpoint-key") ?? randomUUID()),
    provider,
    name: flag("name") ?? `${provider} development source`
  };
}

async function main(): Promise<void> {
  const args = parseArguments();
  // Runtime sluice_api credentials are intentionally function-only and cannot
  // create sources. Use a dashboard/provisioning role whose RLS context belongs
  // to a tenant owner or administrator.
  const databaseUrl = process.env["SLUICE_BOOTSTRAP_DATABASE_URL"];
  const rawKeyring = process.env["SLUICE_MASTER_KEYS"];
  const activeVersion = Number(process.env["SLUICE_ACTIVE_KEY_VERSION"]);
  const secretValue = process.env["SLUICE_BOOTSTRAP_SECRET"];
  const configValue = process.env["SLUICE_BOOTSTRAP_CONFIG_JSON"] ?? "{}";

  if (
    databaseUrl === undefined ||
    rawKeyring === undefined ||
    secretValue === undefined ||
    !Number.isSafeInteger(activeVersion)
  ) {
    throw new Error(
      "SLUICE_BOOTSTRAP_DATABASE_URL, SLUICE_MASTER_KEYS, SLUICE_ACTIVE_KEY_VERSION, and SLUICE_BOOTSTRAP_SECRET are required"
    );
  }
  if (Buffer.byteLength(secretValue, "utf8") < 16) {
    throw new Error("SLUICE_BOOTSTRAP_SECRET must contain at least 16 UTF-8 bytes");
  }

  const config = parseProviderSourceRuntimeConfig(
    args.provider,
    JSON.parse(configValue) as unknown
  );
  const keyring = parseMasterKeyring(rawKeyring);
  const masterKey = keyring.get(activeVersion);
  if (masterKey === undefined) {
    throw new Error("active master key version is not in the keyring");
  }

  const secretBytes = Buffer.from(secretValue, "utf8");
  const configBytes = Buffer.from(JSON.stringify(config), "utf8");
  const secretEnvelope = Buffer.from(
    serializeEnvelope(
      encryptEnvelope(
        secretBytes,
        encryptSourceContext("secret", args.tenantId, args.sourceId),
        activeVersion,
        masterKey
      )
    ),
    "utf8"
  );
  const configEnvelope = Buffer.from(
    serializeEnvelope(
      encryptEnvelope(
        configBytes,
        encryptSourceContext("config", args.tenantId, args.sourceId),
        activeVersion,
        masterKey
      )
    ),
    "utf8"
  );

  const client = new Client({
    connectionString: databaseUrl,
    ssl:
      process.env["SLUICE_BOOTSTRAP_DATABASE_SSL"] === "true"
        ? { rejectUnauthorized: true }
        : false,
    application_name: "sluice-bootstrap-source"
  });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      args.tenantId
    ]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      args.actorUserId
    ]);
    await client.query(
      `INSERT INTO sluice.webhook_sources (
         id, tenant_id, endpoint_key, provider, name, status,
         signing_secret_envelope, config_envelope, key_version
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, 'active',
         $6::bytea, $7::bytea, $8::integer
       )`,
      [
        args.sourceId,
        args.tenantId,
        args.endpointKey,
        args.provider,
        args.name,
        secretEnvelope,
        configEnvelope,
        activeVersion
      ]
    );
    await client.query(
      `INSERT INTO sluice.audit_log (
         tenant_id, actor_type, actor_id, action, resource_type, resource_id,
         metadata
       ) VALUES (
         $1::uuid, 'user', $2::text, 'webhook_source.created',
         'webhook_source', $3::text, jsonb_build_object(
           'provider', $4::text,
           'name', $5::text
         )
       )`,
      [
        args.tenantId,
        args.actorUserId,
        args.sourceId,
        args.provider,
        args.name
      ]
    );
    await client.query("COMMIT");
    process.stdout.write(
      `${JSON.stringify({
        created: true,
        tenantId: args.tenantId,
        sourceId: args.sourceId,
        endpointKey: args.endpointKey,
        provider: args.provider,
        webhookPath:
          `/v1/webhooks/${providerRouteName(args.provider)}/${args.endpointKey}`,
        keyVersion: activeVersion
      })}\n`
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    secretBytes.fill(0);
    configBytes.fill(0);
    secretEnvelope.fill(0);
    configEnvelope.fill(0);
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "bootstrap failed";
  const diagnostic = error instanceof Error ? error.stack : undefined;
  process.stderr.write(`${diagnostic ?? String(error)}\n`);
  process.stderr.write(
    `${JSON.stringify({
      error: message
    })}\n`
  );
  process.exitCode = 1;
});
