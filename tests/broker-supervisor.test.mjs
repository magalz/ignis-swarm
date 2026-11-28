import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { McpHttpAdapter, tryCliFallback } from "../scripts/broker/adapters.mjs";
import { isDaemonVersionAcceptable } from "../scripts/broker/lifecycle.mjs";
import { Supervisor } from "../scripts/broker/supervisor.mjs";
import { trustLocalConfig } from "../scripts/broker/trust.mjs";
import { mkTemp, writeMockStdioServer } from "./helpers.mjs";

const WAIT_MS = 30_000;

// Await `promise` for at most `ms`. The timer is ref'd and cleared on settle, so a stuck
// promise fails the test with a clear error instead of hanging the run.
function within(promise, label, ms = WAIT_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// A temp dir removed by t.after, so it goes away when an assertion fails too.
// A stdio child holds its cwd on Windows, so tests shut the supervisor down in finally first.
function mk(t, prefix) {
  const dir = mkTemp(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }));
  return dir;
}

// Set (or delete, with undefined) an environment variable until the test ends.
function setEnv(t, name, value) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

// Listen on a free loopback port; t.after drops open connections and closes the server.
async function listen(t, handler) {
  const server = http.createServer(handler);
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  await within(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    "the test http server to listen"
  );
  return { server, port: server.address().port };
}

// Stop a supervisor; runs in finally, before the temp dirs it works in are removed.
function stop(sup) {
  return within(sup.shutdown(), "the supervisor to shut down");
}

test("supervisor retries after crash and fails over local to global with metadata", async (t) => {
  const home = mk(t, "ignis-sup-home-");
  const repo = mk(t, "ignis-sup-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });

  const flaky = writeMockStdioServer(home, { label: "global-ok", crashOnFirstCallMarker: path.join(home, "flaky.crashed") });

  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        demo: { transport: "stdio", command: process.execPath, args: [flaky] },
      },
    })
  );

  fs.writeFileSync(
    path.join(repo, ".agents", "ignis-broker.json"),
    JSON.stringify({
      version: 1,
      servers: {
        demo: { transport: "stdio", command: "nonexistent-binary-xyz-999", args: [] },
      },
    })
  );

  trustLocalConfig(home, path.join(repo, ".agents", "ignis-broker.json"));
  const sup = new Supervisor(home, home, 0);
  try {
    const res = await within(sup.call({ server: "demo", tool: "echo", arguments: {}, cwd: repo }), "the failover call");

    assert.equal(res.meta.source, "global");
    assert.equal(res.meta.fallbackFrom, "local");
    assert.ok(res.meta.localError);
    assert.equal(res.meta.retried, true);
    assert.ok(res.content[0].text.startsWith("global-ok:"));

    const st = await within(sup.status({ cwd: repo }), "supervisor status");
    assert.equal(st.recentFallbacks.length, 1);
    assert.equal(st.recentFallbacks[0].from, "local");
    assert.equal(st.recentFallbacks[0].to, "global");
  } finally {
    await stop(sup);
  }
});

test("supervisor isolates per-workspace pool and evicts LRU", async (t) => {
  const home = mk(t, "ignis-pool-home-");
  const repoA = mk(t, "ignis-pool-a-");
  const repoB = mk(t, "ignis-pool-b-");
  fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });

  const script = writeMockStdioServer(home, { label: "ws" });
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      defaults: { maxWorkspaceInstances: 1 },
      servers: {
        scoped: { transport: "stdio", command: process.execPath, args: [script], perWorkspace: true },
      },
    })
  );

  const sup = new Supervisor(home, home, 0);
  try {
    const outA = await within(sup.call({ server: "scoped", tool: "echo", arguments: {}, cwd: repoA }), "the call in workspace A");
    assert.ok(outA.content[0].text.includes(path.basename(repoA)));

    const outB = await within(sup.call({ server: "scoped", tool: "echo", arguments: {}, cwd: repoB }), "the call in workspace B");
    assert.ok(outB.content[0].text.includes(path.basename(repoB)));

    const st = await within(sup.status({}), "supervisor status");
    assert.equal(st.pool.length, 1);

    const listed = await within(sup.list({ server: "scoped", filter: "cho", cwd: repoB }), "the tool list");
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0].summary, "Echo the label and cwd");
  } finally {
    await stop(sup);
  }
});

