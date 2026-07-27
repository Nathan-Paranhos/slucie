import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ConsoleShell } from "@/components/console-shell";
import {
  isDemoMode,
  SESSION_COOKIE,
  verifySessionToken
} from "@/lib/auth";
import { hasDatabase, queryOne } from "@/lib/db";

interface MembershipLookup {
  user_id: string;
  memberships: Array<{
    tenant_id: string;
    tenant_name: string;
    tenant_status: string;
  }>;
}

export default async function ConsoleLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!session) redirect("/login");

  const demo = isDemoMode();
  let tenants = demo
    ? [
        { id: "all", name: "Todos os tenants" },
        { id: "tnt_aithos_pay", name: "Aithos Pay" },
        { id: "tnt_nexo", name: "Nexo Finance" },
        { id: "tnt_vertice", name: "Vértice" }
      ]
    : [{ id: session.tenantId, name: "Tenant atual" }];

  if (!demo && hasDatabase()) {
    try {
      const lookup = await queryOne<MembershipLookup>(
        `SELECT user_id::text, memberships
           FROM sluice.lookup_dashboard_login($1)`,
        [session.email]
      );
      if (lookup?.user_id === session.sub) {
        const active = lookup.memberships
          .filter((membership) => membership.tenant_status === "active")
          .map((membership) => ({
            id: membership.tenant_id,
            name: membership.tenant_name
          }));
        if (active.some((tenant) => tenant.id === session.tenantId)) {
          tenants = active;
        }
      }
    } catch {
      // The current signed tenant remains available if membership listing is
      // temporarily unavailable. Data requests still pass through RLS.
    }
  }

  return (
    <ConsoleShell
      user={{
        name: session.name,
        email: session.email,
        role: session.role
      }}
      tenants={tenants}
      currentTenantId={session.tenantId}
      demo={demo}
    >
      {children}
    </ConsoleShell>
  );
}
