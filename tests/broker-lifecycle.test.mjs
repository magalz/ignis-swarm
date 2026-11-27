import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, readDaemonInfo } from "../scripts/broker/lifecycle.mjs";
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