test("http adapter parses JSON and SSE responses and signals transport error on 404", async (t) => {
  let expireNext = false;
  const { port } = await listen(t, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (expireNext) {
        expireNext = false;
        res.writeHead(404);
        res.end("expired");
        return;
      }
      assert.equal(req.headers["mcp-session-id"], "sess-1");
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] } })}\n\n`
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }], isError: false } }));
    });
  });


  const adapter = await within(
    McpHttpAdapter.connect({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: {},
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    }),
    "the http adapter to connect"
  );

  const tools = await within(adapter.listTools(), "tools/list");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo");

  const out = await within(adapter.callTool("echo", {}), "tools/call");
  assert.equal(out.content[0].text, "ok");

  expireNext = true;
  await assert.rejects(() => within(adapter.callTool("echo", {}), "the expired-session call"), (err) => err.kind === "transport");
  assert.equal(await within(adapter.isAlive(), "isAlive"), false);
});

function writeFakeMemtraceShim(dir) {
  const jsPath = path.join(dir, "fake-memtrace.mjs");
  fs.writeFileSync(
    jsPath,
    `
const args = process.argv.slice(2);
process.stdout.write("memtrace:" + args.join("|"));
`
  );
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, "fake-memtrace.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`);
    return cmdPath;
  }
  const shPath = path.join(dir, "fake-memtrace.sh");
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`);
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

test("supervisor degrades to opt-in memtrace CLI fallback when MCP fails", async (t) => {
  const home = mk(t, "ignis-cli-fb-home-");
  const repo = mk(t, "ignis-cli-fb-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const shim = writeFakeMemtraceShim(home);
  setEnv(t, "IGNIS_MEMTRACE_CMD", shim);

  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        memtrace: {
          transport: "stdio",
          command: "nonexistent-memtrace-mcp-xyz-999",
          args: [],
          cliFallback: "memtrace",
        },
      },
    })
  );

  const sup = new Supervisor(home, home, 0);
  try {
    const res = await within(
      sup.call({
        server: "memtrace",
        tool: "find_symbol",
        arguments: { query: "Supervisor", limit: 5 },
        cwd: repo,
      }),
      "the CLI-fallback call"
    );

    assert.equal(res.isError, false);
    assert.equal(res.meta.source, "cli_fallback");
    assert.equal(res.meta.fallbackFrom, "global");
    assert.ok(res.meta.mcpError);
    assert.equal(res.meta.retried, true);
    assert.equal(res.content[0].text, "memtrace:find|Supervisor|--limit|5");

    const st = await within(sup.status({ cwd: repo }), "supervisor status");
    assert.equal(st.recentFallbacks.length, 1);
    assert.equal(st.recentFallbacks[0].to, "cli_fallback");
  } finally {
    await stop(sup);
  }
});

test("supervisor does not invoke CLI fallback when cliFallback is not configured", async (t) => {
  const home = mk(t, "ignis-no-fb-home-");
  const repo = mk(t, "ignis-no-fb-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const shim = writeFakeMemtraceShim(home);
  setEnv(t, "IGNIS_MEMTRACE_CMD", shim);

  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        memtrace: {
          transport: "stdio",
          command: "nonexistent-memtrace-mcp-xyz-999",
          args: [],
        },
      },
    })
  );

  const sup = new Supervisor(home, home, 0);
  try {
    await assert.rejects(
      () =>
        within(
          sup.call({
            server: "memtrace",
            tool: "find_symbol",
            arguments: { query: "Supervisor" },
            cwd: repo,
          }),
          "the failing call"
        ),
      (err) => err.kind === "startup" || err.kind === "transport"
    );
  } finally {
    await stop(sup);
  }
});

test("unsupported tool returns null from tryCliFallback and propagates MCP error", async (t) => {
  const direct = await within(tryCliFallback("memtrace", "get_evolution", { symbol: "Foo" }, undefined, 5000), "tryCliFallback");
  assert.equal(direct, null);

  const home = mk(t, "ignis-unsup-fb-home-");
  const repo = mk(t, "ignis-unsup-fb-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const shim = writeFakeMemtraceShim(home);
  setEnv(t, "IGNIS_MEMTRACE_CMD", shim);

  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        memtrace: {
          transport: "stdio",
          command: "nonexistent-memtrace-mcp-xyz-999",
          args: [],
          cliFallback: "memtrace",
        },
      },
    })
  );

  const sup = new Supervisor(home, home, 0);
  try {
    await assert.rejects(
      () =>
        within(
          sup.call({
            server: "memtrace",
            tool: "get_evolution",
            arguments: { symbol: "Foo" },
            cwd: repo,
          }),
          "the failing call"
        ),
      (err) => err.kind === "startup" || err.kind === "transport"
    );
  } finally {
    await stop(sup);
  }
});

test("stdio adapter and CLI fallback resolve bare Windows .cmd shims on PATH", { skip: process.platform !== "win32" }, async (t) => {
  const home = mk(t, "ignis-win-cmd-home-");
  const binDir = mk(t, "ignis-win-cmd-bin-");
  const repo = mk(t, "ignis-win-cmd-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const mcpScript = writeMockStdioServer(binDir, { label: "cmd-shim-ok" });
  fs.writeFileSync(path.join(binDir, "bare-mcp"), "#!/bin/sh\necho wrong-posix-shim\n");
  fs.writeFileSync(
    path.join(binDir, "bare-mcp.cmd"),
    `@echo off\r\n"${process.execPath}" "${mcpScript}" %*\r\n`
  );

  const cliScript = path.join(binDir, "bare-cli.mjs");
  fs.writeFileSync(cliScript, 'process.stdout.write("bare-cli:" + process.argv.slice(2).join("|"));\n');
  fs.writeFileSync(path.join(binDir, "bare-memtrace"), "#!/bin/sh\necho wrong-posix-shim\n");
  fs.writeFileSync(
    path.join(binDir, "bare-memtrace.cmd"),
    `@echo off\r\n"${process.execPath}" "${cliScript}" %*\r\n`
  );

  setEnv(t, "PATH", `${binDir}${path.delimiter}${process.env.PATH || ""}`);
  setEnv(t, "IGNIS_MEMTRACE_CMD", "bare-memtrace");

  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        bare: { transport: "stdio", command: "bare-mcp", args: [] },
      },
    })
  );

  const sup = new Supervisor(home, home, 0);
  try {
    const mcpRes = await within(sup.call({ server: "bare", tool: "echo", arguments: {}, cwd: repo }), "the bare .cmd call");
    assert.equal(mcpRes.isError, false);
    assert.ok(mcpRes.content[0].text.startsWith("cmd-shim-ok:"));

    const cliRes = await within(tryCliFallback("memtrace", "find_symbol", { query: "Foo" }, repo, 5000), "the CLI fallback");
    assert.equal(cliRes.isError, false);
    assert.equal(cliRes.content[0].text, "bare-cli:find|Foo");
  } finally {
    await stop(sup);
  }
});

test("isDaemonVersionAcceptable lets older bridges reuse newer same-major daemons while recycling stale ones", () => {
  assert.equal(isDaemonVersionAcceptable("1.1.1", "1.1.1"), true);
  assert.equal(isDaemonVersionAcceptable("1.1.1", "1.0.0"), true);
  assert.equal(isDaemonVersionAcceptable("1.2.0", "1.1.1"), true);
  assert.equal(isDaemonVersionAcceptable("1.0.0", "1.1.1"), false);
  assert.equal(isDaemonVersionAcceptable("1.1.0", "1.1.1"), false);
  assert.equal(isDaemonVersionAcceptable("2.0.0", "1.1.1"), false);
  assert.equal(isDaemonVersionAcceptable(null, "1.1.1"), false);
});

test("tryCliFallback neutralizes quote and metacharacter injection on Windows Node and batch .cmd shims", { skip: process.platform !== "win32" }, async (t) => {
  const dir = mk(t, "ignis-cmd-inject-");
  setEnv(t, "IGNIS_MEMTRACE_CMD", undefined);
  const marker = path.join(dir, "injected.txt");
  const payload = `x" & echo INJECTED_CLI > "${marker}" & "`;

  const cliScript = path.join(dir, "node-cli.mjs");
  fs.writeFileSync(cliScript, 'process.stdout.write("node:" + process.argv.slice(2).join("|"));\n');
  const nodeCmd = path.join(dir, "node-memtrace.cmd");
  fs.writeFileSync(nodeCmd, `@echo off\r\n"${process.execPath}" "${cliScript}" %*\r\n`);

  process.env.IGNIS_MEMTRACE_CMD = nodeCmd;
  const nodeRes = await within(tryCliFallback("memtrace", "find_symbol", { query: payload }, dir, 5000), "the node .cmd fallback");
  assert.equal(nodeRes.isError, false);
  assert.equal(nodeRes.content[0].text, `node:find|${payload}`);
  assert.equal(fs.existsSync(marker), false);

  const batchCmd = path.join(dir, "batch-memtrace.cmd");
  fs.writeFileSync(batchCmd, "@echo off\r\necho batch:%*\r\n");
  process.env.IGNIS_MEMTRACE_CMD = batchCmd;

  await assert.rejects(
    () => within(tryCliFallback("memtrace", "find_symbol", { query: payload }, dir, 5000), "the batch .cmd fallback"),
    (err) => err.kind === "protocol"
  );
  assert.equal(fs.existsSync(marker), false);

  await assert.rejects(
    () => within(tryCliFallback("memtrace", "find_symbol", { query: "abc\r\necho pwned" }, dir, 5000), "the newline fallback"),
    (err) => err.kind === "protocol"
  );
});

test("supervisor deduplicates concurrent cold starts and invalidates pool on servers.json edits", async (t) => {
  const home = mk(t, "ignis-conc-home-");
  const repo = mk(t, "ignis-conc-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });

  const pidLog = path.join(home, "pids.log");
  const scriptV1 = writeMockStdioServer(home, { label: "v1", banner: false, logPidFile: pidLog });
  const scriptV2 = writeMockStdioServer(home, { label: "v2", banner: false, logPidFile: pidLog });

  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        demo: { transport: "stdio", command: process.execPath, args: [scriptV1] },
      },
    })
  );

  const sup = new Supervisor(home, home, 0);
  try {
    const results = await within(
      Promise.all([
        sup.call({ server: "demo", tool: "echo", arguments: {}, cwd: repo }),
        sup.call({ server: "demo", tool: "echo", arguments: {}, cwd: repo }),
        sup.call({ server: "demo", tool: "echo", arguments: {}, cwd: repo }),
      ]),
      "the concurrent cold-start calls"
    );
    for (const r of results) {
      assert.ok(r.content[0].text.startsWith("v1:"), r.content[0].text);
    }
    const spawnedPids = fs.readFileSync(pidLog, "utf8").trim().split(/\r?\n/);
    assert.equal(spawnedPids.length, 1);

    fs.writeFileSync(
      path.join(home, "servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          demo: { transport: "stdio", command: process.execPath, args: [scriptV2] },
        },
      })
    );
    const v2Res = await within(sup.call({ server: "demo", tool: "echo", arguments: {}, cwd: repo }), "the call after the servers.json edit");
    assert.ok(v2Res.content[0].text.startsWith("v2:"), v2Res.content[0].text);

    fs.writeFileSync(path.join(repo, ".agents", "ignis-broker.json"), "{ invalid-local");
    const listRes = await within(sup.list({ cwd: repo }), "the list with a broken local config");
    assert.ok(listRes.localConfigError);
  } finally {
    await stop(sup);
  }
});

test("http adapter parses multi-line SSE frames and rejects notification-only SSE streams", async (t) => {
  let mode = "multiline";
  const { port } = await listen(t, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-sse" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "multiline") {
        const pretty = JSON.stringify(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: "multi-ok" }], isError: false },
          },
          null,
          2
        );
        const lines = pretty.split("\n").map((l) => `data: ${l}`).join("\n");
        res.end(`event: message\n${lines}\n\n`);
        return;
      }
      res.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`
      );
    });
  });

  const adapter = await within(
    McpHttpAdapter.connect({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: {},
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    }),
    "the http adapter to connect"
  );
  const okRes = await within(adapter.callTool("echo", {}), "the multi-line SSE call");
  assert.equal(okRes.content[0].text, "multi-ok");

  mode = "notif-only";
  await assert.rejects(
    () => within(adapter.callTool("echo", {}), "the notification-only SSE call"),
    (err) => err.kind === "protocol"
  );
});

