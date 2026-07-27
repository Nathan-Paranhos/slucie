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
  ChevronLeft,
  ChevronRight,
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
  MoreHorizontal,
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
    pix: "Pix"
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
          <span>00:00</span>
          <span>06:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>24:00</span>
        </div>
      </div>
      <div className="chart-legend">
        <span>
          <i className="legend-line" /> Eventos autenticados
        </span>
        <span>
          <i
            className="legend-line"
            style={{ background: "#16a36a" }}
          />{" "}
          SLO atendido
        </span>
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
            <Badge status="active" />
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
            {data.activity.map((item, index) => (
              <button
                key={item.id}
                className="activity-item"
                style={{
                  width: "100%",
                  borderTop: 0,
                  borderLeft: 0,
                  borderRight: 0,
                  cursor: "pointer",
                  textAlign: "left",
                  background: "transparent"
                }}
                onClick={() => {
                  const job = data.jobs[index % data.jobs.length];
                  if (job) onSelectJob(job);
                }}
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
            ))}
          </div>
        </section>
      </div>
      <section className="system-strip">
        <div className="mascot-mini">
          <SluiceMascot size={42} state="monitoring" />
        </div>
        <div className="system-strip-copy">
          <h3>Tudo sob controle.</h3>
          <p>
            Fila saudável, cron executando e purge dentro da janela de
            conformidade. Sluice está monitorando seus dados em tempo real.
          </p>
        </div>
        <div className="system-tags">
          <span className="system-tag">
            <i /> PostgreSQL
          </span>
          <span className="system-tag">
            <i /> Redis
          </span>
          <span className="system-tag">
            <i /> pg_cron
          </span>
          <span className="system-tag">
            <i /> 3 workers
          </span>
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
              <th>Duração</th>
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
                <td>
                  <button
                    className="table-action"
                    aria-label={`Detalhes do job ${job.id}`}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </td>
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
        statuses={["accepted", "duplicate", "quarantined"]}
      />
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Evento externo</th>
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
        Exibindo {count} {count === 1 ? "registro" : "registros"}
      </span>
      <div className="pagination-buttons">
        <button aria-label="Página anterior">
          <ChevronLeft size={12} />
        </button>
        <button className="active">1</button>
        <button aria-label="Próxima página">
          <ChevronRight size={12} />
        </button>
      </div>
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
  onToggle
}: {
  section: "sources" | "destinations" | "pipelines";
  data: DashboardPayload;
  onCreate: () => void;
  onToggle: (entity: Source | Destination | Pipeline) => void;
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
            ? (entity as Source).events24h
            : section === "destinations"
              ? (entity as Destination).deliveries24h
              : (entity as Pipeline).throughput;

        return (
          <article className="entity-card" key={entity.id}>
            <div className="entity-card-top">
              <span className="entity-icon">
                <Icon size={18} strokeWidth={1.7} />
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <Badge status={status} />
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
                {section === "pipelines" ? "Throughput" : "Últimas 24h"}
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
              <span>
                <strong>{worker.id}</strong>
                <span>{worker.region}</span>
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
              <span>Uptime</span>
              <strong>{worker.uptime}</strong>
            </div>
          </div>
          <div className="progress" title={`CPU ${worker.cpu}%`}>
            <i style={{ width: `${Math.max(worker.cpu, 4)}%` }} />
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
              <th>Plano</th>
              <th>Retenção</th>
              <th>Eventos no mês</th>
              <th>Membros</th>
              <th>Isolamento</th>
              <th aria-label="Ações" />
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
                <td>{tenant.plan}</td>
                <td>{tenant.retentionDays} dias</td>
                <td className="mono">{tenant.eventsMonth}</td>
                <td>{tenant.members}</td>
                <td>
                  <span className="system-tag">
                    <Shield size={10} /> RLS ativo
                  </span>
                </td>
                <td>
                  <button className="table-action" aria-label="Opções do tenant">
                    <MoreHorizontal size={14} />
                  </button>
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
            <Badge status="active" />
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
            <div className="donut">
              <div className="donut-center">
                <strong>1,2M</strong>
                <span>Total</span>
              </div>
            </div>
            <div className="chart-legend" style={{ flexWrap: "wrap", justifyContent: "center" }}>
              <span>
                <i className="legend-line" style={{ background: "#16a36a" }} />{" "}
                Concluídos 72,5%
              </span>
              <span>
                <i className="legend-line" style={{ background: "#2970ff" }} />{" "}
                Processando 12,4%
              </span>
              <span>
                <i className="legend-line" style={{ background: "#d92d20" }} />{" "}
                DLQ 1,9%
              </span>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function SettingsView() {
  const [toggles, setToggles] = useState({
    notifications: true,
    weekly: true,
    anomaly: true,
    verbose: false
  });
  const cards = [
    {
      title: "Segurança",
      description: "Sessões, segredos e controle de acesso.",
      icon: LockKeyhole,
      rows: [
        ["MFA obrigatório", "Exigir segundo fator para administradores", "notifications"],
        ["Alertas de anomalia", "Mudanças de segredo e falhas de assinatura", "anomaly"]
      ]
    },
    {
      title: "Notificações",
      description: "Alertas ativos e relatórios operacionais.",
      icon: ShieldAlert,
      rows: [
        ["Dead-letter imediato", "Notificar em todos os canais configurados", "notifications"],
        ["Resumo semanal", "Saúde, volume e conformidade", "weekly"]
      ]
    },
    {
      title: "Retenção LGPD",
      description: "Prazo obrigatório para dados brutos.",
      icon: FileClock,
      rows: [
        ["Janela padrão", "90 dias · mínimo operacional 7 dias", null],
        ["Último purge", "26 jul 2026, 15:30 · 1.842 payloads", null]
      ]
    },
    {
      title: "Observabilidade",
      description: "Logs, métricas e auditoria append-only.",
      icon: Activity,
      rows: [
        ["Logs detalhados", "Nunca inclui payload ou segredo", "verbose"],
        ["Auditoria de estado", "Trigger append-only ativo", "notifications"]
      ]
    }
  ] as const;

  return (
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
            {card.rows.map(([title, description, key]) => (
              <div className="setting-row" key={title}>
                <div className="setting-row-copy">
                  <strong>{title}</strong>
                  <span>{description}</span>
                </div>
                {key ? (
                  <button
                    className={`toggle ${toggles[key] ? "on" : ""}`}
                    aria-label={`${toggles[key] ? "Desativar" : "Ativar"} ${title}`}
                    aria-pressed={toggles[key]}
                    onClick={() =>
                      setToggles((current) => ({
                        ...current,
                        [key]: !current[key]
                      }))
                    }
                  />
                ) : (
                  <CheckCircle2 size={15} className="trend-up" />
                )}
              </div>
            ))}
          </section>
        );
      })}
    </div>
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
                <span>Evento externo</span>
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
                    <strong>Efeito confirmado</strong>
                    <span>Ledger idempotente registrado</span>
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
  const [toasts, setToasts] = useState<Toast[]>([]);

  const tenant = searchParams.get("tenant") ?? "all";

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
        if (!response.ok) throw new Error(`dashboard ${response.status}`);
        const payload = (await response.json()) as DashboardPayload;
        setData(payload);
      } catch {
        setError(
          "Não foi possível carregar a operação. Verifique o dashboard e o PostgreSQL."
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

  async function action(
    name: string,
    input: Record<string, unknown>,
    successMessage: string
  ) {
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, ...input })
      });
      const result = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "action failed");
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
        <button className="button button-danger">
          <ShieldAlert size={14} /> Política de alerta ativa
        </button>
      );
    }
    return (
      <>
        <button className="button">
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
  }, [section, refreshing, load]);

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

  return (
    <div className="content">
      <PageHeader section={section}>{titleActions}</PageHeader>

      {section === "overview" && (
        <Overview data={data} onSelectJob={setSelectedJob} />
      )}
      {section === "jobs" && (
        <JobsTable jobs={data.jobs} onSelect={setSelectedJob} />
      )}
      {section === "dead-letter" && (
        <JobsTable jobs={data.jobs} onSelect={setSelectedJob} deadOnly />
      )}
      {section === "events" && (
        <EventsTable events={data.events} onSelect={setSelectedEvent} />
      )}
      {section === "workers" && <WorkersView workers={data.workers} />}
      {section === "tenants" && <TenantsView data={data} />}
      {section === "metrics" && <MetricsView data={data} />}
      {(section === "sources" ||
        section === "destinations" ||
        section === "pipelines") && (
        <EntityCards
          section={section}
          data={data}
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
        />
      )}
      {section === "settings" && <SettingsView />}

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
              "Recurso criado e registrado na auditoria."
            );
            if (ok) setModal(null);
          }}
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
