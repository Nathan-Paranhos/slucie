import "server-only";
import { demoDashboard } from "./demo-data";
import { isDemoMode } from "./auth";
import { hasDatabase, withTenant } from "./db";
import type {
  DashboardPayload,
  Destination,
  Job,
  Source,
  Tenant,
  WebhookEvent,
  Worker
} from "./types";

type DbJob = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  job_type: string;
  source_name: string | null;
  status: string;
  delivery_count: number;
  max_attempts: number;
  priority: number;
  available_at: Date;
  created_at: Date;
  completed_at: Date | null;
  external_event_id: string | null;
};

function jobStatus(status: string): Job["status"] {
  if (status === "dead_letter") return "dead-letter";
  if (
    status === "completed" ||
    status === "processing" ||
    status === "pending" ||
    status === "retry"
  ) {
    return status;
  }
  return "pending";
}

function displayJobStatus(status: string, deliveryCount: number): Job["status"] {
  if (status === "pending" && deliveryCount > 0) return "retry";
  return jobStatus(status);
}

function priority(value: number): Job["priority"] {
  if (value <= 10) return "high";
  if (value <= 50) return "medium";
  return "low";
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo"
  }).format(value);
}

function emptyPayload(): DashboardPayload {
  return {
    ...structuredClone(demoDashboard),
    stats: demoDashboard.stats.map((stat) => ({ ...stat, value: "—", trend: "—" })),
    chart: Array.from({ length: 30 }, () => 0),
    activity: [],
    jobs: [],
    events: [],
    sources: [],
    destinations: [],
    pipelines: [],
    workers: [],
    tenants: []
  };
}

