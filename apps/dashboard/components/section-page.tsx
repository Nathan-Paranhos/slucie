"use client";

import {
  Activity,
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  CalendarClock,
  Check,
  CheckCircle2,
  CircleGauge,
  Clock3,
  Copy,
  Database,
  DatabaseZap,
  Download,
  FileClock,
  Filter,
  Gauge,
  GitBranch,
  KeyRound,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCog,
  Shield,
  ShieldAlert,
  Webhook,
  X
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { SluiceMascot } from "./brand";
import type {
  DashboardPayload,
  Destination,
  Job,
  Pipeline,
  Section,
  Source,
  WebhookEvent
} from "@/lib/types";

const sectionCopy: Record<
  Section,
  { kicker: string; title: string; description: string }
> = {
  overview: {
    kicker: "Operação em tempo real",
    title: "Visão geral",
    description:
      "Saúde da ingestão, execução da fila e compromissos de retenção em uma visão única."
  },
  events: {
    kicker: "Entrada autenticada",
    title: "Eventos",
    description:
      "Cada webhook aceito é persistido de forma durável antes de qualquer processamento."
  },
  jobs: {
    kicker: "PostgreSQL como fila",
    title: "Jobs",
    description:
      "Acompanhe leases, tentativas e efeitos idempotentes do worker pool."
  },
  workers: {
    kicker: "Execução distribuída",
    title: "Workers",
    description:
      "Capacidade, utilização e estado das instâncias .NET que consomem a fila."
  },
  "dead-letter": {
    kicker: "Ação necessária",
    title: "Dead-letter",
    description:
      "Jobs que esgotaram tentativas, preservados com auditoria e notificação ativa."
  },
  tenants: {
    kicker: "Isolamento absoluto",
    title: "Tenants",
    description:
      "Retenção, limites e acesso isolados por políticas RLS no PostgreSQL."
  },
  metrics: {
    kicker: "Observabilidade",
    title: "Métricas",
    description:
      "Throughput, latência, retries e capacidade para operação e billing."
  },
  sources: {
    kicker: "Adaptadores de entrada",
    title: "Fontes",
    description:
      "Endpoints opacos com autenticação específica para cada PSP e tenant."
  },
  destinations: {
    kicker: "Efeitos controlados",
    title: "Destinos",
    description:
      "Entregas HTTPS protegidas contra SSRF e registradas em ledger idempotente."
  },
  pipelines: {
    kicker: "Fluxos de dados",
    title: "Pipelines",
    description:
      "Conecte fontes e destinos sem retirar o Postgres da posição de fonte de verdade."
  },
  settings: {
    kicker: "Governança",
    title: "Configurações",
    description:
      "Segurança, retenção, alertas e parâmetros operacionais do workspace."
  }
};

const statIcons = [CalendarClock, Boxes, CircleGauge, Clock3];

function PageHeader({
  section,
  children
}: {
  section: Section;
  children?: ReactNode;
}) {
  const copy = sectionCopy[section];
  return (
    <header className="page-head">
      <div>
        <p className="page-kicker">{copy.kicker}</p>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

function Badge({ status }: { status: string }) {
  const label: Record<string, string> = {
    completed: "Concluído",
    processing: "Processando",
    pending: "Pendente",
    retry: "Retry",
    "dead-letter": "Dead-letter",
    accepted: "Aceito",
    duplicate: "Duplicado",
    quarantined: "Quarentena",
    active: "Ativo",
    inactive: "Inativo",
    paused: "Pausado",
    draining: "Drenando"
  };

  const normalized =
    status === "accepted"
      ? "success"
      : status === "duplicate"
        ? "processing"
        : status === "quarantined"
          ? "error"
          : status;

  return (
    <span className={`badge badge-${normalized}`}>
      {label[status] ?? status}
    </span>
  );
}

function formatProvider(provider: string) {
  const names: Record<string, string> = {
    asaas: "Asaas",
    pagbank: "PagBank",
    "mercado-pago": "Mercado Pago",
    stripe: "Stripe",
    pix: "Pix",
    generic: "Genérico"
  };
  return names[provider] ?? provider;
}

function StatCards({ data }: { data: DashboardPayload }) {
  return (
    <div className="grid stats-grid">
      {data.stats.map((stat, index) => {
        const Icon = statIcons[index] ?? Gauge;
        return (
          <article className="stat-card" key={stat.label}>
            <div className="stat-head">
              <span>{stat.label}</span>
              <span className="stat-icon">
                <Icon size={14} strokeWidth={1.8} />
              </span>
            </div>
            <p className="stat-value">{stat.value}</p>
            <div className="stat-foot">
              <span
                className={
                  stat.trendDirection === "up" ? "trend-up" : "trend-down"
                }
              >
                {stat.trendDirection === "up" ? (
                  <ArrowUpRight size={11} />
                ) : (
                  <ArrowDownRight size={11} />
                )}
              </span>
              <strong
                className={
                  stat.trendDirection === "up" ? "trend-up" : "trend-down"
                }
              >
                {stat.trend}
              </strong>
              <span>{stat.hint}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function AreaChart({ values }: { values: number[] }) {
  const width = 760;
  const height = 250;
  const safeValues = values.length > 1 ? values : [0, 0];
  const max = Math.max(...safeValues, 1);
  const min = Math.min(...safeValues, 0);
  const range = Math.max(max - min, 1);
  const points = safeValues.map((value, index) => {
    const x = (index / (safeValues.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 30) - 15;
    return [x, y] as const;
  });
  const line = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <>
      <div className="chart-wrap">
        <svg
          className="area-chart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Eventos processados ao longo das últimas 24 horas"
        >
          <defs>
            <linearGradient id="sluice-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#ff6b00" stopOpacity=".24" />
              <stop offset="100%" stopColor="#ff6b00" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.2, 0.4, 0.6, 0.8].map((position) => (
            <line
              key={position}
              className="chart-grid"
              x1="0"
              x2={width}
              y1={height * position}
              y2={height * position}
            />
          ))}
          <path d={area} fill="url(#sluice-area)" />
          <path d={line} className="chart-line" />
        </svg>
        <div className="chart-labels">
          <span>há 24h</span>
          <span>há 18h</span>
          <span>há 12h</span>
          <span>há 6h</span>
          <span>agora</span>
        </div>
      </div>
      <div className="chart-legend">
        <span>
          <i className="legend-line" /> Eventos autenticados
        </span>
        <span>Dados consultados diretamente do PostgreSQL</span>
      </div>
    </>
  );
}

function Overview({
  data,
  onSelectJob
}: {
  data: DashboardPayload;
  onSelectJob: (job: Job) => void;
}) {
  return (
    <>
      <StatCards data={data} />
      <div className="grid overview-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Eventos ao longo do tempo</h2>
              <span className="panel-subtitle">
                Throughput agregado · últimas 24 horas
              </span>
            </div>
          </div>
          <div className="panel-body">
            <AreaChart values={data.chart} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Execuções recentes</h2>
              <span className="panel-subtitle">Atualização contínua</span>
            </div>
            <Activity size={14} className="orange" />
          </div>
          <div className="panel-body activity-list">
            {data.activity.length === 0 ? (
              <div className="empty-state" style={{ minHeight: 220 }}>
                <div className="empty-state-inner">
                  <SluiceMascot size={58} state="monitoring" />
                  <h3>Sem atividade recente</h3>
                  <p>Os próximos eventos e mudanças auditadas aparecerão aqui.</p>
                </div>
              </div>
            ) : (
              data.activity.map((item) => {
                const job = item.jobId
                  ? data.jobs.find((candidate) => candidate.id === item.jobId)
                  : undefined;
                return (
                  <button
                    key={item.id}
                    className="activity-item"
                    style={{
                      width: "100%",
                      borderTop: 0,
                      borderLeft: 0,
                      borderRight: 0,
                      cursor: job ? "pointer" : "default",
                      textAlign: "left",
                      background: "transparent"
                    }}
                    disabled={!job}
                    onClick={() => job && onSelectJob(job)}
                  >
                    <span className={`activity-icon ${item.tone}`}>
                      {item.tone === "success" ? (
                        <Check size={13} />
                      ) : item.tone === "warning" ? (
                        <Clock3 size={13} />
                      ) : (
                        <AlertCircle size={13} />
                      )}
                    </span>
                    <span className="activity-copy">
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </span>
                    <span className="activity-time">{item.time}</span>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>
      <section className="system-strip">
        <div className="mascot-mini">
          <SluiceMascot size={42} state="monitoring" />
        </div>
        <div className="system-strip-copy">
          <h3>
            {data.operational.services.every((service) => service.status === "healthy")
              ? "Serviços operacionais disponíveis."
              : "Atenção a um ou mais serviços."}
          </h3>
          <p>
            {data.operational.deadLetters > 0
              ? `${data.operational.deadLetters} job(s) em dead-letter requerem acompanhamento.`
              : "Nenhum job em dead-letter neste workspace."}
          </p>
        </div>
        <div className="system-tags">
          {data.operational.services.map((service) => (
            <span className="system-tag" key={service.id} title={service.detail}>
              <i
                style={{
                  background:
                    service.status === "healthy"
                      ? "#16a36a"
                      : service.status === "degraded"
                        ? "#ff6b00"
                        : "#d92d20"
                }}
              />
              {service.label}
            </span>
          ))}
        </div>
      </section>
    </>
  );
}

function Toolbar({
  search,
  setSearch,
  status,
  setStatus,
  statuses
}: {
  search: string;
  setSearch: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  statuses: string[];
}) {
  return (
    <div className="toolbar">
      <label className="toolbar-search">
        <span className="sr-only">Filtrar registros</span>
        <Search size={13} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filtrar nesta visão…"
        />
      </label>
      <button
        className={`filter-button ${status === "all" ? "active" : ""}`}
        onClick={() => setStatus("all")}
      >
        Todos
      </button>
      {statuses.map((item) => (
        <button
          className={`filter-button ${status === item ? "active" : ""}`}
          key={item}
          onClick={() => setStatus(item)}
        >
          <Filter size={11} />
          {item === "dead-letter"
            ? "Dead-letter"
            : item.charAt(0).toUpperCase() + item.slice(1)}
        </button>
      ))}
    </div>
  );
}

function JobsTable({
  jobs,
  onSelect,
  deadOnly = false
}: {
  jobs: Job[];
  onSelect: (job: Job) => void;
  deadOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(deadOnly ? "dead-letter" : "all");
  const filtered = jobs.filter((job) => {
    if ((deadOnly || status !== "all") && job.status !== status) return false;
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return [job.id, job.tenant, job.type, job.source, job.externalEventId]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  return (
    <section className="panel">
      <Toolbar
        search={search}
        setSearch={setSearch}
        status={status}
        setStatus={setStatus}
        statuses={
          deadOnly
            ? ["dead-letter"]
            : ["processing", "pending", "retry", "dead-letter"]
        }
      />
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Job ID</th>
              <th>Tenant / fonte</th>
              <th>Status</th>
              <th>Tentativas</th>
              <th>Disponível</th>
              <th>Prioridade</th>
              <th>Duração da tentativa</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((job) => (
              <tr key={job.id} onClick={() => onSelect(job)}>
                <td>
                  <span className="table-primary mono">
                    {job.id.slice(0, 16)}…
                  </span>
                  <span className="table-secondary">{job.type}</span>
                </td>
                <td>
                  <span className="table-primary">{job.tenant}</span>
                  <span className="table-secondary">{job.source}</span>
                </td>
                <td>
                  <Badge status={job.status} />
                </td>
                <td className="mono">
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td>{job.availableAt}</td>
                <td>
                  <span
                    className={
                      job.priority === "high"
                        ? "trend-down"
                        : job.priority === "medium"
                          ? "orange"
                          : "trend-up"
                    }
                  >
                    {job.priority}
                  </span>
                </td>
                <td className="mono">{job.duration}</td>
                <td aria-label={`Detalhes do job ${job.id}`} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          state={deadOnly ? "success" : "monitoring"}
          title={
            deadOnly
              ? "Nenhum dead-letter neste filtro"
              : "Nenhum job encontrado"
          }
          description={
            deadOnly
              ? "Ótimo sinal: não existem falhas terminais correspondentes."
              : "Ajuste os filtros ou aguarde novos eventos."
          }
        />
      ) : (
        <Pagination count={filtered.length} />
      )}
    </section>
  );
}

function EventsTable({
  events,
  onSelect
}: {
  events: WebhookEvent[];
  onSelect: (event: WebhookEvent) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = events.filter((event) => {
    if (status !== "all" && event.status !== status) return false;
    const query = search.toLowerCase();
    return (
      !query ||
      [
        event.id,
        event.externalId,
        event.tenant,
        event.source,
        event.eventType
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  });

  return (
    <section className="panel">
      <Toolbar
        search={search}
        setSearch={setSearch}
        status={status}
        setStatus={setStatus}
        statuses={["accepted", "quarantined"]}
      />
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Identificador externo (hash)</th>
              <th>Provedor</th>
              <th>Tenant / fonte</th>
              <th>Tipo</th>
              <th>Ingestão</th>
              <th>Recebido</th>
              <th>Payload</th>
              <th>Purge</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((event) => (
              <tr key={event.id} onClick={() => onSelect(event)}>
                <td>
                  <span className="table-primary mono">{event.externalId}</span>
                  <span className="table-secondary mono">
                    {event.id.slice(0, 18)}…
                  </span>
                </td>
                <td>{formatProvider(event.provider)}</td>
                <td>
                  <span className="table-primary">{event.tenant}</span>
                  <span className="table-secondary">{event.source}</span>
                </td>
                <td className="mono">{event.eventType}</td>
                <td>
                  <Badge status={event.status} />
                </td>
                <td className="mono">{event.receivedAt}</td>
                <td>{event.size}</td>
                <td>{event.purgeAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination count={filtered.length} />
    </section>
  );
}

function Pagination({ count }: { count: number }) {
  return (
    <div className="pagination">
      <span>
        Exibindo {count} {count === 1 ? "registro" : "registros"} desta consulta
      </span>
    </div>
  );
}

function EmptyState({
  state,
  title,
  description,
  action
}: {
  state: "monitoring" | "processing" | "success" | "alert";
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-inner">
        <SluiceMascot size={88} state={state} />
        <h3>{title}</h3>
        <p>{description}</p>
        {action}
      </div>
    </div>
  );
}

function EntityCards({
  section,
  data,
  onCreate,
  onToggle,
  onToggleReconciliation
}: {
  section: "sources" | "destinations" | "pipelines";
  data: DashboardPayload;
  onCreate: () => void;
  onToggle: (entity: Source | Destination | Pipeline) => void;
  onToggleReconciliation: (source: Source) => void;
}) {
  const entities =
    section === "sources"
      ? data.sources
      : section === "destinations"
        ? data.destinations
        : data.pipelines;

  if (entities.length === 0) {
    return (
      <section className="panel">
        <EmptyState
          state="monitoring"
          title={`Nenhum ${
            section === "sources"
              ? "fonte"
              : section === "destinations"
                ? "destino"
                : "pipeline"
          } configurado`}
          description="Crie o primeiro recurso para começar a mover eventos com segurança."
          action={
            <button className="button button-primary" onClick={onCreate}>
              <Plus size={14} /> Criar recurso
            </button>
          }
        />
      </section>
    );
  }

  return (
    <div className="grid entity-grid">
      {entities.map((entity) => {
        const status = entity.status;
        const Icon =
          section === "sources"
            ? Webhook
            : section === "destinations"
              ? DatabaseZap
              : GitBranch;
        const title =
          section === "pipelines"
            ? (entity as Pipeline).name
            : (entity as Source | Destination).name;
        const first =
          section === "sources"
            ? formatProvider((entity as Source).provider)
            : section === "destinations"
              ? (entity as Destination).host
              : (entity as Pipeline).source;
        const second =
          section === "sources"
            ? (entity as Source).successRate
            : section === "destinations"
              ? (entity as Destination).latency
              : (entity as Pipeline).throughput;

        return (
          <article className="entity-card" key={entity.id}>
            <div className="entity-card-top">
              <span className="entity-icon">
                <Icon size={18} strokeWidth={1.7} />
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <Badge status={status} />
                {section === "sources" && (
                  <button
                    className="table-action"
                    aria-label={`${(entity as Source).reconciliationEnabled ? "Desativar" : "Ativar"} reconciliação de ${title}`}
                    title={`${(entity as Source).reconciliationEnabled ? "Desativar" : "Ativar"} reconciliação`}
                    onClick={() => onToggleReconciliation(entity as Source)}
                  >
                    <RefreshCw size={13} />
                  </button>
                )}
                <button
                  className="table-action"
                  aria-label={`${status === "active" ? "Pausar" : "Ativar"} ${title}`}
                  onClick={() => onToggle(entity)}
                >
                  {status === "active" ? (
                    <Pause size={13} />
                  ) : (
                    <Play size={13} />
                  )}
                </button>
              </div>
            </div>
            <h3>{title}</h3>
            <p>{entity.description}</p>
            <div className="entity-meta">
              <span>
                {section === "pipelines" ? "Fonte" : "Configuração"}
                <strong>{first}</strong>
              </span>
              <span>
                {section === "sources"
                  ? "Sucesso 24h"
                  : section === "destinations"
                    ? "Latência p95"
                    : "Eventos da fonte 24h"}
                <strong>{second}</strong>
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function WorkersView({ workers }: { workers: DashboardPayload["workers"] }) {
  if (!workers.length) {
    return (
      <section className="panel">
        <EmptyState
          state="alert"
          title="Nenhum worker conectado"
          description="Verifique o serviço .NET, a conexão PostgreSQL e o canal de wake-up."
        />
      </section>
    );
  }

  return (
    <div className="grid worker-grid">
      {workers.map((worker) => (
        <article className="worker-card" key={worker.id}>
          <div className="worker-head">
            <div className="worker-name">
              <span className="worker-name-icon">
                <ServerCog size={16} />
              </span>
              <span className="worker-name-copy">
                <strong title={worker.id}>{worker.id}</strong>
                <span className="worker-region" title={worker.region}>{worker.region}</span>
              </span>
            </div>
            <Badge status={worker.status} />
          </div>
          <div className="worker-stats">
            <div className="worker-stat">
              <span>Em execução</span>
              <strong>
                {worker.currentJobs}/{worker.capacity}
              </strong>
            </div>
            <div className="worker-stat">
              <span>Processados</span>
              <strong>{worker.processed}</strong>
            </div>
            <div className="worker-stat">
              <span>Última atividade</span>
              <strong title={worker.lastSeenAt ?? worker.uptime}>
                {worker.lastSeenAt ?? worker.uptime}
              </strong>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function TenantsView({ data }: { data: DashboardPayload }) {
  return (
    <section className="panel">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Status</th>
              <th>Retenção</th>
              <th>Eventos no mês</th>
              <th>Membros</th>
              <th>Isolamento</th>
            </tr>
          </thead>
          <tbody>
            {data.tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td>
                  <span className="table-primary">{tenant.name}</span>
                  <span className="table-secondary mono">{tenant.slug}</span>
                </td>
                <td>
                  <Badge status={tenant.status} />
                </td>
                <td>{tenant.retentionDays} dias</td>
                <td className="mono">{tenant.eventsMonth}</td>
                <td>{tenant.members}</td>
                <td>
                  <span className="system-tag">
                    <Shield size={10} /> RLS ativo
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination count={data.tenants.length} />
    </section>
  );
}

function MetricsView({ data }: { data: DashboardPayload }) {
  const distribution = data.jobDistribution;
  const total = Math.max(distribution.total, 1);
  const completed = (distribution.completed / total) * 100;
  const processing = (distribution.processing / total) * 100;
  const retry = (distribution.retry / total) * 100;
  const deadLetter = (distribution.deadLetter / total) * 100;
  const pending = Math.max(0, 100 - completed - processing - retry - deadLetter);
  const donutStyle = {
    background: `conic-gradient(
      #16a36a 0 ${completed}%,
      #2970ff ${completed}% ${completed + processing}%,
      #ff6b00 ${completed + processing}% ${completed + processing + retry}%,
      #d92d20 ${completed + processing + retry}% ${completed + processing + retry + deadLetter}%,
      #64748b ${completed + processing + retry + deadLetter}% ${completed + processing + retry + deadLetter + pending}%
    )`
  };
  const format = new Intl.NumberFormat("pt-BR");
  return (
    <>
      <StatCards data={data} />
      <div className="grid metric-layout" style={{ marginTop: 15 }}>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Throughput e latência</h2>
              <span className="panel-subtitle">
                Volume autenticado por hora
              </span>
            </div>
          </div>
          <div className="panel-body">
            <AreaChart values={data.chart} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Jobs por status</h2>
              <span className="panel-subtitle">Distribuição terminal e ativa</span>
            </div>
          </div>
          <div className="panel-body donut-wrap">
            <div className="donut" style={donutStyle}>
              <div className="donut-center">
                <strong>{format.format(distribution.total)}</strong>
                <span>Total</span>
              </div>
            </div>
            <div className="chart-legend" style={{ flexWrap: "wrap", justifyContent: "center" }}>
              <span>
                <i className="legend-line" style={{ background: "#16a36a" }} />{" "}
                Concluídos {format.format(distribution.completed)}
              </span>
              <span>
                <i className="legend-line" style={{ background: "#2970ff" }} />{" "}
                Processando {format.format(distribution.processing)}
              </span>
              <span>
                <i className="legend-line" style={{ background: "#ff6b00" }} />{" "}
                Retry {format.format(distribution.retry)}
              </span>
              <span>
                <i className="legend-line" style={{ background: "#d92d20" }} />{" "}
                DLQ {format.format(distribution.deadLetter)}
              </span>
              <span>
                <i className="legend-line" style={{ background: "#64748b" }} />{" "}
                Pendentes {format.format(distribution.pending)}
              </span>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function SettingsView({
  data,
  onRefresh,
  refreshing
}: {
  data: DashboardPayload;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { settings } = data;
  const cards = [
    {
      title: "Segurança da conta",
      description: "Estado observado; autenticação é administrada pela identidade da instância.",
      icon: LockKeyhole,
      rows: [
        ["OIDC", settings.security.oidcConfigured ? "Configurado" : "Não configurado"],
        [
          "MFA da conta",
          settings.security.accountMfaEnabled ? "Ativado" : "Não ativado"
        ],
        ["Duração da sessão", `${settings.security.sessionHours} horas`]
      ]
    },
    {
      title: "Retenção LGPD",
      description: "Políticas efetivas do tenant, aplicadas ao payload bruto cifrado.",
      icon: FileClock,
      rows: [
        ["Payload bruto", `${settings.retention.rawPayloadDays} dias`],
        ["Metadados de deduplicação", `${settings.retention.dedupeMetadataDays} dias`],
        [
          "Próximo payload elegível",
          settings.retention.nextPurgeAt ?? "Nenhum payload pendente"
        ],
        [
          "Purge nas últimas 24h",
          `${settings.retention.payloadsPurged24h} payload(s)`
        ]
      ]
    },
    {
      title: "Notificações operacionais",
      description: "Estado real da fila de notificações; não há preferências locais simuladas.",
      icon: ShieldAlert,
      rows: (["pending", "processing", "sent24h", "failed"] as const).map((key) => {
        const labels = {
          pending: "Pendentes",
          processing: "Em processamento",
          sent24h: "Enviadas nas últimas 24h",
          failed: "Falhas para revisar"
        } as const;
        return [labels[key], String(settings.notifications[key])];
      })
    },
    {
      title: "Auditoria e reconciliação",
      description: "Indicadores reais do banco. A reconciliação é ativada por fonte.",
      icon: Activity,
      rows: [
        ["Registros de auditoria em 24h", String(settings.audit.records24h)],
        [
          "Fontes com reconciliação",
          `${settings.reconciliation.enabledSources} de ${settings.reconciliation.totalSources}`
        ],
        [
          "Falhas de reconciliação",
          String(settings.reconciliation.sourcesWithError)
        ],
        [
          "Último sucesso de reconciliação",
          settings.reconciliation.lastSuccessAt ?? "Sem execução concluída"
        ]
      ]
    }
  ];

  return (
    <>
      <div className="grid settings-grid">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <section className="settings-card" key={card.title}>
              <div className="settings-card-head">
                <Icon size={18} />
                <div>
                  <h3>{card.title}</h3>
                  <p>{card.description}</p>
                </div>
              </div>
              {card.rows.map(([title, value]) => (
                <div className="setting-row" key={title}>
                  <div className="setting-row-copy">
                    <strong>{title}</strong>
                    <span>{value}</span>
                  </div>
                  <span className="mono" style={{ color: "var(--text-secondary)", fontSize: 10 }}>
                    leitura
                  </span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <section className="panel" style={{ marginTop: 15 }}>
        <div className="panel-body" style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
          <div>
            <h2 style={{ margin: 0 }}>Estado lido do sistema</h2>
            <p className="panel-subtitle" style={{ marginTop: 5 }}>
              Apenas controles conectados a uma política persistida aparecem como ações nas telas de Fontes, Destinos e Pipelines.
            </p>
          </div>
          <button className="button" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={14} style={{ animation: refreshing ? "spin 1s linear infinite" : undefined }} />
            {refreshing ? "Atualizando…" : "Atualizar estado"}
          </button>
        </div>
      </section>
    </>
  );
}

function JobDrawer({
  job,
  onClose,
  onRedrive,
  onToast
}: {
  job: Job;
  onClose: () => void;
  onRedrive: (job: Job) => void;
  onToast: (message: string) => void;
}) {
  return (
    <>
      <button className="drawer-backdrop" aria-label="Fechar detalhes" onClick={onClose} />
      <aside className="drawer" aria-label={`Detalhes do job ${job.id}`}>
        <div className="drawer-head">
          <div>
            <p className="page-kicker" style={{ marginBottom: 4 }}>
              Detalhes do job
            </p>
            <h2>{job.id.slice(0, 18)}…</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="detail-section">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <Badge status={job.status} />
              <div style={{ display: "flex", gap: 7 }}>
                <button
                  className="button"
                  onClick={() => {
                    navigator.clipboard.writeText(job.id).catch(() => undefined);
                    onToast("ID copiado para a área de transferência.");
                  }}
                >
                  <Copy size={13} /> Copiar ID
                </button>
                {job.status === "dead-letter" && (
                  <button className="button button-primary" onClick={() => onRedrive(job)}>
                    <RotateCcw size={13} /> Redrive
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="detail-section">
            <h3>Identidade e isolamento</h3>
            <div className="detail-grid">
              <div className="detail">
                <span>Tenant</span>
                <strong>{job.tenant}</strong>
              </div>
              <div className="detail">
                <span>Tenant ID</span>
                <code>{job.tenantId}</code>
              </div>
              <div className="detail">
                <span>Identificador externo (hash)</span>
                <code>{job.externalEventId}</code>
              </div>
              <div className="detail">
                <span>Tipo</span>
                <code>{job.type}</code>
              </div>
              <div className="detail">
                <span>Fonte</span>
                <strong>{job.source}</strong>
              </div>
              <div className="detail">
                <span>Prioridade</span>
                <strong>{job.priority}</strong>
              </div>
            </div>
          </div>
          <div className="detail-section">
            <h3>Ciclo de execução</h3>
            <div className="timeline">
              <div className="timeline-item">
                <i className="timeline-dot" />
                <div className="timeline-copy">
                  <strong>Evento autenticado e persistido</strong>
                  <span>Transação de ingestão confirmada</span>
                </div>
                <span className="timeline-time">{job.createdAt}</span>
              </div>
              <div className="timeline-item">
                <i
                  className="timeline-dot"
                  style={{
                    background:
                      job.status === "dead-letter" ? "#d92d20" : "#ff6b00"
                  }}
                />
                <div className="timeline-copy">
                  <strong>
                    {job.attempts} {job.attempts === 1 ? "entrega" : "entregas"}
                  </strong>
                  <span>Lease protegido por fencing token</span>
                </div>
                <span className="timeline-time">{job.duration}</span>
              </div>
              {job.status === "completed" && (
                <div className="timeline-item">
                  <i className="timeline-dot" />
                  <div className="timeline-copy">
                    <strong>Job concluído</strong>
                    <span>O efeito de destino, quando aplicável, é idempotente.</span>
                  </div>
                  <span className="timeline-time">concluído</span>
                </div>
              )}
            </div>
          </div>
          <div className="detail-section">
            <h3>Preview protegido</h3>
            <pre className="code-block">
              {JSON.stringify(job.payloadPreview, null, 2)}
            </pre>
          </div>
          <div className="detail-section">
            <h3>Garantias</h3>
            <div className="system-tags" style={{ justifyContent: "flex-start" }}>
              <span className="system-tag">
                <Shield size={10} /> RLS
              </span>
              <span className="system-tag">
                <KeyRound size={10} /> AES-256-GCM
              </span>
              <span className="system-tag">
                <Database size={10} /> Durable
              </span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function EventDrawer({
  event,
  onClose,
  onToast
}: {
  event: WebhookEvent;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  return (
    <>
      <button className="drawer-backdrop" aria-label="Fechar detalhes" onClick={onClose} />
      <aside className="drawer" aria-label={`Detalhes do evento ${event.externalId}`}>
        <div className="drawer-head">
          <div>
            <p className="page-kicker" style={{ marginBottom: 4 }}>
              Evento autenticado
            </p>
            <h2>{event.externalId}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="detail-section">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <Badge status={event.status} />
              <button
                className="button"
                onClick={() => {
                  navigator.clipboard.writeText(event.externalId).catch(() => undefined);
                  onToast("ID externo copiado.");
                }}
              >
                <Copy size={13} /> Copiar
              </button>
            </div>
          </div>
          <div className="detail-section">
            <h3>Origem</h3>
            <div className="detail-grid">
              <div className="detail">
                <span>Provedor</span>
                <strong>{formatProvider(event.provider)}</strong>
              </div>
              <div className="detail">
                <span>Tipo</span>
                <code>{event.eventType}</code>
              </div>
              <div className="detail">
                <span>Tenant</span>
                <strong>{event.tenant}</strong>
              </div>
              <div className="detail">
                <span>Fonte</span>
                <strong>{event.source}</strong>
              </div>
              <div className="detail">
                <span>Recebido</span>
                <code>{event.receivedAt}</code>
              </div>
              <div className="detail">
                <span>Tamanho cifrado</span>
                <code>{event.size}</code>
              </div>
            </div>
          </div>
          <div className="detail-section">
            <h3>Retenção LGPD</h3>
            <div className="system-strip" style={{ margin: 0 }}>
              <div className="mascot-mini">
                <SluiceMascot size={40} state="monitoring" />
              </div>
              <div className="system-strip-copy">
                <h3>Purge automático em {event.purgeAt}</h3>
                <p>
                  A identidade de deduplicação permanece; o payload bruto será
                  criptograficamente eliminado.
                </p>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function CreateModal({
  section,
  data,
  onClose,
  onSubmit
}: {
  section: "sources" | "destinations" | "pipelines" | "tenants";
  data: DashboardPayload;
  onClose: () => void;
  onSubmit: (input: Record<string, string>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [sourceProvider, setSourceProvider] = useState("asaas");
  const labels = {
    sources: "Nova fonte",
    destinations: "Novo destino",
    pipelines: "Novo pipeline",
    tenants: "Novo tenant"
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    await onSubmit(Object.fromEntries(data.entries()) as Record<string, string>);
    setBusy(false);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <p className="page-kicker" style={{ marginBottom: 4 }}>
              Configuração segura
            </p>
            <h2>{labels[section]}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label>
            Nome
            <input name="name" required minLength={3} maxLength={100} />
          </label>
          {section === "sources" && (
            <>
              <label>
                Provedor
                <select
                  name="provider"
                  required
                  value={sourceProvider}
                  onChange={(event) => setSourceProvider(event.target.value)}
                >
                  <option value="asaas">Asaas</option>
                  <option value="pagbank">PagBank</option>
                  <option value="mercado-pago">Mercado Pago</option>
                  <option value="stripe">Stripe</option>
                  <option value="pix">Pix configurável</option>
                </select>
              </label>
              <label>
                Segredo de autenticação
                <input name="secret" type="password" required minLength={16} />
              </label>
              <label className="modal-note" style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                <input
                  name="reconciliationEnabled"
                  type="checkbox"
                  value="true"
                  style={{ width: "auto", marginTop: 2 }}
                />
                <span>
                  Ativar reconciliação para esta fonte. Habilite somente se o endpoint
                  do provedor já estiver configurado no worker.
                </span>
              </label>
              {sourceProvider === "pix" && (
                <>
                  <div className="modal-note">
                    O Pix não possui um formato universal. Informe o contrato HMAC
                    oferecido pelo seu PSP.
                  </div>
                  <label>
                    Header da assinatura
                    <input
                      name="signatureHeader"
                      defaultValue="x-webhook-signature"
                      required
                    />
                  </label>
                  <label>
                    Codificação
                    <select name="signatureEncoding" defaultValue="hex">
                      <option value="hex">Hexadecimal</option>
                      <option value="base64">Base64</option>
                    </select>
                  </label>
                  <label>
                    Header de timestamp (opcional)
                    <input
                      name="timestampHeader"
                      placeholder="x-webhook-timestamp"
                    />
                  </label>
                  <label>
                    Template assinado
                    <input
                      name="signedTemplate"
                      defaultValue="{raw}"
                      required
                      title="Use {raw} e, se configurado, {timestamp}"
                    />
                  </label>
                  <label>
                    Prefixo da assinatura (opcional)
                    <input name="signaturePrefix" placeholder="sha256=" />
                  </label>
                  <label>
                    Caminho do ID do evento
                    <input name="eventIdPath" defaultValue="id" required />
                  </label>
                  <label>
                    Caminho do tipo do evento
                    <input name="eventTypePath" defaultValue="type" required />
                  </label>
                  <label>
                    Caminho da data (opcional)
                    <input name="occurredAtPath" placeholder="created_at" />
                  </label>
                </>
              )}
            </>
          )}
          {section === "destinations" && (
            <>
              <label>
                URL HTTPS
                <input
                  name="url"
                  type="url"
                  required
                  pattern="https://.*"
                  placeholder="https://events.example.com/sluice"
                />
              </label>
              <label>
                Host permitido
                <input
                  name="allowedHost"
                  required
                  placeholder="events.example.com"
                />
              </label>
            </>
          )}
          {section === "pipelines" && (
            <>
              <label>
                Fonte
                <select name="sourceId" required>
                  {data.sources.map((source) => (
                    <option value={source.id} key={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Destino
                <select name="destinationId" required>
                  {data.destinations.map((destination) => (
                    <option value={destination.id} key={destination.id}>
                      {destination.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {section === "tenants" && (
            <>
              <label>
                Slug
                <input name="slug" required pattern="[a-z0-9-]+" />
              </label>
              <label>
                Retenção do payload
                <select name="retentionDays" defaultValue="90">
                  <option value="30">30 dias</option>
                  <option value="60">60 dias</option>
                  <option value="90">90 dias</option>
                </select>
              </label>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="button" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "Salvando…" : "Criar com segurança"}
          </button>
        </div>
      </form>
    </div>
  );
}

type Toast = { id: number; message: string; error?: boolean };
type ActionResult = { message?: string; webhookUrl?: string };

function WebhookUrlModal({
  url,
  onClose
}: {
  url: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <p className="page-kicker" style={{ marginBottom: 4 }}>
              Fonte criada
            </p>
            <h2>URL do webhook</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-note">
            Copie esta URL agora. A chave é mascarada na listagem por segurança.
          </p>
          <label>
            Endpoint público
            <input value={url} readOnly aria-label="Endpoint público do webhook" />
          </label>
        </div>
        <div className="modal-foot">
          <button className="button" type="button" onClick={onClose}>
            Fechar
          </button>
          <button className="button button-primary" type="button" onClick={() => void copyUrl()}>
            <Copy size={14} /> {copied ? "Copiado" : "Copiar URL"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function SectionPage({ section }: { section: Section }) {
  const searchParams = useSearchParams();
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<WebhookEvent | null>(null);
  const [modal, setModal] = useState<
    "sources" | "destinations" | "pipelines" | "tenants" | null
  >(null);
  const [createdWebhookUrl, setCreatedWebhookUrl] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const tenant = searchParams.get("tenant") ?? "all";
  const globalQuery = (searchParams.get("q") ?? "").trim().toLowerCase();

  const addToast = useCallback((message: string, toastError = false) => {
    const id = Date.now();
    setToasts((current) => [...current, { id, message, error: toastError }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      4200
    );
  }, []);

  const load = useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const query = tenant === "all" ? "" : `?tenant=${encodeURIComponent(tenant)}`;
        const response = await fetch(`/api/dashboard${query}`, {
          cache: "no-store"
        });
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (response.status === 403) {
          throw new Error(
            "Você não tem acesso ao tenant selecionado. Selecione outro workspace."
          );
        }
        if (response.status === 503) {
          throw new Error(
            "Os dados operacionais estão indisponíveis. Tente novamente em instantes."
          );
        }
        if (!response.ok) {
          throw new Error("Não foi possível carregar a operação.");
        }
        const payload = (await response.json()) as DashboardPayload;
        setData(payload);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Não foi possível carregar a operação."
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [tenant]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visibleData = useMemo(() => {
    if (!data || !globalQuery) return data;
    const matches = (...values: Array<string | number | undefined>) =>
      values.join(" ").toLowerCase().includes(globalQuery);
    return {
      ...data,
      activity: data.activity.filter((item) => matches(item.title, item.detail)),
      jobs: data.jobs.filter((job) =>
        matches(job.id, job.tenant, job.type, job.source, job.externalEventId)
      ),
      events: data.events.filter((event) =>
        matches(
          event.id,
          event.externalId,
          event.provider,
          event.source,
          event.tenant,
          event.eventType
        )
      ),
      sources: data.sources.filter((source) =>
        matches(source.name, source.provider, source.description, source.endpointKey)
      ),
      destinations: data.destinations.filter((destination) =>
        matches(destination.name, destination.kind, destination.host, destination.description)
      ),
      pipelines: data.pipelines.filter((pipeline) =>
        matches(
          pipeline.name,
          pipeline.source,
          pipeline.destination,
          pipeline.description
        )
      ),
      workers: data.workers.filter((worker) =>
        matches(worker.id, worker.region, worker.lastSeenAt, worker.uptime)
      ),
      tenants: data.tenants.filter((item) => matches(item.name, item.slug))
    };
  }, [data, globalQuery]);

  async function action(
    name: string,
    input: Record<string, unknown>,
    successMessage: string,
    onSuccess?: (result: ActionResult) => void
  ) {
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, ...input })
      });
      const result = (await response.json()) as ActionResult;
      if (!response.ok) throw new Error(result.message ?? "action failed");
      onSuccess?.(result);
      addToast(successMessage);
      await load(true);
      return true;
    } catch (actionError) {
      addToast(
        actionError instanceof Error
          ? actionError.message
          : "Não foi possível concluir a ação.",
        true
      );
      return false;
    }
  }

  const exportSection = useCallback(() => {
    if (!visibleData) return;
    const sectionData: Record<Section, unknown> = {
      overview: {
        stats: visibleData.stats,
        chart: visibleData.chart,
        activity: visibleData.activity,
        operational: visibleData.operational
      },
      events: visibleData.events,
      jobs: visibleData.jobs,
      workers: visibleData.workers,
      "dead-letter": visibleData.jobs.filter((job) => job.status === "dead-letter"),
      tenants: visibleData.tenants,
      metrics: {
        stats: visibleData.stats,
        chart: visibleData.chart,
        jobDistribution: visibleData.jobDistribution
      },
      sources: visibleData.sources,
      destinations: visibleData.destinations,
      pipelines: visibleData.pipelines,
      settings: {
        settings: visibleData.settings,
        operational: visibleData.operational
      }
    };
    try {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              tenant: visibleData.tenant,
              section,
              query: globalQuery || undefined,
              data: sectionData[section]
            },
            null,
            2
          )
        ],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `sluice-${section}-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      addToast("Exportação JSON iniciada com os dados visíveis.");
    } catch {
      addToast("Não foi possível gerar a exportação.", true);
    }
  }, [addToast, globalQuery, section, visibleData]);

  const titleActions = useMemo(() => {
    if (["sources", "destinations", "pipelines"].includes(section)) {
      return (
        <button
          className="button button-primary"
          onClick={() =>
            setModal(section as "sources" | "destinations" | "pipelines")
          }
        >
          <Plus size={14} /> Criar{" "}
          {section === "sources"
            ? "fonte"
            : section === "destinations"
              ? "destino"
              : "pipeline"}
        </button>
      );
    }
    if (section === "tenants") {
      return (
        <button className="button button-primary" onClick={() => setModal("tenants")}>
          <Plus size={14} /> Novo tenant
        </button>
      );
    }
    if (section === "dead-letter") {
      return (
        <span className="system-tag" title="Contagem atual de jobs com falha terminal">
          <ShieldAlert size={13} /> {data?.operational.deadLetters ?? 0} em dead-letter
        </span>
      );
    }
    return (
      <>
        <button className="button" onClick={exportSection}>
          <Download size={14} /> Exportar
        </button>
        <button
          className="button"
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          <RefreshCw
            size={14}
            style={{ animation: refreshing ? "spin 1s linear infinite" : undefined }}
          />
          {refreshing ? "Atualizando…" : "Atualizar"}
        </button>
      </>
    );
  }, [data?.operational.deadLetters, exportSection, load, refreshing, section]);

  if (loading) {
    return (
      <div className="content">
        <PageHeader section={section} />
        <div className="grid stats-grid">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="skeleton" key={index} />
          ))}
        </div>
        <div className="skeleton" style={{ height: 390, marginTop: 15 }} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="content">
        <PageHeader section={section} />
        <section className="panel error-state">
          <div>
            <SluiceMascot size={90} state="alert" />
            <h2>Fluxo temporariamente indisponível</h2>
            <p>{error}</p>
            <button className="button button-primary" onClick={() => void load()}>
              <RefreshCw size={14} /> Tentar novamente
            </button>
          </div>
        </section>
      </div>
    );
  }

  const displayedData = visibleData ?? data;

  return (
    <div className="content">
      <PageHeader section={section}>{titleActions}</PageHeader>
      {globalQuery && (
        <p className="panel-subtitle" style={{ margin: "-4px 0 14px" }}>
          Filtro global ativo: “{searchParams.get("q")}”. A exportação inclui somente os dados visíveis.
        </p>
      )}

      {section === "overview" && (
        <Overview data={displayedData} onSelectJob={setSelectedJob} />
      )}
      {section === "jobs" && (
        <JobsTable jobs={displayedData.jobs} onSelect={setSelectedJob} />
      )}
      {section === "dead-letter" && (
        <JobsTable jobs={displayedData.jobs} onSelect={setSelectedJob} deadOnly />
      )}
      {section === "events" && (
        <EventsTable events={displayedData.events} onSelect={setSelectedEvent} />
      )}
      {section === "workers" && <WorkersView workers={displayedData.workers} />}
      {section === "tenants" && <TenantsView data={displayedData} />}
      {section === "metrics" && <MetricsView data={displayedData} />}
      {(section === "sources" ||
        section === "destinations" ||
        section === "pipelines") && (
        <EntityCards
          section={section}
          data={displayedData}
          onCreate={() => setModal(section)}
          onToggle={(entity) =>
            void action(
              "toggle_resource",
              {
                resource: section,
                id: entity.id,
                active: entity.status !== "active"
              },
              `${entity.status === "active" ? "Recurso pausado" : "Recurso ativado"} com auditoria.`
            )
          }
          onToggleReconciliation={(source) => {
            const nextEnabled = !source.reconciliationEnabled;
            if (
              nextEnabled &&
              !window.confirm(
                "Ative somente se o endpoint de reconciliação deste provedor estiver configurado no worker. Continuar?"
              )
            ) {
              return;
            }
            void action(
              "toggle_source_reconciliation",
              { id: source.id, active: nextEnabled },
              `Reconciliação ${nextEnabled ? "ativada" : "desativada"} com auditoria.`
            );
          }}
        />
      )}
      {section === "settings" && (
        <SettingsView
          data={displayedData}
          onRefresh={() => void load(true)}
          refreshing={refreshing}
        />
      )}

      {selectedJob && (
        <JobDrawer
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onToast={addToast}
          onRedrive={(job) =>
            void action(
              "redrive_job",
              { id: job.id, tenantId: job.tenantId },
              "Redrive criado como novo job lógico."
            ).then((ok) => {
              if (ok) setSelectedJob(null);
            })
          }
        />
      )}
      {selectedEvent && (
        <EventDrawer
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onToast={addToast}
        />
      )}
      {modal && (
        <CreateModal
          section={modal}
          data={data}
          onClose={() => setModal(null)}
          onSubmit={async (input) => {
            const ok = await action(
              "create_resource",
              { resource: modal, input },
              "Recurso criado e registrado na auditoria.",
              (result) => {
                if (modal === "sources" && result.webhookUrl) {
                  setCreatedWebhookUrl(result.webhookUrl);
                }
              }
            );
            if (ok) setModal(null);
          }}
        />
      )}
      {createdWebhookUrl && (
        <WebhookUrlModal
          url={createdWebhookUrl}
          onClose={() => setCreatedWebhookUrl(null)}
        />
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast ${toast.error ? "error" : ""}`} key={toast.id}>
            {toast.error ? (
              <AlertCircle size={15} className="trend-down" />
            ) : (
              <CheckCircle2 size={15} className="trend-up" />
            )}
            <span>
              <strong>{toast.error ? "Ação não concluída" : "Operação concluída"}</strong>
              <span>{toast.message}</span>
            </span>
            <button
              aria-label="Fechar mensagem"
              onClick={() =>
                setToasts((current) =>
                  current.filter((item) => item.id !== toast.id)
                )
              }
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
