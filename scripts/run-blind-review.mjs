#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePlatformCommand } from "./broker/adapters.mjs";
import { brokerDataDir, brokerHome } from "./broker/config.mjs";
import {
  blindReviewStatePath,
  defaultOnboardingState,
  detectCli,
  loadOnboardingState,
  recordBlindReviewState,
} from "./broker/onboarding.mjs";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_DIFF_BYTES = 20 * 1024 * 1024;
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const SMOKE_PROMPT = "Reply with the exact word: OK";
const BLIND_REVIEW_PROMPT = [
  "You are an independent blind code reviewer.",
  "Review ONLY the unified git diff provided on stdin.",
  "Identify correctness bugs, edge cases, security vulnerabilities, race conditions, and contract violations.",
  "Do not assume external context or invent requirements not visible in the diff.",
  "Report concrete findings with file paths and line references, or state clearly if no issues are found.",
].join(" ");

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
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--no-session-persistence",
  ];
}

export function buildCodexArgs(model) {
  return [
    ...(model ? ["-m", model] : []),
    "exec",
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

function extractGitDiff(base, cwd) {
  const trimmedBase = typeof base === "string" ? base.trim() : "";
  if (!trimmedBase) {
    throw new Error("--base <git-ref> is required");
  }
  if (trimmedBase.startsWith("-")) {
    throw new Error("--base must not start with '-'");
  }
  const mergeBaseRes = spawnSync("git", ["merge-base", trimmedBase, "HEAD"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (mergeBaseRes.error) {
    return { failure: `git merge-base: ${mergeBaseRes.error.message}` };
  }
  const mergeBase = (mergeBaseRes.stdout || "").trim();
  if (mergeBaseRes.status !== 0 || !mergeBase) {
    const detail = (mergeBaseRes.stderr || "").trim() || `exit ${mergeBaseRes.status}`;
    throw new Error(`git merge-base failed for "${trimmedBase}": ${detail}`);
  }

  const limit = maxDiffBytes();
  const res = spawnSync("git", ["diff", mergeBase, "--"], {
    cwd,
    encoding: "utf8",
    maxBuffer: limit,
    windowsHide: true,
  });
  if (res.error) {
    const detail =
      res.error.code === "ENOBUFS" ? `output is larger than ${limit} bytes` : res.error.message;
    return { failure: `git diff: ${detail}` };
  }
  if (res.status !== 0) {
    throw new Error(`git diff failed (exit ${res.status}): ${(res.stderr || "").trim()}`);
  }
  return { diff: res.stdout || "" };
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

function resolveWorkspaceRoot(cwd) {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  const top = (res.stdout || "").trim();
  if (!res.error && res.status === 0 && top) {
    return top;
  }
  return cwd;
}

function persistState(cwd, fallbackToNative, reason) {
  try {
    recordBlindReviewState(brokerDataDir(brokerHome()), resolveWorkspaceRoot(cwd), {
      fallbackToNative,
      reason,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function withState(cwd, result, persist = true) {
  if (!persist) return result;
  const stateError = persistState(
    cwd,
    result.fallbackToNative === true,
    result.fallbackToNative ? result.reason || null : null
  );
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
      opts.cwd,
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
      opts.cwd,
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
      opts.cwd,
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
      opts.cwd,
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
      opts.cwd,
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

  return withState(
    opts.cwd,
    {
      useNative: false,
      fallbackToNative: false,
      backend: targetBackend,
      model: resolvedModel,
      base: opts.base,
      diffBytes,
      output: res.stdout || "",
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
    if (result.useNative && result.stateError) {
      const statePath = blindReviewStatePath(brokerDataDir(brokerHome()));
      process.stderr.write(
        `fallback marker could not be recorded at ${statePath}: ${result.stateError}\n`
      );
    }
  } else {
    process.stdout.write(result.output || "");
  }
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
