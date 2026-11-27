import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWindowsExecutable } from "./adapters.mjs";
import { discoverMcpConfig } from "./config.mjs";

const VALID_TRACKER_KINDS = new Set(["none", "linear", "itsaplan", "github", "other"]);
const VALID_REVIEW_STRATEGIES = new Set([
  "antigravity_gemini_only",
  "antigravity_first",
  "headless_always",
]);

export function onboardingPath(dataDir) {
  return path.join(dataDir, "onboarding.json");
}

export function defaultOnboardingState() {
  return {
    version: 1,
    completed: false,
    skipped: false,
    completedAt: null,
    brokerManagedServers: [],
    tracker: { kind: "none", mcpServer: null },
    trackers: [],
    memtrace: { enabled: false },
    reviewRouting: {
      strategy: "antigravity_gemini_only",
      headlessBackend: null,
      headlessModel: null,
      effort: "high",
    },
    compaction: { transcriptThresholdKb: 550 },
  };
}

function normalizeTrackerEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("invalid tracker entry");
  }
  const kind = entry.kind ?? "none";
  if (!VALID_TRACKER_KINDS.has(kind)) {
    throw new Error(`invalid tracker.kind: ${kind}`);
  }
  return {
    kind,
    mcpServer: typeof entry.mcpServer === "string" ? entry.mcpServer : null,
  };
}

function normalizeState(raw) {
  const base = defaultOnboardingState();
  if (!raw || typeof raw !== "object") return base;

  const hasTrackersArray = Array.isArray(raw.trackers);
  const rawTrackers = hasTrackersArray
    ? raw.trackers.map(normalizeTrackerEntry).filter((t) => t.kind !== "none")
    : null;

  let tracker;
  if (raw.tracker && typeof raw.tracker === "object") {
    tracker = normalizeTrackerEntry(raw.tracker);
  } else if (rawTrackers && rawTrackers.length > 0) {
    tracker = rawTrackers[0];
  } else {
    tracker = { ...base.tracker };
  }

  let trackers;
  if (rawTrackers !== null) {
    trackers = rawTrackers;
    if (tracker.kind === "none" && trackers.length > 0) {
      tracker = trackers[0];
    }
  } else {
    trackers = tracker.kind === "none" ? [] : [tracker];
  }

  const strategy = raw.reviewRouting?.strategy ?? base.reviewRouting.strategy;
  if (!VALID_REVIEW_STRATEGIES.has(strategy)) {
    throw new Error(`invalid reviewRouting.strategy: ${strategy}`);
  }

  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    completed: Boolean(raw.completed),
    skipped: Boolean(raw.skipped),
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
    brokerManagedServers: Array.isArray(raw.brokerManagedServers)
      ? raw.brokerManagedServers.map(String)
      : [],
    tracker,
    trackers,
    memtrace: {
      enabled: Boolean(raw.memtrace?.enabled),
    },
    reviewRouting: {
      strategy,
      headlessBackend:
        typeof raw.reviewRouting?.headlessBackend === "string"
          ? raw.reviewRouting.headlessBackend
          : null,
      headlessModel:
        typeof raw.reviewRouting?.headlessModel === "string"
          ? raw.reviewRouting.headlessModel
          : null,
      effort:
        typeof raw.reviewRouting?.effort === "string"
          ? raw.reviewRouting.effort
          : base.reviewRouting.effort,
    },
    compaction: {
      transcriptThresholdKb:
        typeof raw.compaction?.transcriptThresholdKb === "number"
          ? raw.compaction.transcriptThresholdKb
          : base.compaction.transcriptThresholdKb,
    },
  };
}

export function loadOnboardingState(dataDir) {
  const filePath = onboardingPath(dataDir);
  if (!fs.existsSync(filePath)) return defaultOnboardingState();
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeState(parsed);
}

