import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isInteractiveUserSession,
  isSubagentPayload,
  resolveWorkspace,
  sanitizeConversationId,
} from "../hooks/lib.mjs";
import { evaluateCommand } from "../hooks/command-rules.mjs";
import { evaluateSubagent } from "../hooks/subagent-gate.mjs";
import { isolatedEnv, mkTemp, removeTree, runNode } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(PLUGIN_ROOT, "hooks");
// Spawned hooks start slowly when the whole suite runs in parallel; the bound only catches a hang.
const HOOK_TIMEOUT_MS = 60_000;

/** Run `fn(iso, root)` with a fresh isolated environment and an empty temp folder; both are removed afterwards. */
function withSandbox(prefix, fn) {
  const iso = isolatedEnv();
  const root = mkTemp(prefix);
  try {
    return fn(iso, root);
  } finally {
    removeTree(root);
    iso.cleanup();
  }
}

/** Run `fn` with the broker environment variables of `iso` set on this process, then restore them. */
function withBrokerEnv(iso, fn) {
  const keys = ["IGNIS_BROKER_HOME", "IGNIS_BROKER_DATA"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = iso.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function subagentCall(args) {
  return { toolCall: { name: "invoke_subagent", args } };
}

test("resolveWorkspace prefers an existing cwd over the workspace paths", () => {
  withSandbox("ignis-lib-ws-", (iso, dir) => {
    assert.equal(resolveWorkspace({ cwd: dir, workspacePaths: ["/other"] }), dir);
  });
});

test("resolveWorkspace falls back to the first workspace path when cwd does not exist", () => {
  withSandbox("ignis-lib-ws-", (iso, dir) => {
    const missing = path.join(dir, "does-not-exist");
    assert.equal(resolveWorkspace({ cwd: missing, workspacePaths: ["/first", "/second"] }), "/first");
  });
});

test("resolveWorkspace uses the first workspace path when there is no cwd", () => {
  assert.equal(resolveWorkspace({ workspacePaths: ["/first"] }), "/first");
});

for (const [label, payload] of [
  ["an empty workspace list", { workspacePaths: [] }],
  ["a workspace list that is not an array", { workspacePaths: "nope" }],
  ["no cwd and no workspace list", {}],
]) {
  test(`resolveWorkspace returns an empty string for ${label}`, () => {
    withSandbox("ignis-lib-ws-", (iso, dir) => {
      const input = "workspacePaths" in payload ? { cwd: path.join(dir, "does-not-exist"), ...payload } : payload;
      assert.equal(resolveWorkspace(input), "");
    });
  });
}

for (const [payload, expected] of [
  [{ isSubagent: true }, true],
  [{ subagent: true }, true],
  [{ parentConversationId: "parent-1" }, true],
  [{}, false],
  [{ isSubagent: "true" }, false],
  [{ subagent: 1 }, false],
  [{ parentConversationId: "" }, false],
  [{ lastUserInput: "hello" }, false],
]) {
  test(`isSubagentPayload(${JSON.stringify(payload)}) is ${expected}`, () => {
    assert.equal(isSubagentPayload(payload), expected);
  });
}

for (const [payload, expected] of [
  [{}, false],
  [{ lastUserInput: "" }, false],
  [{ lastUserInput: "   " }, false],
  [{ lastUserInput: 42 }, false],
  [{ lastUserInput: "build it" }, true],
  [{ lastUserInput: "build it", isSubagent: true }, false],
  [{ lastUserInput: "build it", subagent: true }, false],
  [{ lastUserInput: "build it", parentConversationId: "p" }, false],
  [{ transcriptPath: "   " }, false],
]) {
  test(`isInteractiveUserSession(${JSON.stringify(payload)}) is ${expected}`, () => {
    assert.equal(isInteractiveUserSession(payload), expected);
  });
}

const USER_INPUT_LINE = `${JSON.stringify({ type: "USER_INPUT", text: "hi" })}\n`;

const TRANSCRIPTS = [
  ["a USER_INPUT line at the head", USER_INPUT_LINE, true],
  ["a USER_INPUT line with spaces around the colon", '{"type" : "USER_INPUT"}\n', true],
  ["no USER_INPUT line", `${JSON.stringify({ type: "PLANNER_RESPONSE" })}\n`, false],
  ["a USER_INPUT line beyond the head of the file", `${"x".repeat(5000)}\n${JSON.stringify({ type: "USER_INPUT" })}\n`, false],
];

for (const [label, content, expected] of TRANSCRIPTS) {
  test(`isInteractiveUserSession on a transcript with ${label} is ${expected}`, () => {
    withSandbox("ignis-lib-tr-", (iso, dir) => {
      const transcript = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(transcript, content);
      assert.equal(isInteractiveUserSession({ transcriptPath: transcript }), expected);
    });
  });
}

test("isInteractiveUserSession rejects a missing transcript file", () => {
  withSandbox("ignis-lib-tr-", (iso, dir) => {
    assert.equal(isInteractiveUserSession({ transcriptPath: path.join(dir, "missing.jsonl") }), false);
  });
});

for (const [label, extra] of [
  ["isSubagent", { isSubagent: true }],
  ["parentConversationId", { parentConversationId: "p" }],
]) {
  test(`isInteractiveUserSession rejects a transcript with a user when ${label} is set`, () => {
    withSandbox("ignis-lib-tr-", (iso, dir) => {
      const transcript = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(transcript, USER_INPUT_LINE);
      assert.equal(isInteractiveUserSession({ transcriptPath: transcript, ...extra }), false);
    });
  });
}

for (const [input, expected] of [
  ["conv-123_a.b", "conv-123_a.b"],
  ["  conv-1  ", "conv-1"],
  ["a b/c\\d:e", "a_b_c_d_e"],
  ["../x", ".._x"],
  ["..\\..\\evil", ".._.._evil"],
  [undefined, "unknown"],
  [null, "unknown"],
  ["", "unknown"],
  ["   ", "unknown"],
  [12345, "12345"],
]) {
  test(`sanitizeConversationId(${JSON.stringify(input)}) is ${JSON.stringify(expected)}`, () => {
    assert.equal(sanitizeConversationId(input), expected);
  });
}

for (const hostile of ["../x", "..\\x", "/etc/passwd", "a/../../b", "C:\\Windows"]) {
  test(`sanitizeConversationId leaves no path separator in ${JSON.stringify(hostile)}`, () => {
    assert.doesNotMatch(sanitizeConversationId(hostile), /[\\/:]/);
  });
}

for (const [command, decision, reasonPattern] of [
  ["git reset --hard HEAD~1", "deny", /git reset --hard/],
  ["git push --force-with-lease origin feat/a", "force_ask", /force push/],
  ["git push --force origin main", "deny", /force-pushing to main\/master is forbidden/],
  ["git commit -m wip --no-verify", "deny", /--no-verify/],
  ["git clean -fd", "force_ask", /git clean -f/],
]) {
  test(`evaluateCommand ${JSON.stringify(command)} is ${decision}`, () => {
    const result = evaluateCommand(command);
    assert.equal(result.decision, decision);
    assert.match(result.reason, reasonPattern);
  });
}

for (const command of ["npm test", "", "   ", undefined]) {
  test(`evaluateCommand has no opinion on ${JSON.stringify(command)}`, () => {
    assert.equal(evaluateCommand(command), null);
  });
}

for (const [label, payload] of [
  ["TypeName code-reviewer", subagentCall({ TypeName: "code-reviewer" })],
  ["typeName research", subagentCall({ typeName: "research" })],
  ["no type name", subagentCall({})],
  ["no tool call", {}],
]) {
  test(`evaluateSubagent returns null for ${label}`, () => {
    withSandbox("ignis-lib-gate-other-", (iso) => {
      withBrokerEnv(iso, () => assert.equal(evaluateSubagent(payload), null));
    });
  });
}

test("evaluateSubagent returns null for blind-edge-hunter when routing is not headless_always", () => {
  withSandbox("ignis-lib-gate-", (iso, root) => {
    withBrokerEnv(iso, () => {
      assert.equal(evaluateSubagent({ cwd: root, ...subagentCall({ TypeName: "blind-edge-hunter" }) }), null);
    });
  });
});

const STDIN_CASES = [
  ["a JSON object", '{"a":1,"b":[2]}', { a: 1, b: [2] }],
  ["a JSON object with surrounding whitespace", '  {"a":1}\n', { a: 1 }],
  ["empty input", "", {}],
  ["whitespace only", "  \n", {}],
  ["text that is not JSON", "not json", {}],
];

for (const [label, input, expected] of STDIN_CASES) {
  test(`readStdin returns ${JSON.stringify(expected)} for ${label}`, () => {
    withSandbox("ignis-lib-stdin-", (iso, dir) => {
      const script = path.join(dir, "read-stdin.mjs");
      const libUrl = pathToFileURL(path.join(HOOKS_DIR, "lib.mjs")).href;
      fs.writeFileSync(
        script,
        `import { readStdin } from ${JSON.stringify(libUrl)};\nprocess.stdout.write(JSON.stringify(readStdin()));\n`,
      );
      const res = runNode(script, [], { input, env: iso.env, timeoutMs: HOOK_TIMEOUT_MS });
      assert.equal(res.timedOut, false, "readStdin script timed out");
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), expected);
    });
  });
}

