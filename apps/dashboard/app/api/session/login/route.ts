import { verify } from "@node-rs/argon2";
import { NextResponse } from "next/server";
import {
  createSessionToken,
  isDemoMode,
  isSecureSessionCookie,
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS
} from "@/lib/auth";
import { hasDatabase, queryOne } from "@/lib/db";
import { isSameOrigin } from "@/lib/request-security";

interface UserRow {
  user_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: string;
  mfa_enabled: boolean;
  memberships: Array<{
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
    tenant_status: string;
    role: "owner" | "admin" | "operator" | "viewer";
  }>;
}

function validReturnTo(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: "origin_not_allowed", message: "Origem não permitida." },
      { status: 403 }
    );
  }

  let input: { email?: string; password?: string; returnTo?: string };
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const email = input.email?.trim().toLowerCase();
  const password = input.password ?? "";

  if (!email || password.length < 8 || password.length > 256) {
    return NextResponse.json(
      { error: "invalid_credentials", message: "E-mail ou senha inválidos." },
      { status: 401 }
    );
  }

  let user:
    | {
        id: string;
        email: string;
        name: string;
        role: "owner" | "admin" | "operator" | "viewer";
        tenantId: string;
      }
    | undefined;

  if (isDemoMode()) {
    const demoEmail = (process.env.SLUICE_DEMO_EMAIL ?? "admin@sluice.local").toLowerCase();
    const demoPassword = process.env.SLUICE_DEMO_PASSWORD ?? "sluice-demo";
    if (email === demoEmail && password === demoPassword) {
      user = {
        id: "demo-admin",
        email,
        name: "Equipe Sluice",
        role: "owner",
        tenantId: "all"
      };
    }
  } else if (hasDatabase()) {
    const row = await queryOne<UserRow>(
      `SELECT
         user_id::text,
         email::text,
         display_name,
         password_hash,
         status,
         mfa_enabled,
         memberships
       FROM sluice.lookup_dashboard_login($1)`,
      [email]
    );

    const membership = row?.memberships.find(
      (item) => item.tenant_status === "active"
    );
    if (
      row?.status === "active" &&
      row.password_hash &&
      membership &&
      (await verify(row.password_hash, password))
    ) {
      user = {
        id: row.user_id,
        email: row.email,
        name: row.display_name,
        role: membership.role,
        tenantId: membership.tenant_id
      };
    }
  }

  if (!user) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return NextResponse.json(
      { error: "invalid_credentials", message: "E-mail ou senha inválidos." },
      { status: 401 }
    );
  }

  const token = await createSessionToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId
  });

  const response = NextResponse.json({
    ok: true,
    returnTo: validReturnTo(input.returnTo)
  });

  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: isSecureSessionCookie(),
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
