import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { loadDashboard } from "@/lib/dashboard-data";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const payload = await loadDashboard(session.tenantId, session.sub);
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
