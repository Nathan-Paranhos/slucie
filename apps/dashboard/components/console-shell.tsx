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
  SlidersHorizontal,
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

const nav = [
  {
    label: "Operação",
    items: [
      { href: "/", label: "Visão geral", icon: CircleGauge },
      { href: "/events", label: "Eventos", icon: CalendarClock },
      { href: "/jobs", label: "Jobs", icon: Boxes },
      { href: "/workers", label: "Workers", icon: ServerCog },
      {
        href: "/dead-letter",
        label: "Dead-letter",
        icon: ShieldAlert,
        count: 1
      }
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

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

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

  const initials = user.name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

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
            {tenants.find((tenant) => tenant.id === currentTenantId)?.name ??
              "Produção"}{" "}
            · Brasil
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
                    {"count" in item && item.count ? (
                      <span className="nav-count">{item.count}</span>
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
                <i className="pulse" />
                Todos os sistemas
              </span>
              <span className="trend-up">OK</span>
            </div>
            <div className="health-bars" aria-label="10 verificações saudáveis">
              {Array.from({ length: 10 }, (_, index) => (
                <i key={index} />
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
        <header className="topbar">
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
            value={
              demo
                ? searchParams.get("tenant") ?? "all"
                : currentTenantId
            }
            disabled={tenantSwitching}
            onChange={(event) => void changeTenant(event.target.value)}
          >
            {tenants.map((tenant) => (
              <option value={tenant.id} key={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
          <button className="icon-button" title="Filtros globais">
            <SlidersHorizontal size={15} />
          </button>
          <button className="icon-button" title="Notificações">
            <Bell size={15} />
            <i className="notification-dot" />
          </button>
          <button className="icon-button account-button" title="Conta">
            <Users size={15} />
            <ChevronDown size={9} />
          </button>
        </header>
        {children}
      </main>
    </div>
  );
}
