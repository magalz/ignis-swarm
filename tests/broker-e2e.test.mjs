import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_ENTRY = path.resolve(__dirname, "..", "scripts", "ignis-broker.mjs");

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("e2e CLI lazy-starts daemon, imports MCPs with summary list, and mcp-bridge survives daemon kill", async () => {
  const home = mkTemp("ignis-e2e-home-");
  const mockScript = path.join(home, "mock_e2e.mjs");
  fs.writeFileSync(
    mockScript,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Return pong.", inputSchema: { type: "object" } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong-node-e2e" }], isError: false } }) + "\\n");
  }
});
`
  );

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

  const env = { ...process.env, IGNIS_BROKER_HOME: home, IGNIS_BROKER_DATA: home };

  const imp = spawnSync(process.execPath, [BROKER_ENTRY, "import-mcp", "--from", srcMcp], {
    encoding: "utf8",
    env,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /Imported 2 server\(s\)/);
  assert.match(imp.stdout, /- demo \[stdio\]/);
  assert.match(imp.stdout, /- remote \[http\]/);

  const st = spawnSync(process.execPath, [BROKER_ENTRY, "status", "--json"], {
    encoding: "utf8",
    env,
    timeout: 10_000,
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
  const nextLine = () => new Promise((resolve) => rl.once("line", (line) => resolve(JSON.parse(line))));

  bridge.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } })}\n`
  );
  const initResp = await nextLine();
  assert.equal(initResp.result.serverInfo.name, "ignis-broker");

  bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const listResp = await nextLine();
  assert.equal(listResp.result.tools.length, 4);

  bridge.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "broker_call", arguments: { server: "demo", tool: "ping", arguments: {} } } })}\n`
  );
  const call1 = await nextLine();
  assert.equal(call1.result.content[0].text, "pong-node-e2e");

  const stopRes = spawnSync(process.execPath, [BROKER_ENTRY, "stop"], {
    encoding: "utf8",
    env,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(stopRes.status, 0, stopRes.stderr);

  bridge.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "broker_call", arguments: { server: "demo", tool: "ping", arguments: {} } } })}\n`
  );
  const call2 = await nextLine();
  assert.equal(call2.result.content[0].text, "pong-node-e2e");

  bridge.stdin.write("null\n");
  bridge.stdin.write("42\n");
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" })}\n`);
  const pingAfterNull = await nextLine();
  assert.equal(pingAfterNull.id, 5);

  const listFlagsRes = spawnSync(
    process.execPath,
    [BROKER_ENTRY, "list", "--json", "demo"],
    { encoding: "utf8", env, timeout: 10_000, windowsHide: true }
  );
  assert.equal(listFlagsRes.status, 0, listFlagsRes.stderr);
  const listFlagsJson = JSON.parse(listFlagsRes.stdout);
  assert.equal(listFlagsJson.tools[0].name, "ping");

  const callFlagsRes = spawnSync(
    process.execPath,
    [BROKER_ENTRY, "call", "--full", "demo", "ping", "--max-bytes=1024"],
    { encoding: "utf8", env, timeout: 10_000, windowsHide: true }
  );
  assert.equal(callFlagsRes.status, 0, callFlagsRes.stderr);
  assert.match(callFlagsRes.stdout, /pong-node-e2e/);

  const daemonInfo = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  const badJsonResp = await fetch(`http://127.0.0.1:${daemonInfo.port}/v1/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonInfo.token}`,
    },
    body: "{malformed-json",
  });
  assert.equal(badJsonResp.status, 400);

  bridge.stdin.end();
  rl.close();
  await new Promise((r) => bridge.once("exit", r));

  spawnSync(process.execPath, [BROKER_ENTRY, "stop"], {
    encoding: "utf8",
    env,
    timeout: 10_000,
    windowsHide: true,
  });
  fs.rmSync(home, { recursive: true, force: true });
});
