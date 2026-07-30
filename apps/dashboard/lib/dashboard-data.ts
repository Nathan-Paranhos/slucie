import "server-only";
import { demoDashboard } from "./demo-data";
import { isDemoMode, SESSION_DURATION_SECONDS } from "./auth";
import { hasDatabase, withTenant } from "./db";
import type {
  Activity,
  DashboardPayload,
  Destination,
  Job,
  ServiceHealth,
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
  attempt_duration_ms: number | null;
  external_event_id: string | null;
};

type ActivityRow = {
  id: string;
  action: string;
  resource_id: string;
  created_at: Date;
  job_id: string | null;
  job_type: string | null;
  delivery_count: number | null;
  source_name: string | null;
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

function relativeTime(value: Date) {
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function numberOrDash(value: string | null | undefined, suffix = "") {
  return value === null || value === undefined ? "—" : `${value}${suffix}`;
}

function emptyPayload(): DashboardPayload {
  return {
    ...structuredClone(demoDashboard),
    stats: demoDashboard.stats.map((stat) => ({ ...stat, value: "—", trend: "—" })),
    chart: Array.from({ length: 24 }, () => 0),
    activity: [],
    jobs: [],
    events: [],
    sources: [],
    destinations: [],
    pipelines: [],
    workers: [],
    tenants: [],
    jobDistribution: {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      retry: 0,
      deadLetter: 0
    },
    operational: {
      services: [],
      deadLetters: 0
    }
  };
}

async function probeService(
  id: ServiceHealth["id"],
  label: string,
  url: string
): Promise<ServiceHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    return response.ok
      ? { id, label, status: "healthy", detail: "Healthcheck respondeu" }
      : {
          id,
          label,
          status: "degraded",
          detail: `Healthcheck respondeu HTTP ${response.status}`
        };
  } catch {
    return {
      id,
      label,
      status: "unavailable",
      detail: "Healthcheck indisponível"
    };
  } finally {
    clearTimeout(timer);
  }
}

function activityFromRow(row: ActivityRow): Activity {
  const source = row.source_name ?? "Sistema";
  const attempts = row.delivery_count ?? 0;
  const common = {
    id: row.id,
    time: relativeTime(row.created_at),
    ...(row.job_id ? { jobId: row.job_id } : {})
  };

  if (row.action === "webhook_event.accepted") {
    return {
      ...common,
      title: `${source} · evento aceito`,
      detail: "Persistido de forma durável antes do processamento.",
      tone: "success"
    };
  }
  if (row.action === "webhook_event.dedupe_conflict") {
    return {
      ...common,
      title: `${source} · conflito de deduplicação`,
      detail: "O evento foi isolado para investigação.",
      tone: "danger"
    };
  }
  if (row.action === "webhook_event.payload_purged") {
    return {
      ...common,
      title: "Purge de payload concluído",
      detail: "Payload bruto removido pela política de retenção.",
      tone: "success"
    };
  }
  if (row.action === "job.completed") {
    return {
      ...common,
      title: `${source} · job concluído`,
      detail: `${row.job_type ?? "job"} finalizado após ${attempts} tentativa${attempts === 1 ? "" : "s"}.`,
      tone: "success"
    };
  }
  if (row.action === "job.dead_letter") {
    return {
      ...common,
      title: `${source} · dead-letter`,
      detail: `${row.job_type ?? "job"} esgotou as tentativas configuradas.`,
      tone: "danger"
    };
  }
  if (row.action === "job.pending" || row.action === "job.processing") {
    return {
      ...common,
      title: `${source} · ${row.action === "job.processing" ? "processando" : "na fila"}`,
      detail: `${row.job_type ?? "job"} com ${attempts} tentativa${attempts === 1 ? "" : "s"}.`,
      tone: "warning"
    };
  }
  if (row.action === "job.redriven") {
    return {
      ...common,
      title: "Redrive solicitado",
      detail: "Um novo job lógico foi criado com auditoria.",
      tone: "warning"
    };
  }
  return {
    ...common,
    title: "Alteração operacional registrada",
    detail: row.action.replaceAll("_", " ").replaceAll(".", " · "),
    tone: "warning"
  };
}

