import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpHttpAdapter, tryCliFallback } from "../scripts/broker/adapters.mjs";
import { isDaemonVersionAcceptable } from "../scripts/broker/lifecycle.mjs";
import { Supervisor } from "../scripts/broker/supervisor.mjs";

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMockStdioServer(dir, name, label, crashFirst) {
  const script = path.join(dir, `${name}.mjs`);
  const marker = path.join(dir, `${name}.crashed`);
  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
import readline from "node:readline";
process.stdout.write("non-json startup banner\\n");
const marker = ${JSON.stringify(marker)};
const crashFirst = ${crashFirst ? "true" : "false"};
const label = ${JSON.stringify(label)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Ping tool. Extra detail.", inputSchema: { type: "object" } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    if (crashFirst && !fs.existsSync(marker)) {
      fs.writeFileSync(marker, "1");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: label + ":" + process.cwd() }], isError: false } }) + "\\n");
  }
});
`
  );
  return script;
}

test("supervisor retries after crash and fails over local to global with metadata", async () => {
  const home = mkTemp("ignis-sup-home-");
  const repo = mkTemp("ignis-sup-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });

  const flaky = writeMockStdioServer(home, "flaky", "global-ok", true);

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

  const sup = new Supervisor(home, home, 0);
  const res = await sup.call({ server: "demo", tool: "ping", arguments: {}, cwd: repo });

  assert.equal(res.meta.source, "global");
  assert.equal(res.meta.fallbackFrom, "local");
  assert.ok(res.meta.localError);
  assert.equal(res.meta.retried, true);
  assert.ok(res.content[0].text.startsWith("global-ok:"));

  const st = await sup.status({ cwd: repo });
  assert.equal(st.recentFallbacks.length, 1);
  assert.equal(st.recentFallbacks[0].from, "local");
  assert.equal(st.recentFallbacks[0].to, "global");

  await sup.shutdown();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("supervisor isolates per-workspace pool and evicts LRU", async () => {
  const home = mkTemp("ignis-pool-home-");
  const repoA = mkTemp("ignis-pool-a-");
  const repoB = mkTemp("ignis-pool-b-");
  fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });

  const script = writeMockStdioServer(home, "ws", "ws", false);
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
  const outA = await sup.call({ server: "scoped", tool: "ping", arguments: {}, cwd: repoA });
  assert.ok(outA.content[0].text.includes(path.basename(repoA)));

  const outB = await sup.call({ server: "scoped", tool: "ping", arguments: {}, cwd: repoB });
  assert.ok(outB.content[0].text.includes(path.basename(repoB)));

  const st = await sup.status({});
  assert.equal(st.pool.length, 1);

  const listed = await sup.list({ server: "scoped", filter: "pin", cwd: repoB });
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0].summary, "Ping tool");

  await sup.shutdown();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
});

test("http adapter parses JSON and SSE responses and signals transport error on 404", async () => {
  let expireNext = false;
  const server = http.createServer((req, res) => {
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

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const adapter = await McpHttpAdapter.connect({
    url: `http://127.0.0.1:${port}/mcp`,
    headers: {},
    startupTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  });

  const tools = await adapter.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo");

  const out = await adapter.callTool("echo", {});
  assert.equal(out.content[0].text, "ok");

  expireNext = true;
  await assert.rejects(() => adapter.callTool("echo", {}), (err) => err.kind === "transport");
  assert.equal(await adapter.isAlive(), false);

  await new Promise((r) => server.close(r));
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

