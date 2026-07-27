import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  isDemoMode,
  SESSION_COOKIE,
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

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ message: "Origem não permitida." }, { status: 403 });
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    return NextResponse.json({ message: "Sessão inválida." }, { status: 401 });
  }
  if (session.role !== "owner" && session.role !== "admin") {
    return NextResponse.json(
      { message: "Permissão de administrador necessária." },
      { status: 403 }
    );
  }

  let body: ActionInput;
  try {
    body = (await request.json()) as ActionInput;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  if (isDemoMode()) {
    await new Promise((resolve) => setTimeout(resolve, 180));
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
                   jsonb_build_object('status', $5))`,
          [tenantId, session.sub, table, body.id, status]
        );
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "create_resource") {
      const resource = body.resource;
      const input = body.input ?? {};
      const name = text(input.name, 100);
      if (name.length < 3) {
        return NextResponse.json(
          { message: "Nome deve conter ao menos 3 caracteres." },
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
        if (secret.length < 16) {
          return NextResponse.json(
            { message: "Segredo deve conter ao menos 16 caracteres." },
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
                signing_secret_envelope, config_envelope, key_version)
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
            [
              sourceId,
              tenantId,
              endpointKey,
              provider,
              name,
              secretEnvelope.bytes,
              configEnvelope.bytes,
              secretEnvelope.keyVersion
            ]
          );
        });
        return NextResponse.json({ ok: true, id: sourceId, endpointKey });
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
        await withTenant(tenantId, session.sub, (client) =>
          client.query(
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
          )
        );
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
