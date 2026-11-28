import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { killProcessTree } from "./adapters.mjs";
import { BROKER_VERSION } from "./config.mjs";

export function daemonInfoPath(dataDir) {
  return path.join(dataDir, "daemon.json");
}

export function daemonLockPath(dataDir) {
  return path.join(dataDir, "daemon.lock");
}

export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    if (fs.statSync(dir).mode & 0o077) fs.chmodSync(dir, 0o700);
  } catch {}
}

export function writeDaemonInfoAtomic(dataDir, info) {
  ensurePrivateDir(dataDir);
  const target = daemonInfoPath(dataDir);
  const tmp = path.join(dataDir, `daemon.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.rmSync(target, { force: true });
    } catch {}
    fs.renameSync(tmp, target);
  }
}

export function readDaemonInfo(dataDir) {
  try {
    const raw = fs.readFileSync(daemonInfoPath(dataDir), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function removeDaemonInfoIfOwner(dataDir, pid) {
  const info = readDaemonInfo(dataDir);
  if (info && info.pid === pid) {
    try {
      fs.rmSync(daemonInfoPath(dataDir), { force: true });
    } catch {}
  }
}

export async function probeHealth(info) {
  if (!info?.port || !info?.token) return null;
  try {
    const resp = await fetch(`http://127.0.0.1:${info.port}/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(HEALTH_PROBE_MS),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function requestShutdown(info) {
  if (!info?.port || !info?.token) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${info.port}/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(SHUTDOWN_REQUEST_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HEALTH_PROBE_MS = 400;
const SHUTDOWN_REQUEST_MS = 1500;
const SHUTDOWN_WAIT_MS = 3000;
const TERM_GRACE_MS = 1500;
const KILL_WAIT_MS = 1500;
const SPAWN_WAIT_MS = 6000;
const IDENTITY_QUERY_MS = process.platform === "win32" ? 15_000 : 5000;
const LOCK_MAX_HOLD_MS =
  HEALTH_PROBE_MS + IDENTITY_QUERY_MS + SHUTDOWN_REQUEST_MS + SHUTDOWN_WAIT_MS + TERM_GRACE_MS + KILL_WAIT_MS + SPAWN_WAIT_MS;
const LOCK_STALE_MS = 30_000;
const EVICT_GUARD_STALE_MS = 5000;
const LOCK_WAIT_MS = LOCK_STALE_MS + LOCK_MAX_HOLD_MS;

function readLockRaw(lockPath) {
  try {
    return fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

function isLockStale(lockPath, raw) {
  try {
    const parsed = JSON.parse(raw);
    return !isPidAlive(parsed.pid) || Date.now() - (parsed.ts || 0) > LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function evictStaleLock(lockPath, raw) {
  const guard = `${lockPath}.evict`;
  try {
    fs.closeSync(fs.openSync(guard, "wx"));
  } catch (err) {
    if (err?.code === "EEXIST") {
      try {
        if (Date.now() - fs.statSync(guard).mtimeMs > EVICT_GUARD_STALE_MS) fs.rmSync(guard, { force: true });
      } catch {}
    }
    return false;
  }
  try {
    if (readLockRaw(lockPath) === raw) fs.rmSync(lockPath, { force: true });
  } finally {
    try {
      fs.rmSync(guard, { force: true });
    } catch {}
  }
  return true;
}

export async function acquireLock(lockPath, timeoutMs = LOCK_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: crypto.randomBytes(8).toString("hex") });
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        if (readLockRaw(lockPath) !== content) return;
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const raw = readLockRaw(lockPath);
      if (raw !== null && isLockStale(lockPath, raw)) {
        if (evictStaleLock(lockPath, raw)) continue;
      }
      await sleep(30);
    }
  }
  throw new Error("timed out acquiring ignis-broker daemon lock");
}

async function waitUntilGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(40);
  }
  return true;
}

async function killAndWait(pid) {
  if (process.platform === "win32") {
    await killProcessTree(pid);
    return waitUntilGone(pid, KILL_WAIT_MS);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (await waitUntilGone(pid, TERM_GRACE_MS)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  return waitUntilGone(pid, KILL_WAIT_MS);
}

const BROKER_COMMAND = /ignis-broker\.mjs["']?\s+daemon(?:\s|$)/;

function queryCommandLine(pid) {
  const [command, args] =
    process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]]
      : ["ps", ["-ww", "-o", "command=", "-p", String(pid)]];
  return new Promise((resolve) => {
    execFile(command, args, { timeout: IDENTITY_QUERY_MS, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

async function pidIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "other";
  if (!isPidAlive(pid)) return "dead";
  const line = await queryCommandLine(pid);
  if (line === null) return isPidAlive(pid) ? "unknown" : "dead";
  return BROKER_COMMAND.test(line) ? "broker" : "other";
}

async function confirmedIdentity(pid) {
  const identity = await pidIdentity(pid);
  if (identity === "unknown") {
    throw new Error(`cannot confirm that pid ${pid} is an ignis-broker daemon, so it was left running`);
  }
  return identity;
}

function dropDaemonInfo(dataDir) {
  try {
    fs.rmSync(daemonInfoPath(dataDir), { force: true });
  } catch {}
}

function notExited(pid) {
  return new Error(`ignis-broker daemon pid ${pid} did not exit`);
}

async function shutdownAndKill(info) {
  await requestShutdown(info);
  if (await waitUntilGone(info.pid, SHUTDOWN_WAIT_MS)) return true;
  return killAndWait(info.pid);
}

export async function stopDaemon(dataDir) {
  const info = readDaemonInfo(dataDir);
  if (!info) return false;
  if (!(await probeHealth(info))) {
    const identity = await pidIdentity(info.pid);
    if (identity === "dead" || identity === "other") dropDaemonInfo(dataDir);
    return false;
  }
  const identity = await confirmedIdentity(info.pid);
  if (identity === "other") {
    dropDaemonInfo(dataDir);
    return false;
  }
  if (!(await shutdownAndKill(info))) throw notExited(info.pid);
  dropDaemonInfo(dataDir);
  return true;
}

export function parseSemver(version) {
  if (typeof version !== "string") return null;
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isDaemonVersionAcceptable(daemonVersion, clientVersion = BROKER_VERSION) {
  if (daemonVersion === clientVersion) return true;
  const d = parseSemver(daemonVersion);
  const c = parseSemver(clientVersion);
  if (!d || !c) return false;
  if (d[0] !== c[0]) return false;
  if (d[1] !== c[1]) return d[1] > c[1];
  return d[2] >= c[2];
}

export async function ensureDaemon(home, dataDir, entryScript) {
  home = path.resolve(home);
  dataDir = path.resolve(dataDir);
  const existing = readDaemonInfo(dataDir);
  if (existing) {
    const h = await probeHealth(existing);
    if (h?.ok && isDaemonVersionAcceptable(h.version, BROKER_VERSION)) {
      return existing;
    }
  }

  ensurePrivateDir(dataDir);
  const release = await acquireLock(daemonLockPath(dataDir));

  try {
    const recheck = readDaemonInfo(dataDir);
    if (recheck) {
      const h = await probeHealth(recheck);
      if (h?.ok && isDaemonVersionAcceptable(h.version, BROKER_VERSION)) {
        return recheck;
      }
      if (isPidAlive(recheck.pid) && (await confirmedIdentity(recheck.pid)) === "broker") {
        if (!h) {
          if (!(await killAndWait(recheck.pid))) throw notExited(recheck.pid);
        } else if (!(await shutdownAndKill(recheck))) {
          throw new Error(`could not stop the outdated ignis-broker daemon pid ${recheck.pid}`);
        }
      }
      dropDaemonInfo(dataDir);
    }

    const child = spawn(process.execPath, [entryScript, "daemon"], {
      cwd: dataDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        IGNIS_BROKER_HOME: home,
        IGNIS_BROKER_DATA: dataDir,
      },
    });
    child.unref();

    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      const info = readDaemonInfo(dataDir);
      if (info) {
        const h = await probeHealth(info);
        if (h?.ok && isDaemonVersionAcceptable(h.version, BROKER_VERSION)) {
          return info;
        }
      }
      await sleep(35);
    }

    throw new Error("timed out waiting for detached ignis-broker daemon to become healthy");
  } finally {
    release();
  }
}
