import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  createSessionToken,
  isSecureSessionCookie,
  isUsableSession,
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
  verifySessionToken
} from "@/lib/auth";
import { hasDatabase, queryOne } from "@/lib/db";
import { isSameOrigin } from "@/lib/request-security";

interface MembershipLookup {
  user_id: string;
  status: string;
  memberships: Array<{
    tenant_id: string;
    tenant_status: string;
    role: "owner" | "admin" | "operator" | "viewer";
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

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ message: "Origem não permitida." }, { status: 403 });
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!isUsableSession(session) || !hasDatabase()) {
    return NextResponse.json({ message: "Sessão inválida." }, { status: 401 });
  }

  let tenantId: unknown;
  try {
    tenantId = (await request.json() as { tenantId?: unknown }).tenantId;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }
  if (!validUuid(tenantId)) {
    return NextResponse.json({ message: "Tenant inválido." }, { status: 400 });
  }

  const lookup = await queryOne<MembershipLookup>(
    `SELECT user_id::text, status, memberships
       FROM sluice.lookup_dashboard_login($1)`,
    [session.email]
  );
  const membership = lookup?.memberships.find(
    (item) =>
      item.tenant_id === tenantId &&
      item.tenant_status === "active"
  );
  if (
    lookup?.user_id !== session.sub ||
    lookup.status !== "active" ||
    !membership
  ) {
    return NextResponse.json(
      { message: "Acesso ao tenant não autorizado." },
      { status: 403 }
    );
  }

  const nextToken = await createSessionToken({
    sub: session.sub,
    email: session.email,
    name: session.name,
    role: membership.role,
    tenantId
  });
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: nextToken,
    httpOnly: true,
    secure: isSecureSessionCookie(),
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
