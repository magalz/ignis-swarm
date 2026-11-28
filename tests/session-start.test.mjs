import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePlatformCommand } from "../scripts/broker/adapters.mjs";
import { CHECKS_DEADLINE_MS } from "../hooks/session-start.mjs";
import { BROKER_ENTRY as BROKER_CLI, isolatedEnv, runNode, writeOnboardingState } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "session-start.mjs");
const RUNNER = path.resolve(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");

const ADR_HINT =
  "[ignis-swarm] Decision indexes detected (docs/adr/INDEX.md). Check relevant ADRs/BDRs before planning or modifying architecture.";
const FIRST_RUN = /\[ignis-swarm\]\[First-Run Onboarding Required\]/;

function withIso(fn) {
  const iso = isolatedEnv();
  try {
    return fn(iso);
  } finally {
    iso.cleanup();
  }
}

function projectDir(iso, { markers = ["package.json"], adr = false, name = "proj" } = {}) {
  const dir = path.join(iso.dirs.root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const marker of markers) {
    if (marker === ".git") fs.mkdirSync(path.join(dir, ".git"));
    else fs.writeFileSync(path.join(dir, marker), "{}");
  }
  if (adr) {
    fs.mkdirSync(path.join(dir, "docs", "adr"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "adr", "INDEX.md"), "| ID | File |\n|---|---|\n");
  }
  return dir;
}

function runHookTimed(iso, payload, extraEnv = {}, timeoutMs = 8000) {
  const started = performance.now();
  const res = runNode(HOOK, [], {
    input: JSON.stringify(payload),
    env: { ...iso.env, ...extraEnv },
    cwd: iso.dirs.root,
    timeoutMs,
  });
  const elapsedMs = performance.now() - started;
  assert.equal(res.timedOut, false, "the hook timed out");
  assert.equal(res.status, 0, res.stderr);
  return { out: JSON.parse(res.stdout.trim()), elapsedMs };
}

function runHook(iso, payload, extraEnv, timeoutMs) {
  return runHookTimed(iso, payload, extraEnv, timeoutMs).out;
}

function sessionMessage(out) {
  assert.equal(out.injectSteps.length, 1);
  return out.injectSteps[0].systemMessage.systemMessage;
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

function routingState(strategy) {
  return {
    reviewRouting: {
      strategy,
      headlessBackend: strategy === "antigravity_gemini_only" ? null : "claude",
      headlessModel: null,
      effort: "high",
    },
  };
}

function headlessAlwaysNotice(backend = "claude", model = "opus") {
  return (
    `[ignis-swarm][Phase 4 Review Routing] strategy=headless_always (backend=${backend}, model=${model}, effort=high). ` +
    `Mandatory: run \`node "${RUNNER}" --base <base-sha> --backend auto\` BEFORE native \`blind-edge-hunter\` (native fallback allowed only if \`fallbackToNative: true\`).`
  );
}

function antigravityFirstNotice(backend = "claude", model = "opus") {
  return (
    `[ignis-swarm][Phase 4 Review Routing] strategy=antigravity_first (native Gemini Pro \`blind-edge-hunter\` first; headless fallback=${backend}/${model}, effort=high). ` +
    `If native quota runs out, run \`node "${RUNNER}" --base <base-sha> --backend auto --fallback\`.`
  );
}

test("session-start emits nothing outside a project directory", () => {
  withIso((iso) => {
    writeOnboardingState(iso.dirs.brokerData);
    const emptyDir = path.join(iso.dirs.root, "empty");
    fs.mkdirSync(emptyDir);
    assert.deepEqual(runHook(iso, { cwd: emptyDir, lastUserInput: "hello" }), {});
  });
});

test("session-start hints the ADR index of a project that has one", () => {
  withIso((iso) => {
    writeOnboardingState(iso.dirs.brokerData);
    const dir = projectDir(iso, { adr: true });
    assert.equal(sessionMessage(runHook(iso, { cwd: dir, lastUserInput: "hello" })), ADR_HINT);
  });
});

test("session-start alerts about a broken local broker config reported by the broker CLI", () => {
  withIso((iso) => {
    writeOnboardingState(iso.dirs.brokerData);
    const dir = projectDir(iso);
    const payload = JSON.stringify({
      localConfigError: "invalid local config .agents/ignis-broker.json: expected value",
      recentFallbacks: [],
    });
    const shim = writeShim(dir, "broker-warn", payload);
    const out = runHook(iso, { cwd: dir, lastUserInput: "hello" }, { IGNIS_BROKER_CMD: shim });
    assert.equal(
      sessionMessage(out),
      "[ignis-broker Alert] Local config error detected (invalid local config .agents/ignis-broker.json: expected value). Global fallback config is active."
    );
  });
});

const MCP_SECRETS = { linear: "SUPER_SECRET_LINEAR_TOKEN_123", serena: "SUPER_SECRET_SERENA_KEY_456" };

function firstRunProject(iso) {
  const dir = projectDir(iso);
  const mcpConfigPath = path.join(iso.dirs.root, "mcp_config.json");
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        linear: { serverUrl: "https://mcp.linear.app/sse", headers: { Authorization: `Bearer ${MCP_SECRETS.linear}` } },
        serena: { command: "uvx", args: ["serena"], env: { API_KEY: MCP_SECRETS.serena } },
      },
    })
  );
  return { dir, env: { IGNIS_MCP_CONFIG_PATH: mcpConfigPath } };
}

