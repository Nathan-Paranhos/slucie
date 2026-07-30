import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SignJWT } from "jose";
import pg from "pg";

const { Pool } = pg;

const execFile = promisify(execFileCallback);
const dashboardRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(dashboardRoot, "..", "..");
const enabled = process.env.SLUICE_CONNECTED_E2E === "1";
const dashboardUrl = (
  process.env.SLUICE_DASHBOARD_URL ?? "http://127.0.0.1:3000"
).replace(/\/+$/, "");
const ingestUrl = (
  process.env.SLUICE_INGEST_URL ?? "http://127.0.0.1:3001"
).replace(/\/+$/, "");
const e2eEmail =
  process.env.SLUICE_CONNECTED_E2E_EMAIL ?? "admin@sluice.local";

function activeAdminMembership(memberships) {
  if (!Array.isArray(memberships)) return undefined;
  return memberships.find(
    (membership) =>
      membership?.tenant_status === "active" &&
      (membership.role === "owner" || membership.role === "admin") &&
      typeof membership.tenant_id === "string"
  );
}

async function signConnectedSession({ databaseUrl, sessionSecret, email }) {
  if (!databaseUrl || !sessionSecret) {
    throw new Error("connected_test_credentials_are_not_configured");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      `SELECT
         user_id::text,
         email::text,
         display_name,
         status,
         memberships
       FROM sluice.lookup_dashboard_login($1)`,
      [email]
    );
    const user = result.rows[0];
    const membership = activeAdminMembership(user?.memberships);
    if (!user || user.status !== "active" || !membership) {
      throw new Error(
        "connected E2E needs an active owner/admin membership for " + email
      );
    }

    const token = await new SignJWT({
      email: user.email,
      name: user.display_name,
      role: membership.role,
      tenantId: membership.tenant_id
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.user_id)
      .setIssuedAt()
      .setExpirationTime("15m")
      .setIssuer("sluice-dashboard")
      .setAudience("sluice-console")
      .sign(new TextEncoder().encode(sessionSecret));

    return {
      token,
      tenantId: membership.tenant_id,
      role: membership.role
    };
  } finally {
    await pool.end();
  }
}

async function credentialsFromDashboardContainer() {
  // Keep the session secret in the running dashboard container. The only value
  // returned to this test process is a short-lived, HTTP-only session token.
  const script = `
    import { createHmac } from 'node:crypto';
    import pg from 'pg';

    const { Pool } = pg;

    const email = ${JSON.stringify(e2eEmail)};
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const result = await pool.query(
        \`SELECT user_id::text, email::text, display_name, status, memberships
           FROM sluice.lookup_dashboard_login($1)\`,
        [email]
      );
      const user = result.rows[0];
      const membership = Array.isArray(user?.memberships)
        ? user.memberships.find((item) =>
            item?.tenant_status === 'active' &&
            (item.role === 'owner' || item.role === 'admin') &&
            typeof item.tenant_id === 'string'
          )
        : undefined;
      if (!user || user.status !== 'active' || !membership) {
        throw new Error('connected E2E needs an active owner/admin membership for ' + email);
      }
      const issuedAt = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: user.user_id,
        email: user.email,
        name: user.display_name,
        role: membership.role,
        tenantId: membership.tenant_id,
        iat: issuedAt,
        exp: issuedAt + 900,
        iss: 'sluice-dashboard',
        aud: 'sluice-console'
      })).toString('base64url');
      const signed = header + '.' + payload;
      const token = signed + '.' + createHmac('sha256', process.env.SLUICE_SESSION_SECRET)
        .update(signed)
        .digest('base64url');
      process.stdout.write(JSON.stringify({ token, tenantId: membership.tenant_id, role: membership.role }));
    } finally {
      await pool.end();
    }
  `;
  const { stdout } = await execFile(
    "docker",
    [
      "compose",
      "--env-file",
      ".env",
      "-f",
      "docker-compose.yml",
      "-f",
      "infra/compose.apps.yml",
      "-f",
      "infra/compose.dev.yml",
      "exec",
      "-T",
      "dashboard",
      "node",
      "--input-type=module",
      "--eval",
      script
    ],
    {
      cwd: repositoryRoot,
      maxBuffer: 1024 * 1024
    }
  );
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("dashboard container did not return E2E credentials");
  return JSON.parse(line);
}