export function saveOnboardingState(dataDir, patch = {}) {
  const current = loadOnboardingState(dataDir);
  const patchHasTrackers = Array.isArray(patch.trackers);
  const patchHasTracker = Boolean(patch.tracker && typeof patch.tracker === "object");

  let nextTrackers = current.trackers;
  let nextTracker = current.tracker;

  if (patchHasTrackers) {
    nextTrackers = patch.trackers.map(normalizeTrackerEntry).filter((t) => t.kind !== "none");
    nextTracker = patchHasTracker
      ? normalizeTrackerEntry({ ...current.tracker, ...patch.tracker })
      : nextTrackers[0] || { kind: "none", mcpServer: null };
  } else if (patchHasTracker) {
    nextTracker = normalizeTrackerEntry({ ...current.tracker, ...patch.tracker });
    nextTrackers = nextTracker.kind === "none" ? [] : [nextTracker];
  }

  const merged = {
    ...current,
    ...patch,
    tracker: nextTracker,
    trackers: nextTrackers,
    memtrace: {
      ...current.memtrace,
      ...(patch.memtrace && typeof patch.memtrace === "object" ? patch.memtrace : {}),
    },
    reviewRouting: {
      ...current.reviewRouting,
      ...(patch.reviewRouting && typeof patch.reviewRouting === "object"
        ? patch.reviewRouting
        : {}),
    },
    compaction: {
      ...current.compaction,
      ...(patch.compaction && typeof patch.compaction === "object" ? patch.compaction : {}),
    },
  };

  if (merged.completed) {
    merged.skipped = false;
    if (!merged.completedAt) {
      merged.completedAt = new Date().toISOString();
    }
  } else if (merged.skipped) {
    merged.completedAt = null;
  }

  const next = normalizeState(merged);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(onboardingPath(dataDir), JSON.stringify(next, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return next;
}

export function skipOnboarding(dataDir) {
  return saveOnboardingState(dataDir, { skipped: true, completed: false });
}

export function resetOnboarding(dataDir) {
  const next = defaultOnboardingState();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(onboardingPath(dataDir), JSON.stringify(next, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return next;
}

export function detectCli(cmd) {
  if (process.platform === "win32") {
    const resolved = resolveWindowsExecutable(cmd, process.env);
    const ext = path.extname(resolved).toLowerCase();
    const rawExts = (process.env.PATHEXT || ".EXE;.COM;.CMD;.BAT")
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const validExt = rawExts.includes(ext) || [".exe", ".com", ".cmd", ".bat"].includes(ext);
    try {
      if (validExt && fs.statSync(resolved).isFile()) {
        return { available: true, path: resolved };
      }
    } catch {}
    return { available: false, path: null };
  }

  const res = spawnSync("which", [cmd], {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout) {
    return { available: false, path: null };
  }
  const firstLine = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return { available: Boolean(firstLine), path: firstLine || null };
}

function compareModelSlugsDesc(a, b) {
  const tokensA = a.split(/(\d+)/);
  const tokensB = b.split(/(\d+)/);
  const len = Math.max(tokensA.length, tokensB.length);
  for (let i = 0; i < len; i += 1) {
    const ta = tokensA[i] ?? "";
    const tb = tokensB[i] ?? "";
    if (ta === tb) continue;
    const na = /^\d+$/.test(ta) ? Number(ta) : null;
    const nb = /^\d+$/.test(tb) ? Number(tb) : null;
    if (na !== null && nb !== null) {
      return nb - na;
    }
    return tb.localeCompare(ta);
  }
  return 0;
}

function parseRootModelFromToml(raw) {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const match = trimmed.match(/^model\s*=\s*(?:"([^"]+)"|'([^']+)')/);
    if (match) return match[1] || match[2] || null;
  }
  return null;
}

export function probeCodexModels(codexHome) {
  const resolvedHome =
    codexHome || (process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
  const solModels = [];
  const otherModels = [];
  let configDefaultModel = null;

  const cachePath = path.join(resolvedHome, "models_cache.json");
  if (fs.existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const models = Array.isArray(parsed.models) ? parsed.models : [];
      for (const m of models) {
        if (!m || typeof m.slug !== "string" || m.visibility === "hide") continue;
        if (/sol/i.test(m.slug)) {
          solModels.push(m.slug);
        } else {
          otherModels.push(m.slug);
        }
      }
      solModels.sort(compareModelSlugsDesc);
      otherModels.sort(compareModelSlugsDesc);
    } catch {}
  }

  const tomlPath = path.join(resolvedHome, "config.toml");
  if (fs.existsSync(tomlPath)) {
    try {
      configDefaultModel = parseRootModelFromToml(fs.readFileSync(tomlPath, "utf8"));
    } catch {}
  }

  return {
    codexHome: resolvedHome,
    solModels,
    otherModels,
    configDefaultModel,
  };
}

export function probeEnvironment(home, dataDir, fromMcpPath, codexHome) {
  const sourcePath =
    fromMcpPath || path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
  return {
    onboarding: loadOnboardingState(dataDir),
    discoveredMcps: discoverMcpConfig(sourcePath, home),
    clis: {
      claude: detectCli("claude"),
      codex: detectCli("codex"),
      memtrace: detectCli("memtrace"),
    },
    codex: probeCodexModels(codexHome),
  };
}

export const BLIND_REVIEW_FALLBACK_TTL_MS = 10 * 60 * 1000;

export function blindReviewStatePath(dataDir) {
  return path.join(dataDir, "blind-review-state.json");
}

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

const BLIND_REVIEW_LOCK_TIMEOUT_MS = 2500;
const BLIND_REVIEW_LOCK_STALE_MS = 5000;
const BLIND_REVIEW_LOCK_RETRY_MS = 10;
const LOCK_SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

function isSameOrAncestor(ancestor, descendant) {
  if (ancestor === descendant) return true;
  const prefix = ancestor.endsWith(path.sep) ? ancestor : `${ancestor}${path.sep}`;
  return descendant.startsWith(prefix);
}

function acquireBlindReviewLock(lockPath) {
  const deadline = Date.now() + BLIND_REVIEW_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > BLIND_REVIEW_LOCK_STALE_MS) {
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch (unlinkErr) {
            if (unlinkErr && unlinkErr.code === "ENOENT") continue;
          }
        }
      } catch (statErr) {
        if (statErr && statErr.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) {
        const timeoutErr = new Error(`timed out acquiring lock: ${lockPath}`);
        timeoutErr.code = "ETIMEDOUT";
        throw timeoutErr;
      }
      Atomics.wait(LOCK_SLEEP_VIEW, 0, 0, BLIND_REVIEW_LOCK_RETRY_MS);
    }
  }
}

function readBlindReviewState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(blindReviewStatePath(dataDir), "utf8"));
    if (raw && typeof raw === "object" && raw.workspaces && typeof raw.workspaces === "object") {
      return raw;
    }
  } catch {
    return { workspaces: {} };
  }
  return { workspaces: {} };
}