test("supervisor degrades to opt-in memtrace CLI fallback when MCP fails", async () => {
  const home = mkTemp("ignis-cli-fb-home-");
  const repo = mkTemp("ignis-cli-fb-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const shim = writeFakeMemtraceShim(home);
  const prevCmd = process.env.IGNIS_MEMTRACE_CMD;
  process.env.IGNIS_MEMTRACE_CMD = shim;

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
    const res = await sup.call({
      server: "memtrace",
      tool: "find_symbol",
      arguments: { query: "Supervisor", limit: 5 },
      cwd: repo,
    });

    assert.equal(res.isError, false);
    assert.equal(res.meta.source, "cli_fallback");
    assert.equal(res.meta.fallbackFrom, "global");
    assert.ok(res.meta.mcpError);
    assert.equal(res.meta.retried, true);
    assert.equal(res.content[0].text, "memtrace:find|Supervisor|--limit|5");

    const st = await sup.status({ cwd: repo });
    assert.equal(st.recentFallbacks.length, 1);
    assert.equal(st.recentFallbacks[0].to, "cli_fallback");
  } finally {
    if (prevCmd === undefined) delete process.env.IGNIS_MEMTRACE_CMD;
    else process.env.IGNIS_MEMTRACE_CMD = prevCmd;
    await sup.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("supervisor does not invoke CLI fallback when cliFallback is not configured", async () => {
  const home = mkTemp("ignis-no-fb-home-");
  const repo = mkTemp("ignis-no-fb-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const shim = writeFakeMemtraceShim(home);
  const prevCmd = process.env.IGNIS_MEMTRACE_CMD;
  process.env.IGNIS_MEMTRACE_CMD = shim;

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
        sup.call({
          server: "memtrace",
          tool: "find_symbol",
          arguments: { query: "Supervisor" },
          cwd: repo,
        }),
      (err) => err.kind === "startup" || err.kind === "transport"
    );
  } finally {
    if (prevCmd === undefined) delete process.env.IGNIS_MEMTRACE_CMD;
    else process.env.IGNIS_MEMTRACE_CMD = prevCmd;
    await sup.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("unsupported tool returns null from tryCliFallback and propagates MCP error", async () => {
  const direct = await tryCliFallback("memtrace", "get_evolution", { symbol: "Foo" }, undefined, 5000);
  assert.equal(direct, null);

  const home = mkTemp("ignis-unsup-fb-home-");
  const repo = mkTemp("ignis-unsup-fb-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const shim = writeFakeMemtraceShim(home);
  const prevCmd = process.env.IGNIS_MEMTRACE_CMD;
  process.env.IGNIS_MEMTRACE_CMD = shim;

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
        sup.call({
          server: "memtrace",
          tool: "get_evolution",
          arguments: { symbol: "Foo" },
          cwd: repo,
        }),
      (err) => err.kind === "startup" || err.kind === "transport"
    );
  } finally {
    if (prevCmd === undefined) delete process.env.IGNIS_MEMTRACE_CMD;
    else process.env.IGNIS_MEMTRACE_CMD = prevCmd;
    await sup.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("stdio adapter and CLI fallback resolve bare Windows .cmd shims on PATH", { skip: process.platform !== "win32" }, async () => {
  const home = mkTemp("ignis-win-cmd-home-");
  const binDir = mkTemp("ignis-win-cmd-bin-");
  const repo = mkTemp("ignis-win-cmd-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const mcpScript = writeMockStdioServer(binDir, "bare-srv", "cmd-shim-ok", false);
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

  const prevPath = process.env.PATH;
  const prevCmd = process.env.IGNIS_MEMTRACE_CMD;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath || ""}`;
  process.env.IGNIS_MEMTRACE_CMD = "bare-memtrace";

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
    const mcpRes = await sup.call({ server: "bare", tool: "ping", arguments: {}, cwd: repo });
    assert.equal(mcpRes.isError, false);
    assert.ok(mcpRes.content[0].text.startsWith("cmd-shim-ok:"));

    const cliRes = await tryCliFallback("memtrace", "find_symbol", { query: "Foo" }, repo, 5000);
    assert.equal(cliRes.isError, false);
    assert.equal(cliRes.content[0].text, "bare-cli:find|Foo");
  } finally {
    process.env.PATH = prevPath;
    if (prevCmd === undefined) delete process.env.IGNIS_MEMTRACE_CMD;
    else process.env.IGNIS_MEMTRACE_CMD = prevCmd;
    await sup.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
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

test("tryCliFallback neutralizes quote and metacharacter injection on Windows Node and batch .cmd shims", { skip: process.platform !== "win32" }, async () => {
  const dir = mkTemp("ignis-cmd-inject-");
  const prevCmd = process.env.IGNIS_MEMTRACE_CMD;
  const marker = path.join(dir, "injected.txt");
  const payload = `x" & echo INJECTED_CLI > "${marker}" & "`;

  try {
    const cliScript = path.join(dir, "node-cli.mjs");
    fs.writeFileSync(cliScript, 'process.stdout.write("node:" + process.argv.slice(2).join("|"));\n');
    const nodeCmd = path.join(dir, "node-memtrace.cmd");
    fs.writeFileSync(nodeCmd, `@echo off\r\n"${process.execPath}" "${cliScript}" %*\r\n`);

    process.env.IGNIS_MEMTRACE_CMD = nodeCmd;
    const nodeRes = await tryCliFallback("memtrace", "find_symbol", { query: payload }, dir, 5000);
    assert.equal(nodeRes.isError, false);
    assert.equal(nodeRes.content[0].text, `node:find|${payload}`);
    assert.equal(fs.existsSync(marker), false);

    const batchCmd = path.join(dir, "batch-memtrace.cmd");
    fs.writeFileSync(batchCmd, "@echo off\r\necho batch:%*\r\n");
    process.env.IGNIS_MEMTRACE_CMD = batchCmd;

    await assert.rejects(
      () => tryCliFallback("memtrace", "find_symbol", { query: payload }, dir, 5000),
      (err) => err.kind === "protocol"
    );
    assert.equal(fs.existsSync(marker), false);

    await assert.rejects(
      () => tryCliFallback("memtrace", "find_symbol", { query: "abc\r\necho pwned" }, dir, 5000),
      (err) => err.kind === "protocol"
    );
  } finally {
    if (prevCmd === undefined) delete process.env.IGNIS_MEMTRACE_CMD;
    else process.env.IGNIS_MEMTRACE_CMD = prevCmd;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor deduplicates concurrent cold starts and invalidates pool on servers.json edits", async () => {
  const home = mkTemp("ignis-conc-home-");
  const repo = mkTemp("ignis-conc-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });

  const pidLog = path.join(home, "pids.log");
  const scriptV1 = path.join(home, "srv-v1.mjs");
  const scriptV2 = path.join(home, "srv-v2.mjs");

  for (const [scriptPath, label] of [
    [scriptV1, "v1"],
    [scriptV2, "v2"],
  ]) {
    fs.writeFileSync(
      scriptPath,
      `
import fs from "node:fs";
import readline from "node:readline";
fs.appendFileSync(${JSON.stringify(pidLog)}, String(process.pid) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: ${JSON.stringify(label)} }], isError: false } }) + "\\n");
  }
});
`
    );
  }

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
    const results = await Promise.all([
      sup.call({ server: "demo", tool: "ping", arguments: {}, cwd: repo }),
      sup.call({ server: "demo", tool: "ping", arguments: {}, cwd: repo }),
      sup.call({ server: "demo", tool: "ping", arguments: {}, cwd: repo }),
    ]);
    for (const r of results) {
      assert.equal(r.content[0].text, "v1");
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
    const v2Res = await sup.call({ server: "demo", tool: "ping", arguments: {}, cwd: repo });
    assert.equal(v2Res.content[0].text, "v2");

    fs.writeFileSync(path.join(repo, ".agents", "ignis-broker.json"), "{ invalid-local");
    const listRes = await sup.list({ cwd: repo });
    assert.ok(listRes.localConfigError);
  } finally {
    await sup.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("http adapter parses multi-line SSE frames and rejects notification-only SSE streams", async () => {
  let mode = "multiline";
  const server = http.createServer((req, res) => {
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

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const adapter = await McpHttpAdapter.connect({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: {},
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    });
    const okRes = await adapter.callTool("echo", {});
    assert.equal(okRes.content[0].text, "multi-ok");

    mode = "notif-only";
    await assert.rejects(
      () => adapter.callTool("echo", {}),
      (err) => err.kind === "protocol"
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("supervisor sends a local http entry's ${VAR} headers and url literally, never the dotenv secret", async () => {
  const home = mkTemp("ignis-lit-home-");
  const repo = mkTemp("ignis-lit-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  const secret = ["sec", "ret", String(process.pid)].join("-");
  fs.writeFileSync(path.join(home, ".env"), `SECRET_X=${secret}\n`);
  fs.writeFileSync(path.join(home, "servers.json"), JSON.stringify({ version: 1, servers: {} }));

  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, url: req.url });
    res.writeHead(500);
    res.end("boom");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
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

  const sup = new Supervisor(home, home, 0);
  try {
    await assert.rejects(() => sup.call({ server: "sink", tool: "x", arguments: {}, cwd: repo }));
  } finally {
    await sup.shutdown();
    await new Promise((r) => server.close(r));
  }

  assert.ok(seen.length > 0);
  for (const hit of seen) {
    assert.equal(hit.auth, "Bearer ${SECRET_X}");
    assert.ok(!String(hit.auth).includes(secret));
    assert.ok(!hit.url.includes(secret));
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});
