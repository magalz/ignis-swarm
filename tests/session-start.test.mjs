import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePlatformCommand } from "../scripts/broker/adapters.mjs";
import { isolatedEnv, writeOnboardingState } from "./helpers.mjs";

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

const RUNNER = path.resolve(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");

function routing(strategy) {
  return {
    reviewRouting: {
      strategy,
      headlessBackend: strategy === "antigravity_gemini_only" ? null : "claude",
      headlessModel: null,
      effort: "high",
    },
  };
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

test("session-start injects Phase 4 routing notice per strategy for interactive sessions only", () => {
  const projDir = makeTempDir("ignis-route-proj-");
  const homeDir = makeTempDir("ignis-route-home-");
  const tempDirs = [projDir, homeDir];
  try {
    fs.mkdirSync(path.join(projDir, ".git"));
    const msg = (strategy, extra = {}, routingOverride = null) => {
      const dataDir = makeTempDir("ignis-route-data-");
      tempDirs.push(dataDir);
      writeCompletedOnboarding(dataDir, routingOverride ? { reviewRouting: routingOverride } : routing(strategy));
      const out = runHook(
        "hooks/session-start.mjs",
        { cwd: projDir, lastUserInput: "hi", ...extra },
        { IGNIS_BROKER_HOME: homeDir, IGNIS_BROKER_DATA: dataDir }
      );
      return out.injectSteps?.[0]?.systemMessage?.systemMessage ?? "";
    };
    const hl = msg("headless_always");
    assert.match(hl, /\[ignis-swarm\]\[Phase 4 Review Routing\] strategy=headless_always \(backend=claude, model=opus, effort=high\)/);
    assert.ok(hl.includes(RUNNER));
    const af = msg("antigravity_first");
    assert.match(af, /strategy=antigravity_first/);
    assert.match(af, /--fallback/);
    assert.doesNotMatch(msg("antigravity_gemini_only"), /Phase 4 Review Routing/);
    assert.doesNotMatch(msg("headless_always", { isSubagent: true }), /Phase 4 Review Routing/);
    const unconf = msg("headless_always", {}, {
      strategy: "headless_always",
      headlessBackend: null,
      headlessModel: null,
      effort: "high",
    });
    assert.match(unconf, /\(backend=unconfigured, model=none, effort=high\)/);
  } finally {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

const BROKER_CLI = path.resolve(PLUGIN_ROOT, "scripts", "ignis-broker.mjs");

function sessionMessage(out) {
  return out.injectSteps?.[0]?.systemMessage?.systemMessage ?? "";
}

test("session-start shows no first-run notice after `onboarding --skip`", () => {
  const projDir = makeTempDir("ignis-skip-proj-");
  const homeDir = makeTempDir("ignis-skip-home-");
  const dataDir = makeTempDir("ignis-skip-data-");
  try {
    fs.writeFileSync(path.join(projDir, "package.json"), "{}");
    const env = { IGNIS_BROKER_HOME: homeDir, IGNIS_BROKER_DATA: dataDir };

    const before = runHook("hooks/session-start.mjs", { cwd: projDir, lastUserInput: "hi" }, env);
    assert.match(sessionMessage(before), /\[ignis-swarm\]\[First-Run Onboarding Required\]/);

    const skip = spawnSync(process.execPath, [BROKER_CLI, "onboarding", "--skip"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 8000,
      windowsHide: true,
    });
    assert.equal(skip.status, 0, skip.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "onboarding.json"), "utf8"));
    assert.equal(saved.skipped, true);
    assert.equal(saved.completed, false);

    const after = runHook("hooks/session-start.mjs", { cwd: projDir, lastUserInput: "hi" }, env);
    assert.deepEqual(after, {});
  } finally {
    for (const d of [projDir, homeDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("session-start decides the routing notice from reviewRouting alone, not from completed", () => {
  const projDir = makeTempDir("ignis-rr-proj-");
  const homeDir = makeTempDir("ignis-rr-home-");
  const tempDirs = [projDir, homeDir];
  try {
    fs.writeFileSync(path.join(projDir, "package.json"), "{}");
    const run = (state, extra = {}) => {
      const dataDir = makeTempDir("ignis-rr-data-");
      tempDirs.push(dataDir);
      writeCompletedOnboarding(dataDir, state);
      return runHook(
        "hooks/session-start.mjs",
        { cwd: projDir, lastUserInput: "hi", ...extra },
        { IGNIS_BROKER_HOME: homeDir, IGNIS_BROKER_DATA: dataDir }
      );
    };
    const routingNotice = /\[ignis-swarm\]\[Phase 4 Review Routing\] strategy=headless_always/;

    const pending = sessionMessage(run({ completed: false, ...routing("headless_always") }));
    assert.match(pending, routingNotice);
    assert.match(pending, /\[ignis-swarm\]\[First-Run Onboarding Required\]/);

    const skipped = sessionMessage(run({ completed: false, skipped: true, ...routing("headless_always") }));
    assert.match(skipped, routingNotice);
    assert.doesNotMatch(skipped, /First-Run Onboarding Required/);

    const pendingFirst = sessionMessage(run({ completed: false, ...routing("antigravity_first") }));
    assert.match(pendingFirst, /strategy=antigravity_first/);

    assert.deepEqual(run({ completed: false, ...routing("headless_always") }, { isSubagent: true }), {});
    assert.deepEqual(run({ completed: false, skipped: true, ...routing("headless_always") }, { isSubagent: true }), {});
  } finally {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("session-start omits the routing notice for antigravity_gemini_only even when completed", () => {
  const projDir = makeTempDir("ignis-rr-gem-proj-");
  const homeDir = makeTempDir("ignis-rr-gem-home-");
  const dataDir = makeTempDir("ignis-rr-gem-data-");
  try {
    fs.writeFileSync(path.join(projDir, "package.json"), "{}");
    writeCompletedOnboarding(dataDir, { completed: true, ...routing("antigravity_gemini_only") });
    const out = runHook(
      "hooks/session-start.mjs",
      { cwd: projDir, lastUserInput: "hi" },
      { IGNIS_BROKER_HOME: homeDir, IGNIS_BROKER_DATA: dataDir }
    );
    assert.doesNotMatch(sessionMessage(out), /Phase 4 Review Routing/);
    assert.deepEqual(out, {});
  } finally {
    for (const d of [projDir, homeDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("session-start first-run notice names the real broker CLI path and a runnable example", () => {
  const projDir = makeTempDir("ignis-path-proj-");
  const dataDir = makeTempDir("ignis-path-data-");
  try {
    fs.writeFileSync(path.join(projDir, "package.json"), "{}");
    const out = runHook(
      "hooks/session-start.mjs",
      { cwd: projDir, lastUserInput: "start" },
      { IGNIS_BROKER_HOME: dataDir, IGNIS_BROKER_DATA: dataDir }
    );
    const msg = sessionMessage(out);
    assert.match(msg, /\[ignis-swarm\]\[First-Run Onboarding Required\]/);
    assert.ok(fs.existsSync(BROKER_CLI), "broker CLI exists on disk");
    assert.ok(msg.includes(BROKER_CLI), `notice names ${BROKER_CLI}`);
    assert.ok(msg.includes("<plugin-root>"), "notice explains the <plugin-root> placeholder");
    assert.ok(msg.includes(`node "${BROKER_CLI}" onboarding --probe`), "notice carries a quoted, ready-to-run example");
  } finally {
    for (const d of [projDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("session-start runs the memtrace check for a skipped onboarding with memtrace enabled", () => {
  const projDir = makeTempDir("ignis-mt-skip-proj-");
  const homeDir = makeTempDir("ignis-mt-skip-home-");
  const dataDir = makeTempDir("ignis-mt-skip-data-");
  try {
    fs.writeFileSync(path.join(projDir, "package.json"), "{}");
    const healthyShim = writeShim(projDir, "memtrace-ok", "memtrace daemon running", 0);
    writeCompletedOnboarding(dataDir, { completed: false, skipped: true, memtrace: { enabled: true } });
    const out = runHook(
      "hooks/session-start.mjs",
      { cwd: projDir, lastUserInput: "hi" },
      { IGNIS_BROKER_HOME: homeDir, IGNIS_BROKER_DATA: dataDir, IGNIS_MEMTRACE_CMD: healthyShim }
    );
    const msg = sessionMessage(out);
    assert.match(msg, /\[ignis-swarm\]\[Memtrace\] Active/);
    assert.doesNotMatch(msg, /First-Run Onboarding Required/);
  } finally {
    for (const d of [projDir, homeDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

function writeNodeShim(dir, baseName, { sleepMs, stdoutText, marker }) {
  const impl = path.join(dir, `${baseName}.impl.mjs`);
  fs.writeFileSync(
    impl,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
      `await new Promise((resolve) => setTimeout(resolve, ${sleepMs}));`,
      `process.stdout.write(${JSON.stringify(`${stdoutText}\n`)});`,
      "",
    ].join("\n")
  );
  if (process.platform === "win32") {
    const shim = path.join(dir, `${baseName}.cmd`);
    fs.writeFileSync(shim, `@echo off\r\nnode "%~dp0${baseName}.impl.mjs" %*\r\n`);
    assert.equal(
      resolvePlatformCommand(shim, ["status"]).command,
      process.execPath,
      "the shim must unwrap to node so that killing the child kills the sleeper"
    );
    return shim;
  }
  const shim = path.join(dir, `${baseName}.sh`);
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

function slowChecksScenario(sleepMs) {
  const iso = isolatedEnv();
  const projDir = path.join(iso.dirs.root, "proj");
  const toolsDir = path.join(iso.dirs.root, "tools");
  fs.mkdirSync(path.join(projDir, "docs", "adr"), { recursive: true });
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "docs", "adr", "INDEX.md"), "| ID | File |\n|---|---|\n");
  writeOnboardingState(iso.dirs.brokerData, { memtrace: { enabled: true }, ...routing("headless_always") });
  const markers = {
    memtrace: path.join(toolsDir, "memtrace.started"),
    broker: path.join(toolsDir, "broker.started"),
  };
  const memtraceShim = writeNodeShim(toolsDir, "shim-memtrace", {
    sleepMs,
    stdoutText: "memtrace daemon running",
    marker: markers.memtrace,
  });
  const brokerShim = writeNodeShim(toolsDir, "shim-broker", {
    sleepMs,
    stdoutText: JSON.stringify({ localConfigError: "invalid local config", recentFallbacks: [] }),
    marker: markers.broker,
  });
  const env = { ...iso.env, IGNIS_MEMTRACE_CMD: memtraceShim, IGNIS_BROKER_CMD: brokerShim };
  return { iso, projDir, markers, env };
}

function runHookTimed(inputObj, env) {
  const started = performance.now();
  const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "session-start.mjs")], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    env,
    timeout: 9000,
    windowsHide: true,
  });
  const elapsedMs = performance.now() - started;
  assert.ifError(res.error);
  assert.equal(res.status, 0, res.stderr);
  return { out: JSON.parse(res.stdout.trim()), elapsedMs };
}

test("session-start finishes inside its budget and keeps the ready notices when both checks are slow", () => {
  const sc = slowChecksScenario(4000);
  try {
    const { out, elapsedMs } = runHookTimed({ cwd: sc.projDir, lastUserInput: "hi" }, sc.env);
    assert.ok(elapsedMs < 4500, `hook took ${Math.round(elapsedMs)} ms, the budget is 4500 ms`);
    const msg = sessionMessage(out);
    assert.match(msg, /\[ignis-swarm\]\[Phase 4 Review Routing\] strategy=headless_always/);
    assert.match(msg, /docs\/adr\/INDEX\.md/);
    assert.ok(fs.existsSync(sc.markers.memtrace), "the memtrace check ran");
    assert.ok(fs.existsSync(sc.markers.broker), "the broker check ran");
  } finally {
    sc.iso.cleanup();
  }
});

test("session-start starts no memtrace or broker process for subagents and workers", () => {
  const sc = slowChecksScenario(4000);
  try {
    const transcript = path.join(sc.iso.dirs.root, "transcript.jsonl");
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "MODEL_RESPONSE", text: "working" })}\n`);
    const payloads = [
      { cwd: sc.projDir, transcriptPath: transcript },
      { cwd: sc.projDir, lastUserInput: "audit", isSubagent: true },
      { cwd: sc.projDir, lastUserInput: "audit", parentConversationId: "parent-1" },
    ];
    for (const payload of payloads) {
      const { out, elapsedMs } = runHookTimed(payload, sc.env);
      assert.ok(elapsedMs < 2500, `subagent hook took ${Math.round(elapsedMs)} ms for ${JSON.stringify(Object.keys(payload))}`);
      const msg = sessionMessage(out);
      assert.match(msg, /docs\/adr\/INDEX\.md/);
      assert.doesNotMatch(msg, /Phase 4 Review Routing|Memtrace|ignis-broker/);
      assert.ok(!fs.existsSync(sc.markers.memtrace), "no memtrace process for a subagent");
      assert.ok(!fs.existsSync(sc.markers.broker), "no broker process for a subagent");
    }
  } finally {
    sc.iso.cleanup();
  }
});

test("session-start reports both checks, in order, when they answer at once", () => {
  const sc = slowChecksScenario(0);
  try {
    const { out, elapsedMs } = runHookTimed({ cwd: sc.projDir, lastUserInput: "hi" }, sc.env);
    assert.ok(elapsedMs < 3000, `hook took ${Math.round(elapsedMs)} ms with instant checks`);
    const msg = sessionMessage(out);
    const memtrace = msg.indexOf("[ignis-swarm][Memtrace] Active (memtrace daemon running).");
    const routingAt = msg.indexOf("[ignis-swarm][Phase 4 Review Routing]");
    const hint = msg.indexOf("Decision indexes detected (docs/adr/INDEX.md)");
    const broker = msg.indexOf("[ignis-broker Alert] Local config error detected (invalid local config).");
    assert.ok(memtrace >= 0 && routingAt > memtrace && hint > routingAt && broker > hint, msg);
  } finally {
    sc.iso.cleanup();
  }
});
