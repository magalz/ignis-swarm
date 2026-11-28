// Daemon coverage: bearer auth on every route, the request body cap, describe/restart/status
// over the HTTP API, and a real hard kill of the daemon followed by a CLI call.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPidAlive } from "../scripts/broker/lifecycle.mjs";
import { isolatedEnv, waitUntil } from "./helpers.mjs";

const BROKER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ignis-broker.mjs");
const CLI_TIMEOUT_MS = 60_000;
const BODY_CAP_BYTES = 16 * 1024 * 1024;

function writeCountingMock(dir) {
  const script = path.join(dir, "mock-counting.mjs");
  const callLog = path.join(dir, "calls.log");
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  else if (msg.method === "tools/list") send({ id: msg.id, result: { tools: [{ name: "echo", description: "Echo back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else if (msg.method === "tools/call") {
    fs.appendFileSync(${JSON.stringify(callLog)}, process.pid + "\\n");
    send({ id: msg.id, result: { content: [{ type: "text", text: "echo-ok" }], isError: false } });
  }
});
`
  );
  return { script, callLog };
}

// Isolated env plus a servers.json with one stdio server, "demo", running the counting mock.
function setup(t) {
  const iso = isolatedEnv();
  const mock = writeCountingMock(iso.dirs.root);
  fs.writeFileSync(
    path.join(iso.dirs.brokerHome, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: { demo: { transport: "stdio", command: process.execPath, args: [mock.script], perWorkspace: true, requestTimeoutMs: 10_000 } },
    })
  );
  t.after(() => iso.cleanup());
  const cli = (...args) =>
    spawnSync(process.execPath, [BROKER_ENTRY, ...args], { encoding: "utf8", env: iso.env, cwd: iso.dirs.root, timeout: CLI_TIMEOUT_MS, windowsHide: true });
  const readInfo = () => JSON.parse(fs.readFileSync(path.join(iso.dirs.brokerData, "daemon.json"), "utf8"));
  const callCount = () => (fs.existsSync(mock.callLog) ? fs.readFileSync(mock.callLog, "utf8").split("\n").filter(Boolean).length : 0);
  return { iso, cli, readInfo, callCount };
}

function startDaemon({ cli, readInfo }) {
  const res = cli("status", "--json");
  assert.equal(res.status, 0, res.stderr);
  return readInfo();
}

function api(info, method, route, { token = info.token, body } = {}) {
  return fetch(`http://127.0.0.1:${info.port}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

const ROUTES = [
  ["GET", "/health", undefined],
  ["POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }],
  ["POST", "/v1/list", {}],
  ["POST", "/v1/describe", { server: "demo", tool: "echo" }],
  ["POST", "/v1/call", { server: "demo", tool: "echo", arguments: {} }],
  ["POST", "/v1/status", {}],
  ["POST", "/v1/restart", {}],
];

test("every daemon route answers 401 without a token or with a wrong one, and 200 with the right one", { timeout: 120_000 }, async (t) => {
  const ctx = setup(t);
  const info = startDaemon(ctx);

  for (const [method, route, body] of [...ROUTES, ["POST", "/admin/shutdown", {}], ["GET", "/nope", undefined]]) {
    for (const [label, token] of [["no token", null], ["wrong token", `${info.token}x`], ["empty token", ""]]) {
      const res = await api(info, method, route, { token, body });
      assert.equal(res.status, 401, `${method} ${route} with ${label}`);
      await res.text();
    }
    const basic = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method,
      headers: { Authorization: `Basic ${info.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(basic.status, 401, `${method} ${route} with the token under another scheme`);
    await basic.text();
  }
  assert.equal(isPidAlive(info.pid), true, "401 on /admin/shutdown did not stop the daemon");

  for (const [method, route, body] of ROUTES) {
    const res = await api(info, method, route, { body });
    assert.equal(res.status, 200, `${method} ${route} with the right token`);
    await res.text();
  }
  const unknown = await api(info, "GET", "/nope");
  assert.equal(unknown.status, 404, "an authorized unknown route is a 404");
  await unknown.text();
});

test("a request body over the cap is refused and the daemon keeps serving", { timeout: 120_000 }, async (t) => {
  const ctx = setup(t);
  const info = startDaemon(ctx);

  // Raw http request so the outcome is the server's answer, not fetch's handling of a reset.
  const outcome = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: info.port, method: "POST", path: "/v1/status", headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json", Connection: "close" } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
        res.on("error", (err) => resolve({ error: err }));
      }
    );
    req.on("error", (err) => resolve({ error: err }));
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent <= BODY_CAP_BYTES + chunk.length) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once("drain", pump);
      }
      req.end();
    };
    pump();
  });
  // The daemon answers 400 and may drop the socket while the client is still writing, so a
  // client-side reset is also a refusal; either way the body was not accepted.
  if (!outcome.error) {
    assert.equal(outcome.status, 400, "oversized body is a protocol error (400)");
    assert.match(outcome.text, /exceeds/);
  }

  assert.equal(isPidAlive(info.pid), true, "daemon survived the oversized body");
  const next = await api(info, "POST", "/v1/status", { body: {} });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).pid, info.pid, "the same daemon answers the next request");
});

test("describe, call, status and restart work over the HTTP API against a mock stdio server", { timeout: 120_000 }, async (t) => {
  const ctx = setup(t);
  const info = startDaemon(ctx);
  const cwd = fs.realpathSync.native(ctx.iso.dirs.root);
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });

  const describe = await api(info, "POST", "/v1/describe", { body: { server: "demo", tool: "echo", cwd } });
  assert.equal(describe.status, 200);
  const described = await describe.json();
  assert.equal(described.schema.name, "echo");
  assert.equal(described.schema.inputSchema.properties.text.type, "string");

  for (const [body, label] of [[{ server: "demo", tool: "missing", cwd }, "unknown tool"], [{ server: "nope", tool: "echo", cwd }, "unknown server"]]) {
    const res = await api(info, "POST", "/v1/describe", { body });
    assert.equal(res.status, 404, label);
    await res.text();
  }

  const call = await api(info, "POST", "/v1/call", { body: { server: "demo", tool: "echo", arguments: {}, cwd } });
  assert.equal((await call.json()).content[0].text, "echo-ok");
  assert.equal(ctx.callCount(), 1);

  const status = await (await api(info, "POST", "/v1/status", { body: { cwd } })).json();
  assert.equal(status.pid, info.pid);
  assert.equal(status.servers.find((s) => s.name === "demo")?.name, "demo");
  assert.ok(status.pool.length >= 1, "the call left a pooled backend");

  const restart = await api(info, "POST", "/v1/restart", { body: { server: "demo" } });
  assert.equal(restart.status, 200);
  assert.equal((await restart.json()).evicted, status.pool.length);
  const after = await (await api(info, "POST", "/v1/status", { body: { cwd } })).json();
  assert.equal(after.pool.length, 0, "restart emptied the pool");

  const again = await api(info, "POST", "/v1/call", { body: { server: "demo", tool: "echo", arguments: {}, cwd } });
  assert.equal((await again.json()).content[0].text, "echo-ok", "the next call reconnects");
  assert.equal(ctx.callCount(), 2);
});

test("a daemon killed hard is replaced on the next CLI call, which succeeds exactly once", { timeout: 150_000 }, async (t) => {
  const ctx = setup(t);
  const first = ctx.cli("call", "demo", "echo");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /echo-ok/);
  const oldInfo = ctx.readInfo();
  assert.equal(isPidAlive(oldInfo.pid), true);
  assert.equal(ctx.callCount(), 1);

  if (process.platform === "win32") {
    const killed = spawnSync("taskkill", ["/PID", String(oldInfo.pid), "/F"], { timeout: 20_000, windowsHide: true });
    assert.equal(killed.status, 0, String(killed.stderr));
  } else {
    process.kill(oldInfo.pid, "SIGKILL");
  }
  await waitUntil("the killed daemon to exit", () => !isPidAlive(oldInfo.pid));

  const second = ctx.cli("call", "demo", "echo");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /echo-ok/);
  const newInfo = ctx.readInfo();
  assert.notEqual(newInfo.pid, oldInfo.pid, "a new daemon answered");
  assert.equal(isPidAlive(newInfo.pid), true);
  assert.equal(ctx.callCount(), 2, "the second CLI call reached the backend exactly once");
});
