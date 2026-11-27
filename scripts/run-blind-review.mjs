#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePlatformCommand } from "./broker/adapters.mjs";
import { brokerDataDir, brokerHome } from "./broker/config.mjs";
import { defaultOnboardingState, detectCli, loadOnboardingState } from "./broker/onboarding.mjs";
import { recordReviewState, reviewStatePath } from "./broker/review-state.mjs";
import { collectChanges, gitToplevel, headSha } from "./lib/git-changes.mjs";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_DIFF_BYTES = 20 * 1024 * 1024;
const MERGE_BASE_TIMEOUT_MS = 10_000;
const DIFF_TIMEOUT_MS = 30_000;
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const SMOKE_PROMPT = "Reply with the exact word: OK";
const BLIND_REVIEW_PROMPT = [
  "You are an independent blind code reviewer.",
  "Review ONLY the unified git diff provided on stdin.",
  "Identify correctness bugs, edge cases, security vulnerabilities, race conditions, and contract violations.",
  "Do not assume external context or invent requirements not visible in the diff.",
  "Report concrete findings with file paths and line references, or state clearly if no issues are found.",
  "End your answer with exactly one final line, either Status: PASS or Status: ISSUES.",
  "Use Status: PASS when you found no HIGH or MEDIUM issues, otherwise use Status: ISSUES.",
].join(" ");
const VERDICT_LINE =
  /^[ \t]*(?:>[ \t]*|[-*+][ \t]+)*[*_`]*[ \t]*Status[ \t]*[*_`]*[ \t]*:[ \t*_`]*(PASS|ISSUES)(?![A-Za-z0-9])(.*)$/i;
const VERDICT_TEMPLATE_TAIL = /^[\s*_`]*[|/]|\b(?:PASS|ISSUES)\b/;
const NO_VERDICT_DETAIL_CHARS = 200;

const VALID_BACKENDS = new Set(["auto", "native", "claude", "codex"]);

const VALUE_FLAG_MAP = {
  "--base": "base",
  "--cwd": "cwd",
  "--backend": "backend",
  "--model": "model",
  "--effort": "effort",
};

