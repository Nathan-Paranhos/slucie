export type JobStatus =
  | "completed"
  | "processing"
  | "pending"
  | "retry"
  | "dead-letter";

export type Provider =
  | "asaas"
  | "pagbank"
  | "mercado-pago"
  | "stripe"
  | "pix"
  | "generic";

export interface Stat {
  label: string;
  value: string;
  trend: string;
  trendDirection: "up" | "down";
  hint: string;
}

export interface Activity {
  id: string;
  title: string;
  detail: string;
  time: string;
  tone: "success" | "warning" | "danger";
  jobId?: string;
}

export interface Job {
  id: string;
  tenant: string;
  tenantId: string;
  type: string;
  source: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  priority: "high" | "medium" | "low";
  availableAt: string;
  createdAt: string;
  duration: string;
  externalEventId: string;
  payloadPreview: Record<string, unknown>;
}

export interface WebhookEvent {
  id: string;
  externalId: string;
  provider: Provider;
  source: string;
  tenant: string;
  eventType: string;
  status: "accepted" | "duplicate" | "quarantined";
  receivedAt: string;
  size: string;
  purgeAt: string;
}

export interface Source {
  id: string;
  name: string;
  provider: Provider;
  description: string;
  endpointKey: string;
  status: "active" | "inactive";
  events24h: string;
  successRate: string;
  reconciliationEnabled: boolean;
  reconciliationWindowHours: number;
  reconciliationLastSuccessAt: string | null;
  reconciliationHasError: boolean;
}

export interface Destination {
  id: string;
  name: string;
  kind: "http" | "webhook" | "data-lake" | "internal";
  description: string;
  host: string;
  status: "active" | "inactive";
  deliveries24h: string;
  latency: string;
}

export interface Pipeline {
  id: string;
  name: string;
  source: string;
  destination: string;
  description: string;
  status: "active" | "paused";
  throughput: string;
  successRate: string;
}

export interface Worker {
  id: string;
  region: string;
  status: "active" | "draining";
  currentJobs: number;
  capacity: number;
  processed: string;
  uptime: string;
  cpu: number;
  lastSeenAt?: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: "active" | "inactive";
  retentionDays: number;
  eventsMonth: string;
  members: number;
}

export type ServiceHealthStatus = "healthy" | "degraded" | "unavailable";

export interface ServiceHealth {
  id: "database" | "ingest" | "worker";
  label: string;
  status: ServiceHealthStatus;
  detail: string;
}

export interface JobDistribution {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  retry: number;
  deadLetter: number;
}

export interface OperationalSettings {
  security: {
    oidcConfigured: boolean;
    accountMfaEnabled: boolean;
    sessionHours: number;
  };
  retention: {
    rawPayloadDays: number;
    dedupeMetadataDays: number;
    defaultMaxAttempts: number;
    waitingForPurge: number;
    nextPurgeAt: string | null;
    lastPayloadPurgeAt: string | null;
    payloadsPurged24h: number;
  };
  notifications: {
    pending: number;
    processing: number;
    sent24h: number;
    failed: number;
  };
  audit: {
    records24h: number;
  };
  reconciliation: {
    enabledSources: number;
    totalSources: number;
    sourcesWithError: number;
    lastSuccessAt: string | null;
  };
}

export interface DashboardPayload {
  generatedAt: string;
  tenant: {
    id: string;
    name: string;
    retentionDays: number;
  };
  stats: Stat[];
  chart: number[];
  activity: Activity[];
  jobs: Job[];
  events: WebhookEvent[];
  sources: Source[];
  destinations: Destination[];
  pipelines: Pipeline[];
  workers: Worker[];
  tenants: Tenant[];
  jobDistribution: JobDistribution;
  operational: {
    services: ServiceHealth[];
    deadLetters: number;
  };
  settings: OperationalSettings;
}

export type Section =
  | "overview"
  | "events"
  | "jobs"
  | "workers"
  | "dead-letter"
  | "tenants"
  | "metrics"
  | "sources"
  | "destinations"
  | "pipelines"
  | "settings";

export const sections: Section[] = [
  "overview",
  "events",
  "jobs",
  "workers",
  "dead-letter",
  "tenants",
  "metrics",
  "sources",
  "destinations",
  "pipelines",
  "settings"
];

export function isSection(value: string): value is Section {
  return sections.includes(value as Section);
}
