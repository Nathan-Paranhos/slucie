import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dashboardRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitUntilReady(baseUrl, process, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Dashboard exited before readiness.\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Dashboard readiness timed out.\n${output.join("")}`);
}

test("demo login, protected console, and mutations work end to end", async (t) => {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const server = spawn(
    process.execPath,
    [path.join(dashboardRoot, ".next", "standalone", "server.js")],
    {
      cwd: dashboardRoot,
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        NODE_ENV: "production",
        SLUICE_DEMO_MODE: "true",
        SLUICE_DEMO_EMAIL: "admin@sluice.local",
        SLUICE_DEMO_PASSWORD: "sluice-demo",
        SLUICE_COOKIE_SECURE: "false",
        SLUICE_SESSION_SECRET:
          "dashboard-integration-test-session-secret-32-chars"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  server.stdout.on("data", (chunk) => output.push(chunk.toString()));
  server.stderr.on("data", (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([
        once(server, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    }
  });

  await waitUntilReady(baseUrl, server, output);

  const denied = await fetch(`${baseUrl}/api/dashboard`, {
    redirect: "manual"
  });
  assert.equal(denied.status, 401);

  const invalid = await fetch(`${baseUrl}/api/session/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl
    },
    body: JSON.stringify({
      email: "admin@sluice.local",
      password: "wrong-password"
    })
  });
  assert.equal(invalid.status, 401);

  const login = await fetch(`${baseUrl}/api/session/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl
    },
    body: JSON.stringify({
      email: "admin@sluice.local",
      password: "sluice-demo"
    })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie?.includes("sluice_session="));
  assert.ok(setCookie?.includes("HttpOnly"));
  assert.ok(setCookie?.includes("SameSite=lax"));
  assert.ok(!setCookie?.includes("Secure"));
  const cookie = setCookie.split(";", 1)[0];

  const dashboard = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { cookie }
  });
  assert.equal(dashboard.status, 200);
  const snapshot = await dashboard.json();
  assert.ok(Array.isArray(snapshot.stats));
  assert.ok(snapshot.stats.length >= 4);
  assert.ok(Array.isArray(snapshot.jobs));
  assert.ok(Array.isArray(snapshot.events));

  const consolePage = await fetch(`${baseUrl}/jobs`, {
    headers: { cookie }
  });
  assert.equal(consolePage.status, 200);
  assert.match(await consolePage.text(), /Sluice/);

  const crossOriginAction = await fetch(`${baseUrl}/api/actions`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://attacker.invalid"
    },
    body: JSON.stringify({ action: "redrive_job" })
  });
  assert.equal(crossOriginAction.status, 403);

  const action = await fetch(`${baseUrl}/api/actions`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: baseUrl
    },
    body: JSON.stringify({
      action: "redrive_job",
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "all"
    })
  });
  const actionBody = await action.json();
  assert.equal(
    action.status,
    200,
    `Unexpected mutation response: ${JSON.stringify(actionBody)}`
  );
  assert.deepEqual(actionBody, {
    ok: true,
    demo: true,
    message: "Ação simulada no modo de demonstração."
  });

  const logout = await fetch(`${baseUrl}/api/session/logout`, {
    method: "POST",
    headers: { cookie, origin: baseUrl }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
});