export async function loadDashboard(
  tenantId: string,
  userId: string
): Promise<DashboardPayload> {
  if (isDemoMode()) {
    return structuredClone(demoDashboard);
  }
  if (!hasDatabase()) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (tenantId === "all") {
    throw new Error(
      "The aggregate all-tenant view is available only in demo mode; select one tenant."
    );
  }

  const serviceChecks = Promise.all([
    probeService(
      "ingest",
      "Ingestão",
      process.env.SLUICE_INGEST_HEALTH_URL ?? "http://ingest-api:8080/health/ready"
    ),
    probeService(
      "worker",
      "Worker",
      process.env.SLUICE_WORKER_HEALTH_URL ?? "http://worker:8080/health/ready"
    )
  ]);

  return withTenant(tenantId, userId, async (client) => {
    const output = emptyPayload();
    const values = [tenantId];
    const [
      statsResult,
      jobsResult,
      eventsResult,
      sourcesResult,
      destinationsResult,
      pipelinesResult,
      tenantsResult,
      workersResult,
      chartResult,
      distributionResult,
      activityResult,
      settingsResult,
      externalServices
    ] = await Promise.all([
      client.query<{
        event_count: string;
        completed_count: string;
        success_rate: string | null;
        p95_attempt_ms: string | null;
      }>(
        `SELECT
           (SELECT count(*) FROM sluice.webhook_events e
             WHERE e.tenant_id = $1::uuid
               AND e.received_at >= now() - interval '24 hours')::text event_count,
           (SELECT count(*) FROM sluice.jobs j
             WHERE j.tenant_id = $1::uuid
               AND j.status = 'completed'
               AND j.completed_at >= now() - interval '24 hours')::text completed_count,
           (SELECT round(
             100.0 * count(*) FILTER (WHERE j.status = 'completed') /
             NULLIF(count(*) FILTER (WHERE j.status IN ('completed','dead_letter')), 0), 2)
             FROM sluice.jobs j
             WHERE j.tenant_id = $1::uuid
               AND j.created_at >= now() - interval '24 hours')::text success_rate,
           (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms))
              FROM sluice.job_attempts a
             WHERE a.tenant_id = $1::uuid
               AND a.finished_at >= now() - interval '24 hours'
               AND a.duration_ms IS NOT NULL)::text p95_attempt_ms`,
        values
      ),
      client.query<DbJob>(
        `SELECT j.id::text, j.tenant_id::text, t.name tenant_name, j.job_type,
                s.name source_name, j.status::text, j.delivery_count,
                j.max_attempts, j.priority, j.available_at, j.created_at,
                latest_attempt.duration_ms attempt_duration_ms,
                CASE WHEN e.external_event_id_hash IS NULL THEN NULL
                     ELSE 'sha256:' || left(encode(e.external_event_id_hash, 'hex'), 16)
                END external_event_id
         FROM sluice.jobs j
         JOIN sluice.tenants t ON t.id = j.tenant_id
         LEFT JOIN sluice.webhook_events e
           ON e.id = j.event_id AND e.tenant_id = j.tenant_id
         LEFT JOIN sluice.webhook_sources s
           ON s.id = e.source_id AND s.tenant_id = e.tenant_id
         LEFT JOIN LATERAL (
           SELECT a.duration_ms
             FROM sluice.job_attempts a
            WHERE a.tenant_id = j.tenant_id
              AND a.job_id = j.id
              AND a.duration_ms IS NOT NULL
            ORDER BY a.attempt_number DESC
            LIMIT 1
         ) latest_attempt ON true
         WHERE j.tenant_id = $1::uuid
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
                CASE WHEN EXISTS (
                  SELECT 1 FROM sluice.audit_log a
                   WHERE a.tenant_id = e.tenant_id
                     AND a.resource_id = e.id::text
                     AND a.action = 'webhook_event.dedupe_conflict'
                ) THEN 'quarantined' ELSE 'accepted' END ingestion_status,
                e.received_at, octet_length(e.raw_body_envelope) payload_size_bytes,
                e.purge_after
         FROM sluice.webhook_events e
         JOIN sluice.webhook_sources s
           ON s.id = e.source_id AND s.tenant_id = e.tenant_id
         JOIN sluice.tenants t ON t.id = e.tenant_id
         WHERE e.tenant_id = $1::uuid
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
        success_rate: string | null;
        reconciliation_enabled: boolean;
        reconciliation_window_hours: number;
        reconciliation_last_success_at: Date | null;
        reconciliation_has_error: boolean;
      }>(
        `SELECT s.id::text, s.name, replace(s.provider::text, '_', '-') provider,
                s.endpoint_key::text public_key,
                (s.status = 'active') is_active,
                metrics.events_24h::text,
                metrics.success_rate::text success_rate,
                s.reconciliation_enabled, s.reconciliation_window_hours,
                checkpoint.last_succeeded_at reconciliation_last_success_at,
                (checkpoint.last_error IS NOT NULL) reconciliation_has_error
         FROM sluice.webhook_sources s
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT e.id) FILTER (
                    WHERE e.received_at >= now() - interval '24 hours'
                  ) events_24h,
                  round(100.0 * count(j.id) FILTER (
                    WHERE j.created_at >= now() - interval '24 hours'
                      AND j.status = 'completed'
                  ) /
                    NULLIF(count(j.id) FILTER (
                      WHERE j.created_at >= now() - interval '24 hours'
                        AND j.status IN ('completed', 'dead_letter')
                    ), 0), 2)
                    success_rate
             FROM sluice.webhook_events e
             LEFT JOIN sluice.jobs j
               ON j.tenant_id = e.tenant_id AND j.event_id = e.id
            WHERE e.tenant_id = s.tenant_id AND e.source_id = s.id
         ) metrics ON true
         LEFT JOIN sluice.reconciliation_checkpoints checkpoint
           ON checkpoint.tenant_id = s.tenant_id AND checkpoint.source_id = s.id
         WHERE s.tenant_id = $1::uuid
         ORDER BY s.name`,
        values
      ),
      client.query<{
        id: string;
        name: string;
        kind: Destination["kind"];
        endpoint_url: string;
        is_active: boolean;
        deliveries_24h: string;
        p95_ms: string | null;
      }>(
        `SELECT d.id::text, d.name, d.kind::text,
                COALESCE(d.allowed_hosts[1], 'sem host permitido') endpoint_url,
                (d.status = 'active') is_active,
                metrics.deliveries_24h::text,
                metrics.p95_ms::text p95_ms
         FROM sluice.destinations d
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (
                    WHERE effect.status = 'applied'
                      AND effect.applied_at >= now() - interval '24 hours'
                  ) deliveries_24h,
                  round(percentile_cont(0.95) WITHIN GROUP (
                    ORDER BY extract(epoch FROM (effect.applied_at - effect.reserved_at)) * 1000
                  ) FILTER (
                    WHERE effect.status = 'applied'
                      AND effect.applied_at >= now() - interval '24 hours'
                  )) p95_ms
             FROM sluice.job_delivery_effects effect
            WHERE effect.tenant_id = d.tenant_id
              AND effect.destination_id = d.id
         ) metrics ON true
         WHERE d.tenant_id = $1::uuid
         ORDER BY d.name`,
        values
      ),
      client.query<{
        id: string;
        name: string;
        source_name: string;
        destination_name: string;
        is_active: boolean;
        events_24h: string;
        success_rate: string | null;
      }>(
        `SELECT p.id::text, p.name, s.name source_name,
                string_agg(d.name, ', ' ORDER BY d.name) destination_name,
                (p.status = 'active') is_active,
                metrics.events_24h::text,
                metrics.success_rate::text success_rate
         FROM sluice.pipelines p
         JOIN sluice.webhook_sources s
           ON s.id = p.source_id AND s.tenant_id = p.tenant_id
         LEFT JOIN sluice.pipeline_destinations pd
           ON pd.pipeline_id = p.id AND pd.tenant_id = p.tenant_id
         LEFT JOIN sluice.destinations d
           ON d.id = pd.destination_id AND d.tenant_id = pd.tenant_id
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT e.id) FILTER (
                    WHERE e.received_at >= now() - interval '24 hours'
                  ) events_24h,
                  round(100.0 * count(j.id) FILTER (
                    WHERE j.created_at >= now() - interval '24 hours'
                      AND j.status = 'completed'
                  ) /
                    NULLIF(count(j.id) FILTER (
                      WHERE j.created_at >= now() - interval '24 hours'
                        AND j.status IN ('completed', 'dead_letter')
                    ), 0), 2)
                    success_rate
             FROM sluice.webhook_events e
             LEFT JOIN sluice.jobs j
               ON j.tenant_id = e.tenant_id AND j.event_id = e.id
            WHERE e.tenant_id = p.tenant_id AND e.source_id = p.source_id
         ) metrics ON true
         WHERE p.tenant_id = $1::uuid
         GROUP BY p.id, p.name, s.name, p.status, metrics.events_24h, metrics.success_rate
         ORDER BY p.name`,
        values
      ),
      client.query<{
        id: string;
        name: string;
        slug: string;
        status: string;
        retention_days: number;
        events_month: string;
        members: string;
      }>(
        `SELECT t.id::text, t.name, t.slug, t.status::text,
                t.raw_payload_retention_days retention_days,
                (SELECT count(*) FROM sluice.webhook_events e
                  WHERE e.tenant_id = t.id
                    AND e.received_at >= date_trunc('month', now()))::text events_month,
                (SELECT count(*) FROM sluice.tenant_memberships m
                  WHERE m.tenant_id = t.id)::text members
         FROM sluice.tenants t
         WHERE t.id = $1::uuid
         ORDER BY t.name`,
        values
      ),
      client.query<{
        worker_id: string;
        current_jobs: string;
        processed: string;
        last_seen_at: Date | null;
      }>(
        `SELECT a.worker_id,
                count(DISTINCT j.id) FILTER (
                  WHERE j.status = 'processing'
                    AND j.claimed_by = a.worker_id
                    AND j.lease_expires_at > clock_timestamp()
                )::text current_jobs,
                count(*) FILTER (
                  WHERE a.status = 'succeeded'
                    AND a.finished_at >= now() - interval '24 hours'
                )::text processed,
                max(COALESCE(a.finished_at, a.started_at)) last_seen_at
           FROM sluice.job_attempts a
           LEFT JOIN sluice.jobs j
             ON j.tenant_id = a.tenant_id AND j.id = a.job_id
          WHERE a.tenant_id = $1::uuid
          GROUP BY a.worker_id
          ORDER BY last_seen_at DESC`,
        values
      ),
      client.query<{ count: string }>(
        `SELECT count(e.id)::text count
           FROM generate_series(
                  date_trunc('hour', now()) - interval '23 hours',
                  date_trunc('hour', now()),
                  interval '1 hour'
                ) bucket
           LEFT JOIN sluice.webhook_events e
             ON e.tenant_id = $1::uuid
            AND e.received_at >= bucket
            AND e.received_at < bucket + interval '1 hour'
          GROUP BY bucket
          ORDER BY bucket`,
        values
      ),
      client.query<{
        total: string;
        pending: string;
        processing: string;
        completed: string;
        retry: string;
        dead_letter: string;
      }>(
        `SELECT count(*)::text total,
                count(*) FILTER (WHERE status = 'pending' AND delivery_count = 0)::text pending,
                count(*) FILTER (WHERE status = 'processing')::text processing,
                count(*) FILTER (WHERE status = 'completed')::text completed,
                count(*) FILTER (WHERE status = 'pending' AND delivery_count > 0)::text retry,
                count(*) FILTER (WHERE status = 'dead_letter')::text dead_letter
           FROM sluice.jobs
          WHERE tenant_id = $1::uuid`,
        values
      ),
      client.query<ActivityRow>(
        `SELECT a.id::text, a.action, a.resource_id, a.created_at,
                j.id::text job_id, j.job_type, j.delivery_count, s.name source_name
           FROM sluice.audit_log a
           LEFT JOIN sluice.jobs j
             ON j.tenant_id = a.tenant_id AND j.id::text = a.resource_id
           LEFT JOIN sluice.webhook_events e
             ON e.tenant_id = a.tenant_id
            AND (e.id::text = a.resource_id OR e.id = j.event_id)
           LEFT JOIN sluice.webhook_sources s
             ON s.tenant_id = a.tenant_id AND s.id = e.source_id
          WHERE a.tenant_id = $1::uuid
          ORDER BY a.created_at DESC
          LIMIT 12`,
        values
      ),
      client.query<{
        raw_payload_days: number;
        dedupe_metadata_days: number;
        default_max_attempts: number;
        account_mfa_enabled: boolean;
        waiting_for_purge: string;
        next_purge_at: Date | null;
        last_payload_purge_at: Date | null;
        payloads_purged_24h: string;
        notifications_pending: string;
        notifications_processing: string;
        notifications_sent_24h: string;
        notifications_failed: string;
        audit_records_24h: string;
        enabled_sources: string;
        total_sources: string;
        reconciliation_sources_with_error: string;
        reconciliation_last_success_at: Date | null;
      }>(
        `SELECT t.raw_payload_retention_days raw_payload_days,
                t.dedupe_metadata_retention_days dedupe_metadata_days,
                t.default_max_attempts,
                COALESCE((SELECT u.mfa_enabled FROM sluice.users u WHERE u.id = $2::uuid), false)
                  account_mfa_enabled,
                (SELECT count(*) FROM sluice.webhook_events e
                  WHERE e.tenant_id = t.id
                    AND e.raw_body_envelope IS NOT NULL
                    AND e.purge_after <= now())::text waiting_for_purge,
                (SELECT min(e.purge_after) FROM sluice.webhook_events e
                  WHERE e.tenant_id = t.id
                    AND e.raw_body_envelope IS NOT NULL
                    AND e.purge_after > now()) next_purge_at,
                (SELECT max(e.payload_purged_at) FROM sluice.webhook_events e
                  WHERE e.tenant_id = t.id) last_payload_purge_at,
                (SELECT count(*) FROM sluice.webhook_events e
                  WHERE e.tenant_id = t.id
                    AND e.payload_purged_at >= now() - interval '24 hours')::text payloads_purged_24h,
                (SELECT count(*) FROM sluice.notification_outbox n
                  WHERE n.tenant_id = t.id AND n.status = 'pending')::text notifications_pending,
                (SELECT count(*) FROM sluice.notification_outbox n
                  WHERE n.tenant_id = t.id AND n.status = 'processing')::text notifications_processing,
                (SELECT count(*) FROM sluice.notification_outbox n
                  WHERE n.tenant_id = t.id
                    AND n.status = 'sent'
                    AND n.sent_at >= now() - interval '24 hours')::text notifications_sent_24h,
                (SELECT count(*) FROM sluice.notification_outbox n
                  WHERE n.tenant_id = t.id AND n.status = 'failed')::text notifications_failed,
                (SELECT count(*) FROM sluice.audit_log a
                  WHERE a.tenant_id = t.id
                    AND a.created_at >= now() - interval '24 hours')::text audit_records_24h,
                (SELECT count(*) FROM sluice.webhook_sources s
                  WHERE s.tenant_id = t.id AND s.reconciliation_enabled)::text enabled_sources,
                (SELECT count(*) FROM sluice.webhook_sources s
                  WHERE s.tenant_id = t.id)::text total_sources,
                (SELECT count(*) FROM sluice.reconciliation_checkpoints c
                  WHERE c.tenant_id = t.id AND c.last_error IS NOT NULL)::text reconciliation_sources_with_error,
                (SELECT max(c.last_succeeded_at) FROM sluice.reconciliation_checkpoints c
                  WHERE c.tenant_id = t.id) reconciliation_last_success_at
           FROM sluice.tenants t
          WHERE t.id = $1::uuid`,
        [tenantId, userId]
      ),
      serviceChecks
    ]);

    const stats = statsResult.rows[0];
    const distribution = distributionResult.rows[0];
    const settings = settingsResult.rows[0];
    const number = new Intl.NumberFormat("pt-BR", { notation: "compact" });
    const workerHealth = externalServices.find((service) => service.id === "worker");

    output.stats = [
      {
        label: "Eventos recebidos",
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
        value: numberOrDash(stats?.success_rate, "%"),
        trend: stats?.success_rate === null ? "sem terminais" : "efetiva",
        trendDirection: "up",
        hint: "jobs terminais em 24h"
      },
      {
        label: "Latência p95",
        value: numberOrDash(stats?.p95_attempt_ms, "ms"),
        trend: stats?.p95_attempt_ms === null ? "sem tentativas" : "p95",
        trendDirection: "up",
        hint: "duração de tentativa"
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
      duration:
        row.attempt_duration_ms === null ? "—" : `${row.attempt_duration_ms}ms`,
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
        : "payload removido",
      purgeAt: formatDate(row.purge_after)
    }));

    output.sources = sourcesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      description: row.reconciliation_has_error
        ? "A última reconciliação registrou uma falha; revise a configuração do worker."
        : row.reconciliation_enabled
          ? `Reconciliação ativa em janela de ${row.reconciliation_window_hours} h.`
          : "Reconciliação desativada para esta fonte.",
      endpointKey: `${row.public_key.slice(0, 9)}••••${row.public_key.slice(-3)}`,
      status: row.is_active ? "active" : "inactive",
      events24h: number.format(Number(row.events_24h)),
      successRate: numberOrDash(row.success_rate, "%"),
      reconciliationEnabled: row.reconciliation_enabled,
      reconciliationWindowHours: row.reconciliation_window_hours,
      reconciliationLastSuccessAt: row.reconciliation_last_success_at
        ? formatDate(row.reconciliation_last_success_at)
        : null,
      reconciliationHasError: row.reconciliation_has_error
    }));

    output.destinations = destinationsResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: `Destino ${row.kind} configurado para entregas idempotentes.`,
      host: row.endpoint_url,
      status: row.is_active ? "active" : "inactive",
      deliveries24h: number.format(Number(row.deliveries_24h)),
      latency: numberOrDash(row.p95_ms, "ms")
    }));

    output.pipelines = pipelinesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      source: row.source_name,
      destination: row.destination_name || "Sem destino",
      description: "Métricas exibem os eventos da fonte, pois entregas não retêm pipeline.",
      status: row.is_active ? "active" : "paused",
      throughput: number.format(Number(row.events_24h)),
      successRate: numberOrDash(row.success_rate, "%")
    }));

    output.tenants = tenantsResult.rows.map<Tenant>((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: "",
      status: row.status === "active" ? "active" : "inactive",
      retentionDays: row.retention_days,
      eventsMonth: number.format(Number(row.events_month)),
      members: Number(row.members)
    }));

    output.workers = workersResult.rows.map<Worker>((row) => ({
      id: row.worker_id,
      region: "atividade registrada",
      status: "active",
      currentJobs: Number(row.current_jobs),
      capacity: Number(process.env.WORKER_DISPLAY_CAPACITY ?? 32),
      processed: number.format(Number(row.processed)),
      uptime: row.last_seen_at ? relativeTime(row.last_seen_at) : "sem atividade",
      cpu: 0,
      lastSeenAt: row.last_seen_at ? formatDate(row.last_seen_at) : undefined
    }));
    if (output.workers.length === 0 && workerHealth) {
      output.workers.push({
        id: process.env.WORKER_DISPLAY_ID ?? "sluice-worker",
        region: "healthcheck do serviço",
        status: workerHealth.status === "healthy" ? "active" : "draining",
        currentJobs: 0,
        capacity: Number(process.env.WORKER_DISPLAY_CAPACITY ?? 32),
        processed: "0",
        uptime: workerHealth.detail,
        cpu: 0
      });
    }

    output.chart = chartResult.rows.map((row) => Number(row.count));
    output.activity = activityResult.rows.map(activityFromRow);
    output.jobDistribution = {
      total: Number(distribution?.total ?? 0),
      pending: Number(distribution?.pending ?? 0),
      processing: Number(distribution?.processing ?? 0),
      completed: Number(distribution?.completed ?? 0),
      retry: Number(distribution?.retry ?? 0),
      deadLetter: Number(distribution?.dead_letter ?? 0)
    };
    output.operational = {
      services: [
        {
          id: "database",
          label: "PostgreSQL",
          status: "healthy",
          detail: "Consultas operacionais disponíveis"
        },
        ...externalServices
      ],
      deadLetters: output.jobDistribution.deadLetter
    };
    output.settings = {
      security: {
        oidcConfigured: Boolean(process.env.SLUICE_OIDC_ISSUER),
        accountMfaEnabled: Boolean(settings?.account_mfa_enabled),
        sessionHours: SESSION_DURATION_SECONDS / 3600
      },
      retention: {
        rawPayloadDays: settings?.raw_payload_days ?? 0,
        dedupeMetadataDays: settings?.dedupe_metadata_days ?? 0,
        defaultMaxAttempts: settings?.default_max_attempts ?? 0,
        waitingForPurge: Number(settings?.waiting_for_purge ?? 0),
        nextPurgeAt: settings?.next_purge_at ? formatDate(settings.next_purge_at) : null,
        lastPayloadPurgeAt: settings?.last_payload_purge_at
          ? formatDate(settings.last_payload_purge_at)
          : null,
        payloadsPurged24h: Number(settings?.payloads_purged_24h ?? 0)
      },
      notifications: {
        pending: Number(settings?.notifications_pending ?? 0),
        processing: Number(settings?.notifications_processing ?? 0),
        sent24h: Number(settings?.notifications_sent_24h ?? 0),
        failed: Number(settings?.notifications_failed ?? 0)
      },
      audit: { records24h: Number(settings?.audit_records_24h ?? 0) },
      reconciliation: {
        enabledSources: Number(settings?.enabled_sources ?? 0),
        totalSources: Number(settings?.total_sources ?? 0),
        sourcesWithError: Number(settings?.reconciliation_sources_with_error ?? 0),
        lastSuccessAt: settings?.reconciliation_last_success_at
          ? formatDate(settings.reconciliation_last_success_at)
          : null
      }
    };
    output.generatedAt = new Date().toISOString();
    output.tenant = output.tenants[0]
      ? {
          id: output.tenants[0].id,
          name: output.tenants[0].name,
          retentionDays: output.tenants[0].retentionDays
        }
      : { id: tenantId, name: "Tenant indisponível", retentionDays: 0 };

    return output;
  });
}