export function recordBlindReviewState(
  dataDir,
  cwd,
  { fallbackToNative, reason = null, nowMs = Date.now() },
) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = blindReviewStatePath(dataDir);
  const lockPath = `${target}.lock`;
  acquireBlindReviewLock(lockPath);
  try {
    const existing = readBlindReviewState(dataDir);
    const workspaces = {};
    for (const [key, entry] of Object.entries(existing.workspaces)) {
      const ts = entry?.timestampMs;
      if (Number.isFinite(ts) && nowMs - ts <= BLIND_REVIEW_FALLBACK_TTL_MS) {
        workspaces[key] = entry;
      }
    }
    workspaces[normalizeWorkspaceKey(cwd)] = {
      fallbackToNative: Boolean(fallbackToNative),
      timestampMs: nowMs,
      reason,
    };
    const state = { workspaces };
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    try {
      fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        fs.writeFileSync(target, payload, { encoding: "utf8", mode: 0o600 });
      } else {
        throw err;
      }
    }
    return state;
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

export function hasFreshNativeFallback(dataDir, dirs, nowMs = Date.now()) {
  const { workspaces } = readBlindReviewState(dataDir);
  const freshEntries = [];
  for (const [storedKey, entry] of Object.entries(workspaces)) {
    if (!storedKey || !storedKey.trim()) continue;
    if (!entry || typeof entry.fallbackToNative !== "boolean") continue;
    if (!Number.isFinite(entry.timestampMs)) continue;
    const delta = nowMs - entry.timestampMs;
    if (!(delta >= 0 && delta <= BLIND_REVIEW_FALLBACK_TTL_MS)) continue;
    freshEntries.push({
      key: normalizeWorkspaceKey(storedKey),
      fallbackToNative: entry.fallbackToNative,
      timestampMs: entry.timestampMs,
    });
  }
  if (freshEntries.length === 0) return false;
  return (dirs ?? []).some((dir) => {
    if (typeof dir !== "string" || !dir.trim()) return false;
    const normDir = normalizeWorkspaceKey(dir);
    let best = null;
    for (const entry of freshEntries) {
      if (!isSameOrAncestor(entry.key, normDir)) continue;
      if (
        !best ||
        entry.key.length > best.key.length ||
        (entry.key.length === best.key.length &&
          (entry.timestampMs > best.timestampMs ||
            (entry.timestampMs === best.timestampMs && !entry.fallbackToNative)))
      ) {
        best = entry;
      }
    }
    return best?.fallbackToNative === true;
  });
}
