import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isInteractiveUserSession,
  isSubagentPayload,
  resolveWorkspace,
  sanitizeConversationId,
} from "../hooks/lib.mjs";
import { evaluateCommand } from "../hooks/command-rules.mjs";
import { evaluateSubagent } from "../hooks/subagent-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(PLUGIN_ROOT, "hooks");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function isolatedEnv(root) {
  return {
    ...process.env,
    IGNIS_BROKER_HOME: path.join(root, "broker-home"),
    IGNIS_BROKER_DATA: path.join(root, "broker-data"),
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
  };
}

test("resolveWorkspace prefers an existing cwd, then the first workspace path, then empty", () => {
  const dir = makeTempDir("ignis-lib-ws-");
  try {
    assert.equal(resolveWorkspace({ cwd: dir, workspacePaths: ["/other"] }), dir);
    const missing = path.join(dir, "does-not-exist");
    assert.equal(resolveWorkspace({ cwd: missing, workspacePaths: ["/first", "/second"] }), "/first");
    assert.equal(resolveWorkspace({ workspacePaths: ["/first"] }), "/first");
    assert.equal(resolveWorkspace({ cwd: missing, workspacePaths: [] }), "");
    assert.equal(resolveWorkspace({ cwd: missing, workspacePaths: "nope" }), "");
    assert.equal(resolveWorkspace({}), "");
  } finally {
    removeDir(dir);
  }
});

test("isSubagentPayload is a negative check on the three subagent markers", () => {
  assert.equal(isSubagentPayload({ isSubagent: true }), true);
  assert.equal(isSubagentPayload({ subagent: true }), true);
  assert.equal(isSubagentPayload({ parentConversationId: "parent-1" }), true);
  assert.equal(isSubagentPayload({}), false);
  assert.equal(isSubagentPayload({ isSubagent: "true" }), false);
  assert.equal(isSubagentPayload({ subagent: 1 }), false);
  assert.equal(isSubagentPayload({ parentConversationId: "" }), false);
  assert.equal(isSubagentPayload({ lastUserInput: "hello" }), false);
});

test("isInteractiveUserSession needs positive evidence of a user and rejects subagents", () => {
  assert.equal(isInteractiveUserSession({}), false);
  assert.equal(isInteractiveUserSession({ lastUserInput: "" }), false);
  assert.equal(isInteractiveUserSession({ lastUserInput: "   " }), false);
  assert.equal(isInteractiveUserSession({ lastUserInput: 42 }), false);
  assert.equal(isInteractiveUserSession({ lastUserInput: "build it" }), true);
  assert.equal(isInteractiveUserSession({ lastUserInput: "build it", isSubagent: true }), false);
  assert.equal(isInteractiveUserSession({ lastUserInput: "build it", subagent: true }), false);
  assert.equal(
    isInteractiveUserSession({ lastUserInput: "build it", parentConversationId: "p" }),
    false,
  );
  assert.equal(isInteractiveUserSession({ transcriptPath: "   " }), false);
});

test("isInteractiveUserSession reads USER_INPUT from the head of a transcript file", () => {
  const dir = makeTempDir("ignis-lib-tr-");
  try {
    const withUser = path.join(dir, "with-user.jsonl");
    fs.writeFileSync(withUser, `${JSON.stringify({ type: "USER_INPUT", text: "hi" })}\n`);
    const spacedUser = path.join(dir, "spaced-user.jsonl");
    fs.writeFileSync(spacedUser, '{"type" : "USER_INPUT"}\n');
    const withoutUser = path.join(dir, "without-user.jsonl");
    fs.writeFileSync(withoutUser, `${JSON.stringify({ type: "PLANNER_RESPONSE" })}\n`);
    const lateUser = path.join(dir, "late-user.jsonl");
    fs.writeFileSync(
      lateUser,
      `${"x".repeat(5000)}\n${JSON.stringify({ type: "USER_INPUT" })}\n`,
    );
    const missing = path.join(dir, "missing.jsonl");

    assert.equal(isInteractiveUserSession({ transcriptPath: withUser }), true);
    assert.equal(isInteractiveUserSession({ transcriptPath: spacedUser }), true);
    assert.equal(isInteractiveUserSession({ transcriptPath: withoutUser }), false);
    assert.equal(isInteractiveUserSession({ transcriptPath: lateUser }), false);
    assert.equal(isInteractiveUserSession({ transcriptPath: missing }), false);
    assert.equal(isInteractiveUserSession({ transcriptPath: withUser, isSubagent: true }), false);
    assert.equal(
      isInteractiveUserSession({ transcriptPath: withUser, parentConversationId: "p" }),
      false,
    );
  } finally {
    removeDir(dir);
  }
});