const BROKEN_GATES = {
  "a syntax error": "export function evaluateSubagent( {\n",
  "an import of a missing broker module":
    'import "../scripts/broker/missing.mjs";\nexport function evaluateSubagent() { return null; }\n',
  "an evaluator that throws":
    'export function evaluateSubagent() { throw new Error("gate exploded"); }\n',
};

/** Run a copy of the hooks, with `gateSource` as its subagent gate, on one tool call. */
function runCopiedPreToolUse(gateSource, toolCall) {
  return withSandbox("ignis-lib-broken-", (iso, root) => {
    fs.cpSync(HOOKS_DIR, path.join(root, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(root, "hooks", "subagent-gate.mjs"), gateSource);
    const res = runNode(path.join(root, "hooks", "pre-tool-use.mjs"), [], {
      cwd: root,
      input: JSON.stringify({ toolCall }),
      env: iso.env,
      timeoutMs: HOOK_TIMEOUT_MS,
    });
    assert.equal(res.timedOut, false, "pre-tool-use timed out");
    assert.equal(res.status, 0, `pre-tool-use exited ${res.status}: ${res.stderr}`);
    return { out: JSON.parse(res.stdout.trim()), stderr: res.stderr };
  });
}

const GUARDED_COMMANDS = [
  ["denies git reset --hard", "git reset --hard", "deny"],
  ["asks before git clean -fd", "git clean -fd", "force_ask"],
  ["allows npm test", "npm test", "allow"],
];

for (const [gateLabel, source] of Object.entries(BROKEN_GATES)) {
  for (const [label, commandLine, decision] of GUARDED_COMMANDS) {
    test(`pre-tool-use ${label} when the subagent gate has ${gateLabel}`, () => {
      const result = runCopiedPreToolUse(source, { name: "run_command", args: { CommandLine: commandLine } });
      assert.equal(result.out.decision, decision);
    });
  }

  test(`pre-tool-use allows a subagent and reports on stderr when the subagent gate has ${gateLabel}`, () => {
    const result = runCopiedPreToolUse(source, { name: "invoke_subagent", args: { TypeName: "blind-edge-hunter" } });
    assert.equal(result.out.decision, "allow");
    assert.match(result.stderr.trim(), /^ignis-swarm pre-tool-use: .+/);
  });
}

for (const input of [null, 7, "text"]) {
  test(`pre-tool-use prints allow and exits 0 when stdin is ${JSON.stringify(input)}`, () => {
    withSandbox("ignis-lib-null-", (iso, root) => {
      fs.cpSync(HOOKS_DIR, path.join(root, "hooks"), { recursive: true });
      const res = runNode(path.join(root, "hooks", "pre-tool-use.mjs"), [], {
        cwd: root,
        input: JSON.stringify(input),
        env: iso.env,
        timeoutMs: HOOK_TIMEOUT_MS,
      });
      assert.equal(res.timedOut, false, "pre-tool-use timed out");
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout.trim()), { decision: "allow" });
    });
  });
}