test("supervisor sends a local http entry's ${VAR} headers and url literally, never the dotenv secret", async (t) => {
  const home = mk(t, "ignis-lit-home-");
  const repo = mk(t, "ignis-lit-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  const secret = ["sec", "ret", String(process.pid)].join("-");
  fs.writeFileSync(path.join(home, ".env"), `SECRET_X=${secret}\n`);
  fs.writeFileSync(path.join(home, "servers.json"), JSON.stringify({ version: 1, servers: {} }));

  const seen = [];
  const { port } = await listen(t, (req, res) => {
    seen.push({ auth: req.headers.authorization, url: req.url });
    res.writeHead(500);
    res.end("boom");
  });
  fs.writeFileSync(
    path.join(repo, ".agents", "ignis-broker.json"),
    JSON.stringify({
      version: 1,
      servers: {
        sink: {
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp?k=\${SECRET_X}`,
          headers: { Authorization: "Bearer ${SECRET_X}" },
          startupTimeoutMs: 3000,
          requestTimeoutMs: 3000,
        },
      },
    })
  );
  trustLocalConfig(home, path.join(repo, ".agents", "ignis-broker.json"));

  const sup = new Supervisor(home, home, 0);
  try {
    await assert.rejects(() => within(sup.call({ server: "sink", tool: "x", arguments: {}, cwd: repo }), "the call to the failing sink"));
  } finally {
    await stop(sup);
  }

  assert.ok(seen.length > 0);
  for (const hit of seen) {
    assert.equal(hit.auth, "Bearer ${SECRET_X}");
    assert.ok(!String(hit.auth).includes(secret));
    assert.ok(!hit.url.includes(secret));
  }
});
