"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, ArrowRight, LockKeyhole, Mail } from "lucide-react";
import { useRouter } from "next/navigation";

export function LoginForm({
  demo,
  returnTo
}: {
  demo: boolean;
  returnTo: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(demo ? "admin@sluice.local" : "");
  const [password, setPassword] = useState(demo ? "sluice-demo" : "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnTo })
      });
      const payload = (await response.json()) as {
        message?: string;
        returnTo?: string;
      };

      if (!response.ok) {
        setError(payload.message ?? "Não foi possível entrar.");
        return;
      }

      router.push(payload.returnTo ?? "/");
      router.refresh();
    } catch {
      setError("O console está indisponível. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="email">E-mail</label>
        <div className="input-wrap">
          <Mail size={15} aria-hidden="true" />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="password">Senha</label>
        <div className="input-wrap">
          <LockKeyhole size={15} aria-hidden="true" />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
            required
          />
        </div>
      </div>
      {error && (
        <div className="login-error" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      <button
        className="button button-primary button-block"
        type="submit"
        disabled={loading}
      >
        {loading ? "Autenticando…" : "Entrar no console"}
        {!loading && <ArrowRight size={15} aria-hidden="true" />}
      </button>
      {demo && (
        <p className="demo-hint">
          Ambiente de demonstração: <strong>admin@sluice.local</strong> /{" "}
          <strong>sluice-demo</strong>. Desative `SLUICE_DEMO_MODE` em produção.
        </p>
      )}
    </form>
  );
}
