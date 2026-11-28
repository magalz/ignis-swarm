import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWindowsExecutable } from "./adapters.mjs";
import { isPlainObject, writePrivateFileAtomic } from "../lib/common.mjs";
import { describeServers, discoverLocalConfig, discoverMcpConfig } from "./config.mjs";
import { parseJsonSafely, readTrustedLocalConfig } from "./trust.mjs";

const VALID_TRACKER_KINDS = new Set(["none", "linear", "itsaplan", "github", "other"]);
const VALID_REVIEW_STRATEGIES = new Set([
  "antigravity_gemini_only",
  "antigravity_first",
  "headless_always",
]);

const VALID_HEADLESS_BACKENDS = new Set(["claude", "codex"]);
const STATE_KEYS = new Set([
  "version",
  "completed",
  "skipped",
  "completedAt",
  "brokerManagedServers",
  "tracker",
  "trackers",
  "memtrace",
  "reviewRouting",
  "compaction",
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
  writePrivateFileAtomic(onboardingPath(dataDir), JSON.stringify(next, null, 2));
  return next;
}

function oneOf(set) {
  return `one of: ${[...set].join(", ")}`;
}

function validateTracker(entry, where) {
  if (!isPlainObject(entry)) return `${where} must be an object`;
  if (entry.kind !== undefined && !VALID_TRACKER_KINDS.has(entry.kind)) {
    return `${where}.kind must be ${oneOf(VALID_TRACKER_KINDS)}`;
  }
  if (entry.mcpServer !== undefined && entry.mcpServer !== null && typeof entry.mcpServer !== "string") {
    return `${where}.mcpServer must be a string or null`;
  }
  return null;
}

function validateSection(value, where, checks) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return `${where} must be an object`;
  for (const [key, ok, expected] of checks) {
    if (value[key] !== undefined && !ok(value[key])) return `${where}.${key} must be ${expected}`;
  }
  return null;
}

const isString = (v) => typeof v === "string";
const isStringOrNull = (v) => v === null || typeof v === "string";
const isBoolean = (v) => typeof v === "boolean";
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

function firstInputError(input) {
  for (const key of Object.keys(input)) {
    if (!STATE_KEYS.has(key)) return `unknown key ${key} (known keys: ${[...STATE_KEYS].join(", ")})`;
  }
  const flat = [
    ["version", isNumber, "a number"],
    ["completed", isBoolean, "a boolean"],
    ["skipped", isBoolean, "a boolean"],
    ["completedAt", isStringOrNull, "a string or null"],
    ["brokerManagedServers", (v) => Array.isArray(v) && v.every(isString), "an array of strings"],
  ];
  for (const [key, ok, expected] of flat) {
    if (input[key] !== undefined && !ok(input[key])) return `${key} must be ${expected}`;
  }
  if (input.tracker !== undefined) {
    const err = validateTracker(input.tracker, "tracker");
    if (err) return err;
  }
  if (input.trackers !== undefined) {
    if (!Array.isArray(input.trackers)) return "trackers must be an array of tracker objects";
    for (const [i, entry] of input.trackers.entries()) {
      const err = validateTracker(entry, `trackers[${i}]`);
      if (err) return err;
    }
  }
  return (
    validateSection(input.memtrace, "memtrace", [["enabled", isBoolean, "a boolean"]]) ||
    validateSection(input.reviewRouting, "reviewRouting", [
      ["strategy", (v) => VALID_REVIEW_STRATEGIES.has(v), oneOf(VALID_REVIEW_STRATEGIES)],
      [
        "headlessBackend",
        (v) => v === null || VALID_HEADLESS_BACKENDS.has(v),
        `null or ${oneOf(VALID_HEADLESS_BACKENDS)}`,
      ],
      ["headlessModel", isStringOrNull, "a string or null"],
      ["effort", isString, "a string"],
    ]) ||
    validateSection(input.compaction, "compaction", [["transcriptThresholdKb", isNumber, "a number"]])
  );
}

export function parseOnboardingInput(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.trim() === "") throw new Error("onboarding input is empty");
  const input = parseJsonSafely(source);
  if (!isPlainObject(input)) throw new Error("onboarding input must be a JSON object");
  const problem = firstInputError(input);
  if (problem) throw new Error(`invalid onboarding state: ${problem}`);
  return input;
}

export function saveOnboardingInput(dataDir, input) {
  const patch = { ...input };
  if (patch.completed === undefined) patch.completed = patch.skipped !== true;
  return saveOnboardingState(dataDir, patch);
}

export function skipOnboarding(dataDir) {
  return saveOnboardingState(dataDir, { skipped: true, completed: false });
}

export function resetOnboarding(dataDir) {
  const next = defaultOnboardingState();
  writePrivateFileAtomic(onboardingPath(dataDir), JSON.stringify(next, null, 2));
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

export function defaultMcpSourcePath(fromFlag) {
  return typeof fromFlag === "string"
    ? fromFlag
    : path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
}

function probeLocalBrokerConfig(dataDir, cwd) {
  const file = discoverLocalConfig(cwd);
  if (!file) return null;
  const read = readTrustedLocalConfig(dataDir, file);
  if (read.error) {
    return { path: read.path, trusted: false, servers: [], error: read.error.message };
  }
  return { path: read.path, trusted: read.status === "trusted", servers: describeServers(read.parsed) };
}

export function probeEnvironment(home, dataDir, fromMcpPath, codexHome, cwd) {
  const sourcePath = defaultMcpSourcePath(fromMcpPath || undefined);
  return {
    onboarding: loadOnboardingState(dataDir),
    discoveredMcps: discoverMcpConfig(sourcePath, home),
    clis: {
      claude: detectCli("claude"),
      codex: detectCli("codex"),
      memtrace: detectCli("memtrace"),
    },
    codex: probeCodexModels(codexHome),
    localBrokerConfig: probeLocalBrokerConfig(dataDir, cwd),
  };
}
