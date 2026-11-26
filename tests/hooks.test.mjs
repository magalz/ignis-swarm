import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function runHook(scriptRelPath, inputObj, extraEnv = {}) {
  const scriptPath = path.join(PLUGIN_ROOT, scriptRelPath);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 8000,
    windowsHide: true,
  });
  assert.equal(res.status, 0, `Hook ${scriptRelPath} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  spawnSync("git", ["init"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, windowsHide: true });
}

test("pre-tool-use denies dangerous shortcuts and allows normal commands", () => {
  const denyNoVerify = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: 'git commit -m "wip" --no-verify' } },
  });
  assert.equal(denyNoVerify.decision, "deny");

  const denyForceMain = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "git push --force origin main" } },
  });
  assert.equal(denyForceMain.decision, "deny");

  const denyResetHard = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "git reset --hard HEAD~1" } },
  });
  assert.equal(denyResetHard.decision, "deny");

  const askForceLease = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "git push --force-with-lease origin feat/a" } },
  });
  assert.equal(askForceLease.decision, "ask");

  const allowTest = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
  });
  assert.equal(allowTest.decision, "allow");

  for (const dangerous of [
    "rm -fr /",
    "rm -r -f /",
    "rm -rf E:\\ && echo done",
    "Remove-Item -Force -Recurse C:\\",
  ]) {
    const denied = runHook("hooks/pre-tool-use.mjs", {
      toolCall: { name: "run_command", args: { CommandLine: dangerous } },
    });
    assert.equal(denied.decision, "deny", `Expected deny for: ${dangerous}`);
  }
});

function writeCompletedOnboarding(dataDir, overrides = {}) {
  const state = {
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
    ...overrides,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "onboarding.json"), JSON.stringify(state, null, 2), "utf8");
}

function writeShim(dir, baseName, stdoutText, exitCode = 0) {
  const shimPath = path.join(dir, process.platform === "win32" ? `${baseName}.cmd` : `${baseName}.sh`);
  if (process.platform === "win32") {
    fs.writeFileSync(shimPath, `@echo off\r\necho ${stdoutText}\r\nexit /b ${exitCode}\r\n`);
  } else {
    fs.writeFileSync(shimPath, `#!/bin/sh\necho '${stdoutText}'\nexit ${exitCode}\n`);
    fs.chmodSync(shimPath, 0o755);
  }
  return shimPath;
}

test("session-start handles non-project dir, ADR index hint, and broker local config alert", () => {
  const emptyDir = makeTempDir("ignis-empty-");
  const dataDir = makeTempDir("ignis-onboard-");
  writeCompletedOnboarding(dataDir);

  const emptyOut = runHook(
    "hooks/session-start.mjs",
    { cwd: emptyDir, lastUserInput: "hello" },
    { IGNIS_BROKER_HOME: emptyDir, IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(emptyOut, {});

  const projDir = makeTempDir("ignis-proj-");
  fs.mkdirSync(path.join(projDir, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(projDir, "docs", "adr", "INDEX.md"), "| ID | File |\n|---|---|\n");

  const indexOut = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "hello" },
    { IGNIS_BROKER_HOME: emptyDir, IGNIS_BROKER_DATA: dataDir }
  );
  assert.match(indexOut.injectSteps[0].systemMessage.systemMessage, /docs\/adr\/INDEX\.md/);

  const brokerPayload = JSON.stringify({
    localConfigError: "invalid local config .agents/ignis-broker.json: expected value",
    recentFallbacks: [],
  });
  const brokerShim = writeShim(projDir, "broker-warn", brokerPayload, 0);

  const brokerWarnOut = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "hello" },
    { IGNIS_BROKER_CMD: brokerShim, IGNIS_BROKER_HOME: emptyDir, IGNIS_BROKER_DATA: dataDir }
  );
  assert.match(brokerWarnOut.injectSteps[0].systemMessage.systemMessage, /ignis-broker Alert/i);
  assert.match(brokerWarnOut.injectSteps[0].systemMessage.systemMessage, /Global fallback config is active/i);

  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});