test("pre-tool-use has no static dependency on the broker", () => {
  const preToolUse = fs.readFileSync(path.join(HOOKS_DIR, "pre-tool-use.mjs"), "utf8");
  assert.doesNotMatch(preToolUse, /scripts\/broker/);
});

test("command-rules has no static dependency on the broker", () => {
  const commandRules = fs.readFileSync(path.join(HOOKS_DIR, "command-rules.mjs"), "utf8");
  assert.doesNotMatch(commandRules, /scripts\/broker/);
});

test("pre-tool-use loads the subagent gate by dynamic import only", () => {
  const preToolUse = fs.readFileSync(path.join(HOOKS_DIR, "pre-tool-use.mjs"), "utf8");
  assert.doesNotMatch(preToolUse, /^import\b[^\n]*subagent-gate/m);
  assert.match(preToolUse, /import\(\s*["']\.\/subagent-gate\.mjs["']\s*\)/);
});

const SHARED_HELPER_DEFINITION =
  /(?:function|const|let)\s+(?:readStdin|resolveWorkspace|isSubagentPayload|isInteractiveUserSession|sanitizeConversationId|sanitizeConvId)\b/;

for (const name of fs.readdirSync(HOOKS_DIR)) {
  if (!name.endsWith(".mjs") || name === "lib.mjs") continue;
  test(`${name} does not redefine a helper that lives in hooks/lib.mjs`, () => {
    const source = fs.readFileSync(path.join(HOOKS_DIR, name), "utf8");
    assert.doesNotMatch(source, SHARED_HELPER_DEFINITION);
  });
}

test("pre-tool-use statically imports only the two hook siblings, so a crash elsewhere cannot block every tool", () => {
  const preToolUse = fs.readFileSync(path.join(HOOKS_DIR, "pre-tool-use.mjs"), "utf8");
  const specifiers = [...preToolUse.matchAll(/^import\b[^\n]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
  assert.deepEqual(specifiers.sort(), ["./command-rules.mjs", "./lib.mjs"]);
});
