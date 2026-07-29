import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSessionToken, isSecureSessionCookie, SESSION_COOKIE, SESSION_DURATION_SECONDS } from "@/lib/auth";
import { hasDatabase, queryOne } from "@/lib/db";
import { oidcConfig, verifyCallback } from "@/lib/oidc";

const FLOW_COOKIE = "sluice_oidc_flow";
type UserRow = { user_id: string; email: string; display_name: string; status: string; memberships: Array<{ tenant_id: string; tenant_status: string; role: "owner" | "admin" | "operator" | "viewer" }> };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const flowCookie = (await cookies()).get(FLOW_COOKIE)?.value;
  const fail = new URL("/login", url.origin);
  try {
    if (!flowCookie || !hasDatabase()) throw new Error("OIDC flow unavailable");
    const flow = JSON.parse(flowCookie) as { state: string; nonce: string; verifier: string; returnTo: string };
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code || state !== flow.state) throw new Error("Invalid OIDC state");
    const identity = await verifyCallback(oidcConfig()!, new URL("/api/session/oidc/callback", url.origin).toString(), code, flow.nonce, flow.verifier);
    const row = await queryOne<UserRow>(`SELECT user_id::text, email::text, display_name, status, memberships FROM sluice.lookup_dashboard_login($1)`, [identity.email]);
    const membership = row?.memberships.find((item) => item.tenant_status === "active");
    if (!row || row.status !== "active" || !membership) throw new Error("Unauthorized OIDC user");
    const token = await createSessionToken({ sub: row.user_id, email: row.email, name: row.display_name, role: membership.role, tenantId: membership.tenant_id });
    const response = NextResponse.redirect(new URL(flow.returnTo, url.origin));
    response.cookies.set(FLOW_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/session/oidc", maxAge: 0 });
    response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: isSecureSessionCookie(), sameSite: "strict", path: "/", maxAge: SESSION_DURATION_SECONDS });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    fail.searchParams.set("error", "sso");
    const response = NextResponse.redirect(fail);
    response.cookies.set(FLOW_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/session/oidc", maxAge: 0 });
    return response;
  }
}
