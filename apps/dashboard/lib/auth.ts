import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const SESSION_COOKIE = "sluice_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 8;

export interface SessionClaims extends JWTPayload {
  sub: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "operator" | "viewer";
  tenantId: string;
}

export type SessionIdentity = Pick<
  SessionClaims,
  "sub" | "email" | "name" | "role" | "tenantId"
>;

function sessionKey() {
  const raw = process.env.SLUICE_SESSION_SECRET;
  if (!raw || raw.length < 32) {
    if (process.env.NODE_ENV === "production") {
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
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  if (process.env.SLUICE_DEMO_MODE !== undefined) {
    return process.env.SLUICE_DEMO_MODE === "true";
  }
  return true;
}

export function isSecureSessionCookie() {
  if (process.env.NODE_ENV === "production") {
    return true;
  }
  if (process.env.SLUICE_COOKIE_SECURE !== undefined) {
    return process.env.SLUICE_COOKIE_SECURE === "true";
  }
  return false;
}
