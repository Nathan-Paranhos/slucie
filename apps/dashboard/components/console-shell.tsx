"use client";

import {
  Activity,
  Bell,
  Boxes,
  Building2,
  CalendarClock,
  ChevronDown,
  CircleGauge,
  DatabaseZap,
  GitBranch,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ServerCog,
  Settings,
  ShieldAlert,
  Users,
  Webhook,
  X
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { Brand } from "./brand";
import type { DashboardPayload } from "@/lib/types";

const nav = [
  {
    label: "Operação",
    items: [
      { href: "/", label: "Visão geral", icon: CircleGauge },
      { href: "/events", label: "Eventos", icon: CalendarClock },
      { href: "/jobs", label: "Jobs", icon: Boxes },
      { href: "/workers", label: "Workers", icon: ServerCog },
      { href: "/dead-letter", label: "Dead-letter", icon: ShieldAlert }
    ]
  },
  {
    label: "Fluxos",
    items: [
      { href: "/sources", label: "Fontes", icon: Webhook },
      { href: "/destinations", label: "Destinos", icon: DatabaseZap },
      { href: "/pipelines", label: "Pipelines", icon: GitBranch }
    ]
  },
  {
    label: "Gestão",
    items: [
      { href: "/tenants", label: "Tenants", icon: Building2 },
      { href: "/metrics", label: "Métricas", icon: Activity },
      { href: "/settings", label: "Configurações", icon: Settings }
    ]
  }
];

export function ConsoleShell({
  children,
  user,
  tenants,
  currentTenantId,
  demo
}: {
  children: ReactNode;
  user: {
    name: string;
    email: string;
    role: string;
  };
  tenants: Array<{ id: string; name: string }>;
  currentTenantId: string;
  demo: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [tenantSwitching, setTenantSwitching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const selectedTenant = demo
    ? searchParams.get("tenant") ?? "all"
    : currentTenantId;
  const selectedTenantName =
    tenants.find((tenant) => tenant.id === selectedTenant)?.name ?? "Workspace selecionado";

  const [openDropdown, setOpenDropdown] = useState<"notifications" | "profile" | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [operational, setOperational] = useState<Pick<
    DashboardPayload,
    "operational" | "settings"
  > | null>(null);
  const [newName, setNewName] = useState(user.name);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const topbarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    setQuery(searchParams.get("q") ?? "");
  }, [searchParams]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (topbarRef.current && !topbarRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  useEffect(() => {
    let active = true;
    setOperational(null);
    async function loadOperationalStatus() {
      try {
        const query = demo && selectedTenant !== "all"
          ? `?tenant=${encodeURIComponent(selectedTenant)}`
          : "";
        const response = await fetch(`/api/dashboard${query}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as DashboardPayload;
        if (active) {
          setOperational({
            operational: payload.operational,
            settings: payload.settings
          });
        }
      } catch {
        // The visible page keeps its own recovery state. The sidebar stays neutral.
      }
    }
    void loadOperationalStatus();
    const interval = window.setInterval(() => void loadOperationalStatus(), 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [demo, selectedTenant]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    if (query.trim()) params.set("q", query.trim());
    else params.delete("q");
    const suffix = params.toString() ? `?${params}` : "";
    router.push(`${pathname}${suffix}`);
  }

  async function changeTenant(tenant: string) {
    if (demo) {
      const params = new URLSearchParams(searchParams.toString());
      if (tenant === "all") params.delete("tenant");
      else params.set("tenant", tenant);
      const suffix = params.toString() ? `?${params}` : "";
      router.push(`${pathname}${suffix}`);
      return;
    }

    setTenantSwitching(true);
    try {
      const response = await fetch("/api/session/tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: tenant })
      });
      if (!response.ok) return;
      const params = new URLSearchParams(searchParams.toString());
      params.delete("tenant");
      const suffix = params.toString() ? `?${params}` : "";
      router.replace(`${pathname}${suffix}`);
      router.refresh();
    } finally {
      setTenantSwitching(false);
    }
  }

  async function logout() {
    await fetch("/api/session/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || name === user.name) return;
    setSavingProfile(true);
    setProfileError("");
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_profile", input: { name } })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!response.ok) {
        setProfileError(payload.message ?? "Não foi possível salvar o perfil.");
        return;
      }
      setProfileModalOpen(false);
      router.refresh();
    } catch {
      setProfileError("Não foi possível salvar o perfil.");
    } finally {
      setSavingProfile(false);
    }
  }

  const initials = user.name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const services = operational?.operational.services ?? [];
  const deadLetters = operational?.operational.deadLetters;
  const unhealthyServices = services.filter((service) => service.status !== "healthy");
  const notifications = operational
    ? [
        ...(deadLetters && deadLetters > 0
          ? [
              {
                id: "dead-letter",
                title: "Dead-letter requer atenção",
                desc: `${deadLetters} job(s) aguardam análise ou redrive.`,
                time: "Estado atual"
              }
            ]
          : []),
        ...(operational.settings.notifications.failed > 0
          ? [
              {
                id: "notification-failed",
                title: "Falhas de notificação",
                desc: `${operational.settings.notifications.failed} envio(s) precisam de revisão.`,
                time: "Estado atual"
              }
            ]
          : []),
        ...(operational.settings.notifications.pending > 0 ||
        operational.settings.notifications.processing > 0
          ? [
              {
                id: "notification-queue",
                title: "Fila de notificações em andamento",
                desc: `${operational.settings.notifications.pending} pendente(s) e ${operational.settings.notifications.processing} em processamento.`,
                time: "Estado atual"
              }
            ]
          : [])
      ]
    : [];
  const healthLabel = !operational
    ? "Verificando serviços"
    : unhealthyServices.length === 0
      ? "Serviços operacionais"
      : "Serviços requerem atenção";
  const healthResult = !operational
    ? "…"
    : unhealthyServices.length === 0
      ? "OK"
      : "Atenção";

  return (
    <div className={`console ${isCollapsed ? "console-collapsed" : ""}`}>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Fechar menu"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? "open" : ""} ${isCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          <Brand compact={isCollapsed} showTag={!isCollapsed} />
          <button
            className="icon-button collapse-toggle"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? "Expandir menu" : "Recolher menu"}
          >
            {isCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>
        <div className="sidebar-workspace">
          <span>Workspace</span>
          <strong>
            {tenants.find((tenant) => tenant.id === selectedTenant)?.name ??
              "Workspace selecionado"}
          </strong>
        </div>
        <nav className="sidebar-nav" aria-label="Navegação principal">
          {nav.map((group) => (
            <div key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    className={`nav-link ${active ? "active" : ""}`}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon size={15} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {item.href === "/dead-letter" && deadLetters ? (
                      <span className="nav-count">{deadLetters}</span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="system-health">
            <div className="system-health-head">
              <span className="health-label">
                <i
                  className={operational && unhealthyServices.length === 0 ? "pulse" : ""}
                  style={{
                    background: !operational
                      ? "#59616d"
                      : unhealthyServices.length === 0
                        ? undefined
                        : "#d92d20"
                  }}
                />
                {healthLabel}
              </span>
              <span className={!operational ? "" : unhealthyServices.length ? "trend-down" : "trend-up"}>
                {healthResult}
              </span>
            </div>
            <div className="health-bars" aria-label={healthLabel}>
              {(services.length ? services : Array.from({ length: 3 }, () => null)).map((service, index) => (
                <i
                  key={service?.id ?? index}
                  title={service ? `${service.label}: ${service.detail}` : "Aguardando healthcheck"}
                  style={{
                    background:
                      service?.status === "healthy"
                        ? "#16a36a"
                        : service?.status === "degraded"
                          ? "#ff6b00"
                          : service?.status === "unavailable"
                            ? "#d92d20"
                            : "#59616d"
                  }}
                />
              ))}
            </div>
          </div>
          <div className="user-card">
            <span className="avatar">{initials}</span>
            <span className="user-card-text">
              <strong>{user.name}</strong>
              <span>
                {user.role} · {user.email}
              </span>
            </span>
            <button
              className="table-action"
              onClick={logout}
              title="Sair"
              aria-label="Sair do console"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar" ref={topbarRef}>
          <button
            className="icon-button mobile-menu"
            aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X size={17} /> : <Menu size={17} />}
          </button>
          <form className="search-box" onSubmit={submitSearch}>
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar evento, job ou tenant…"
              aria-label="Busca global"
            />
            <span className="search-shortcut">⌘ K</span>
          </form>
          <div className="topbar-spacer" />
          <select
            className="topbar-select"
            aria-label="Tenant selecionado"
            value={selectedTenant}
            title={selectedTenantName}
            disabled={tenantSwitching}
            onChange={(event) => void changeTenant(event.target.value)}
          >
            {tenants.map((tenant) => (
              <option value={tenant.id} key={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
          <div className="dropdown-container">
            <button
              className="icon-button"
              title="Notificações"
              onClick={() => setOpenDropdown(openDropdown === "notifications" ? null : "notifications")}
            >
              <Bell size={15} />
              {notifications.length > 0 && <i className="notification-dot" />}
            </button>
            {openDropdown === "notifications" && (
              <div className="dropdown-menu notifications-menu" onClick={e => e.stopPropagation()}>
                <div className="dropdown-header">
                  <div className="dropdown-header-title">
                    Alertas operacionais
                  </div>
                </div>
                {!operational ? (
                  <div style={{padding: '12px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13}}>
                    Consultando estado operacional…
                  </div>
                ) : notifications.length > 0 ? notifications.map(n => (
                  <div key={n.id} className="notification-item unread">
                    <span className="notification-title">{n.title}</span>
                    <span className="notification-desc">{n.desc}</span>
                    <span className="notification-time">{n.time}</span>
                  </div>
                )) : (
                  <div style={{padding: '12px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13}}>Nenhum alerta operacional pendente.</div>
                )}
              </div>
            )}
          </div>

          <div className="dropdown-container">
            <button
              className="icon-button account-button"
              title="Conta"
              onClick={() => setOpenDropdown(openDropdown === "profile" ? null : "profile")}
            >
              <Users size={15} />
              <ChevronDown size={9} />
            </button>
            {openDropdown === "profile" && (
              <div className="dropdown-menu profile-menu" onClick={e => e.stopPropagation()}>
                <div className="dropdown-header">
                  <div className="dropdown-header-title">{user.name}</div>
                  <div className="dropdown-header-subtitle">{user.email} · {user.role}</div>
                </div>
                <button className="dropdown-item" onClick={() => {
                  setOpenDropdown(null);
                  setNewName(user.name);
                  setProfileError("");
                  setProfileModalOpen(true);
                }}>
                  <Users size={14} /> Meu Perfil
                </button>
                <button className="dropdown-item danger" onClick={logout}>
                  <LogOut size={14} /> Sair
                </button>
              </div>
            )}
          </div>
        </header>
        {children}
        {profileModalOpen && (
          <div className="modal-overlay" onClick={() => setProfileModalOpen(false)}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-title">Meu Perfil</div>
                <button className="icon-button" onClick={() => setProfileModalOpen(false)}><X size={15}/></button>
              </div>
              <form onSubmit={saveProfile} style={{display: 'flex', flexDirection: 'column', gap: 15}}>
                <div>
                  <label style={{display: 'block', marginBottom: 5, fontSize: 13, color: 'var(--text-primary)'}}>Nome de Exibição</label>
                  <input className="input" value={newName} onChange={e => setNewName(e.target.value)} required style={{width: '100%', padding: '8px 12px', background: 'var(--surface-hover)', border: '1px solid var(--border)', borderRadius: 6, color: 'white'}}/>
                </div>
                <div>
                  <label style={{display: 'block', marginBottom: 5, fontSize: 13, color: 'var(--text-primary)'}}>E-mail</label>
                  <input className="input" value={user.email} disabled style={{width: '100%', padding: '8px 12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'not-allowed'}}/>
                </div>
                {profileError && <p className="form-error" role="alert">{profileError}</p>}
                <button type="submit" disabled={savingProfile} style={{padding: '8px 16px', background: 'white', color: 'black', border: 'none', borderRadius: 6, fontWeight: 500, cursor: 'pointer', marginTop: 10, alignSelf: 'flex-end'}}>
                  {savingProfile ? "Salvando..." : "Salvar Alterações"}
                </button>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
