import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BROKER_VERSION } from "../scripts/broker/config.mjs";
import { acquireLock, ensureDaemon, isPidAlive, readDaemonInfo, stopDaemon } from "../scripts/broker/lifecycle.mjs";
import { truncateContentBlocks } from "../scripts/broker/spill.mjs";
import { isolatedEnv, mkTemp, runNode } from "./helpers.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ignis-broker.mjs");
const POSIX = process.platform !== "win32";
const brokerArgs = (dataDir) => [BIN, "daemon", "--data-dir", path.resolve(dataDir)];

// An env where `ps` and `powershell` cannot be found, so the identity query fails.
// Windows env names are case-insensitive: drop every PATH variant, or `Path` wins.
function envWithoutTools(env, emptyBin) {
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"));
  return { ...kept, PATH: emptyBin };
}

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
  return spawn(process.execPath, [script, dataDir, version, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
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
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, ts: Date.now() - 120_000 }));
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
  const fresh = await ensureDaemon(iso.dirs.brokerHome, dataDir, BIN);
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
  const child = spawn(process.execPath, [script, dataDir, marker, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
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

const MUTE_DAEMON = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const [dataDir] = process.argv.slice(2);
const server = http.createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  const info = { pid: process.pid, port: server.address().port, token: "fake-token", version: "0.0.1" };
  fs.writeFileSync(path.join(dataDir, "daemon.json"), JSON.stringify(info));
});
setInterval(() => {}, 1000);
`;

test("stopDaemon keeps daemon.json while a pid that does not answer health is still alive", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "mute-daemon.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const child = spawn(process.execPath, [script, dataDir, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(child.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "mute daemon.json");
  assert.equal(await stopDaemon(dataDir), false);
  assert.equal(isPidAlive(info.pid), true, "the unresponsive daemon is not killed");
  assert.equal(fs.existsSync(path.join(dataDir, "daemon.json")), true, "daemon.json still points at the live pid");
});

function pinPid(pid) {
  const original = process.kill;
  process.kill = (target, signal) => {
    if (target === pid && signal !== 0 && signal !== undefined) return true;
    return original.call(process, target, signal);
  };
  return () => {
    process.kill = original;
  };
}

const UNPINNABLE = { skip: !POSIX && "win32 kills through taskkill, which a signal pin cannot intercept" };

test("stopDaemon throws and keeps daemon.json when the pid survives every kill", UNPINNABLE, async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const child = startFakeDaemon(iso.dirs.root, dataDir, BROKER_VERSION);
  let unpin = () => {};
  t.after(() => {
    unpin();
    killQuietly(child.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "fake daemon.json");
  unpin = pinPid(info.pid);
  await assert.rejects(stopDaemon(dataDir), new RegExp(`daemon pid ${info.pid} did not exit`));
  assert.equal(fs.existsSync(path.join(dataDir, "daemon.json")), true, "daemon.json still points at the live pid");
});

test("ignis-broker stop exits non-zero and names the pid when the daemon cannot be killed", UNPINNABLE, async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const child = startFakeDaemon(iso.dirs.root, dataDir, BROKER_VERSION);
  t.after(() => {
    killQuietly(child.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "fake daemon.json");
  const harness = path.join(iso.dirs.root, "stop-harness.mjs");
  fs.writeFileSync(
    harness,
    `
