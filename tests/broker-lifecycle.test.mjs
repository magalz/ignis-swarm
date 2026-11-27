import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROKER_VERSION } from "../scripts/broker/config.mjs";
import { acquireLock, ensureDaemon, isPidAlive, readDaemonInfo, stopDaemon } from "../scripts/broker/lifecycle.mjs";
import { truncateContentBlocks } from "../scripts/broker/spill.mjs";
import { isolatedEnv, mkTemp, runNode } from "./helpers.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ignis-broker.mjs");
const POSIX = process.platform !== "win32";

function stopDaemonFor({ env, dataDir }) {
  const info = readDaemonInfo(dataDir);
  runNode(BIN, ["stop"], { env, timeoutMs: 15_000 });
  if (isPidAlive(info?.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {}
    const deadline = Date.now() + 5000;
    while (isPidAlive(info.pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

test("a lazily started daemon does not hold the folder it was started from", (t) => {
  const iso = isolatedEnv();
  const start = mkTemp("ignis-life-cwd-");
  t.after(() => {
    stopDaemonFor({ env: iso.env, dataDir: iso.dirs.brokerData });
    iso.cleanup();
    fs.rmSync(start, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const res = runNode(BIN, ["list"], { env: iso.env, cwd: start, timeoutMs: 30_000 });
  assert.equal(res.timedOut, false);
  const info = readDaemonInfo(iso.dirs.brokerData);
  assert.ok(info?.pid, `daemon.json missing after list: ${res.stderr}`);

  if (process.platform === "win32") {
    fs.rmSync(start, { recursive: true });
    assert.equal(fs.existsSync(start), false);
  } else if (process.platform === "linux") {
    assert.equal(fs.readlinkSync(`/proc/${info.pid}/cwd`), fs.realpathSync(iso.dirs.brokerData));
  } else {
    t.skip("daemon cwd assertion needs /proc, which this platform lacks");
  }
});

test("the data dir is created private and an existing open one is tightened", { skip: !POSIX && "POSIX modes only" }, (t) => {
  const iso = isolatedEnv();
  t.after(() => {
    stopDaemonFor({ env: iso.env, dataDir: iso.dirs.brokerData });
    iso.cleanup();
  });
  fs.chmodSync(iso.dirs.brokerData, 0o755);
  const res = runNode(BIN, ["list"], { env: iso.env, timeoutMs: 30_000 });
  assert.equal(res.timedOut, false);
  assert.equal(fs.statSync(iso.dirs.brokerData).mode & 0o777, 0o700);
});

test("a fresh data dir created by the broker is 0700", { skip: !POSIX && "POSIX modes only" }, (t) => {
  const iso = isolatedEnv();
  const fresh = path.join(iso.dirs.root, "fresh-data");
  const env = { ...iso.env, IGNIS_BROKER_DATA: fresh };
  t.after(() => {
    stopDaemonFor({ env, dataDir: fresh });
    iso.cleanup();
  });
  const res = runNode(BIN, ["list"], { env, timeoutMs: 30_000 });
  assert.equal(res.timedOut, false);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
});

test("the spill dir is created 0700", { skip: !POSIX && "POSIX modes only" }, (t) => {
  const root = mkTemp("ignis-life-spill-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const spillDir = path.join(root, "spill");
  const out = truncateContentBlocks([{ type: "text", text: "x\n".repeat(50) }], 20, 5, spillDir, false);
  assert.ok(out.spillPath, "spill file was written");
  assert.equal(fs.statSync(spillDir).mode & 0o777, 0o700);
});

test("relative IGNIS_BROKER_HOME and DATA still start the daemon from another cwd", (t) => {
  const iso = isolatedEnv();
  const work = mkTemp("ignis-life-rel-");
  const env = { ...iso.env, IGNIS_BROKER_HOME: "bh", IGNIS_BROKER_DATA: "bd" };
  const dataDir = path.join(work, "bd");
  const absEnv = { ...iso.env, IGNIS_BROKER_HOME: path.join(work, "bh"), IGNIS_BROKER_DATA: dataDir };
  t.after(() => {
    stopDaemonFor({ env: absEnv, dataDir });
    iso.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const res = runNode(BIN, ["list"], { env, cwd: work, timeoutMs: 30_000 });
  assert.equal(res.timedOut, false);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(readDaemonInfo(dataDir)?.pid, "daemon.json is in <cwd>/bd");
  assert.equal(fs.existsSync(path.join(dataDir, "bd")), false);
});

const LIFECYCLE_URL = new URL("../scripts/broker/lifecycle.mjs", import.meta.url).href;

const FAKE_DAEMON = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const [dataDir, version] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, version }));
});
server.listen(0, "127.0.0.1", () => {
  const info = { pid: process.pid, port: server.address().port, token: "fake-token", version };
  fs.writeFileSync(path.join(dataDir, "daemon.json"), JSON.stringify(info));
});
setInterval(() => {}, 1000);
`;

const LOCK_RACER = `
import fs from "node:fs";
import { acquireLock } from ${JSON.stringify(LIFECYCLE_URL)};
const [lockPath, marker] = process.argv.slice(2);
const release = await acquireLock(lockPath);
try {
  fs.writeFileSync(marker, String(process.pid), { flag: "wx" });
} catch {
  console.error("overlap");
  process.exit(3);
}
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(marker);
release();
`;

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function startFakeDaemon(root, dataDir, version) {
  const script = path.join(root, "fake-daemon.mjs");
  fs.writeFileSync(script, FAKE_DAEMON);
  return spawn(process.execPath, [script, dataDir, version], { stdio: "ignore", windowsHide: true });
}

function killQuietly(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

test("a waiter outlasts a holder that keeps the lock past the old 6 s budget", async (t) => {
  const root = mkTemp("ignis-life-lock-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const lockPath = path.join(root, "daemon.lock");
  const release = await acquireLock(lockPath);
  const started = Date.now();
  const holding = new Promise((r) => setTimeout(r, 7000)).then(release);
  let releaseWaiter;
  try {
    releaseWaiter = await acquireLock(lockPath);
  } finally {
    await holding;
  }
  releaseWaiter();
  assert.ok(Date.now() - started >= 6900, "the waiter got the lock only after the holder released it");
});

test("racing evictors of a stale lock never both hold it", async (t) => {
  const root = mkTemp("ignis-life-race-");
  const children = [];
  t.after(() => {
    children.forEach((c) => killQuietly(c.pid));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const lockPath = path.join(root, "daemon.lock");
  const marker = path.join(root, "held");
  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const deadPid = Number(probe.stdout);
  assert.ok(deadPid > 0 && !isPidAlive(deadPid));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, ts: Date.now() }));
  const racer = path.join(root, "racer.mjs");
  fs.writeFileSync(racer, LOCK_RACER);
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    const child = spawn(process.execPath, [racer, lockPath, marker], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    results.push(
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          killQuietly(child.pid);
          resolve({ code: "timeout", stderr });
        }, 20_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, stderr });
        });
      })
    );
  }
  for (const outcome of await Promise.all(results)) assert.equal(outcome.code, 0, `racer failed: ${outcome.code} ${outcome.stderr}`);
});

test("stopDaemon kills a daemon that ignores the shutdown request", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const child = startFakeDaemon(iso.dirs.root, dataDir, BROKER_VERSION);
  t.after(() => {
    killQuietly(child.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "fake daemon.json");
  assert.equal(info.pid, child.pid);
  assert.equal(await stopDaemon(dataDir), true);
  assert.equal(isPidAlive(info.pid), false, "the stubborn daemon is dead");
  assert.equal(fs.existsSync(path.join(dataDir, "daemon.json")), false);
});

test("ensureDaemon kills an old-version daemon that ignores shutdown and starts a real one", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const old = startFakeDaemon(iso.dirs.root, dataDir, "0.0.1");
  t.after(() => {
    killQuietly(old.pid);
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "fake daemon.json");
  const saved = { IGNIS_BROKER_HOME: process.env.IGNIS_BROKER_HOME, IGNIS_BROKER_DATA: process.env.IGNIS_BROKER_DATA };
  Object.assign(process.env, { IGNIS_BROKER_HOME: iso.dirs.brokerHome, IGNIS_BROKER_DATA: dataDir });
  let fresh;
  try {
    fresh = await ensureDaemon(iso.dirs.brokerHome, dataDir, BIN);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(isPidAlive(oldInfo.pid), false, "the old daemon is dead");
  assert.notEqual(fresh.pid, oldInfo.pid);
  assert.equal(isPidAlive(fresh.pid), true);
  assert.equal(await stopDaemon(dataDir), true);
  assert.equal(isPidAlive(fresh.pid), false);
});

const SLOW_DAEMON = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const [dataDir, marker] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.includes("shutdown")) {
    res.end("{}");
    server.close();
    setTimeout(() => {
      fs.writeFileSync(marker, "cleaned");
      process.exit(0);
    }, 2200);
    return;
  }
  res.end(JSON.stringify({ ok: true, version: "0.0.1" }));
});
server.listen(0, "127.0.0.1", () => {
  const info = { pid: process.pid, port: server.address().port, token: "fake-token", version: "0.0.1" };
  fs.writeFileSync(path.join(dataDir, "daemon.json"), JSON.stringify(info));
});
setInterval(() => {}, 1000);
`;

test("stopDaemon lets a cooperative daemon finish its slow cleanup before escalating", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "slow-daemon.mjs");
  const marker = path.join(iso.dirs.root, "cleaned.txt");
  fs.writeFileSync(script, SLOW_DAEMON);
  const child = spawn(process.execPath, [script, dataDir, marker], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(child.pid);
    iso.cleanup();
  });
  await waitFor(() => readDaemonInfo(dataDir), 10_000, "slow daemon.json");
  assert.equal(await stopDaemon(dataDir), true);
  assert.equal(fs.readFileSync(marker, "utf8"), "cleaned", "the daemon finished its own cleanup before it was killed");
  assert.equal(isPidAlive(child.pid), false);
  assert.equal(fs.existsSync(path.join(dataDir, "daemon.json")), false);
});
