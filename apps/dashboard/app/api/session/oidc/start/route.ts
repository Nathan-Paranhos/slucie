import { NextResponse } from "next/server";
import { authorizationUrl, oidcConfig, randomToken, validReturnTo } from "@/lib/oidc";

const FLOW_COOKIE = "sluice_oidc_flow";

export async function GET(request: Request) {
  const config = oidcConfig();
  if (!config) return NextResponse.json({ error: "oidc_not_configured" }, { status: 404 });
  const url = new URL(request.url);
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const callback = new URL("/api/session/oidc/callback", url.origin).toString();
  const destination = await authorizationUrl(config, callback, state, nonce, verifier);
  const response = NextResponse.redirect(destination);
  response.cookies.set(FLOW_COOKIE, JSON.stringify({ state, nonce, verifier, returnTo: validReturnTo(url.searchParams.get("returnTo")) }), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/api/session/oidc", maxAge: 600
  });
  return response;
}