const pid = Number(process.argv[2]);
const original = process.kill;
process.kill = (target, signal) => (target === pid && signal !== 0 && signal !== undefined ? true : original.call(process, target, signal));
process.argv = [process.argv[0], ${JSON.stringify(BIN)}, "stop"];
await import(${JSON.stringify(pathToFileURL(BIN).href)});
`
  );
  const res = runNode(harness, [String(info.pid)], { env: iso.env, timeoutMs: 20_000 });
  assert.equal(res.timedOut, false);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, new RegExp(`error: ignis-broker daemon pid ${info.pid} did not exit`));
  assert.doesNotMatch(res.stdout, /stopped/);
  assert.equal(isPidAlive(info.pid), true);
});

test("ensureDaemon kills a hung daemon that no longer answers health before it spawns a new one", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "mute-daemon.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const hung = spawn(process.execPath, [script, dataDir, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(hung.pid);
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "mute daemon.json");
  const fresh = await ensureDaemon(iso.dirs.brokerHome, dataDir, BIN);
  assert.equal(isPidAlive(oldInfo.pid), false, "the hung daemon is dead");
  assert.notEqual(fresh.pid, oldInfo.pid);
  assert.equal(isPidAlive(fresh.pid), true);
  assert.equal(await stopDaemon(dataDir), true);
});

test("ensureDaemon throws instead of spawning a second daemon when the hung pid survives", UNPINNABLE, async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "mute-daemon.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const hung = spawn(process.execPath, [script, dataDir, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
  let unpin = () => {};
  t.after(() => {
    unpin();
    killQuietly(hung.pid);
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "mute daemon.json");
  unpin = pinPid(oldInfo.pid);
  await assert.rejects(ensureDaemon(iso.dirs.brokerHome, dataDir, BIN), new RegExp(`daemon pid ${oldInfo.pid} did not exit`));
  assert.equal(readDaemonInfo(dataDir)?.pid, oldInfo.pid, "daemon.json was not replaced by a second daemon");
});

const TERM_IGNORING_DAEMON = FAKE_DAEMON.replace("setInterval", 'process.on("SIGTERM", () => {});\nsetInterval');

test("stopDaemon escalates from SIGTERM to SIGKILL for a daemon that traps SIGTERM", { skip: !POSIX && "SIGTERM semantics are POSIX-only" }, async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "term-daemon.mjs");
  fs.writeFileSync(script, TERM_IGNORING_DAEMON);
  const child = spawn(process.execPath, [script, dataDir, BROKER_VERSION, ...brokerArgs(dataDir)], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => {
    killQuietly(child.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "term daemon.json");
  assert.equal(await stopDaemon(dataDir), true);
  assert.equal((await exited).signal, "SIGKILL", "ended by SIGKILL after it ignored SIGTERM");
  assert.equal(isPidAlive(info.pid), false);
  assert.equal(fs.existsSync(path.join(dataDir, "daemon.json")), false);
});

test("stopDaemon never kills a pid that answers health but is not a broker daemon", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "decoy-daemon.mjs");
  fs.writeFileSync(script, FAKE_DAEMON);
  const decoy = spawn(process.execPath, [script, dataDir, BROKER_VERSION], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(decoy.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "decoy daemon.json");
  assert.equal(await stopDaemon(dataDir), false);
  assert.equal(isPidAlive(info.pid), true, "the unrelated process is still running");
  assert.equal(fs.existsSync(path.join(dataDir, "daemon.json")), false, "the stale daemon.json was removed");
});

test("stopDaemon never kills an unrelated pid that does not answer health and drops the stale daemon.json", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "decoy-mute.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const decoy = spawn(process.execPath, [script, dataDir], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(decoy.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "decoy daemon.json");
  assert.equal(await stopDaemon(dataDir), false);
  assert.equal(isPidAlive(info.pid), true, "the unrelated process is still running");
  assert.equal(fs.existsSync(path.join(dataDir, "daemon.json")), false, "the stale daemon.json was removed");
});

test("ensureDaemon never kills an unrelated live pid recorded in daemon.json and starts a real daemon", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "decoy-mute.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const decoy = spawn(process.execPath, [script, dataDir], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(decoy.pid);
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "decoy daemon.json");
  const fresh = await ensureDaemon(iso.dirs.brokerHome, dataDir, BIN);
  assert.equal(isPidAlive(oldInfo.pid), true, "the unrelated process was killed");
  assert.notEqual(fresh.pid, oldInfo.pid);
  assert.equal(isPidAlive(fresh.pid), true);
  assert.equal(await stopDaemon(dataDir), true);
});

test("stopDaemon stops a healthy daemon through /admin/shutdown even when its identity cannot be queried", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  t.after(() => {
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  // Start it through the CLI, not in this process: on POSIX a daemon whose parent is
  // blocked in spawnSync stays a zombie after it exits, and still looks alive.
  const started = runNode(BIN, ["status"], { env: iso.env, timeoutMs: 30_000 });
  assert.equal(started.status, 0, started.stderr);
  const info = readDaemonInfo(dataDir);
  assert.ok(isPidAlive(info?.pid), "the CLI started a daemon");
  const emptyBin = path.join(iso.dirs.root, "empty-bin");
  fs.mkdirSync(emptyBin);
  const harness = path.join(iso.dirs.root, "stop-harness.mjs");
  fs.writeFileSync(
    harness,
    `
