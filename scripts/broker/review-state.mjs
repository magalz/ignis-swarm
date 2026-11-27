import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gitToplevel, headSha } from "../lib/git-changes.mjs";

export const REVIEW_STATE_TTL_MS = 10 * 60 * 1000;

const STATUSES = new Set(["fallback", "reviewed", "empty"]);
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 5;
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

export function normalizeWorkspaceKey(dir) {
  const resolved = path.resolve(dir);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function statePathForKey(dataDir, key) {
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(dataDir, "blind-review", `${digest}.json`);
}

export function reviewStatePath(dataDir, root) {
  return statePathForKey(dataDir, normalizeWorkspaceKey(root));
}

function pause(ms) {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRIES || !RETRYABLE_RENAME_CODES.has(err?.code)) throw err;
      pause(20 + Math.floor(Math.random() * 31));
    }
  }
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    return;
  }
}

function pruneStale(dir, keep) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      if (file === keep) continue;
      try {
        if (Math.abs(now - fs.statSync(file).mtimeMs) > PRUNE_AGE_MS) removeQuietly(file);
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}

export function recordReviewState(dataDir, root, { status, reason = null, headSha: sha, nowMs = Date.now() } = {}) {
  if (!STATUSES.has(status)) {
    throw new TypeError(`review state status must be one of ${[...STATUSES].join(", ")}`);
  }
  if (typeof sha !== "string" || sha === "") {
    throw new TypeError("review state headSha must be a non-empty string");
  }
  const key = normalizeWorkspaceKey(root);
  const record = { version: 1, key, status, reason, headSha: sha, timestampMs: nowMs };
  const file = statePathForKey(dataDir, key);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameWithRetry(temp, file);
  } catch (err) {
    removeQuietly(temp);
    throw err;
  }
  pruneStale(dir, file);
  return record;
}

export function readReviewState(dataDir, root) {
  const key = normalizeWorkspaceKey(root);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePathForKey(dataDir, key), "utf8"));
  } catch {
    return null;
  }
  const isRecord = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  return isRecord && parsed.key === key ? parsed : null;
}

function satisfies(record, currentSha, nowMs) {
  if (!record || !STATUSES.has(record.status) || record.headSha !== currentSha) return false;
  if (!Number.isFinite(record.timestampMs)) return false;
  const age = nowMs - record.timestampMs;
  return age >= 0 && age <= REVIEW_STATE_TTL_MS;
}

export function reviewGateDecision(dataDir, dirs, { nowMs = Date.now(), env } = {}) {
  const supplied = (Array.isArray(dirs) ? dirs : []).filter((dir) => typeof dir === "string" && dir !== "");
  if (supplied.length === 0) {
    return { allow: false, missing: [], errors: [{ dir: null, message: "no workspace supplied" }] };
  }
  const errors = [];
  const missing = [];
  const roots = new Map();
  for (const dir of supplied) {
    const top = gitToplevel(dir, { env });
    if (top.notGit) continue;
    if (top.error) {
      errors.push({ dir, message: top.error.message });
      continue;
    }
    const key = normalizeWorkspaceKey(top.root);
    if (!roots.has(key)) roots.set(key, top.root);
  }
  let fallback = false;
  for (const root of roots.values()) {
    let current;
    try {
      current = headSha(root, { env });
    } catch (err) {
      errors.push({ dir: root, message: err.message });
      continue;
    }
    const record = readReviewState(dataDir, root);
    if (!satisfies(record, current, nowMs)) {
      missing.push(root);
    } else if (record.status === "fallback") {
      fallback = true;
    }
  }
  return { allow: errors.length === 0 && missing.length === 0 && fallback, missing, errors };
}