test("sanitizeConversationId keeps dots, trims, falls back to unknown and neutralises separators", () => {
  assert.equal(sanitizeConversationId("conv-123_a.b"), "conv-123_a.b");
  assert.equal(sanitizeConversationId("  conv-1  "), "conv-1");
  assert.equal(sanitizeConversationId("a b/c\\d:e"), "a_b_c_d_e");
  assert.equal(sanitizeConversationId("../x"), ".._x");
  assert.equal(sanitizeConversationId("..\\..\\evil"), ".._.._evil");
  assert.equal(sanitizeConversationId(undefined), "unknown");
  assert.equal(sanitizeConversationId(null), "unknown");
  assert.equal(sanitizeConversationId(""), "unknown");
  assert.equal(sanitizeConversationId("   "), "unknown");
  assert.equal(sanitizeConversationId(12345), "12345");
  for (const hostile of ["../x", "..\\x", "/etc/passwd", "a/../../b", "C:\\Windows"]) {
    assert.doesNotMatch(sanitizeConversationId(hostile), /[\\/:]/, `separator left in: ${hostile}`);
  }
});

test("evaluateCommand returns deny, ask or null in rule order", () => {
  const deny = evaluateCommand("git reset --hard HEAD~1");
  assert.equal(deny.decision, "deny");
  assert.match(deny.reason, /git reset --hard/);

  const ask = evaluateCommand("git push --force-with-lease origin feat/a");
  assert.equal(ask.decision, "force_ask");
  assert.match(ask.reason, /force push/);

  assert.equal(evaluateCommand("git push --force origin main").decision, "deny");
  assert.equal(evaluateCommand("git commit -m wip --no-verify").decision, "deny");
  assert.equal(evaluateCommand("git clean -fd").decision, "force_ask");

  assert.equal(evaluateCommand("npm test"), null);
  assert.equal(evaluateCommand(""), null);
  assert.equal(evaluateCommand("   "), null);
  assert.equal(evaluateCommand(undefined), null);
});

test("evaluateSubagent returns null for subagents that are not blind-edge-hunter", () => {
  assert.equal(
    evaluateSubagent({ toolCall: { name: "invoke_subagent", args: { TypeName: "code-reviewer" } } }),
    null,
  );
  assert.equal(
    evaluateSubagent({ toolCall: { name: "invoke_subagent", args: { typeName: "research" } } }),
    null,
  );
  assert.equal(evaluateSubagent({ toolCall: { name: "invoke_subagent", args: {} } }), null);
  assert.equal(evaluateSubagent({}), null);
});

test("evaluateSubagent returns null for blind-edge-hunter when routing is not headless_always", () => {
  const root = makeTempDir("ignis-lib-gate-");
  const saved = {};
  const env = isolatedEnv(root);
  for (const key of ["IGNIS_BROKER_HOME", "IGNIS_BROKER_DATA"]) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    assert.equal(
      evaluateSubagent({
        cwd: root,
        toolCall: { name: "invoke_subagent", args: { TypeName: "blind-edge-hunter" } },
      }),
      null,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeDir(root);
  }
});

