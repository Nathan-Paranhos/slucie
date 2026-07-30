import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { loadDashboard } from "@/lib/dashboard-data";
import {
  isDemoMode,
  isUsableSession,
  SESSION_COOKIE,
  verifySessionToken
} from "@/lib/auth";
import { hasDatabase, queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

interface MembershipLookup {
  user_id: string;
  status: string;
  memberships: Array<{
    tenant_id: string;
    tenant_status: string;
  }>;
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

export async function GET(request: Request) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!isUsableSession(session)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    let tenantId = session.tenantId;
    const requestedTenant = new URL(request.url).searchParams.get("tenant");

    if (!isDemoMode() && requestedTenant !== null) {
      if (!validUuid(requestedTenant)) {
        return NextResponse.json(
          { error: "invalid_tenant", message: "Tenant inválido." },
          { status: 400 }
        );
      }

      if (requestedTenant !== session.tenantId) {
        if (session.role !== "owner") {
          return NextResponse.json(
            {
              error: "tenant_access_denied",
              message: "Apenas owners podem consultar outro tenant."
            },
            { status: 403 }
          );
        }
        if (!hasDatabase()) {
          return NextResponse.json(
            {
              error: "dashboard_unavailable",
              message: "PostgreSQL não configurado."
            },
            { status: 503 }
          );
        }

        const lookup = await queryOne<MembershipLookup>(
          `SELECT user_id::text, status, memberships
             FROM sluice.lookup_dashboard_login($1)`,
          [session.email]
        );
        const membership = lookup?.memberships.find(
          (item) =>
            item.tenant_id === requestedTenant &&
            item.tenant_status === "active"
        );
        if (
          lookup?.user_id !== session.sub ||
          lookup.status !== "active" ||
          !membership
        ) {
          return NextResponse.json(
            {
              error: "tenant_access_denied",
              message: "Acesso ao tenant não autorizado."
            },
            { status: 403 }
          );
        }
        tenantId = requestedTenant;
      }
    }

    const payload = await loadDashboard(tenantId, session.sub);
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    console.error("dashboard_query_failed", {
      message: error instanceof Error ? error.message : "unknown"
    });
    return NextResponse.json(
      {
        error: "dashboard_unavailable",
        message: "Não foi possível consultar os dados operacionais."
      },
      { status: 503 }
    );
  }
}