test("session-start asks for first-run onboarding and lists the discovered MCP names", () => {
  withIso((iso) => {
    const { dir, env } = firstRunProject(iso);
    const msg = sessionMessage(runHook(iso, { cwd: dir, lastUserInput: "start work" }, env));
    assert.match(msg, FIRST_RUN);
    assert.match(msg, /Load skill `ignis-onboarding`/);
    assert.match(msg, /Discovered MCPs \(redacted\): linear \(http\), serena \(stdio\)\./);
  });
});

test("session-start first-run notice leaks no MCP secret", () => {
  withIso((iso) => {
    const { dir, env } = firstRunProject(iso);
    const msg = sessionMessage(runHook(iso, { cwd: dir, lastUserInput: "start work" }, env));
    for (const secret of Object.values(MCP_SECRETS)) assert.equal(msg.includes(secret), false);
  });
});

for (const [label, payload] of [
  ["a payload without user input", {}],
  ["a payload flagged isSubagent", { lastUserInput: "audit", isSubagent: true }],
]) {
  test(`session-start shows no first-run notice for ${label}`, () => {
    withIso((iso) => {
      const { dir, env } = firstRunProject(iso);
      assert.deepEqual(runHook(iso, { cwd: dir, ...payload }, env), {});
    });
  });
}

test("session-start first-run notice names the real broker CLI path", () => {
  withIso((iso) => {
    const dir = projectDir(iso);
    const msg = sessionMessage(runHook(iso, { cwd: dir, lastUserInput: "start" }));
    assert.match(msg, FIRST_RUN);
    assert.equal(fs.existsSync(BROKER_CLI), true);
    assert.equal(msg.includes(`replace \`<broker-cli>\` with this absolute path: \`${BROKER_CLI}\``), true);
  });
});

test("session-start first-run notice carries a quoted, ready-to-run example", () => {
  withIso((iso) => {
    const dir = projectDir(iso);
    const msg = sessionMessage(runHook(iso, { cwd: dir, lastUserInput: "start" }));
    assert.equal(msg.includes(`Example: \`node "${BROKER_CLI}" onboarding --probe\``), true);
  });
});

test("session-start first-run notice no longer mentions <plugin-root>", () => {
  withIso((iso) => {
    const dir = projectDir(iso);
    const msg = sessionMessage(runHook(iso, { cwd: dir, lastUserInput: "start" }));
    assert.equal(msg.includes("<plugin-root>"), false);
  });
});