import { stopDaemon } from ${JSON.stringify(LIFECYCLE_URL)};
try {
  console.log(String(await stopDaemon(process.argv[2])));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
`
  );
  const res = runNode(harness, [dataDir], { env: envWithoutTools(iso.env, emptyBin), timeoutMs: 30_000 });
  assert.equal(res.timedOut, false);
  assert.equal(res.status, 0, `a healthy daemon must stop without an identity query: ${res.stderr}`);
  assert.equal(res.stdout.trim(), "true");
  await waitFor(() => !isPidAlive(info.pid), 10_000, "the daemon to exit");
  assert.equal(readDaemonInfo(dataDir), null);
});

test("ensureDaemon refuses to spawn when it cannot confirm what the hung pid is", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "mute-daemon.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const hung = spawn(process.execPath, [script, dataDir, ...brokerArgs(dataDir)], { stdio: "ignore" });
  t.after(() => {
    killQuietly(hung.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "mute daemon.json");
  const emptyBin = path.join(iso.dirs.root, "empty-bin");
  fs.mkdirSync(emptyBin);
  const harness = path.join(iso.dirs.root, "ensure-harness.mjs");
  fs.writeFileSync(
    harness,
    `
import { ensureDaemon } from ${JSON.stringify(LIFECYCLE_URL)};
try {
  await ensureDaemon(process.argv[2], process.argv[3], ${JSON.stringify(BIN)});
  console.log("spawned");
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
`
  );
  const res = runNode(harness, [iso.dirs.brokerHome, dataDir], { env: envWithoutTools(iso.env, emptyBin), timeoutMs: 30_000 });
  assert.equal(res.timedOut, false);
  assert.equal(res.status, 2, `expected a refusal: ${res.stdout} ${res.stderr}`);
  assert.match(res.stderr, new RegExp(`${oldInfo.pid}`));
  assert.equal(isPidAlive(oldInfo.pid), true, "an unconfirmed pid was killed");
  assert.equal(readDaemonInfo(dataDir)?.pid, oldInfo.pid, "daemon.json was replaced by a second daemon");
});

const NOT_OK_DAEMON = FAKE_DAEMON.replace('JSON.stringify({ ok: true, version })', 'JSON.stringify({ ok: false, version })');

test("ensureDaemon does not drop daemon.json while a pid that answers ok:false is alive", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "not-ok-daemon.mjs");
  fs.writeFileSync(script, NOT_OK_DAEMON);
  const sick = spawn(process.execPath, [script, dataDir, BROKER_VERSION, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(sick.pid);
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "not-ok daemon.json");
  const fresh = await ensureDaemon(iso.dirs.brokerHome, dataDir, BIN);
  assert.equal(isPidAlive(oldInfo.pid), false, "the ok:false daemon was orphaned alive after its daemon.json was dropped");
  assert.notEqual(fresh.pid, oldInfo.pid);
  assert.equal(isPidAlive(fresh.pid), true);
  assert.equal(await stopDaemon(dataDir), true);
});

const TREE_DAEMON = FAKE_DAEMON.replace(
  "setInterval",
  `import { spawn } from "node:child_process";
const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true, detached: true });
fs.writeFileSync(path.join(dataDir, "child.pid"), String(kid.pid));
setInterval`
);

test("the win32 hard kill takes the daemon's child process down too", { skip: POSIX && "taskkill /T is win32-only; POSIX escalation signals the pid directly" }, async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "tree-daemon.mjs");
  fs.writeFileSync(script, TREE_DAEMON);
  const daemon = spawn(process.execPath, [script, dataDir, BROKER_VERSION, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
  let kidPid;
  t.after(() => {
    killQuietly(daemon.pid);
    killQuietly(kidPid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "tree daemon.json");
  kidPid = Number(await waitFor(() => {
    try {
      return fs.readFileSync(path.join(dataDir, "child.pid"), "utf8");
    } catch {
      return null;
    }
  }, 10_000, "child.pid"));
  assert.ok(isPidAlive(kidPid));
  assert.equal(await stopDaemon(dataDir), true);
  assert.equal(isPidAlive(info.pid), false);
  await waitFor(() => !isPidAlive(kidPid), 10_000, "the daemon's child to die with it");
});

test("stopDaemon and ensureDaemon never kill the broker daemon of another data dir that reused the recorded pid", async (t) => {
  const isoA = isolatedEnv();
  const isoB = isolatedEnv();
  const dataA = isoA.dirs.brokerData;
  const dataB = isoB.dirs.brokerData;
  t.after(() => {
    killQuietly(readDaemonInfo(dataB)?.pid);
    killQuietly(readDaemonInfo(dataA)?.pid);
    isoA.cleanup();
    isoB.cleanup();
  });
  const started = runNode(BIN, ["status"], { env: isoB.env, timeoutMs: 30_000 });
  assert.equal(started.status, 0, started.stderr);
  const infoB = readDaemonInfo(dataB);
  assert.ok(isPidAlive(infoB?.pid), "the CLI started daemon B");
  const staleA = { pid: infoB.pid, port: 1, token: "dead-token", version: BROKER_VERSION };
  fs.mkdirSync(dataA, { recursive: true });
  fs.writeFileSync(path.join(dataA, "daemon.json"), JSON.stringify(staleA));

  assert.equal(await stopDaemon(dataA), false);
  assert.equal(isPidAlive(infoB.pid), true, "stopDaemon(A) killed the daemon of data dir B");
  assert.equal(readDaemonInfo(dataA), null, "A's stale daemon.json was kept");

  fs.writeFileSync(path.join(dataA, "daemon.json"), JSON.stringify(staleA));
  const freshA = await ensureDaemon(isoA.dirs.brokerHome, dataA, BIN);
  assert.equal(isPidAlive(infoB.pid), true, "ensureDaemon(A) killed the daemon of data dir B");
  assert.notEqual(freshA.pid, infoB.pid);
  assert.equal(isPidAlive(freshA.pid), true, "A's own daemon is running");
  assert.equal(readDaemonInfo(dataB)?.pid, infoB.pid, "B's daemon.json is untouched");
  assert.equal(await stopDaemon(dataA), true);
  assert.equal(isPidAlive(infoB.pid), true, "stopping A's daemon left B running");
});

test("a broker daemon whose --data-dir only starts with this data dir counts as another daemon", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "prefix-daemon.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const decoy = spawn(process.execPath, [script, dataDir, BIN, "daemon", "--data-dir", `${path.resolve(dataDir)}2`], {
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(() => {
    killQuietly(decoy.pid);
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "prefix daemon.json");
  const fresh = await ensureDaemon(iso.dirs.brokerHome, dataDir, BIN);
  assert.equal(isPidAlive(oldInfo.pid), true, "the daemon of the prefix-sharing data dir was killed");
  assert.notEqual(fresh.pid, oldInfo.pid);
  assert.equal(isPidAlive(fresh.pid), true);
  assert.equal(await stopDaemon(dataDir), true);
});

test("a broker command line without --data-dir is never killed and never replaced", async (t) => {
  const iso = isolatedEnv();
  const dataDir = iso.dirs.brokerData;
  const script = path.join(iso.dirs.root, "old-daemon.mjs");
  fs.writeFileSync(script, MUTE_DAEMON);
  const old = spawn(process.execPath, [script, dataDir, BIN, "daemon"], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(old.pid);
    killQuietly(readDaemonInfo(dataDir)?.pid);
    iso.cleanup();
  });
  const oldInfo = await waitFor(() => readDaemonInfo(dataDir), 10_000, "old daemon.json");
  await assert.rejects(ensureDaemon(iso.dirs.brokerHome, dataDir, BIN), new RegExp(`cannot confirm that pid ${oldInfo.pid} `));
  assert.equal(isPidAlive(oldInfo.pid), true, "an unconfirmable daemon was killed");
  assert.equal(readDaemonInfo(dataDir)?.pid, oldInfo.pid, "daemon.json was replaced by a second daemon");
  assert.equal(await stopDaemon(dataDir), false);
  assert.equal(isPidAlive(oldInfo.pid), true);
  assert.equal(readDaemonInfo(dataDir)?.pid, oldInfo.pid, "stopDaemon dropped the daemon.json of an unconfirmable daemon");
});

test("a data dir with spaces is matched, quoted or not, and never by a longer sibling", async (t) => {
  const iso = isolatedEnv();
  const dataDir = path.join(iso.dirs.root, "data dir with spaces");
  fs.mkdirSync(dataDir, { recursive: true });
  const script = path.join(iso.dirs.root, "spaced-daemon.mjs");
  fs.writeFileSync(script, FAKE_DAEMON);
  const child = spawn(process.execPath, [script, dataDir, BROKER_VERSION, ...brokerArgs(dataDir)], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    killQuietly(child.pid);
    iso.cleanup();
  });
  const info = await waitFor(() => readDaemonInfo(dataDir), 10_000, "spaced daemon.json");
  assert.equal(await stopDaemon(dataDir), true);
  assert.equal(isPidAlive(info.pid), false, "a daemon of a data dir with spaces was not recognised");
});
