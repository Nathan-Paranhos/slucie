import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  createSessionToken,
  isDemoMode,
  isSecureSessionCookie,
  isUsableSession,
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
  type SessionClaims,
  verifySessionToken
} from "@/lib/auth";
import { hasDatabase, withTenant } from "@/lib/db";
import { sealEnvelope } from "@/lib/envelope";
import { isSameOrigin } from "@/lib/request-security";

type ActionInput = {
  action?: string;
  id?: string;
  tenantId?: string;
  resource?: string;
  active?: boolean;
  input?: Record<string, unknown>;
};

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function text(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function resourceName(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length >= 3 && normalized.length <= 100
    ? normalized
    : "";
}

async function profileResponse(
  session: SessionClaims,
  name: string,
  demo = false
) {
  const token = await createSessionToken({
    sub: session.sub,
    email: session.email,
    name,
    role: session.role,
    tenantId: session.tenantId
  });
  const response = NextResponse.json({ ok: true, ...(demo ? { demo: true } : {}) });
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

function publicWebhookUrl(
  request: Request,
  provider: string,
  endpointKey: string
) {
  const configured = process.env.SLUICE_INGEST_PUBLIC_URL?.trim();
  let base = configured?.replace(/\/+$/, "");

  if (!base) {
    let requestUrl = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        // Actions are same-origin protected before this helper is called. On a
        // reverse proxy, `request.url` can contain the internal container host;
        // the browser origin is the correct public host for the generated URL.
        requestUrl = new URL(origin);
      } catch {
        // Keep the request URL when a malformed Origin reaches this helper.
      }
    }
    const localHost =
      requestUrl.hostname === "localhost" ||
      requestUrl.hostname === "127.0.0.1" ||
      requestUrl.hostname === "::1";
    base = localHost
      ? `${requestUrl.protocol}//${requestUrl.hostname}:3001`
      : requestUrl.origin;
  }

  const routeProvider = provider === "mercado_pago" ? "mercado-pago" : provider;
  return `${base}/v1/webhooks/${routeProvider}/${endpointKey}`;
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ message: "Origem não permitida." }, { status: 403 });
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!isUsableSession(session)) {
    return NextResponse.json({ message: "Sessão inválida." }, { status: 401 });
  }

  let body: ActionInput;
  try {
    body = (await request.json()) as ActionInput;
  } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const profileName =
    body.action === "update_profile" ? text(body.input?.name, 100) : undefined;
  if (body.action === "update_profile" && !profileName) {
    return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
  }

  if (
    body.action !== "update_profile" &&
    session.role !== "owner" &&
    session.role !== "admin"
  ) {
    return NextResponse.json(
      { message: "Permissão de administrador necessária." },
      { status: 403 }
    );
  }

  if (isDemoMode()) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (profileName) return profileResponse(session, profileName, true);
    return NextResponse.json({
      ok: true,
      demo: true,
      message: "Ação simulada no modo de demonstração."
    });
  }

  if (!hasDatabase()) {
    return NextResponse.json(
      { message: "PostgreSQL não configurado." },
      { status: 503 }
    );
  }

  const tenantId = session.tenantId;
  if (!validUuid(tenantId)) {
    return NextResponse.json(
      { message: "Selecione um tenant válido." },
      { status: 400 }
    );
  }

  try {
    if (profileName) {
      const name = await withTenant(tenantId, session.sub, async (client) => {
        const result = await client.query<{ display_name: string }>(
          `SELECT sluice.update_current_dashboard_profile($1) AS display_name`,
          [profileName]
        );
        const displayName = result.rows[0]?.display_name;
        if (!displayName) throw new Error("profile_update_failed");
        await client.query(
          `INSERT INTO sluice.audit_log
             (tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'user', $2, 'user.profile_updated', 'user', $2,
                   jsonb_build_object('display_name_changed', true))`,
          [tenantId, session.sub]
        );
        return displayName;
      });
      return profileResponse(session, name);
    }

    if (body.action === "redrive_job") {
      if (!validUuid(body.id) || body.tenantId !== tenantId) {
        return NextResponse.json({ message: "Job inválido." }, { status: 400 });
      }
      const created = await withTenant(tenantId, session.sub, async (client) => {
        const result = await client.query<{ job_id: string }>(
          `SELECT sluice.admin_redrive_dead_letter($1, $2, $3)::text job_id`,
          [tenantId, body.id, "Redrive solicitado pelo dashboard"]
        );
        return result.rows[0]?.job_id;
      });
      return NextResponse.json({ ok: true, id: created });
    }

    if (body.action === "toggle_resource") {
      if (
        !validUuid(body.id) ||
        !["sources", "destinations", "pipelines"].includes(body.resource ?? "")
      ) {
        return NextResponse.json({ message: "Recurso inválido." }, { status: 400 });
      }
      const table =
        body.resource === "sources"
          ? "webhook_sources"
          : body.resource === "destinations"
            ? "destinations"
            : "pipelines";
      const status = body.active
        ? "active"
        : body.resource === "pipelines"
          ? "paused"
          : "disabled";

      await withTenant(tenantId, session.sub, async (client) => {
        const result = await client.query(
          `UPDATE sluice.${table}
              SET status = $1, updated_at = clock_timestamp()
            WHERE tenant_id = $2 AND id = $3`,
          [status, tenantId, body.id]
        );
        if (result.rowCount !== 1) throw new Error("resource_not_found");
        await client.query(
          `INSERT INTO sluice.audit_log
             (tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'user', $2, 'resource.status_changed', $3, $4,
                   jsonb_build_object('status', $5::text))`,
          [tenantId, session.sub, table, body.id, status]
        );
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "toggle_source_reconciliation") {
      if (!validUuid(body.id)) {
        return NextResponse.json({ message: "Fonte inválida." }, { status: 400 });
      }
      const enabled = body.active === true;
      await withTenant(tenantId, session.sub, async (client) => {
        const result = await client.query(
          `UPDATE sluice.webhook_sources
              SET reconciliation_enabled = $1, updated_at = clock_timestamp()
            WHERE tenant_id = $2 AND id = $3`,
          [enabled, tenantId, body.id]
        );
        if (result.rowCount !== 1) throw new Error("source_not_found");
        await client.query(
          `INSERT INTO sluice.audit_log
             (tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'user', $2, 'webhook_source.reconciliation_changed',
                   'webhook_source', $3,
                   jsonb_build_object('enabled', $4::boolean))`,
          [tenantId, session.sub, body.id, enabled]
        );
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "create_resource") {
      const resource = body.resource;
      const input = body.input ?? {};
      const name = resourceName(input.name);
      if (!name) {
        return NextResponse.json(
          { message: "O nome deve conter entre 3 e 100 caracteres." },
          { status: 400 }
        );
      }

      if (resource === "tenants") {
        const slug = text(input.slug, 80).toLowerCase();
        const retention = Number(input.retentionDays ?? 90);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
          return NextResponse.json({ message: "Slug inválido." }, { status: 400 });
        }
        const result = await withTenant(tenantId, session.sub, (client) =>
          client.query<{ tenant_id: string }>(
            `SELECT sluice.admin_create_tenant($1, $2, $3)::text tenant_id`,
            [slug, name, retention]
          )
        );
        return NextResponse.json({ ok: true, id: result.rows[0]?.tenant_id });
      }

      if (resource === "sources") {
        const providerInput = text(input.provider, 30);
        const provider =
          providerInput === "mercado-pago" ? "mercado_pago" : providerInput;
        if (
          !["asaas", "pagbank", "mercado_pago", "stripe", "pix"].includes(provider)
        ) {
          return NextResponse.json({ message: "Provedor inválido." }, { status: 400 });
        }
        const secret = text(input.secret, 2048);
        const reconciliationEnabled =
          input.reconciliationEnabled === true ||
          input.reconciliationEnabled === "true";
        if (Buffer.byteLength(secret, "utf8") < 16) {
          return NextResponse.json(
            { message: "O segredo deve conter pelo menos 16 bytes UTF-8." },
            { status: 400 }
          );
        }
        const sourceId = randomUUID();
        const endpointKey = randomUUID();
        const pixJsonPath = (value: unknown, fallback?: string) => {
          const candidate = text(value, 120) || fallback || "";
          return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(candidate)
            ? candidate
            : "";
        };
        const pixEventIdPath = pixJsonPath(input.eventIdPath, "id");
        const pixEventTypePath = pixJsonPath(input.eventTypePath, "type");
        const pixOccurredAtPath = pixJsonPath(input.occurredAtPath);
        const pixTimestampHeader = text(input.timestampHeader, 100).toLowerCase();
        const pixSignedTemplate = text(input.signedTemplate, 256) || "{raw}";
        const pixSignatureEncoding =
          input.signatureEncoding === "base64" ? "base64" : "hex";
        if (
          provider === "pix" &&
          (!pixEventIdPath ||
            !pixEventTypePath ||
            !pixSignedTemplate.includes("{raw}") ||
            (pixSignedTemplate.includes("{timestamp}") && !pixTimestampHeader))
        ) {
          return NextResponse.json(
            { message: "Configuração Pix inválida." },
            { status: 400 }
          );
        }
        const secretContext = `webhook-source-secret:${tenantId}:${sourceId}`;
        const configContext = `webhook-source-config:${tenantId}:${sourceId}`;
        const secretEnvelope = sealEnvelope(Buffer.from(secret, "utf8"), secretContext);
        const configEnvelope = sealEnvelope(
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              signatureToleranceSeconds: 300,
              job: { type: "deliver_event", priority: 100, maxAttempts: 8 },
              provider:
                provider === "pix"
                  ? {
                      algorithm: "hmac-sha256",
                      signatureHeader:
                        text(input.signatureHeader, 100).toLowerCase() ||
                        "x-webhook-signature",
                      timestampHeader: pixTimestampHeader || undefined,
                      signatureEncoding: pixSignatureEncoding,
                      signaturePrefix: text(input.signaturePrefix, 64),
                      signedTemplate: pixSignedTemplate,
                      eventIdPath: pixEventIdPath,
                      eventTypePath: pixEventTypePath,
                      occurredAtPath: pixOccurredAtPath || undefined
                    }
                  : undefined
            }),
            "utf8"
          ),
          configContext,
          secretEnvelope.keyVersion
        );
        await withTenant(tenantId, session.sub, async (client) => {
          await client.query(
            `INSERT INTO sluice.webhook_sources
               (id, tenant_id, endpoint_key, provider, name, status,
                signing_secret_envelope, config_envelope, key_version,
                reconciliation_enabled)
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)`,
            [
              sourceId,
              tenantId,
              endpointKey,
              provider,
              name,
              secretEnvelope.bytes,
              configEnvelope.bytes,
              secretEnvelope.keyVersion,
              reconciliationEnabled
            ]
          );
          await client.query(
            `INSERT INTO sluice.audit_log
               (tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             VALUES ($1, 'user', $2, 'webhook_source.created', 'webhook_source', $3,
                     jsonb_build_object(
                       'provider', $4::text,
                       'name', $5::text,
                       'reconciliation_enabled', $6::boolean
                     ))`,
            [tenantId, session.sub, sourceId, provider, name, reconciliationEnabled]
          );
        });
        return NextResponse.json({
          ok: true,
          id: sourceId,
          endpointKey,
          webhookUrl: publicWebhookUrl(request, provider, endpointKey)
        });
      }

      if (resource === "destinations") {
        const rawUrl = text(input.url, 2048);
        const allowedHost = text(input.allowedHost, 253).toLowerCase();
        let url: URL;
        try {
          url = new URL(rawUrl);
        } catch {
          return NextResponse.json({ message: "URL inválida." }, { status: 400 });
        }
        if (url.protocol !== "https:" || url.hostname.toLowerCase() !== allowedHost) {
          return NextResponse.json(
            { message: "O destino deve usar HTTPS e corresponder ao host permitido." },
            { status: 400 }
          );
        }
        const destinationId = randomUUID();
        const envelope = sealEnvelope(
          Buffer.from(
            JSON.stringify({ url: url.toString(), method: "POST", headers: {} }),
            "utf8"
          ),
          `destination-config:${tenantId}:${destinationId}`
        );
        await withTenant(tenantId, session.sub, async (client) => {
          await client.query(
            `INSERT INTO sluice.destinations
               (id, tenant_id, name, kind, status, config_envelope,
                key_version, allowed_hosts)
             VALUES ($1, $2, $3, 'webhook', 'active', $4, $5, ARRAY[$6]::text[])`,
            [
              destinationId,
              tenantId,
              name,
              envelope.bytes,
              envelope.keyVersion,
              allowedHost
            ]
          );
          await client.query(
            `INSERT INTO sluice.audit_log
               (tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             VALUES ($1, 'user', $2, 'destination.created', 'destination', $3,
                     jsonb_build_object('host', $4::text, 'name', $5::text))`,
            [tenantId, session.sub, destinationId, allowedHost, name]
          );
        });
        return NextResponse.json({ ok: true, id: destinationId });
      }

      if (resource === "pipelines") {
        if (!validUuid(input.sourceId) || !validUuid(input.destinationId)) {
          return NextResponse.json(
            { message: "Fonte ou destino inválido." },
            { status: 400 }
          );
        }
        const pipelineId = randomUUID();
        await withTenant(tenantId, session.sub, async (client) => {
          await client.query(
            `INSERT INTO sluice.pipelines
               (id, tenant_id, source_id, name, status)
             VALUES ($1, $2, $3, $4, 'active')`,
            [pipelineId, tenantId, input.sourceId, name]
          );
          await client.query(
            `INSERT INTO sluice.pipeline_destinations
               (tenant_id, pipeline_id, destination_id, position)
             VALUES ($1, $2, $3, 0)`,
            [tenantId, pipelineId, input.destinationId]
          );
          await client.query(
            `INSERT INTO sluice.audit_log
               (tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             VALUES ($1, 'user', $2, 'pipeline.created', 'pipeline', $3,
                     jsonb_build_object(
                       'source_id', $4::uuid,
                       'destination_id', $5::uuid,
                       'name', $6::text
                     ))`,
            [tenantId, session.sub, pipelineId, input.sourceId, input.destinationId, name]
          );
        });
        return NextResponse.json({ ok: true, id: pipelineId });
      }
    }

    return NextResponse.json({ message: "Ação desconhecida." }, { status: 400 });
  } catch (error) {
    console.error("dashboard_action_failed", {
      action: body.action,
      message: error instanceof Error ? error.message : "unknown"
    });
    return NextResponse.json(
      { message: "A operação foi recusada ou não pôde ser concluída." },
      { status: 409 }
    );
  }
}
