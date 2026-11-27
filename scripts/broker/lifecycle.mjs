import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
      signal: AbortSignal.timeout(400),
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
      signal: AbortSignal.timeout(1500),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return () => {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!isPidAlive(parsed.pid) || Date.now() - (parsed.ts || 0) > 15_000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 15_000) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch {}
      }
      await sleep(30);
    }
  }
  throw new Error("timed out acquiring ignis-broker daemon lock");
}

export async function stopDaemon(dataDir) {
  const info = readDaemonInfo(dataDir);
  if (!info) return false;
  if (!(await probeHealth(info))) {
    try {
      fs.rmSync(daemonInfoPath(dataDir), { force: true });
    } catch {}
    return false;
  }
  await requestShutdown(info);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await probeHealth(info)) && !isPidAlive(info.pid)) break;
    await sleep(40);
  }
  try {
    fs.rmSync(daemonInfoPath(dataDir), { force: true });
  } catch {}
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
  entryScript = path.resolve(entryScript);
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
      if (h?.ok) {
        await requestShutdown(recheck);
        const waitUntil = Date.now() + 2000;
        while (Date.now() < waitUntil) {
          if (!(await probeHealth(recheck))) break;
          await sleep(40);
        }
      }
      try {
        fs.rmSync(daemonInfoPath(dataDir), { force: true });
      } catch {}
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

    const deadline = Date.now() + 6000;
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
