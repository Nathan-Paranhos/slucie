import "server-only";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var sluiceDashboardPool: Pool | undefined;
}

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export function database() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (!global.sluiceDashboardPool) {
    const ssl =
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized:
              process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
            ca: process.env.DATABASE_SSL_CA_FILE
              ? readFileSync(process.env.DATABASE_SSL_CA_FILE, "utf8")
              : undefined
          }
        : undefined;
    global.sluiceDashboardPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DASHBOARD_DB_POOL_SIZE ?? 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "sluice-dashboard",
      ssl
    });
  }

  return global.sluiceDashboardPool;
}

export async function withTenant<T>(
  tenantId: string,
  userId: string,
  operation: (client: PoolClient) => Promise<T>
) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  sql: string,
  values: unknown[] = []
) {
  const result = await database().query<T>(sql, values);
  return result.rows[0] ?? null;
}
