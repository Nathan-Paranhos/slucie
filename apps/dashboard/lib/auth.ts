import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { isProductionRuntime } from "./runtime";

export const SESSION_COOKIE = "sluice_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 8;

export interface SessionClaims extends JWTPayload {
  sub: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "operator" | "viewer";
  tenantId: string;
}

const CONNECTED_TENANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SessionIdentity = Pick<
  SessionClaims,
  "sub" | "email" | "name" | "role" | "tenantId"
>;

function sessionKey() {
  const raw = process.env.SLUICE_SESSION_SECRET;
  if (!raw || raw.length < 32) {
    if (isProductionRuntime()) {
      throw new Error("SLUICE_SESSION_SECRET must contain at least 32 characters");
    }
    return new TextEncoder().encode(
      "development-only-session-key-change-before-production"
    );
  }

  return new TextEncoder().encode(raw);
}

export async function createSessionToken(
  claims: SessionIdentity
) {
  return new SignJWT({
    email: claims.email,
    name: claims.name,
    role: claims.role,
    tenantId: claims.tenantId
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .setIssuer("sluice-dashboard")
    .setAudience("sluice-console")
    .sign(sessionKey());
}

export async function verifySessionToken(
  token: string
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      issuer: "sluice-dashboard",
      audience: "sluice-console"
    });

    if (
      !payload.sub ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.tenantId !== "string"
    ) {
      return null;
    }

    return payload as SessionClaims;
  } catch {
    return null;
  }
}

export function isDemoMode() {
  if (isProductionRuntime()) {
    return false;
  }
  if (process.env.SLUICE_DEMO_MODE !== undefined) {
    return process.env.SLUICE_DEMO_MODE === "true";
  }
  return true;
}

/**
 * A signed token can outlive a runtime-mode change. Demo sessions use the
 * synthetic "all" tenant, which must never reach connected-mode queries.
 */
export function isUsableSession(
  session: SessionClaims | null | undefined
): session is SessionClaims {
  if (!session) return false;
  return isDemoMode()
    ? session.tenantId === "all"
    : CONNECTED_TENANT_ID.test(session.tenantId);
}

export function isSecureSessionCookie() {
  // Production authentication is always HTTPS-only. An environment value can
  // enable Secure cookies in development, but must never downgrade production.
  if (isProductionRuntime()) return true;
  return process.env.SLUICE_COOKIE_SECURE === "true";
}
