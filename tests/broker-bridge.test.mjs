import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { postToDaemon } from "../scripts/broker/bridge.mjs";
import { isolatedEnv } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_ENTRY = path.resolve(__dirname, "..", "scripts", "ignis-broker.mjs");

function startFake(handler) {
  const seen = { count: 0 };
  const server = http.createServer((req, res) => {
    seen.count += 1;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res, seen, Buffer.concat(chunks).toString("utf8")));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function stopFake(fake) {
  fake.server.closeAllConnections?.();
  return new Promise((resolve) => fake.server.close(resolve));
}

function counter(infos) {
  const state = { calls: 0 };
  const ensure = async () => {
    const info = infos[Math.min(state.calls, infos.length - 1)];
    state.calls += 1;
    return info;
  };
  return { state, ensure };
}

test("a connection destroyed after the request was read is not resent", async () => {
  const fake = await startFake((req) => req.socket.destroy());
  try {
    const { state, ensure } = counter([{ port: fake.port, token: "t" }]);
    await assert.rejects(
      postToDaemon({ ensure, path: "/mcp", body: { id: 1 }, timeoutMs: 5000 })
    );
    assert.equal(fake.seen.count, 1);
    assert.equal(state.calls, 1);
  } finally {
    await stopFake(fake);
  }
});

test("a refused connection is retried once through a fresh ensure", async () => {
  const fake = await startFake((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const dead = await closedPort();
    const { state, ensure } = counter([
      { port: dead, token: "t" },
      { port: fake.port, token: "t" },
    ]);
    const out = await postToDaemon({ ensure, path: "/mcp", body: { id: 1 }, timeoutMs: 5000 });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { ok: true });
    assert.equal(state.calls, 2);
    assert.equal(fake.seen.count, 1);
  } finally {
    await stopFake(fake);
  }
});

test("a 401 is retried once and the second answer is returned", async () => {
  const tokens = [];
  const fake = await startFake((req, res) => {
    tokens.push(req.headers.authorization);
    if (tokens.length === 1) {
      res.writeHead(401);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ second: true }));
  });
  try {
    const { state, ensure } = counter([
      { port: fake.port, token: "old" },
      { port: fake.port, token: "new" },
    ]);
    const out = await postToDaemon({ ensure, path: "/mcp", body: { id: 1 }, timeoutMs: 5000 });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { second: true });
    assert.equal(state.calls, 2);
    assert.deepEqual(tokens, ["Bearer old", "Bearer new"]);
  } finally {
    await stopFake(fake);
  }
});

test("a 500 is not retried", async () => {
  const fake = await startFake((req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const { state, ensure } = counter([{ port: fake.port, token: "t" }]);
    await assert.rejects(
      postToDaemon({ ensure, path: "/mcp", body: { id: 1 }, timeoutMs: 5000 }),
      /HTTP 500: boom/
    );
    assert.equal(state.calls, 1);
    assert.equal(fake.seen.count, 1);
  } finally {
    await stopFake(fake);
  }
});

function setupBroker(t) {
  const iso = isolatedEnv();
  const mockScript = path.join(iso.dirs.root, "mock-slow.mjs");
  fs.writeFileSync(
    mockScript,
    `
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", inputSchema: { type: "object" } }, { name: "fast", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") {
    const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: msg.params.name }], isError: false } });
    if (msg.params.name === "slow") setTimeout(reply, 2500);
    else reply();
  }
});
`
  );
  fs.writeFileSync(
    path.join(iso.dirs.brokerHome, "servers.json"),
    JSON.stringify({
      version: 1,
      defaults: {},
      servers: { demo: { transport: "stdio", command: process.execPath, args: [mockScript] } },
    })
  );
  t.after(() => {
    try {
      spawnSync(process.execPath, [BROKER_ENTRY, "stop"], {
        env: iso.env,
        timeout: 15_000,
        windowsHide: true,
      });
    } finally {
      iso.cleanup();
    }
  });
  return iso;
}

function startBridge(t, env) {
  const bridge = spawn(process.execPath, [BROKER_ENTRY, "mcp-bridge"], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const killTimer = setTimeout(() => bridge.kill(), 50_000);
  t.after(() => {
    clearTimeout(killTimer);
    bridge.kill();
  });
  const lines = [];
  const waiters = [];
  const rl = readline.createInterface({ input: bridge.stdout });
  rl.on("line", (line) => {
    lines.push(JSON.parse(line));
    for (const w of waiters.splice(0)) w();
  });
  const waitFor = async (n) => {
    while (lines.length < n) {
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  const exited = new Promise((resolve) => bridge.on("close", (code) => resolve(code)));
  return { bridge, lines, waitFor, exited };
}

const slowCall = (id) =>
  `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "broker_call", arguments: { server: "demo", tool: "slow", arguments: {} } },
  })}\n`;

test("e2e a ping sent during a slow tools/call is answered first", { timeout: 60_000 }, async (t) => {
  const iso = setupBroker(t);
  const b = startBridge(t, iso.env);
  b.bridge.stdin.write(slowCall(1));
  await new Promise((r) => setTimeout(r, 200));
  b.bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  await b.waitFor(2);
  assert.deepEqual(
    b.lines.map((l) => l.id),
    [2, 1]
  );
  assert.equal(b.lines[1].result.content[0].text, "slow");
  b.bridge.stdin.end();
  await b.exited;
});

test("e2e closing stdin waits for the in-flight reply and exits 0", { timeout: 60_000 }, async (t) => {
  const iso = setupBroker(t);
  const b = startBridge(t, iso.env);
  b.bridge.stdin.write(slowCall(1));
  b.bridge.stdin.end();
  const code = await b.exited;
  assert.equal(code, 0);
  assert.equal(b.lines.length, 1);
  assert.equal(b.lines[0].id, 1);
  assert.equal(b.lines[0].result.content[0].text, "slow");
});