test("session-start shows no first-run notice after `onboarding --skip`", () => {
  withIso((iso) => {
    const dir = projectDir(iso);
    assert.match(sessionMessage(runHook(iso, { cwd: dir, lastUserInput: "hi" })), FIRST_RUN);

    const skip = runNode(BROKER_CLI, ["onboarding", "--skip"], { env: iso.env, timeoutMs: 8000 });
    assert.equal(skip.status, 0, skip.stderr);

    assert.deepEqual(runHook(iso, { cwd: dir, lastUserInput: "hi" }), {});
  });
});

test("`onboarding --skip` records skipped true and completed false", () => {
  withIso((iso) => {
    const skip = runNode(BROKER_CLI, ["onboarding", "--skip"], { env: iso.env, timeoutMs: 8000 });
    assert.equal(skip.status, 0, skip.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(iso.dirs.brokerData, "onboarding.json"), "utf8"));
    assert.equal(saved.skipped, true);
    assert.equal(saved.completed, false);
  });
});

test("session-start handles a Windows shim path and a cwd containing a space and an ampersand", { skip: process.platform !== "win32" }, () => {
  withIso((iso) => {
    const dir = projectDir(iso, { name: "repo & app" });
    const dataDir = path.join(iso.dirs.root, "data & state");
    writeOnboardingState(dataDir);
    const payload = JSON.stringify({ localConfigError: "invalid local config", recentFallbacks: [] });
    const shim = writeShim(iso.dirs.root, "broker & shim", payload);
    const out = runHook(iso, { cwd: dir, lastUserInput: "hello" }, { IGNIS_BROKER_CMD: shim, IGNIS_BROKER_DATA: dataDir });
    assert.equal(
      sessionMessage(out),
      "[ignis-broker Alert] Local config error detected (invalid local config). Global fallback config is active."
    );
  });
});

function memtraceScenario(iso, state, exitCode, stdoutText) {
  const dir = projectDir(iso);
  const shim = writeShim(dir, "memtrace-shim", stdoutText, exitCode);
  writeOnboardingState(iso.dirs.brokerData, state);
  return runHook(iso, { cwd: dir, lastUserInput: "hello" }, { IGNIS_MEMTRACE_CMD: shim });
}

test("session-start skips the memtrace check when memtrace.enabled is false", () => {
  withIso((iso) => {
    assert.deepEqual(memtraceScenario(iso, { memtrace: { enabled: false } }, 1, "daemon stopped"), {});
  });
});

test("session-start reports a healthy memtrace daemon when memtrace.enabled is true", () => {
  withIso((iso) => {
    const out = memtraceScenario(iso, { memtrace: { enabled: true } }, 0, "memtrace daemon running");
    assert.equal(sessionMessage(out), "[ignis-swarm][Memtrace] Active (memtrace daemon running).");
  });
});

test("session-start alerts about an unhealthy memtrace daemon when memtrace.enabled is true", () => {
  withIso((iso) => {
    const out = memtraceScenario(iso, { memtrace: { enabled: true } }, 1, "daemon stopped");
    assert.equal(sessionMessage(out), "[ignis-swarm][Memtrace Alert] memtrace status failed (daemon stopped).");
  });
});

test("session-start runs the memtrace check for a skipped onboarding with memtrace enabled, without the first-run notice", () => {
  withIso((iso) => {
    const out = memtraceScenario(
      iso,
      { completed: false, skipped: true, memtrace: { enabled: true } },
      0,
      "memtrace daemon running"
    );
    assert.equal(sessionMessage(out), "[ignis-swarm][Memtrace] Active (memtrace daemon running).");
  });
});

