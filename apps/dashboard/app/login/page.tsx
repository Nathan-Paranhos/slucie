import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Brand } from "@/components/brand";
import {
  isDemoMode,
  isUsableSession,
  SESSION_COOKIE,
  verifySessionToken
} from "@/lib/auth";
import { oidcConfig } from "@/lib/oidc";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Entrar"
};

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const existing = (await cookies()).get(SESSION_COOKIE)?.value;
  if (existing && isUsableSession(await verifySessionToken(existing))) {
    redirect("/");
  }

  const demo = isDemoMode();
  const oidc = Boolean(oidcConfig());
  const resolvedSearchParams = await searchParams;

  return (
    <main className="login-page">
      <section className="login-visual" aria-label="Apresentação do Sluice">
        <Brand />
        <div className="login-copy">
          <p className="eyebrow">Infraestrutura de eventos</p>
          <h1>
            Ingestão segura.
            <br />
            <span className="orange">Fluxo confiável.</span>
          </h1>
          <p>
            Webhooks autenticados, jobs duráveis e isolamento absoluto entre
            tenants. Tudo operado na sua infraestrutura, do primeiro byte ao
            purge LGPD.
          </p>
          <ul className="login-facts">
            <li>
              <span className="fact-dot" /> Apache 2.0
            </li>
            <li>
              <span className="fact-dot" /> PostgreSQL como fonte de verdade
            </li>
            <li>
              <span className="fact-dot" /> LGPD-native
            </li>
          </ul>
        </div>
        <p className="login-footer">
          Sluice é um projeto open source mantido pela Aithos Tech.
        </p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <Brand showTag={false} />
          <h2>Acesse o console</h2>
          <p>
            Monitore eventos, workers, retenção e toda a operação em um só lugar.
          </p>
          <LoginForm
            demo={demo}
            oidc={oidc}
            returnTo={
              resolvedSearchParams.returnTo?.startsWith("/")
                ? resolvedSearchParams.returnTo
                : "/"
            }
          />
        </div>
      </section>
    </main>
  );
}