test("session-start triggers first-run onboarding with redacted MCP names and zero secrets", () => {
  const projDir = makeTempDir("ignis-onboard-proj-");
  const dataDir = makeTempDir("ignis-onboard-empty-");
  fs.writeFileSync(path.join(projDir, "package.json"), "{}");

  const mcpConfigPath = path.join(dataDir, "mcp_config.json");
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        linear: {
          serverUrl: "https://mcp.linear.app/sse",
          headers: { Authorization: "Bearer SUPER_SECRET_LINEAR_TOKEN_123" },
        },
        serena: {
          command: "uvx",
          args: ["serena"],
          env: { API_KEY: "SUPER_SECRET_SERENA_KEY_456" },
        },
      },
    })
  );

  const out = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "start work" },
    {
      IGNIS_BROKER_HOME: dataDir,
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_MCP_CONFIG_PATH: mcpConfigPath,
    }
  );
  const msg = out.injectSteps[0].systemMessage.systemMessage;
  assert.match(msg, /\[ignis-swarm\]\[First-Run Onboarding Required\]/);
  assert.match(msg, /ignis-onboarding/);
  assert.match(msg, /linear \(http\)/);
  assert.match(msg, /serena \(stdio\)/);
  assert.doesNotMatch(msg, /SUPER_SECRET_LINEAR_TOKEN_123/);
  assert.doesNotMatch(msg, /SUPER_SECRET_SERENA_KEY_456/);

  const subagentNoInput = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir },
    {
      IGNIS_BROKER_HOME: dataDir,
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_MCP_CONFIG_PATH: mcpConfigPath,
    }
  );
  assert.deepEqual(subagentNoInput, {});

  const subagentFlag = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "audit", isSubagent: true },
    {
      IGNIS_BROKER_HOME: dataDir,
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_MCP_CONFIG_PATH: mcpConfigPath,
    }
  );
  assert.deepEqual(subagentFlag, {});

  fs.rmSync(projDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("session-start handles Windows shim path and cwd containing space and ampersand", { skip: process.platform !== "win32" }, () => {
  const baseDir = makeTempDir("ignis space & dir-");
  const projDir = path.join(baseDir, "repo & app");
  const dataDir = path.join(baseDir, "data & state");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "package.json"), "{}");
  writeCompletedOnboarding(dataDir);

  const brokerPayload = JSON.stringify({
    localConfigError: "invalid local config",
    recentFallbacks: [],
  });
  const shimPath = writeShim(baseDir, "broker & shim", brokerPayload, 0);

  const out = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "hello" },
    { IGNIS_BROKER_CMD: shimPath, IGNIS_BROKER_HOME: dataDir, IGNIS_BROKER_DATA: dataDir }
  );
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /ignis-broker Alert/i);

  fs.rmSync(baseDir, { recursive: true, force: true });
});

