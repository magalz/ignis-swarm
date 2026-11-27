import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpStdioAdapter, killProcessTree } from "../scripts/broker/adapters.mjs";
import { mkTemp } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeServer(dir, name, mode) {
  const script = path.join(dir, `${name}.mjs`);
  const record = path.join(dir, `${name}.record`);
  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
const record = ${JSON.stringify(record)};
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
let callId = null;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    if (mode === "exit-after-init") setTimeout(() => process.exit(0), 50);
  } else if (msg.method === "tools/call") {
    callId = msg.id;
    if (mode === "ping") send({ id: callId, method: "ping" });
    else if (mode === "sampling") send({ id: 900, method: "sampling/createMessage", params: {} });
    else if (mode === "notify") send({ method: "notifications/message", params: {} });
  } else if (msg.id === callId && callId !== null && !msg.method) {
    fs.writeFileSync(record, JSON.stringify(msg));
    send({ id: callId, result: { content: [{ type: "text", text: "real" }] } });
  } else if (msg.id === 900) {
    fs.writeFileSync(record, JSON.stringify(msg));
    send({ id: callId, result: { content: [{ type: "text", text: "real" }] } });
  }
  if (msg.method === "tools/call" && mode === "notify") {
    send({ id: callId, result: { content: [{ type: "text", text: "real" }] } });
  }
});
`
  );
  return { script, record };
}

async function startAdapter(script, env) {
  return McpStdioAdapter.start({
    command: process.execPath,
    args: [script],
    env,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 3000,
  });
}

test("a server ping with the call's id is answered and does not settle the call", async () => {
  const dir = mkTemp("ignis-proto-");
  const { script, record } = writeServer(dir, "ping", "ping");
  const adapter = await startAdapter(script);
  try {
    const res = await adapter.callTool("t", {});
    assert.equal(res.content[0]?.text, "real");
    const answer = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(answer.id, 1 + 1);
    assert.deepEqual(answer.result, {});
    assert.equal(answer.jsonrpc, "2.0");
  } finally {
    await adapter.shutdown();
  }
});

test("an unknown server request gets -32601 and the real result still arrives", async () => {
  const dir = mkTemp("ignis-proto-");
  const { script, record } = writeServer(dir, "sampling", "sampling");
  const adapter = await startAdapter(script);
  try {
    const res = await adapter.callTool("t", {});
    assert.equal(res.content[0]?.text, "real");
    const answer = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(answer.id, 900);
    assert.equal(answer.error.code, -32601);
    assert.equal(answer.error.message, "Method not found");
  } finally {
    await adapter.shutdown();
  }
});

test("a server notification is ignored", async () => {
  const dir = mkTemp("ignis-proto-");
  const { script } = writeServer(dir, "notify", "notify");
  const adapter = await startAdapter(script);
  try {
    const res = await adapter.callTool("t", {});
    assert.equal(res.content[0]?.text, "real");
  } finally {
    await adapter.shutdown();
  }
});

test("a child that exits after initialize yields a transport error and no uncaught exception", async () => {
  const dir = mkTemp("ignis-proto-");
  const { script } = writeServer(dir, "exit", "exit-after-init");
  const uncaught = [];
  const spy = (err) => uncaught.push(err);
  process.on("uncaughtException", spy);
  const adapter = await startAdapter(script);
  try {
    await sleep(400);
    await assert.rejects(adapter.callTool("t", {}), (err) => err.kind === "transport");
    await sleep(200);
    assert.deepEqual(uncaught, []);
  } finally {
    process.removeListener("uncaughtException", spy);
    await adapter.shutdown();
  }
});

test("killProcessTree is non-blocking and kills a child that ignores SIGTERM", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true }
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("child never became ready")), 10_000);
      child.stdout.once("data", () => {
        clearTimeout(t);
        resolve();
      });
    });
    let ticks = 0;
    const iv = setInterval(() => {
      ticks++;
    }, 20);
    const pending = killProcessTree(child.pid);
    assert.ok(pending && typeof pending.then === "function", "returns a promise");
    await pending;
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(25);
    clearInterval(iv);
    assert.ok(exited, "child is dead");
    assert.ok(ticks > 0, "event loop kept ticking");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});