async function connectedCredentials() {
  const databaseUrl =
    process.env.SLUICE_CONNECTED_E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  const sessionSecret = process.env.SLUICE_SESSION_SECRET;
  if (databaseUrl && sessionSecret) {
    return signConnectedSession({
      databaseUrl,
      sessionSecret,
      email: e2eEmail
    });
  }

  try {
    return await credentialsFromDashboardContainer();
  } catch (error) {
    const detail =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unavailable";
    throw new Error(
      "Unable to obtain connected-test credentials. Run this from the repository " +
        "with the Compose dashboard running, or set SLUICE_CONNECTED_E2E_DATABASE_URL " +
        "and SLUICE_SESSION_SECRET. " +
        `(${detail})`
    );
  }
}

async function json(response) {
  const body = await response.text();
  try {
    return body ? JSON.parse(body) : undefined;
  } catch {
    return body;
  }
}

async function expectStatus(response, status) {
  const body = await json(response);
  assert.equal(
    response.status,
    status,
    `Expected HTTP ${status}, received ${response.status}: ${JSON.stringify(body)}`
  );
  return body;
}

function authHeaders(token, extra = {}) {
  return {
    cookie: `sluice_session=${token}`,
    ...extra
  };
}

async function dashboardRequest(token, path = "/api/dashboard") {
  return fetch(`${dashboardUrl}${path}`, {
    headers: authHeaders(token)
  });
}

async function dashboardAction(token, body, origin = dashboardUrl) {
  return fetch(`${dashboardUrl}/api/actions`, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      origin
    }),
    body: JSON.stringify(body)
  });
}

async function sendWebhook(url, rawBody, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: rawBody
  });
}

function sourceInput(name, provider, secret, extra = {}) {
  return { name, provider, secret, ...extra };
}