export function parseArgs(argv) {
  const opts = {
    base: null,
    cwd: process.cwd(),
    backend: "auto",
    fallback: false,
    model: null,
    effort: null,
    timeoutMs: null,
    json: false,
    smokeTest: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (Object.hasOwn(VALUE_FLAG_MAP, arg)) {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
      opts[VALUE_FLAG_MAP[arg]] = argv[++i];
    } else if (arg === "--timeout-ms") {
      if (i + 1 >= argv.length) throw new Error("missing value for --timeout-ms");
      opts.timeoutMs = Number(argv[++i]);
    } else if (arg === "--fallback") {
      opts.fallback = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--smoke-test") {
      opts.smokeTest = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!VALID_BACKENDS.has(opts.backend)) {
    throw new Error(`unsupported backend: ${opts.backend}`);
  }

  if (opts.timeoutMs === null || Number.isNaN(opts.timeoutMs) || opts.timeoutMs <= 0) {
    opts.timeoutMs = opts.smokeTest ? DEFAULT_SMOKE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  }

  return opts;
}

export function buildClaudeArgs(prompt, model, effort, mcpConfigPath) {
  return [
    "-p",
    prompt,
    "--model",
    model || "opus",
    "--effort",
    effort || "high",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--no-session-persistence",
  ];
}

export function buildCodexArgs(model) {
  return [
    "exec",
    ...(model ? ["-m", model] : []),
    "--sandbox",
    "read-only",
    "-c",
    "approval_policy=never",
    "-",
  ];
}

function maxDiffBytes() {
  const configured = Number(process.env.IGNIS_REVIEW_MAX_DIFF_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_DIFF_BYTES;
}

function resolveCommand(backend) {
  if (backend === "claude") {
    const override = (process.env.IGNIS_CLAUDE_CMD || "").trim();
    return override || "claude";
  }
  if (backend === "codex") {
    const override = (process.env.IGNIS_CODEX_CMD || "").trim();
    return override || "codex";
  }
  throw new Error(`unsupported backend: ${backend}`);
}

function invokeCli(cmd, args, { cwd, input, timeoutMs }) {
  const isNodeScript = /\.(mjs|cjs|js)$/i.test(cmd);
  if (isNodeScript) {
    return spawnSync(process.execPath, [cmd, ...args], {
      cwd,
      input,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
  }

  const hasPathSep = cmd.includes("/") || cmd.includes("\\");
  let resolvedCmd = cmd;
  if (!hasPathSep) {
    const detected = detectCli(cmd);
    if (!detected.available) {
      const err = new Error(`CLI binary not found: ${cmd}`);
      err.code = "ENOENT";
      return { error: err, status: null, stdout: "", stderr: "" };
    }
    resolvedCmd = detected.path || cmd;
  }

  let resolved;
  try {
    resolved = resolvePlatformCommand(resolvedCmd, args, process.env);
  } catch (err) {
    return { error: err, status: null, stdout: "", stderr: "" };
  }
  return spawnSync(resolved.command, resolved.args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    ...resolved.options,
  });
}

function invokeBackend(backend, prompt, model, effort, invokeOptions) {
  const cmd = resolveCommand(backend);
  if (backend === "codex") {
    return invokeCli(cmd, buildCodexArgs(model), invokeOptions);
  }
  let configDir = null;
  try {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-mcp-"));
    const configPath = path.join(configDir, "mcp-config.json");
    fs.writeFileSync(configPath, EMPTY_MCP_CONFIG, "utf8");
    return invokeCli(cmd, buildClaudeArgs(prompt, model, effort, configPath), invokeOptions);
  } catch (err) {
    return { error: err, status: null, stdout: "", stderr: "" };
  } finally {
    if (configDir) {
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function openRepo(cwd, env) {
  if (!isDirectory(cwd)) {
    throw new Error(`--cwd is not a directory: ${cwd}`);
  }
  const top = gitToplevel(cwd, { env });
  if (top.notGit) {
    throw new Error(`${cwd} is not inside a git repository`);
  }
  if (top.error) {
    const code = top.error.code === "ENOENT" ? "git_failed" : top.error.code;
    return { error: { code, message: top.error.message } };
  }
  try {
    return { root: top.root, headSha: headSha(top.root, { env }) };
  } catch (err) {
    return { error: { code: "git_failed", message: err.message } };
  }
}

function extractGitDiff(base, cwd) {
  const trimmedBase = typeof base === "string" ? base.trim() : "";
  if (!trimmedBase) {
    throw new Error("--base <git-ref> is required");
  }
  if (trimmedBase.startsWith("-")) {
    throw new Error("--base must not start with '-'");
  }
  const env = gitEnv();
  const repo = openRepo(cwd, env);
  if (repo.error) {
    return { failure: `${repo.error.code}: ${repo.error.message}`, snapshot: { error: repo.error.message } };
  }
  const snapshot = { root: repo.root, headSha: repo.headSha };

  let diffBase = "HEAD";
  if (snapshot.headSha !== "unborn") {
    const mergeBaseRes = spawnSync("git", ["merge-base", trimmedBase, snapshot.headSha], {
      cwd: snapshot.root,
      env,
      encoding: "utf8",
      timeout: MERGE_BASE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (mergeBaseRes.error) {
      const code = mergeBaseRes.error.code === "ETIMEDOUT" ? "timeout" : "git_failed";
      return { failure: `${code}: git merge-base: ${mergeBaseRes.error.message}`, snapshot };
    }
    diffBase = (mergeBaseRes.stdout || "").trim();
    if (mergeBaseRes.status !== 0 || !diffBase) {
      const detail = (mergeBaseRes.stderr || "").trim() || `exit ${mergeBaseRes.status}`;
      throw new Error(`git merge-base failed for "${trimmedBase}": ${detail}`);
    }
  }

  const limit = maxDiffBytes();
  const changes = collectChanges(snapshot.root, {
    base: diffBase,
    maxBytes: limit,
    env,
    timeoutMs: DIFF_TIMEOUT_MS,
  });
  if (changes.error) {
    const detail =
      changes.error.code === "too_large" ? `diff is larger than ${limit} bytes` : changes.error.message;
    return { failure: `${changes.error.code}: ${detail}`, snapshot };
  }
  return { diff: changes.diff, snapshot };
}

function runSmokeTest(opts) {
  if (opts.backend !== "claude" && opts.backend !== "codex") {
    throw new Error("--smoke-test requires --backend claude|codex");
  }
  const effectiveModel = opts.backend === "claude" ? opts.model || "opus" : opts.model || null;
  const input = opts.backend === "codex" ? SMOKE_PROMPT : "";

  const res = invokeBackend(opts.backend, SMOKE_PROMPT, effectiveModel, opts.effort || "high", {
    cwd: opts.cwd,
    input,
    timeoutMs: opts.timeoutMs,
  });

  if (res.error) {
    return {
      ok: false,
      backend: opts.backend,
      model: effectiveModel,
      output: "",
      stderr: res.error.message,
    };
  }

  const output = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();
  const ok = res.status === 0 && /\bOK\b/i.test(output);

  return {
    ok,
    backend: opts.backend,
    model: effectiveModel,
    output,
    stderr,
  };
}

function parseVerdict(output) {
  let verdict = null;
  for (const line of output.split(/\r?\n/)) {
    const match = VERDICT_LINE.exec(line);
    if (match && !VERDICT_TEMPLATE_TAIL.test(match[2])) verdict = match[1].toUpperCase();
  }
  return verdict;
}

function gitEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE)$/i.test(key))
  );
}

function reviewStatus(result) {
  if (result.fallbackToNative === true) return "fallback";
  return result.diffBytes === 0 ? "empty" : "reviewed";
}

function persistState(snapshot, result) {
  if (snapshot.error) return snapshot.error;
  try {
    const status = reviewStatus(result);
    recordReviewState(brokerDataDir(brokerHome()), snapshot.root, {
      status,
      reason: status === "fallback" ? result.reason || null : null,
      headSha: snapshot.headSha,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function stateHintPath(cwd) {
  const dataDir = brokerDataDir(brokerHome());
  const top = gitToplevel(cwd, { env: gitEnv() });
  return top.root ? reviewStatePath(dataDir, top.root) : path.dirname(reviewStatePath(dataDir, cwd));
}

function withState(snapshot, result, persist = true) {
  if (!persist) return result;
  const stateError = persistState(snapshot, result);
  return stateError === null ? result : { ...result, stateError };
}

export function runBlindReview(opts) {
  if (!VALID_BACKENDS.has(opts.backend)) {
    throw new Error(`unsupported backend: ${opts.backend}`);
  }
  if (opts.smokeTest) {
    return runSmokeTest(opts);
  }

  let onboarding;
  try {
    onboarding = loadOnboardingState(brokerDataDir(brokerHome()));
  } catch {
    onboarding = defaultOnboardingState();
  }
  const routing = onboarding.reviewRouting || {};
  const shouldPersist = opts.backend === "auto" || opts.backend === routing.headlessBackend;

  let targetBackend = opts.backend;
  let effectiveModel = opts.model;
  let effectiveEffort = opts.effort || routing.effort || "high";

  if (targetBackend === "native") {
    return {
      useNative: true,
      fallbackToNative: false,
      fallbackBackend: null,
      reason: "backend=native",
    };
  }

  if (targetBackend === "auto") {
    const strategy = routing.strategy || "antigravity_gemini_only";
    if (strategy === "antigravity_gemini_only") {
      return {
        useNative: true,
        fallbackToNative: false,
        fallbackBackend: null,
        reason: "strategy=antigravity_gemini_only",
      };
    }
    if (strategy === "antigravity_first" && !opts.fallback) {
      return {
        useNative: true,
        fallbackToNative: false,
        fallbackBackend: routing.headlessBackend || null,
        reason: "strategy=antigravity_first",
      };
    }
    if (strategy === "antigravity_first" || strategy === "headless_always") {
      targetBackend = routing.headlessBackend;
      if (!effectiveModel) {
        effectiveModel = routing.headlessModel || null;
      }
    }
  }

  if (!opts.base || !String(opts.base).trim()) {
    throw new Error("--base <git-ref> is required");
  }

  const extracted = extractGitDiff(opts.base, opts.cwd);
  if (extracted.failure) {
    return withState(
      extracted.snapshot,
      {
        useNative: true,
        fallbackToNative: true,
        reason: `diff extraction failed: ${extracted.failure}`,
        base: opts.base,
      },
      shouldPersist
    );
  }
  const diff = extracted.diff;
  const diffBytes = Buffer.byteLength(diff, "utf8");

  if (diffBytes === 0) {
    return withState(
      extracted.snapshot,
      {
        useNative: false,
        fallbackToNative: false,
        backend: targetBackend || null,
        model: effectiveModel || null,
        base: opts.base,
        diffBytes: 0,
        output: "No changes found in diff.\n",
        stderr: "",
      },
      shouldPersist
    );
  }

  if (targetBackend !== "claude" && targetBackend !== "codex") {
    return withState(
      extracted.snapshot,
      {
        useNative: true,
        fallbackToNative: true,
        reason: `invalid or unconfigured headless backend: ${String(targetBackend)}`,
        base: opts.base,
        diffBytes,
      },
      shouldPersist
    );
  }

  const resolvedModel = targetBackend === "claude" ? effectiveModel || "opus" : effectiveModel || null;
  const stdinPayload =
    targetBackend === "claude" ? diff : `${BLIND_REVIEW_PROMPT}\n\n${diff}`;

  const res = invokeBackend(targetBackend, BLIND_REVIEW_PROMPT, resolvedModel, effectiveEffort, {
    cwd: opts.cwd,
    input: stdinPayload,
    timeoutMs: opts.timeoutMs,
  });

  if (res.error) {
    return withState(
      extracted.snapshot,
      {
        useNative: true,
        fallbackToNative: true,
        reason: res.error.message,
        base: opts.base,
        diffBytes,
      },
      shouldPersist
    );
  }

  if (res.status !== 0) {
    const detail = ((res.stderr || "").trim() || (res.stdout || "").trim()).slice(0, 400);
    return withState(
      extracted.snapshot,
      {
        useNative: true,
        fallbackToNative: true,
        reason: `${targetBackend} exited with status ${res.status}: ${detail}`,
        base: opts.base,
        diffBytes,
      },
      shouldPersist
    );
  }

  const output = res.stdout || "";
  const verdict = parseVerdict(output);
  if (verdict === null) {
    const snippet = output.replace(/\s+/g, " ").trim().slice(0, NO_VERDICT_DETAIL_CHARS);
    const detail = snippet ? `no Status line): ${snippet}` : "empty output)";
    return withState(
      extracted.snapshot,
      {
        useNative: true,
        fallbackToNative: true,
        reason: `headless reviewer returned no verdict (${detail}`,
        base: opts.base,
        diffBytes,
      },
      shouldPersist
    );
  }

  return withState(
    extracted.snapshot,
    {
      useNative: false,
      fallbackToNative: false,
      backend: targetBackend,
      model: resolvedModel,
      base: opts.base,
      diffBytes,
      verdict,
      output,
      stderr: res.stderr || "",
    },
    shouldPersist
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = runBlindReview(opts);
  if (opts.json || opts.smokeTest || result.useNative) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(result.output || "");
  }
  if (result.stateError) {
    process.stderr.write(
      `review state could not be recorded at ${stateHintPath(opts.cwd)}: ${result.stateError}\n`
    );
  }
}

function canonicalPath(file) {
  const real = fs.realpathSync.native(file);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isEntrypoint = isMainModule();

if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