function routingMessage(iso, state, payload = {}) {
  const dir = projectDir(iso, { markers: [".git"] });
  writeOnboardingState(iso.dirs.brokerData, state);
  return runHook(iso, { cwd: dir, lastUserInput: "hi", ...payload });
}

for (const [strategy, expected] of [
  ["headless_always", headlessAlwaysNotice()],
  ["antigravity_first", antigravityFirstNotice()],
]) {
  test(`session-start injects the ${strategy} routing notice for an interactive session`, () => {
    withIso((iso) => {
      assert.equal(sessionMessage(routingMessage(iso, routingState(strategy))), expected);
    });
  });
}

test("session-start injects no routing notice for antigravity_gemini_only", () => {
  withIso((iso) => {
    assert.deepEqual(routingMessage(iso, routingState("antigravity_gemini_only")), {});
  });
});

test("session-start injects no routing notice for a subagent", () => {
  withIso((iso) => {
    assert.deepEqual(routingMessage(iso, routingState("headless_always"), { isSubagent: true }), {});
  });
});

test("session-start names the unconfigured backend when headless_always has none", () => {
  withIso((iso) => {
    const unconfigured = { strategy: "headless_always", headlessBackend: null, headlessModel: null, effort: "high" };
    const out = routingMessage(iso, { reviewRouting: unconfigured });
    assert.equal(sessionMessage(out), headlessAlwaysNotice("unconfigured", "none"));
  });
});

test("session-start adds the routing notice to the first-run notice while onboarding is pending", () => {
  withIso((iso) => {
    const msg = sessionMessage(routingMessage(iso, { completed: false, ...routingState("headless_always") }));
    assert.match(msg, FIRST_RUN);
    assert.equal(msg.split("\n").includes(headlessAlwaysNotice()), true);
  });
});

test("session-start injects the antigravity_first routing notice while onboarding is pending", () => {
  withIso((iso) => {
    const msg = sessionMessage(routingMessage(iso, { completed: false, ...routingState("antigravity_first") }));
    assert.equal(msg.split("\n").includes(antigravityFirstNotice()), true);
  });
});

test("session-start injects only the routing notice once onboarding is skipped", () => {
  withIso((iso) => {
    const out = routingMessage(iso, { completed: false, skipped: true, ...routingState("headless_always") });
    assert.equal(sessionMessage(out), headlessAlwaysNotice());
  });
});

for (const [label, state] of [
  ["pending", { completed: false }],
  ["skipped", { completed: false, skipped: true }],
]) {
  test(`session-start injects nothing for a subagent while onboarding is ${label}`, () => {
    withIso((iso) => {
      assert.deepEqual(routingMessage(iso, { ...state, ...routingState("headless_always") }, { isSubagent: true }), {});
    });
  });
}

