import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, mkTemp, runNode, writeOnboardingState } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = path.join(PLUGIN_ROOT, "hooks");
const HOOK = path.join(HOOKS_DIR, "pre-tool-use.mjs");
const NO_OPINION = { decision: "allow" };
const UNREADABLE_LINE = "ignis-swarm pre-tool-use: unreadable hook payload";

function runHook(input, { hookPath = HOOK, state } = {}) {
  const iso = isolatedEnv();
  try {
    if (state) writeOnboardingState(iso.dirs.brokerData, state);
    const res = runNode(hookPath, [], { input, env: iso.env, cwd: PLUGIN_ROOT, timeoutMs: 8000 });
    assert.equal(res.timedOut, false, "the hook timed out");
    assert.equal(res.status, 0, `the hook exited ${res.status}: ${res.stderr}`);
    return { out: JSON.parse(res.stdout.trim()), raw: res.stdout, stderr: res.stderr };
  } finally {
    iso.cleanup();
  }
}

function toolPayload(name, args) {
  return JSON.stringify({ toolCall: { name, args } });
}

const HEADLESS_ALWAYS = {
  reviewRouting: {
    strategy: "headless_always",
    headlessBackend: "claude",
    headlessModel: null,
    effort: "high",
  },
};

for (const name of ["invoke_subagent", "InvokeSubagent", "invoke-subagent", "Invoke Subagent"]) {
  test(`tool name ${JSON.stringify(name)} reaches the subagent gate`, () => {
    const { out } = runHook(toolPayload(name, { TypeName: "blind-edge-hunter" }), { state: HEADLESS_ALWAYS });
    assert.equal(out.decision, "deny");
    assert.match(out.reason, /headless_always/);
  });
}

for (const name of ["run_command", "RunCommand", "run-command", "RUN_COMMAND"]) {
  test(`tool name ${JSON.stringify(name)} reaches the command rules`, () => {
    const { out } = runHook(toolPayload(name, { CommandLine: "git reset --hard" }));
    assert.equal(out.decision, "deny");
  });
}

for (const name of ["read_file", "write_file", "manage_subagents", "define_subagent"]) {
  test(`unrelated tool ${JSON.stringify(name)} gets no opinion even with a dangerous CommandLine`, () => {
    const { out, stderr } = runHook(toolPayload(name, { CommandLine: "git reset --hard", TypeName: "blind-edge-hunter" }), {
      state: HEADLESS_ALWAYS,
    });
    assert.deepEqual(out, NO_OPINION);
    assert.equal(stderr, "");
  });
}

const JSON_ENCODED_COMMANDS = [
  ['"git reset --hard"', "git reset --hard"],
  ['  "git status"  ', "git status"],
  ['"echo \\"hi\\" && ls"', 'echo "hi" && ls'],
  ['"C:\\\\Program Files\\\\app.exe --flag"', "C:\\Program Files\\app.exe --flag"],
];

const PLAIN_COMMANDS = [
  'git -C "D:/my repo" status',
  'git commit -m "msg"',
  '"a" && "b"',
  '"node" "script.js" --flag',
  '"C:\\Program Files\\app.exe"',
  '"unterminated',
  '"',
  "plain command",
];