test("readStdin parses JSON from stdin and returns an empty object for empty or invalid input", () => {
  const dir = makeTempDir("ignis-lib-stdin-");
  try {
    const script = path.join(dir, "read-stdin.mjs");
    const libUrl = pathToFileURL(path.join(HOOKS_DIR, "lib.mjs")).href;
    fs.writeFileSync(
      script,
      `import { readStdin } from ${JSON.stringify(libUrl)};\nprocess.stdout.write(JSON.stringify(readStdin()));\n`,
    );
    const run = (input) => {
      const res = spawnSync(process.execPath, [script], {
        input,
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    };
    assert.deepEqual(run('{"a":1,"b":[2]}'), { a: 1, b: [2] });
    assert.deepEqual(run('  {"a":1}\n'), { a: 1 });
    assert.deepEqual(run(""), {});
    assert.deepEqual(run("  \n"), {});
    assert.deepEqual(run("not json"), {});
  } finally {
    removeDir(dir);
  }
});

const BROKEN_GATES = {
  "a syntax error": "export function evaluateSubagent( {\n",
  "an import of a missing broker module":
    'import "../scripts/broker/missing.mjs";\nexport function evaluateSubagent() { return null; }\n',
  "an evaluator that throws":
    'export function evaluateSubagent() { throw new Error("gate exploded"); }\n',
};

function runCopiedPreToolUse(root, input) {
  const res = spawnSync(process.execPath, [path.join(root, "hooks", "pre-tool-use.mjs")], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: isolatedEnv(root),
    timeout: 8000,
    windowsHide: true,
  });
  assert.equal(res.status, 0, `pre-tool-use exited ${res.status}: ${res.stderr}`);
  return { out: JSON.parse(res.stdout.trim()), stderr: res.stderr };
}

for (const [label, source] of Object.entries(BROKEN_GATES)) {
  test(`pre-tool-use keeps the command guard when the subagent gate has ${label}`, () => {
    const root = makeTempDir("ignis-lib-broken-");
    try {
      fs.cpSync(HOOKS_DIR, path.join(root, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(root, "hooks", "subagent-gate.mjs"), source);

      const denied = runCopiedPreToolUse(root, {
        toolCall: { name: "run_command", args: { CommandLine: "git reset --hard" } },
      });
      assert.equal(denied.out.decision, "deny");

      const asked = runCopiedPreToolUse(root, {
        toolCall: { name: "run_command", args: { CommandLine: "git clean -fd" } },
      });
      assert.equal(asked.out.decision, "force_ask");

      const allowed = runCopiedPreToolUse(root, {
        toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
      });
      assert.equal(allowed.out.decision, "allow");

      const subagent = runCopiedPreToolUse(root, {
        toolCall: { name: "invoke_subagent", args: { TypeName: "blind-edge-hunter" } },
      });
      assert.equal(subagent.out.decision, "allow");
      assert.notEqual(subagent.stderr.trim(), "", "a gate failure must be reported on stderr");
    } finally {
      removeDir(root);
    }
  });
}

test("pre-tool-use prints allow and exits 0 when stdin is not an object", () => {
  const root = makeTempDir("ignis-lib-null-");
  try {
    fs.cpSync(HOOKS_DIR, path.join(root, "hooks"), { recursive: true });
    for (const input of [null, 7, "text"]) {
      const res = spawnSync(process.execPath, [path.join(root, "hooks", "pre-tool-use.mjs")], {
        cwd: root,
        input: JSON.stringify(input),
        encoding: "utf8",
        env: isolatedEnv(root),
        timeout: 8000,
        windowsHide: true,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout.trim()), { decision: "allow" });
    }
  } finally {
    removeDir(root);
  }
});

test("pre-tool-use and command-rules have no static dependency on the broker or the subagent gate", () => {
  const preToolUse = fs.readFileSync(path.join(HOOKS_DIR, "pre-tool-use.mjs"), "utf8");
  const commandRules = fs.readFileSync(path.join(HOOKS_DIR, "command-rules.mjs"), "utf8");
  assert.doesNotMatch(preToolUse, /scripts\/broker/);
  assert.doesNotMatch(commandRules, /scripts\/broker/);
  assert.doesNotMatch(preToolUse, /^import\b[^\n]*subagent-gate/m);
  assert.match(preToolUse, /import\(\s*["']\.\/subagent-gate\.mjs["']\s*\)/);
});

test("no hook redefines a helper that lives in hooks/lib.mjs", () => {
  const helperDefinition =
    /(?:function|const|let)\s+(?:readStdin|resolveWorkspace|isSubagentPayload|isInteractiveUserSession|sanitizeConversationId|sanitizeConvId)\b/;
  for (const name of fs.readdirSync(HOOKS_DIR)) {
    if (!name.endsWith(".mjs") || name === "lib.mjs") continue;
    const source = fs.readFileSync(path.join(HOOKS_DIR, name), "utf8");
    assert.doesNotMatch(source, helperDefinition, `${name} redefines a shared helper`);
  }
});