export async function loadDashboard(
  tenantId: string,
  userId: string
): Promise<DashboardPayload> {
  if (isDemoMode() || !hasDatabase()) {
    return structuredClone(demoDashboard);
  }

  if (tenantId === "all") {
    throw new Error(
      "The aggregate all-tenant view is available only in demo mode; select one tenant."
    );
  }
  const effectiveTenant = tenantId;

  return withTenant(effectiveTenant, userId, async (client) => {
    const output = emptyPayload();
    const tenantFilter = effectiveTenant ? "WHERE t.id = $1::uuid" : "";
    const values = effectiveTenant ? [effectiveTenant] : [];

    const [
      statsResult,
      jobsResult,
      eventsResult,
      sourcesResult,
      destinationsResult,
      pipelinesResult,
      tenantsResult,
      workersResult,
      chartResult
    ] = await Promise.all([
      client.query<{
        event_count: string;
        completed_count: string;
        success_rate: string;
        p95_ms: string;
      }>(
        `SELECT
           (SELECT count(*) FROM sluice.webhook_events e
             WHERE e.received_at >= now() - interval '24 hours'
             ${effectiveTenant ? "AND e.tenant_id = $1::uuid" : ""})::text event_count,
           (SELECT count(*) FROM sluice.jobs j
             WHERE j.status = 'completed'
               AND j.completed_at >= now() - interval '24 hours'
             ${effectiveTenant ? "AND j.tenant_id = $1::uuid" : ""})::text completed_count,
           COALESCE((SELECT round(
             100.0 * count(*) FILTER (WHERE j.status = 'completed') /
             NULLIF(count(*) FILTER (WHERE j.status IN ('completed','dead_letter')), 0), 2)
             FROM sluice.jobs j
             WHERE j.created_at >= now() - interval '24 hours'
             ${effectiveTenant ? "AND j.tenant_id = $1::uuid" : ""}), 100)::text success_rate,
           COALESCE((SELECT round(
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY extract(epoch FROM (j.completed_at - j.created_at)) * 1000
             )) FROM sluice.jobs j
             WHERE j.completed_at >= now() - interval '24 hours'
             ${effectiveTenant ? "AND j.tenant_id = $1::uuid" : ""}), 0)::text p95_ms`,
        values
      ),
      client.query<DbJob>(
        `SELECT j.id::text, j.tenant_id::text, t.name tenant_name, j.job_type,
                s.name source_name, j.status::text, j.delivery_count,
                j.max_attempts, j.priority, j.available_at, j.created_at,
                j.completed_at,
                CASE WHEN e.external_event_id_hash IS NULL THEN NULL
                     ELSE 'sha256:' || left(encode(e.external_event_id_hash, 'hex'), 16)
                END external_event_id
         FROM sluice.jobs j
         JOIN sluice.tenants t ON t.id = j.tenant_id
         LEFT JOIN sluice.webhook_events e
           ON e.id = j.event_id AND e.tenant_id = j.tenant_id
         LEFT JOIN sluice.webhook_sources s
           ON s.id = e.source_id AND s.tenant_id = e.tenant_id
         ${effectiveTenant ? "WHERE j.tenant_id = $1::uuid" : ""}
         ORDER BY j.created_at DESC
         LIMIT 100`,
        values
      ),
      client.query<{
        id: string;
        external_event_id: string;
        provider: WebhookEvent["provider"];
        source_name: string;
        tenant_name: string;
        event_type: string;
        ingestion_status: WebhookEvent["status"];
        received_at: Date;
        payload_size_bytes: number | null;
        purge_after: Date;
      }>(
        `SELECT e.id::text,
                'sha256:' || left(encode(e.external_event_id_hash, 'hex'), 16)
                  external_event_id,
                replace(s.provider::text, '_', '-') provider,
                s.name source_name, t.name tenant_name,
                e.provider_event_type event_type,
                'accepted'::text ingestion_status,
                e.received_at, octet_length(e.raw_body_envelope) payload_size_bytes,
                e.purge_after
         FROM sluice.webhook_events e
         JOIN sluice.webhook_sources s
           ON s.id = e.source_id AND s.tenant_id = e.tenant_id
         JOIN sluice.tenants t ON t.id = e.tenant_id
         ${effectiveTenant ? "WHERE e.tenant_id = $1::uuid" : ""}
         ORDER BY e.received_at DESC
         LIMIT 100`,
        values
      ),
      client.query<{
        id: string;
        name: string;
        provider: Source["provider"];
        public_key: string;
        is_active: boolean;
        events_24h: string;
      }>(
        `SELECT s.id::text, s.name, replace(s.provider::text, '_', '-') provider,
                s.endpoint_key::text public_key,
                (s.status = 'active') is_active,
                count(e.id) FILTER (WHERE e.received_at >= now() - interval '24 hours')::text events_24h
         FROM sluice.webhook_sources s
         LEFT JOIN sluice.webhook_events e
           ON e.source_id = s.id AND e.tenant_id = s.tenant_id
         ${effectiveTenant ? "WHERE s.tenant_id = $1::uuid" : ""}
         GROUP BY s.id, s.name, s.provider, s.endpoint_key, s.status
         ORDER BY s.name`,
        values
      ),
      client.query<{
        id: string;
        name: string;
        kind: Destination["kind"];
        endpoint_url: string;
        is_active: boolean;
      }>(
        `SELECT d.id::text, d.name, d.kind::text,
                COALESCE(d.allowed_hosts[1], 'configurado') endpoint_url,
                (d.status = 'active') is_active
         FROM sluice.destinations d
         ${effectiveTenant ? "WHERE d.tenant_id = $1::uuid" : ""}
         ORDER BY d.name`,
        values
      ),
      client.query<{
        id: string;
        name: string;
        source_name: string;
        destination_name: string;
        is_active: boolean;
      }>(
        `SELECT p.id::text, p.name, s.name source_name,
                string_agg(d.name, ', ' ORDER BY d.name) destination_name,
                (p.status = 'active') is_active
         FROM sluice.pipelines p
         JOIN sluice.webhook_sources s
           ON s.id = p.source_id AND s.tenant_id = p.tenant_id
         LEFT JOIN sluice.pipeline_destinations pd
           ON pd.pipeline_id = p.id AND pd.tenant_id = p.tenant_id
         LEFT JOIN sluice.destinations d
           ON d.id = pd.destination_id AND d.tenant_id = pd.tenant_id
         ${effectiveTenant ? "WHERE p.tenant_id = $1::uuid" : ""}
         GROUP BY p.id, p.name, s.name, p.status
         ORDER BY p.name`,
        values
      ),
      client.query<{
        id: string;
        name: string;
        slug: string;
        status: string;
        retention_days: number;
      }>(
        `SELECT t.id::text, t.name, t.slug, t.status::text,
                t.raw_payload_retention_days retention_days
         FROM sluice.tenants t ${tenantFilter}
         ORDER BY t.name`,
        values
      ),
      client.query<{
        claimed_by: string;
        current_jobs: string;
        processed: string;
      }>(
        `SELECT claimed_by,
                count(*) FILTER (WHERE status = 'processing')::text current_jobs,
                count(*) FILTER (WHERE status = 'completed')::text processed
         FROM sluice.jobs
         WHERE claimed_by IS NOT NULL
           ${effectiveTenant ? "AND tenant_id = $1::uuid" : ""}
         GROUP BY claimed_by
         ORDER BY claimed_by`,
        values
      ),
      client.query<{ bucket: Date; count: string }>(
        `SELECT date_trunc('hour', received_at) bucket, count(*)::text
         FROM sluice.webhook_events
         WHERE received_at >= now() - interval '24 hours'
           ${effectiveTenant ? "AND tenant_id = $1::uuid" : ""}
         GROUP BY bucket ORDER BY bucket`,
        values
      )
    ]);

    const stats = statsResult.rows[0];
    const number = new Intl.NumberFormat("pt-BR", { notation: "compact" });
    output.stats = [
      {
        label: "Eventos processados",
        value: number.format(Number(stats?.event_count ?? 0)),
        trend: "24h",
        trendDirection: "up",
        hint: "janela móvel"
      },
      {
        label: "Jobs concluídos",
        value: number.format(Number(stats?.completed_count ?? 0)),
        trend: "24h",
        trendDirection: "up",
        hint: "janela móvel"
      },
      {
        label: "Taxa de sucesso",
        value: `${stats?.success_rate ?? "100"}%`,
        trend: "efetiva",
        trendDirection: "up",
        hint: "terminais nas últimas 24h"
      },
      {
        label: "Latência p95",
        value: `${Math.round(Number(stats?.p95_ms ?? 0))}ms`,
        trend: "p95",
        trendDirection: "up",
        hint: "criação → conclusão"
      }
    ];

    output.jobs = jobsResult.rows.map((row) => ({
      id: row.id,
      tenant: row.tenant_name,
      tenantId: row.tenant_id,
      type: row.job_type,
      source: row.source_name ?? "Sistema",
      status: displayJobStatus(row.status, row.delivery_count),
      attempts: row.delivery_count,
      maxAttempts: row.max_attempts,
      priority: priority(row.priority),
      availableAt: formatDate(row.available_at),
      createdAt: formatDate(row.created_at),
      duration: row.completed_at
        ? `${Math.max(0, row.completed_at.getTime() - row.created_at.getTime())}ms`
        : "—",
      externalEventId: row.external_event_id ?? "—",
      payloadPreview: { protected: true, message: "Payload cifrado em repouso" }
    }));

    output.events = eventsResult.rows.map((row) => ({
      id: row.id,
      externalId: row.external_event_id,
      provider: row.provider,
      source: row.source_name,
      tenant: row.tenant_name,
      eventType: row.event_type,
      status: row.ingestion_status,
      receivedAt: formatDate(row.received_at),
      size: row.payload_size_bytes
        ? `${(row.payload_size_bytes / 1024).toFixed(1)} KB`
        : "—",
      purgeAt: formatDate(row.purge_after)
    }));

    output.sources = sourcesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      description: "Fonte autenticada e isolada por tenant.",
      endpointKey: `${row.public_key.slice(0, 9)}••••${row.public_key.slice(-3)}`,
      status: row.is_active ? "active" : "inactive",
      events24h: number.format(Number(row.events_24h)),
      successRate: "—"
    }));

    output.destinations = destinationsResult.rows.map((row) => {
      const host = row.endpoint_url;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        description: "Destino HTTPS com ledger idempotente.",
        host,
        status: row.is_active ? "active" : "inactive",
        deliveries24h: "—",
        latency: "—"
      };
    });

    output.pipelines = pipelinesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      source: row.source_name,
      destination: row.destination_name || "Sem destino",
      description: "Pipeline de entrega confiável.",
      status: row.is_active ? "active" : "paused",
      throughput: "—",
      successRate: "—"
    }));

    output.tenants = tenantsResult.rows.map<Tenant>((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: "Self-hosted",
      status: row.status === "active" ? "active" : "inactive",
      retentionDays: row.retention_days,
      eventsMonth: "—",
      members: 0
    }));

    output.workers = workersResult.rows.map<Worker>((row) => ({
      id: row.claimed_by,
      region: "self-hosted",
      status: "active",
      currentJobs: Number(row.current_jobs),
      capacity: Number(process.env.WORKER_DISPLAY_CAPACITY ?? 32),
      processed: number.format(Number(row.processed)),
      uptime: "online",
      cpu: 0
    }));

    output.chart =
      chartResult.rows.length > 0
        ? chartResult.rows.map((row) => Number(row.count))
        : Array.from({ length: 24 }, () => 0);
    output.generatedAt = new Date().toISOString();
    output.tenant =
      effectiveTenant && output.tenants[0]
        ? {
            id: output.tenants[0].id,
            name: output.tenants[0].name,
            retentionDays: output.tenants[0].retentionDays
          }
        : { id: "all", name: "Todos os tenants", retentionDays: 90 };

    return output;
  });
}
