// Shared test helpers. Importing this module has no side effects.
// Not a test file: `node --test tests/*.test.mjs` does not run it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_GIT_NAME = "Ignis Test";
const TEST_GIT_EMAIL = "ignis-test@example.invalid";

const ISOLATED_GIT_CONFIG = `[user]
\tname = ${TEST_GIT_NAME}
\temail = ${TEST_GIT_EMAIL}
[commit]
\tgpgsign = false
[init]
\tdefaultBranch = main
[core]
\tautocrlf = false
`;

// Variables a test must never inherit: the plugin's own settings, and the git
// variables that point at another repository or override the commit identity
// (set when the suite runs from inside a git hook).
const STRIPPED_ENV =
  /^(IGNIS_.*|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)))$/i;

export function mkTemp(prefix = "ignis-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Environment for a child process that cannot see the developer's machine:
 * no IGNIS_* variables, temp broker/codex/home directories and a temp global
 * git config. `overrides` are applied last.
 * @returns {{ env: Record<string, string>, dirs: { root: string, home: string, brokerHome: string, brokerData: string, codexHome: string }, cleanup: () => void }}
 */
export function isolatedEnv(overrides = {}) {
  const root = mkTemp("ignis-iso-");
  const dirs = {
    root,
    home: path.join(root, "home"),
    brokerHome: path.join(root, "broker-home"),
    brokerData: path.join(root, "broker-data"),
    codexHome: path.join(root, "codex-home"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const gitConfig = path.join(root, "gitconfig");
  fs.writeFileSync(gitConfig, ISOLATED_GIT_CONFIG);

  const isolated = {
    IGNIS_BROKER_HOME: dirs.brokerHome,
    IGNIS_BROKER_DATA: dirs.brokerData,
    CODEX_HOME: dirs.codexHome,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: dirs.home,
    USERPROFILE: dirs.home,
  };
  // Windows environment names are case-insensitive: drop case variants too.
  const replaced = new Set(Object.keys(isolated).map((key) => key.toUpperCase()));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIPPED_ENV.test(key) && !replaced.has(key.toUpperCase())) env[key] = value;
  }
  Object.assign(env, isolated, overrides);

  return {
    env,
    dirs,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Run git in `cwd`; returns trimmed stdout and throws with the command and stderr on any failure. */
export function runGit(cwd, args, { env } = {}) {
  const res = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
  if (res.error || res.status !== 0) {
    const detail = [res.error?.message, res.stderr?.trim()].filter(Boolean).join(": ");
    throw new Error(`git ${args.join(" ")} failed (exit ${res.status}): ${detail}`);
  }
  return res.stdout.trim();
}

/**
 * Create a git repository in `dir` on branch main, write `files` (relative path
 * to content) and, unless `commit` is false, record them in one commit. The repo
 * carries its own identity and commit.gpgsign=false, so it commits even when
 * `env` is not isolated.
 */
export function initGitRepo(dir, { env, commit = true, files = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "--initial-branch=main"], { env });
  runGit(dir, ["config", "user.name", TEST_GIT_NAME], { env });
  runGit(dir, ["config", "user.email", TEST_GIT_EMAIL], { env });
  runGit(dir, ["config", "commit.gpgsign", "false"], { env });
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  if (commit) {
    runGit(dir, ["add", "-A"], { env });
    runGit(dir, ["commit", "--allow-empty", "-m", "initial commit"], { env });
  }
  return dir;
}

let mockServerCount = 0;

/**
 * Write a newline-delimited JSON-RPC MCP server script into `dir` and return its path.
 * It answers initialize, tools/list (one tool, "echo") and tools/call; echo returns
 * `${label}:${process.cwd()}` as content[0] and the JSON-encoded arguments as content[1].
 * - banner: print a non-JSON line on stdout at startup
 * - crashOnFirstCallMarker: path of a marker file; the first tools/call that finds
 *   no marker creates it and exits 1
 * - logPidFile: append the process pid to this file at startup
 */
export function writeMockStdioServer(dir, { label = "mock", crashOnFirstCallMarker, banner = true, logPidFile } = {}) {
  const config = {
    label,
    marker: crashOnFirstCallMarker ?? null,
    banner: Boolean(banner),
    pidFile: logPidFile ?? null,
  };
  const script = path.join(dir, `mock-stdio-${label.replace(/[^\w.-]/g, "_")}-${++mockServerCount}.mjs`);
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import readline from "node:readline";
const config = ${JSON.stringify(config)};
if (config.pidFile) fs.appendFileSync(config.pidFile, process.pid + "\\n");
if (config.banner) process.stdout.write("non-json startup banner\\n");
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ id: msg.id, result: { tools: [{ name: "echo", description: "Echo the label, cwd and arguments.", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") {
    if (config.marker && !fs.existsSync(config.marker)) {
      fs.writeFileSync(config.marker, "1");
      process.exit(1);
    }
    if (msg.params?.name !== "echo") {
      send({ id: msg.id, error: { code: -32602, message: "Unknown tool: " + msg.params?.name } });
      return;
    }
    const text = config.label + ":" + process.cwd();
    send({ id: msg.id, result: { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(msg.params.arguments ?? {}) }], isError: false } });
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
});
`
  );
  return script;
}

/**
 * Run a node script synchronously. A child that outlives `timeoutMs` is killed:
 * status is null and timedOut is true. Any other spawn failure throws.
 */
export function runNode(scriptPath, args = [], { input, env, cwd, timeoutMs = 15_000 } = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    input,
    env,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const timedOut = res.error?.code === "ETIMEDOUT";
  if (res.error && !timedOut) throw res.error;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", timedOut };
}

/** Write `<dataDir>/onboarding.json` as a completed onboarding, with `state` merged over the defaults. Returns the file path. */
export function writeOnboardingState(dataDir, state = {}) {
  const merged = {
    version: 1,
    completed: true,
    skipped: false,
    completedAt: "2026-01-01T00:00:00.000Z",
    brokerManagedServers: [],
    tracker: { kind: "none", mcpServer: null },
    memtrace: { enabled: false },
    reviewRouting: {
      strategy: "antigravity_gemini_only",
      headlessBackend: null,
      headlessModel: null,
      effort: "high",
    },
    compaction: { transcriptThresholdKb: 550 },
    ...state,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "onboarding.json");
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
  return file;
}