function commandSeenByRules(commandLine) {
  const root = mkTemp("ignis-dispatch-echo-");
  try {
    fs.cpSync(HOOKS_DIR, path.join(root, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "hooks", "command-rules.mjs"),
      'export function evaluateCommand(commandLine) { return { decision: "deny", reason: commandLine }; }\n',
    );
    const { out } = runHook(toolPayload("run_command", { CommandLine: commandLine }), {
      hookPath: path.join(root, "hooks", "pre-tool-use.mjs"),
    });
    return out.reason;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("a TypeName that is a JSON-encoded string is still gated", () => {
  const { out } = runHook(toolPayload("invoke_subagent", { TypeName: JSON.stringify("blind-edge-hunter") }), {
    state: HEADLESS_ALWAYS,
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /headless_always/);
});

test("a CommandLine that is a JSON-encoded string is still denied", () => {
  const { out } = runHook(toolPayload("run_command", { CommandLine: JSON.stringify("git reset --hard") }));
  assert.equal(out.decision, "deny");
});

test("the command rules see a JSON-encoded CommandLine as its plain value", () => {
  for (const [encoded, plain] of JSON_ENCODED_COMMANDS) {
    assert.equal(commandSeenByRules(encoded), plain, encoded);
  }
});

test("a CommandLine that is not one whole JSON string literal reaches the command rules unchanged", () => {
  for (const commandLine of PLAIN_COMMANDS) {
    assert.equal(commandSeenByRules(commandLine), commandLine, commandLine);
  }
});

test("a payload without a tool name gets no opinion", () => {
  const { out } = runHook(JSON.stringify({ toolCall: { args: { CommandLine: "git reset --hard" } } }));
  assert.deepEqual(out, NO_OPINION);
});

test("invalid JSON on stdin gets no opinion and one stderr line", () => {
  const { out, stderr } = runHook("{not json");
  assert.deepEqual(out, NO_OPINION);
  assert.equal(stderr.trim(), UNREADABLE_LINE);
});

test("empty stdin gets no opinion and one stderr line", () => {
  for (const input of ["", "  \n"]) {
    const { out, stderr } = runHook(input);
    assert.deepEqual(out, NO_OPINION, JSON.stringify(input));
    assert.equal(stderr.trim(), UNREADABLE_LINE);
  }
});

test("stdin that is valid JSON but not a payload object gets no opinion and one stderr line", () => {
  for (const input of ["null", "7", '"text"', "[]", '[{"toolCall":{"name":"run_command"}}]', "{}"]) {
    const { out, stderr } = runHook(input);
    assert.deepEqual(out, NO_OPINION, input);
    assert.equal(stderr.trim(), UNREADABLE_LINE, input);
  }
});

test("a payload that starts with a byte order mark is still read", () => {
  const { out, stderr } = runHook("﻿" + toolPayload("RunCommand", { CommandLine: "git reset --hard" }));
  assert.equal(out.decision, "deny");
  assert.equal(stderr, "");
});

test("a readable payload writes nothing to stderr", () => {
  const { out, stderr } = runHook(toolPayload("run_command", { CommandLine: "npm test" }));
  assert.deepEqual(out, NO_OPINION);
  assert.equal(stderr, "");
});

test("an error in the command rules is written to stderr and the hook gives no opinion", () => {
  const root = mkTemp("ignis-dispatch-throw-");
  try {
    fs.cpSync(HOOKS_DIR, path.join(root, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "hooks", "command-rules.mjs"),
      'export function evaluateCommand() { throw new Error("rules exploded"); }\n',
    );
    const { out, stderr } = runHook(toolPayload("RunCommand", { CommandLine: "git reset --hard" }), {
      hookPath: path.join(root, "hooks", "pre-tool-use.mjs"),
    });
    assert.deepEqual(out, NO_OPINION);
    assert.match(stderr, /ignis-swarm pre-tool-use: rules exploded/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const NO_OPINION_STDOUT = '{"decision":"allow"}';

// The host treats a JSON object without `decision` as a deny (agy CLI 1.5.18, AGYSWM-16), so the
// no-opinion output must be exactly {"decision":"allow"} and never {}.
test("an unmatched command prints exactly the no-opinion string", () => {
  const stdout = runHook(toolPayload("run_command", { CommandLine: "npm test" })).raw;
  assert.equal(stdout, NO_OPINION_STDOUT);
});

test("an unrelated tool prints exactly the no-opinion string", () => {
  const stdout = runHook(toolPayload("read_file", { AbsolutePath: "/tmp/a" })).raw;
  assert.equal(stdout, NO_OPINION_STDOUT);
});

test("an unreadable payload prints exactly the no-opinion string", () => {
  for (const input of ["", "{not json", "{}", "null"]) {
    const stdout = runHook(input).raw;
    assert.equal(stdout, NO_OPINION_STDOUT, JSON.stringify(input));
    assert.notEqual(stdout, "{}", JSON.stringify(input));
  }
});

test("a subagent type the gate has no opinion on prints exactly the no-opinion string", () => {
  const otherType = toolPayload("invoke_subagent", { TypeName: "general-purpose" });
  assert.equal(runHook(otherType, { state: HEADLESS_ALWAYS }).raw, NO_OPINION_STDOUT);
  const hunter = toolPayload("invoke_subagent", { TypeName: "blind-edge-hunter" });
  assert.equal(runHook(hunter).raw, NO_OPINION_STDOUT, "default routing is antigravity_gemini_only");
});
