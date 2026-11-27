import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPidAlive, readDaemonInfo, daemonInfoPath } from "../scripts/broker/lifecycle.mjs";
import { isolatedEnv, mkTemp, runNode } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "scripts", "ignis-broker.mjs");
const SERVER_URL = pathToFileURL(path.join(ROOT, "scripts", "broker", "server.mjs")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killDaemon(dataDir, pid) {
  const info = readDaemonInfo(dataDir);
  const target = pid ?? info?.pid;
  if (target && isPidAlive(target)) {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  }
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

function writeIdleConfig(iso, servers = {}) {
  fs.writeFileSync(
    path.join(iso.dirs.brokerHome, "servers.json"),
    JSON.stringify({ version: 1, defaults: { idleTimeoutSecs: 2 }, servers })
  );
}

test("a daemon with no traffic exits on idle and removes its daemon.json", async (t) => {
  const iso = isolatedEnv();
  let pid;
  t.after(() => {
    killDaemon(iso.dirs.brokerData, pid);
    iso.cleanup();
  });
  writeIdleConfig(iso);
  const res = runNode(BIN, ["status"], { env: iso.env, timeoutMs: 30_000 });
  assert.equal(res.timedOut, false);
  pid = readDaemonInfo(iso.dirs.brokerData)?.pid;
  assert.ok(pid, `daemon.json missing after status: ${res.stderr}`);
  const gone = await waitFor(() => !isPidAlive(pid), 6000);
  assert.equal(gone, true, "daemon pid is still alive 6 s after the 2 s idle timeout");
  assert.equal(fs.existsSync(daemonInfoPath(iso.dirs.brokerData)), false);
});

test("a slow call in flight when the idle timer would fire completes, then the daemon exits", async (t) => {
  const iso = isolatedEnv();
  const work = mkTemp("ignis-idle-mock-");
  let pid;
  t.after(() => {
    killDaemon(iso.dirs.brokerData, pid);
    iso.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const mock = path.join(work, "slow-mock.mjs");
  fs.writeFileSync(
    mock,
    `
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") {
    setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "slow-done" }], isError: false } }), 3000);
  }
});
`
  );
  writeIdleConfig(iso, {
    demo: { transport: "stdio", command: process.execPath, args: [mock], requestTimeoutMs: 20_000 },
  });
  const warm = runNode(BIN, ["status"], { env: iso.env, timeoutMs: 30_000 });
  assert.equal(warm.timedOut, false);
  pid = readDaemonInfo(iso.dirs.brokerData)?.pid;
  assert.ok(pid, `daemon.json missing after status: ${warm.stderr}`);

  const child = spawn(process.execPath, [BIN, "call", "demo", "slow"], { env: iso.env, windowsHide: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  let removedDuringCall = false;
  const exited = new Promise((resolve) => child.once("close", resolve));
  const watcher = (async () => {
    let done = false;
    exited.then(() => (done = true));
    while (!done) {
      if (!fs.existsSync(daemonInfoPath(iso.dirs.brokerData)) || !isPidAlive(pid)) removedDuringCall = true;
      await sleep(100);
    }
  })();
  const code = await exited;
  await watcher;
  clearTimeout(killer);
  assert.equal(code, 0, `call failed: ${err}`);
  assert.match(out, /slow-done/);
  assert.equal(removedDuringCall, false, "daemon.json was removed or the daemon died during the in-flight call");
  assert.ok(isPidAlive(pid));
  assert.equal(fs.existsSync(daemonInfoPath(iso.dirs.brokerData)), true);

  const gone = await waitFor(() => !isPidAlive(pid), 6000);
  assert.equal(gone, true, "daemon did not exit on idle after the call finished");
  assert.equal(fs.existsSync(daemonInfoPath(iso.dirs.brokerData)), false);
});

test("an uncaught async error is logged, daemon.json is removed and the exit code is 1", async (t) => {
  const iso = isolatedEnv();
  const work = mkTemp("ignis-crash-");
  t.after(() => {
    killDaemon(iso.dirs.brokerData);
    iso.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const closed = startHarness(iso, work, `setTimeout(() => { throw new Error("crash-test-boom"); }, 300);`);
  const code = await closed;
  assert.equal(code, 1);
  assert.equal(fs.existsSync(daemonInfoPath(iso.dirs.brokerData)), false);
  const log = fs.readFileSync(path.join(iso.dirs.brokerData, "daemon.log"), "utf8");
  assert.match(log, /crash-test-boom/);
});

function startHarness(iso, work, body) {
  const harness = path.join(work, "crash-harness.mjs");
  fs.writeFileSync(
    harness,
    `
import { runDaemon } from ${JSON.stringify(SERVER_URL)};
await runDaemon(process.argv[2], process.argv[3], 0);
${body}
`
  );
  const child = spawn(process.execPath, [harness, iso.dirs.brokerHome, iso.dirs.brokerData], {
    env: iso.env,
    windowsHide: true,
    stdio: "ignore",
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 8000);
  return new Promise((resolve) => child.once("close", resolve)).finally(() => clearTimeout(killer));
}

test("an unhandled rejection is logged, daemon.json is removed and the exit code is 1", async (t) => {
  const iso = isolatedEnv();
  const work = mkTemp("ignis-reject-");
  t.after(() => {
    killDaemon(iso.dirs.brokerData);
    iso.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const closed = startHarness(iso, work, `setTimeout(() => { Promise.reject(new Error("reject-test-boom")); }, 300);`);
  assert.equal(await closed, 1);
  assert.equal(fs.existsSync(daemonInfoPath(iso.dirs.brokerData)), false);
  const log = fs.readFileSync(path.join(iso.dirs.brokerData, "daemon.log"), "utf8");
  assert.match(log, /reject-test-boom/);
});

test("a crash trims daemon.log past 256 KiB and appends the new line at the end", async (t) => {
  const iso = isolatedEnv();
  const work = mkTemp("ignis-logtrim-");
  t.after(() => {
    killDaemon(iso.dirs.brokerData);
    iso.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const logFile = path.join(iso.dirs.brokerData, "daemon.log");
  const before = 300 * 1024;
  fs.writeFileSync(logFile, "old-line\n".repeat(Math.ceil(before / 9)));
  const prefilled = fs.statSync(logFile).size;
  assert.ok(prefilled > 256 * 1024);
  const closed = startHarness(iso, work, `setTimeout(() => { throw new Error("trim-test-boom"); }, 300);`);
  assert.equal(await closed, 1);
  const size = fs.statSync(logFile).size;
  assert.ok(size < prefilled, `log did not shrink: ${size} >= ${prefilled}`);
  const lines = fs.readFileSync(logFile, "utf8").split("\n");
  const lastIdx = lines.findLastIndex((l) => /trim-test-boom/.test(l));
  assert.ok(lastIdx >= 0, "the crash line is missing");
  assert.equal(lines.slice(lastIdx + 1).some((l) => l.includes("old-line")), false, "old lines follow the new one");
});

test("a crash shuts the supervisor down so a pooled child that ignores stdin EOF dies", async (t) => {
  const iso = isolatedEnv();
  const work = mkTemp("ignis-crash-child-");
  const pidFile = path.join(work, "child.pid");
  const trigger = path.join(work, "go");
  let childPid;
  t.after(() => {
    killDaemon(iso.dirs.brokerData);
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    iso.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const mock = path.join(work, "stubborn-mock.mjs");
  fs.writeFileSync(
    mock,
    `
import fs from "node:fs";
import readline from "node:readline";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }], isError: false } });
  }
});
setInterval(() => {}, 1000);
`
  );
  writeIdleConfig(iso, {
    demo: { transport: "stdio", command: process.execPath, args: [mock], requestTimeoutMs: 20_000 },
  });
  const closed = startHarness(
    iso,
    work,
    `
const fs = await import("node:fs");
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(trigger)})) throw new Error("crash-child-boom");
}, 100);
`
  );
  await waitFor(() => fs.existsSync(daemonInfoPath(iso.dirs.brokerData)), 8000);
  const res = runNode(BIN, ["call", "demo", "ping"], { env: iso.env, timeoutMs: 15_000 });
  assert.match(res.stdout, /pong/, `call failed: ${res.stderr}`);
  childPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(isPidAlive(childPid));
  fs.writeFileSync(trigger, "1");
  assert.equal(await closed, 1);
  const dead = await waitFor(() => !isPidAlive(childPid), 4000);
  assert.equal(dead, true, "the pooled child survived the daemon crash");
});
