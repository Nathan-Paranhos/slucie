import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isProductionRuntime } from "./runtime";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  requiredAcr: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured in production`);
  return value;
}

export function oidcConfig(): OidcConfig | null {
  const configured = Boolean(process.env.SLUICE_OIDC_ISSUER?.trim());
  if (!configured) {
    if (isProductionRuntime()) {
      throw new Error("OIDC is mandatory in production; configure SLUICE_OIDC_ISSUER");
    }
    return null;
  }
  const issuer = required("SLUICE_OIDC_ISSUER").replace(/\/$/, "");
  if (!issuer.startsWith("https://")) throw new Error("SLUICE_OIDC_ISSUER must use HTTPS");
  return {
    issuer,
    clientId: required("SLUICE_OIDC_CLIENT_ID"),
    clientSecret: required("SLUICE_OIDC_CLIENT_SECRET"),
    requiredAcr: required("SLUICE_OIDC_REQUIRED_ACR")
  };
}

export function validReturnTo(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function randomToken() {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function discovery(config: OidcConfig): Promise<Discovery> {
  const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
    cache: "no-store"
  });
  if (!response.ok) throw new Error("OIDC discovery failed");
  const value = await response.json() as Partial<Discovery>;
  if (!value.authorization_endpoint?.startsWith("https://") ||
      !value.token_endpoint?.startsWith("https://") || !value.jwks_uri?.startsWith("https://")) {
    throw new Error("OIDC discovery returned insecure endpoints");
  }
  return value as Discovery;
}

export async function authorizationUrl(config: OidcConfig, redirectUri: string, state: string, nonce: string, verifier: string) {
  const metadata = await discovery(config);
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("acr_values", config.requiredAcr);
  return url;
}

export async function verifyCallback(config: OidcConfig, redirectUri: string, code: string, nonce: string, verifier: string) {
  const metadata = await discovery(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: redirectUri,
    client_id: config.clientId, client_secret: config.clientSecret, code_verifier: verifier
  });
  const response = await fetch(metadata.token_endpoint, { method: "POST", body, cache: "no-store" });
  if (!response.ok) throw new Error("OIDC token exchange failed");
  const token = await response.json() as { id_token?: string };
  if (!token.id_token) throw new Error("OIDC response has no ID token");
  const keys = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const { payload } = await jwtVerify(token.id_token, keys, { issuer: config.issuer, audience: config.clientId });
  if (payload.nonce !== nonce || payload.acr !== config.requiredAcr || payload.email_verified !== true || typeof payload.email !== "string") {
    throw new Error("OIDC identity does not satisfy required assurance");
  }
  return { email: payload.email.toLowerCase() };
}