function writeNodeShim(dir, baseName, { sleepMs, stdoutText, marker }) {
  const impl = path.join(dir, `${baseName}.impl.mjs`);
  fs.writeFileSync(
    impl,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now()));`,
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

const DEADLINE_MARGIN_MS = 6000;
const SLOW_CHECK_MS = 20_000;
const MEMTRACE_NOTICE = "[ignis-swarm][Memtrace] Active (memtrace daemon running).";
const MEMTRACE_TIMEOUT_NOTICE = "[ignis-swarm][Memtrace Alert] memtrace status failed (timed out after 3000 ms).";
const BROKER_NOTICE =
  "[ignis-broker Alert] Local config error detected (invalid local config). Global fallback config is active.";

function slowChecksScenario(sleepMs) {
  const iso = isolatedEnv();
  const projDir = projectDir(iso, { adr: true });
  const toolsDir = path.join(iso.dirs.root, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  writeOnboardingState(iso.dirs.brokerData, { memtrace: { enabled: true }, ...routingState("headless_always") });
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
  const env = { IGNIS_MEMTRACE_CMD: memtraceShim, IGNIS_BROKER_CMD: brokerShim };
  return { iso, projDir, markers, env };
}

describe("session-start with slow memtrace and broker checks", () => {
  let sc;
  let run;
  let beganAt;
  let endedAt;

  before(() => {
    sc = slowChecksScenario(SLOW_CHECK_MS);
    beganAt = Date.now();
    run = runHookTimed(sc.iso, { cwd: sc.projDir, lastUserInput: "hi" }, sc.env, 60_000);
    endedAt = Date.now();
  });

  after(() => sc.iso.cleanup());

  for (const name of ["memtrace", "broker"]) {
    test(`stops waiting for the ${name} check within ${CHECKS_DEADLINE_MS} ms plus a margin`, () => {
      const startedAt = Number(fs.readFileSync(sc.markers[name], "utf8"));
      assert.ok(startedAt >= beganAt && startedAt <= endedAt, `the ${name} check recorded no start inside the run`);
      const lateness = endedAt - startedAt;
      assert.ok(
        lateness < CHECKS_DEADLINE_MS + DEADLINE_MARGIN_MS,
        `hook ended ${lateness} ms after the ${name} check started, the deadline is ${CHECKS_DEADLINE_MS} ms plus ${DEADLINE_MARGIN_MS} ms of margin`
      );
    });
  }

  test("keeps the ready notices, reports the memtrace timeout and says nothing about the timed-out broker check", () => {
    assert.equal(sessionMessage(run.out), [MEMTRACE_TIMEOUT_NOTICE, headlessAlwaysNotice(), ADR_HINT].join("\n"));
  });
});

test("session-start starts no memtrace or broker process for a payload with a transcript but no user input", () => {
  const sc = slowChecksScenario(SLOW_CHECK_MS);
  try {
    const transcript = path.join(sc.iso.dirs.root, "transcript.jsonl");
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "MODEL_RESPONSE", text: "working" })}\n`);
    assertNoChecksFor(sc, { cwd: sc.projDir, transcriptPath: transcript });
  } finally {
    sc.iso.cleanup();
  }
});

for (const [label, extra] of [
  ["isSubagent", { isSubagent: true }],
  ["a parentConversationId", { parentConversationId: "parent-1" }],
]) {
  test(`session-start starts no memtrace or broker process for a payload with ${label}`, () => {
    const sc = slowChecksScenario(SLOW_CHECK_MS);
    try {
      assertNoChecksFor(sc, { cwd: sc.projDir, lastUserInput: "audit", ...extra });
    } finally {
      sc.iso.cleanup();
    }
  });
}

function assertNoChecksFor(sc, payload) {
  const { out, elapsedMs } = runHookTimed(sc.iso, payload, sc.env);
  assert.ok(elapsedMs < SLOW_CHECK_MS / 2, `subagent hook took ${Math.round(elapsedMs)} ms`);
  assert.equal(sessionMessage(out), ADR_HINT);
  assert.equal(fs.existsSync(sc.markers.memtrace), false);
  assert.equal(fs.existsSync(sc.markers.broker), false);
}

test("session-start reports both checks, in order, when they answer at once", () => {
  const sc = slowChecksScenario(0);
  try {
    const { out } = runHookTimed(sc.iso, { cwd: sc.projDir, lastUserInput: "hi" }, sc.env);
    assert.equal(
      sessionMessage(out),
      [MEMTRACE_NOTICE, headlessAlwaysNotice(), ADR_HINT, BROKER_NOTICE].join("\n")
    );
  } finally {
    sc.iso.cleanup();
  }
});

test("session-start returns well before the deadline when both checks answer at once", () => {
  const sc = slowChecksScenario(0);
  try {
    const { elapsedMs } = runHookTimed(sc.iso, { cwd: sc.projDir, lastUserInput: "hi" }, sc.env);
    assert.ok(elapsedMs < SLOW_CHECK_MS / 2, `hook took ${Math.round(elapsedMs)} ms with instant checks`);
  } finally {
    sc.iso.cleanup();
  }
});
