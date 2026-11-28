import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPidAlive } from "../scripts/broker/lifecycle.mjs";
import { isolatedEnv, waitUntil, writeMockStdioServer } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_ENTRY = path.resolve(__dirname, "..", "scripts", "ignis-broker.mjs");

const CLI_TIMEOUT_MS = 60_000;
const WAIT_MS = 30_000;

test("isolatedEnv cleanup stops a daemon the test left running and removes its folder", { timeout: 120_000 }, async () => {
  const iso = isolatedEnv();
  const started = spawnSync(process.execPath, [BROKER_ENTRY, "status", "--json"], {
    encoding: "utf8",
    env: iso.env,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  });
  let pid = 0;
  let survived = true;
  try {
    assert.equal(started.status, 0, started.stderr);
    pid = JSON.parse(started.stdout).pid;
    assert.ok(isPidAlive(pid), "the lazy-started daemon is running");
  } finally {
    iso.cleanup();
    survived = isPidAlive(pid);
    if (pid && survived) process.kill(pid, "SIGKILL");
  }
  assert.equal(survived, false, "cleanup stopped the daemon");
  assert.equal(fs.existsSync(iso.dirs.root), false, "the iso folder is gone");
});

test("e2e CLI lazy-starts daemon, imports MCPs with summary list, and mcp-bridge survives daemon kill", { timeout: 180_000 }, async (t) => {
  const iso = isolatedEnv();
  const home = iso.dirs.root;
  const env = iso.env;
  t.after(() => {
    try {
      spawnSync(process.execPath, [BROKER_ENTRY, "stop"], {
        encoding: "utf8",
        env,
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
      });
    } finally {
      iso.cleanup();
    }
  });
  const mockScript = writeMockStdioServer(home, { label: "pong-node-e2e", banner: false });

  const srcMcp = path.join(home, "mcp_config.json");
  fs.writeFileSync(
    srcMcp,
    JSON.stringify({
      mcpServers: {
        demo: { command: process.execPath, args: [mockScript] },
        remote: { serverUrl: "https://api.example.com/mcp" },
      },
    })
  );

  const imp = spawnSync(process.execPath, [BROKER_ENTRY, "import-mcp", "--from", srcMcp], {
    encoding: "utf8",
    env,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /Imported 2 server\(s\)/);
  assert.match(imp.stdout, /- demo \[stdio\]/);
  assert.match(imp.stdout, /- remote \[http\]/);

  const st = spawnSync(process.execPath, [BROKER_ENTRY, "status", "--json"], {
    encoding: "utf8",
    env,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.equal(st.status, 0, st.stderr);
  const stJson = JSON.parse(st.stdout);
  assert.ok(stJson.pid > 0);

  const bridge = spawn(process.execPath, [BROKER_ENTRY, "mcp-bridge"], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });

  const rl = readline.createInterface({ input: bridge.stdout });
  const bridgeExited = new Promise((resolve) => bridge.once("exit", resolve));
  t.after(async () => {
    rl.close();
    bridge.stdin.destroy();
    bridge.kill();
    await Promise.race([bridgeExited, new Promise((r) => setTimeout(r, 10_000))]);
  });

  // The next reply line, or an error when the bridge exits or WAIT_MS passes. The timer is
  // ref'd and cleared on settle, so a silent bridge fails the test instead of hanging it.
  const nextLine = (label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no bridge reply in ${WAIT_MS} ms: ${label}`)), WAIT_MS);
      const onExit = () => reject(new Error(`the bridge exited while waiting for: ${label}`));
      bridge.once("exit", onExit);
      rl.once("line", (line) => {
        clearTimeout(timer);
        bridge.off("exit", onExit);
        resolve(JSON.parse(line));
      });
    });

  bridge.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } })}\n`
  );
  const initResp = await nextLine("initialize");
  assert.equal(initResp.result.serverInfo.name, "ignis-broker");

  bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const listResp = await nextLine("tools/list");
  assert.equal(listResp.result.tools.length, 4);

  bridge.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "broker_call", arguments: { server: "demo", tool: "echo", arguments: {} } } })}\n`
  );
  const call1 = await nextLine("the first broker_call");
  assert.match(call1.result.content[0].text, /^pong-node-e2e:/);

  const stopRes = spawnSync(process.execPath, [BROKER_ENTRY, "stop"], {
    encoding: "utf8",
    env,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.equal(stopRes.status, 0, stopRes.stderr);
  await waitUntil("the killed daemon to exit", () => !isPidAlive(stJson.pid));

  bridge.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "broker_call", arguments: { server: "demo", tool: "echo", arguments: {} } } })}\n`
  );
  const call2 = await nextLine("the broker_call after the daemon stop");
  assert.match(call2.result.content[0].text, /^pong-node-e2e:/);

  bridge.stdin.write("null\n");
  bridge.stdin.write("42\n");
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" })}\n`);
  const pingAfterNull = await nextLine("ping after null and number lines");
  assert.equal(pingAfterNull.id, 5);

  const listFlagsRes = spawnSync(
    process.execPath,
    [BROKER_ENTRY, "list", "--json", "demo"],
    { encoding: "utf8", env, timeout: CLI_TIMEOUT_MS, windowsHide: true }
  );
  assert.equal(listFlagsRes.status, 0, listFlagsRes.stderr);
  const listFlagsJson = JSON.parse(listFlagsRes.stdout);
  assert.equal(listFlagsJson.tools[0].name, "echo");

  const callFlagsRes = spawnSync(
    process.execPath,
    [BROKER_ENTRY, "call", "--full", "demo", "echo", "--max-bytes=1024"],
    { encoding: "utf8", env, timeout: CLI_TIMEOUT_MS, windowsHide: true }
  );
  assert.equal(callFlagsRes.status, 0, callFlagsRes.stderr);
  assert.match(callFlagsRes.stdout, /pong-node-e2e/);

  const daemonInfo = JSON.parse(fs.readFileSync(path.join(iso.dirs.brokerData, "daemon.json"), "utf8"));
  const badJsonResp = await fetch(`http://127.0.0.1:${daemonInfo.port}/v1/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonInfo.token}`,
    },
    body: "{malformed-json",
    signal: AbortSignal.timeout(WAIT_MS),
  });
  assert.equal(badJsonResp.status, 400);

  bridge.stdin.end();
  await waitUntil("the bridge to exit after stdin closed", () => bridge.exitCode !== null || bridge.signalCode !== null);
});