test(
  "connected dashboard API: authorization, resource lifecycle, and logical cleanup",
  { skip: !enabled },
  async (t) => {
    const health = await fetch(`${dashboardUrl}/api/health`);
    await expectStatus(health, 200);

    const unauthenticated = await fetch(`${dashboardUrl}/api/dashboard`);
    await expectStatus(unauthenticated, 401);

    const { token, tenantId, role } = await connectedCredentials();
    assert.ok(token.length > 100, "a short-lived connected session was expected");
    assert.ok(["owner", "admin"].includes(role));
    assert.match(tenantId, /^[0-9a-f-]{36}$/i);

    const created = [];
    t.after(async () => {
      // Audit records are deliberately append-only, so physical DELETE would
      // violate the product's retention model. Turning every E2E resource off
      // is the safe cleanup operation and keeps it out of active processing.
      for (const resource of [...created].reverse()) {
        const response = await dashboardAction(token, {
          action: "toggle_resource",
          id: resource.id,
          tenantId,
          resource: resource.resource,
          active: false
        });
        await expectStatus(response, 200);
      }
    });

    const snapshot = await expectStatus(await dashboardRequest(token), 200);
    assert.ok(Array.isArray(snapshot.stats));
    assert.ok(Array.isArray(snapshot.jobs));
    assert.ok(Array.isArray(snapshot.events));
    assert.ok(Array.isArray(snapshot.sources));
    assert.ok(Array.isArray(snapshot.destinations));
    assert.ok(Array.isArray(snapshot.pipelines));
    assert.equal(typeof snapshot.operational?.deadLetters, "number");
    assert.ok(Array.isArray(snapshot.operational?.services));
    assert.equal(snapshot.operational.services.length, 3);
    assert.equal(typeof snapshot.settings?.retention?.rawPayloadDays, "number");
    assert.equal(typeof snapshot.settings?.notifications?.pending, "number");
    assert.equal(typeof snapshot.jobDistribution?.deadLetter, "number");

    for (const path of [
      "/",
      "/events",
      "/jobs",
      "/workers",
      "/dead-letter",
      "/tenants",
      "/metrics",
      "/sources",
      "/destinations",
      "/pipelines",
      "/settings"
    ]) {
      const page = await fetch(`${dashboardUrl}${path}`, {
        headers: authHeaders(token)
      });
      await expectStatus(page, 200);
    }

    await expectStatus(
      await dashboardRequest(token, "/api/dashboard?tenant=not-a-uuid"),
      400
    );
    await expectStatus(
      await dashboardRequest(token, `/api/dashboard?tenant=${randomUUID()}`),
      403
    );
    await expectStatus(
      await dashboardAction(
        token,
        { action: "redrive_job", id: randomUUID(), tenantId },
        "https://attacker.invalid"
      ),
      403
    );
    await expectStatus(
      await dashboardAction(token, {
        action: "create_resource",
        resource: "sources",
        input: {
          name: "E2E invalid source",
          provider: "stripe",
          secret: "too-short"
        }
      }),
      400
    );
    await expectStatus(
      await dashboardAction(token, {
        action: "create_resource",
        resource: "destinations",
        input: {
          name: "E2E invalid destination",
          url: "http://not-https.invalid/hook",
          allowedHost: "not-https.invalid"
        }
      }),
      400
    );

    const suffix = randomUUID().slice(0, 12);
    const sourceName = `E2E source ${suffix}`;
    const sourceSecret = `e2e-secret-${randomUUID()}`;
    const source = await expectStatus(
      await dashboardAction(token, {
        action: "create_resource",
        resource: "sources",
        input: {
          name: sourceName,
          provider: "stripe",
          secret: sourceSecret
        }
      }),
      200
    );
    assert.equal(source.ok, true);
    assert.match(source.id, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(JSON.stringify(source), new RegExp(sourceSecret));
    const webhookUrl = new URL(source.webhookUrl);
    assert.match(webhookUrl.pathname, /^\/v1\/webhooks\/stripe\//);
    created.push({ id: source.id, resource: "sources" });

    const destinationName = `E2E destination ${suffix}`;
    const destination = await expectStatus(
      await dashboardAction(token, {
        action: "create_resource",
        resource: "destinations",
        input: {
          name: destinationName,
          url: `https://e2e-${suffix}.invalid/receive`,
          allowedHost: `e2e-${suffix}.invalid`
        }
      }),
      200
    );
    assert.equal(destination.ok, true);
    assert.match(destination.id, /^[0-9a-f-]{36}$/i);
    created.push({ id: destination.id, resource: "destinations" });

    const pipelineName = `E2E pipeline ${suffix}`;
    const pipeline = await expectStatus(
      await dashboardAction(token, {
        action: "create_resource",
        resource: "pipelines",
        input: {
          name: pipelineName,
          sourceId: source.id,
          destinationId: destination.id
        }
      }),
      200
    );
    assert.equal(pipeline.ok, true);
    assert.match(pipeline.id, /^[0-9a-f-]{36}$/i);
    created.push({ id: pipeline.id, resource: "pipelines" });

    const afterCreate = await expectStatus(await dashboardRequest(token), 200);
    assert.equal(
      afterCreate.sources.find((item) => item.id === source.id)?.name,
      sourceName
    );
    assert.equal(
      afterCreate.sources.find((item) => item.id === source.id)
        ?.reconciliationEnabled,
      false,
      "new sources keep reconciliation disabled until the operator enables it"
    );
    assert.equal(
      afterCreate.destinations.find((item) => item.id === destination.id)?.name,
      destinationName
    );
    assert.equal(
      afterCreate.pipelines.find((item) => item.id === pipeline.id)?.name,
      pipelineName
    );

    await expectStatus(
      await dashboardAction(token, {
        action: "toggle_source_reconciliation",
        id: source.id,
        active: true
      }),
      200
    );
    const afterReconciliationEnable = await expectStatus(
      await dashboardRequest(token),
      200
    );
    assert.equal(
      afterReconciliationEnable.sources.find((item) => item.id === source.id)
        ?.reconciliationEnabled,
      true
    );
    await expectStatus(
      await dashboardAction(token, {
        action: "toggle_source_reconciliation",
        id: source.id,
        active: false
      }),
      200
    );

    for (const resource of [...created].reverse()) {
      await expectStatus(
        await dashboardAction(token, {
          action: "toggle_resource",
          id: resource.id,
          tenantId,
          resource: resource.resource,
          active: false
        }),
        200
      );
    }

    const afterDisable = await expectStatus(await dashboardRequest(token), 200);
    assert.notEqual(
      afterDisable.sources.find((item) => item.id === source.id)?.status,
      "active"
    );
    assert.notEqual(
      afterDisable.destinations.find((item) => item.id === destination.id)?.status,
      "active"
    );
    assert.equal(
      afterDisable.pipelines.find((item) => item.id === pipeline.id)?.status,
      "paused"
    );
  }
);

test(
  "connected ingest: signed webhooks for every supported provider",
  { skip: !enabled },
  async (t) => {
    const { token, tenantId } = await connectedCredentials();
    const suffix = randomUUID().slice(0, 12);
    const createdSourceIds = [];
    t.after(async () => {
      for (const id of createdSourceIds.reverse()) {
        await expectStatus(
          await dashboardAction(token, {
            action: "toggle_resource",
            id,
            tenantId,
            resource: "sources",
            active: false
          }),
          200
        );
      }
    });

    async function createSource(provider, secret, extra = {}) {
      const body = await expectStatus(
        await dashboardAction(token, {
          action: "create_resource",
          resource: "sources",
          input: sourceInput(`E2E ${provider} ${suffix}`, provider, secret, extra)
        }),
        200
      );
      const endpoint = new URL(body.webhookUrl);
      assert.equal(endpoint.port, new URL(ingestUrl).port);
      assert.match(endpoint.pathname, /^\/v1\/webhooks\//);
      createdSourceIds.push(body.id);
      return body;
    }

    const asaasSecret = `asaas-${randomUUID()}`;
    const asaas = await createSource("asaas", asaasSecret);
    const asaasRaw = JSON.stringify({
      id: `asaas-${suffix}`,
      event: "PAYMENT_RECEIVED",
      dateCreated: new Date().toISOString()
    });
    const asaasAccepted = await expectStatus(
      await sendWebhook(asaas.webhookUrl, asaasRaw, {
        "asaas-access-token": asaasSecret
      }),
      200
    );
    assert.equal(asaasAccepted.received, true);
    assert.equal(asaasAccepted.duplicate, false);
    await expectStatus(
      await sendWebhook(asaas.webhookUrl, asaasRaw, {
        "asaas-access-token": "wrong-secret"
      }),
      401
    );
    const asaasDuplicate = await expectStatus(
      await sendWebhook(asaas.webhookUrl, asaasRaw, {
        "asaas-access-token": asaasSecret
      }),
      200
    );
    assert.equal(asaasDuplicate.duplicate, true);
    const asaasConflict = await expectStatus(
      await sendWebhook(
        asaas.webhookUrl,
        JSON.stringify({
          id: `asaas-${suffix}`,
          event: "PAYMENT_REFUNDED",
          dateCreated: new Date().toISOString()
        }),
        { "asaas-access-token": asaasSecret }
      ),
      409
    );
    assert.equal(asaasConflict.quarantined, true);

    const pagbankSecret = `pagbank-${randomUUID()}`;
    const pagbank = await createSource("pagbank", pagbankSecret);
    const pagbankRaw = JSON.stringify({
      id: `pagbank-${suffix}`,
      status: "PAID",
      created_at: new Date().toISOString()
    });
    const pagbankSignature = createHash("sha256")
      .update(pagbankSecret)
      .update("-")
      .update(pagbankRaw)
      .digest("hex");
    const pagbankAccepted = await expectStatus(
      await sendWebhook(pagbank.webhookUrl, pagbankRaw, {
        "x-authenticity-token": pagbankSignature
      }),
      200
    );
    assert.equal(pagbankAccepted.received, true);

    const mercadoSecret = `mercado-${randomUUID()}`;
    const mercado = await createSource("mercado-pago", mercadoSecret);
    const mercadoDataId = `mercado-data-${suffix}`;
    const mercadoTimestamp = Math.floor(Date.now() / 1000);
    const mercadoRequestId = `request-${suffix}`;
    const mercadoRaw = JSON.stringify({
      id: `mercado-${suffix}`,
      type: "payment",
      action: "updated",
      date_created: new Date().toISOString(),
      data: { id: mercadoDataId }
    });
    const mercadoManifest = `id:${mercadoDataId.toLowerCase()};request-id:${mercadoRequestId};ts:${mercadoTimestamp};`;
    const mercadoSignature = createHmac("sha256", mercadoSecret)
      .update(mercadoManifest, "utf8")
      .digest("hex");
    const mercadoAccepted = await expectStatus(
      await sendWebhook(
        `${mercado.webhookUrl}?data.id=${encodeURIComponent(mercadoDataId)}`,
        mercadoRaw,
        {
          "x-request-id": mercadoRequestId,
          "x-signature": `ts=${mercadoTimestamp},v1=${mercadoSignature}`
        }
      ),
      200
    );
    assert.equal(mercadoAccepted.received, true);

    const stripeSecret = `stripe-${randomUUID()}`;
    const stripe = await createSource("stripe", stripeSecret);
    const stripeTimestamp = Math.floor(Date.now() / 1000);
    const stripeRaw = JSON.stringify({
      id: `stripe-${suffix}`,
      object: "event",
      type: "payment_intent.succeeded",
      created: stripeTimestamp,
      data: { object: { id: `pi-${suffix}` } }
    });
    const stripeSignature = createHmac("sha256", stripeSecret)
      .update(`${stripeTimestamp}.${stripeRaw}`)
      .digest("hex");
    const stripeAccepted = await expectStatus(
      await sendWebhook(stripe.webhookUrl, stripeRaw, {
        "stripe-signature": `t=${stripeTimestamp},v1=${stripeSignature}`
      }),
      200
    );
    assert.equal(stripeAccepted.received, true);

    const pixSecret = `pix-${randomUUID()}`;
    const pix = await createSource("pix", pixSecret, {
      signatureHeader: "x-webhook-signature",
      signatureEncoding: "hex",
      signedTemplate: "{raw}",
      eventIdPath: "id",
      eventTypePath: "type"
    });
    const pixRaw = JSON.stringify({
      id: `pix-${suffix}`,
      type: "pix.received",
      createdAt: new Date().toISOString()
    });
    const pixSignature = createHmac("sha256", pixSecret)
      .update(pixRaw)
      .digest("hex");
    const pixAccepted = await expectStatus(
      await sendWebhook(pix.webhookUrl, pixRaw, {
        "x-webhook-signature": pixSignature
      }),
      200
    );
    assert.equal(pixAccepted.received, true);

    const dashboard = await expectStatus(await dashboardRequest(token), 200);
    for (const id of createdSourceIds) {
      assert.ok(
        dashboard.sources.some((source) => source.id === id),
        `dashboard must expose source ${id}`
      );
    }
  }
);
