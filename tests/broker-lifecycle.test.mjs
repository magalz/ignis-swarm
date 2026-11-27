import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemonInfo } from "../scripts/broker/lifecycle.mjs";
import { truncateContentBlocks } from "../scripts/broker/spill.mjs";
import { isolatedEnv, mkTemp, runNode } from "./helpers.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ignis-broker.mjs");
const POSIX = process.platform !== "win32";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopDaemonFor(iso) {
  const info = readDaemonInfo(iso.dirs.brokerData);
  runNode(BIN, ["stop"], { env: iso.env, timeoutMs: 15_000 });
  if (info?.pid && pidAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {}
  }
}

test("a lazily started daemon does not hold the folder it was started from", (t) => {
  const iso = isolatedEnv();
  const start = mkTemp("ignis-life-cwd-");
  t.after(() => {
    stopDaemonFor(iso);
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
    t.diagnostic("daemon cwd assertion skipped: no /proc on this platform");
  }
});

test("the data dir is created private and an existing open one is tightened", { skip: !POSIX && "POSIX modes only" }, (t) => {
  const iso = isolatedEnv();
  t.after(() => {
    stopDaemonFor(iso);
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
    runNode(BIN, ["stop"], { env, timeoutMs: 15_000 });
    const info = readDaemonInfo(fresh);
    if (info?.pid && pidAlive(info.pid)) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {}
    }
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