test("session-start respects memtrace.enabled flag when onboarding is completed", () => {
  const projDir = makeTempDir("ignis-mt-proj-");
  const dataDir = makeTempDir("ignis-mt-data-");
  fs.writeFileSync(path.join(projDir, "package.json"), "{}");

  const failingShim = writeShim(projDir, "memtrace-fail", "daemon stopped", 1);
  const healthyShim = writeShim(projDir, "memtrace-ok", "memtrace daemon running", 0);

  writeCompletedOnboarding(dataDir, { memtrace: { enabled: false } });
  const disabledOut = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "hello" },
    { IGNIS_BROKER_HOME: dataDir, IGNIS_BROKER_DATA: dataDir, IGNIS_MEMTRACE_CMD: failingShim }
  );
  assert.deepEqual(disabledOut, {});

  writeCompletedOnboarding(dataDir, { memtrace: { enabled: true } });
  const healthyOut = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "hello" },
    { IGNIS_BROKER_HOME: dataDir, IGNIS_BROKER_DATA: dataDir, IGNIS_MEMTRACE_CMD: healthyShim }
  );
  assert.match(healthyOut.injectSteps[0].systemMessage.systemMessage, /\[ignis-swarm\]\[Memtrace\] Active/);
  assert.match(healthyOut.injectSteps[0].systemMessage.systemMessage, /memtrace daemon running/);

  const unhealthyOut = runHook(
    "hooks/session-start.mjs",
    { cwd: projDir, lastUserInput: "hello" },
    { IGNIS_BROKER_HOME: dataDir, IGNIS_BROKER_DATA: dataDir, IGNIS_MEMTRACE_CMD: failingShim }
  );
  assert.match(unhealthyOut.injectSteps[0].systemMessage.systemMessage, /\[ignis-swarm\]\[Memtrace Alert\]/);
  assert.match(unhealthyOut.injectSteps[0].systemMessage.systemMessage, /daemon stopped/);

  fs.rmSync(projDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("compaction-watch triggers at threshold, enforces +150KB cooldown, resets on compact_boundary, and skips subagents", () => {
  const dataDir = makeTempDir("ignis-compact-");
  writeCompletedOnboarding(dataDir, { compaction: { transcriptThresholdKb: 100 } });

  const transcriptPath = path.join(dataDir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "a".repeat(50 * 1024));

  const below = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(below, {});

  fs.writeFileSync(transcriptPath, "a".repeat(110 * 1024));
  const firstTrigger = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  const firstMsg = firstTrigger.injectSteps[0].systemMessage.systemMessage;
  assert.match(firstMsg, /\[ignis-swarm\]\[Compaction Checkpoint\]/);
  assert.match(firstMsg, /\/compact Preserve:/);

  const cooldownHit = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(cooldownHit, {});

  fs.appendFileSync(transcriptPath, "b".repeat(160 * 1024));
  const secondTrigger = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.match(
    secondTrigger.injectSteps[0].systemMessage.systemMessage,
    /\[ignis-swarm\]\[Compaction Checkpoint\]/
  );

  fs.appendFileSync(transcriptPath, `\n{"type":"compact_boundary"}\n${"c".repeat(110 * 1024)}`);
  const postCompactTrigger = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.match(
    postCompactTrigger.injectSteps[0].systemMessage.systemMessage,
    /\[ignis-swarm\]\[Compaction Checkpoint\]/
  );

  const subagentOut = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath, isSubagent: true },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(subagentOut, {});

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("post-tool-use returns empty object and appends audit log", () => {
  const dataDir = makeTempDir("ignis-data-");
  const out = runHook(
    "hooks/post-tool-use.mjs",
    {
      conversationId: "conv-123",
      stepIdx: 4,
      toolCall: { name: "run_command", args: { CommandLine: "go test ./..." } },
    },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(out, {});

  const logPath = path.join(dataDir, "audit", "conv-123.jsonl");
  assert.equal(fs.existsSync(logPath), true);
  const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(record.isTest, true);
  assert.equal(record.tool, "run_command");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("stop-gate prevents loops, checks ADR INDEX integrity, and catches banned diff shortcuts", () => {
  const repoDir = makeTempDir("ignis-repo-");
  initGitRepo(repoDir);

  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "lib.js"), "export function add(a, b) { return a + b; }\n");
  spawnSync("git", ["add", "."], { cwd: repoDir, windowsHide: true });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repoDir, windowsHide: true });

  fs.mkdirSync(path.join(repoDir, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "docs", "adr", "INDEX.md"), "| ID | File |\n|---|---|\n| ADR-0010 | ADR-0010-other.md |\n");
  fs.writeFileSync(path.join(repoDir, "docs", "adr", "ADR-001-cache.md"), "# ADR-001\n");

  const unindexed = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: false,
  });
  assert.equal(unindexed.decision, "continue");
  assert.match(unindexed.reason, /ADR-001-cache\.md/);

  const noLoop = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: true,
  });
  assert.deepEqual(noLoop, {});

  fs.writeFileSync(
    path.join(repoDir, "docs", "adr", "INDEX.md"),
    "| ID | File |\n|---|---|\n| ADR-001 | ADR-001-cache.md |\n"
  );
  const cleanOut = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: false,
  });
  assert.deepEqual(cleanOut, {});

  fs.writeFileSync(
    path.join(repoDir, "src", "lib.js"),
    "export function add(a, b) { return a + b; }\ntest.skip('skipped', () => {});\n"
  );
  const bannedDiff = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: false,
  });
  assert.equal(bannedDiff.decision, "continue");
  assert.match(bannedDiff.reason, /\.skip/);

  fs.rmSync(repoDir, { recursive: true, force: true });
});
