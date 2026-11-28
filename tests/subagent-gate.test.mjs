import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_STATE_TTL_MS, recordReviewState } from "../scripts/broker/review-state.mjs";
import { gitToplevel, headSha } from "../scripts/lib/git-changes.mjs";
import { initGitRepo, isolatedEnv, runGit, runNode, writeOnboardingState } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "pre-tool-use.mjs");
const RUNNER = path.join(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");
const HOOK_TIMEOUT_MS = 60_000;
const HUNTER = { TypeName: "blind-edge-hunter" };
const ALREADY_COMPLETED =
  "the headless reviewer already completed for every workspace root; use its output instead of the native blind-edge-hunter.";
const UNREADABLE_TYPE = "could not read the subagent type; refusing native review under headless_always";

function routing(strategy) {
  return {
    strategy,
    headlessBackend: strategy === "antigravity_gemini_only" ? null : "claude",
    headlessModel: null,
    effort: "high",
  };
}

function setup(t) {
  const iso = isolatedEnv();
  t.after(() => iso.cleanup());
  const { env, dirs } = iso;
  const workspace = path.join(dirs.root, "ws");
  const repo = initGitRepo(path.join(workspace, "repo"), { env });
  const other = initGitRepo(path.join(workspace, "repo-other"), { env });
  const plain = path.join(workspace, "plain");
  fs.mkdirSync(plain, { recursive: true });
  const sub = path.join(repo, "packages", "app");
  fs.mkdirSync(sub, { recursive: true });

  const mark = (dir, status, extra = {}) =>
    recordReviewState(dirs.brokerData, dir, { status, reason: null, headSha: headSha(dir, { env }), ...extra });

  const gate = ({ strategy = "headless_always", args = HUNTER, cwd = repo, workspacePaths, reviewRouting, hookEnv = env } = {}) => {
    writeOnboardingState(dirs.brokerData, { reviewRouting: reviewRouting ?? routing(strategy) });
    const payload = { cwd, toolCall: { name: "invoke_subagent", args } };
    if (workspacePaths !== undefined) payload.workspacePaths = workspacePaths;
    const res = runNode(HOOK, [], { input: JSON.stringify(payload), env: hookEnv, cwd: PLUGIN_ROOT, timeoutMs: HOOK_TIMEOUT_MS });
    assert.equal(res.status, 0, `pre-tool-use hook failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim());
  };

  const noGitEnv = () => {
    const emptyBin = path.join(dirs.root, "no-git-here");
    fs.mkdirSync(emptyBin, { recursive: true });
    const stripped = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"));
    return { ...stripped, PATH: emptyBin };
  };

  const rootOf = (dir) => gitToplevel(dir, { env }).root;
  const command = (dir) => `node "${RUNNER}" --base <base-sha> --backend auto --cwd "${rootOf(dir)}"`;

  return { env, dirs, repo, other, plain, sub, mark, gate, noGitEnv, rootOf, command };
}

test("headless_always denies blind-edge-hunter without a review state and names the runner command", (t) => {
  const { gate, repo, command } = setup(t);
  const denied = gate();
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(command(repo)), denied.reason);
});

const HUNTER_SPELLINGS = [
  { typeName: "blind-edge-hunter" },
  { TypeName: "", typeName: "blind-edge-hunter" },
  { TypeName: "research", typeName: "blind-edge-hunter" },
  { TypeName: "blind-edge-hunter", typeName: "research" },
  { TypeName: "Blind-Edge-Hunter" },
  { TypeName: "ignis-swarm:blind-edge-hunter" },
  { TypeName: "ignis-swarm/blind-edge-hunter" },
];

for (const args of HUNTER_SPELLINGS) {
  test(`headless_always denies blind-edge-hunter spelled ${JSON.stringify(args)}`, (t) => {
    assert.equal(setup(t).gate({ args }).decision, "deny");
  });
}

test("a fresh fallback record for the repository allows blind-edge-hunter", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "fallback", { reason: "claude exited with status 3" });
  assert.equal(gate().decision, "allow");
});

test("a fresh fallback record for the repository allows blind-edge-hunter from a subdirectory", (t) => {
  const { mark, gate, repo, sub } = setup(t);
  mark(repo, "fallback", { reason: "claude exited with status 3" });
  assert.equal(gate({ cwd: sub }).decision, "allow");
});

test("a record made from a subdirectory belongs to the repository root, not the subdirectory", (t) => {
  const { mark, gate, repo, sub } = setup(t);
  mark(sub, "fallback");
  assert.equal(gate({ cwd: repo }).decision, "deny");
});

test("a record for one repository does not allow another repository", (t) => {
  const { mark, gate, repo, other } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate({ cwd: other }).decision, "deny");
});

test("a fallback record no longer allows once HEAD has moved", (t) => {
  const { mark, gate, repo, env } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate().decision, "allow");
  runGit(repo, ["commit", "--allow-empty", "-m", "moved"], { env });
  assert.equal(gate().decision, "deny");
});

test("a fallback record older than the time limit does not allow", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "fallback", { nowMs: Date.now() - REVIEW_STATE_TTL_MS - 60_000 });
  assert.equal(gate().decision, "deny");
});

for (const status of ["reviewed", "empty"]) {
  test(`a ${status} record alone does not allow the native reviewer`, (t) => {
    const { mark, gate, repo } = setup(t);
    mark(repo, status);
    assert.equal(gate().decision, "deny");
  });
}

test("a workspace without a record denies even when another workspace has a fallback record", (t) => {
  const { mark, gate, repo, other } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate({ cwd: repo, workspacePaths: [repo, other] }).decision, "deny");
});

for (const otherStatus of ["empty", "reviewed", "fallback"]) {
  test(`a fallback record plus a ${otherStatus} record for the other workspace allows`, (t) => {
    const { mark, gate, repo, other } = setup(t);
    mark(repo, "fallback");
    mark(other, otherStatus);
    assert.equal(gate({ cwd: repo, workspacePaths: [repo, other] }).decision, "allow");
  });
}

test("a workspace path outside any git repository is ignored next to a repository with a record", (t) => {
  const { mark, gate, repo, plain } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate({ cwd: repo, workspacePaths: [repo, plain] }).decision, "allow");
});

test("a cwd outside any git repository is ignored when a workspace repository has a record", (t) => {
  const { mark, gate, repo, plain } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate({ cwd: plain, workspacePaths: [repo] }).decision, "allow");
});

test("a session whose cwd is outside a git repository is allowed", (t) => {
  const { gate, plain } = setup(t);
  assert.equal(gate({ cwd: plain }).decision, "allow");
});

test("a session whose every workspace path is outside a git repository is allowed", (t) => {
  const { gate, plain, dirs } = setup(t);
  const second = path.join(dirs.root, "ws", "plain-two");
  fs.mkdirSync(second, { recursive: true });
  assert.equal(gate({ cwd: plain, workspacePaths: [plain, second] }).decision, "allow");
});

test("empty workspace values deny and say that no workspace was supplied", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "fallback");
  const denied = gate({ cwd: "", workspacePaths: [""] });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /no workspace supplied/);
});

test("with git available the same fallback record allows (control for the no-git denial)", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate().decision, "allow");
});

test("the gate denies when git cannot be run", (t) => {
  const { mark, gate, repo, noGitEnv } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate({ hookEnv: noGitEnv() }).decision, "deny");
});

test("the no-git denial names the directory, the git command and the error, and offers no runner command", (t) => {
  const { mark, gate, repo, noGitEnv } = setup(t);
  mark(repo, "fallback");
  const denied = gate({ hookEnv: noGitEnv() });
  assert.ok(denied.reason.includes(`${repo}: `), denied.reason);
  assert.match(denied.reason, /git rev-parse --show-toplevel/);
  assert.match(denied.reason, /ENOENT/);
  assert.ok(!denied.reason.includes("--cwd"), denied.reason);
});

test("an unconfigured headless backend is named in the denial", (t) => {
  const { gate } = setup(t);
  const denied = gate({
    reviewRouting: { strategy: "headless_always", headlessBackend: null, headlessModel: null, effort: "high" },
  });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /\(backend=unconfigured, model=none\)/);
});

for (const strategy of ["antigravity_first", "antigravity_gemini_only"]) {
  test(`the ${strategy} strategy does not gate blind-edge-hunter`, (t) => {
    assert.equal(setup(t).gate({ strategy }).decision, "allow");
  });
}

test("other subagent types are not gated under headless_always", (t) => {
  assert.equal(setup(t).gate({ args: { TypeName: "research" } }).decision, "allow");
});

test("when every root already has a reviewed or empty record the denial says the headless review is complete", (t) => {
  const { mark, gate, repo, other } = setup(t);
  mark(repo, "reviewed");
  mark(other, "empty");
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(ALREADY_COMPLETED), denied.reason);
});

test("the headless-review-complete denial offers no runner command", (t) => {
  const { mark, gate, repo, other } = setup(t);
  mark(repo, "reviewed");
  mark(other, "empty");
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.ok(!denied.reason.includes("--cwd"), denied.reason);
});

test("the headless-review-complete denial also applies to a single reviewed workspace", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "reviewed");
  assert.ok(gate({ cwd: repo }).reason.includes(ALREADY_COMPLETED));
});

test("the denial lists only the roots that lack a current record, each with its own runner command", (t) => {
  const { mark, gate, repo, other, command } = setup(t);
  mark(repo, "fallback");
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(command(other)), denied.reason);
  assert.ok(!denied.reason.includes(command(repo)), denied.reason);
});

test("the denial for a partly covered session mentions fallbackToNative and not the completed message", (t) => {
  const { mark, gate, repo, other } = setup(t);
  mark(repo, "fallback");
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.ok(denied.reason.includes("fallbackToNative: true"), denied.reason);
  assert.ok(!denied.reason.includes(ALREADY_COMPLETED), denied.reason);
});

test("when no root has a current record the denial lists every root", (t) => {
  const { gate, repo, other, command } = setup(t);
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(command(repo)), denied.reason);
  assert.ok(denied.reason.includes(command(other)), denied.reason);
});

test("when no root has a current record the denial names the backend and model", (t) => {
  const { gate, repo, other } = setup(t);
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.match(denied.reason, /\(backend=claude, model=opus\)/);
});

/** Hook environments that point git at the other repository; root detection must ignore them. */
function redirectedEnvs({ env, other }) {
  const pointedAtOther = { ...env, GIT_DIR: path.join(other, ".git") };
  return [
    ["GIT_DIR", pointedAtOther],
    ["GIT_DIR and GIT_WORK_TREE", { ...pointedAtOther, GIT_WORK_TREE: other }],
  ];
}

for (const [label, index] of [["GIT_DIR", 0], ["GIT_DIR and GIT_WORK_TREE", 1]]) {
  test(`${label} in the hook environment does not redirect root detection`, (t) => {
    const { mark, gate, repo, other, sub, env } = setup(t);
    runGit(other, ["commit", "--allow-empty", "-m", "other moved"], { env });
    mark(repo, "fallback");
    const [, hookEnv] = redirectedEnvs({ env, other })[index];
    assert.equal(gate({ cwd: sub, hookEnv }).decision, "allow");
  });
}

const UNREADABLE_ARGS = [
  null,
  "blind-edge-hunter",
  ["blind-edge-hunter"],
  {},
  { Prompt: "review this" },
  { TypeName: 7 },
  { typeName: null },
];

for (const args of UNREADABLE_ARGS) {
  test(`an unreadable subagent payload ${JSON.stringify(args)} is denied under headless_always`, (t) => {
    const denied = setup(t).gate({ args });
    assert.equal(denied.decision, "deny");
    assert.ok(denied.reason.includes(UNREADABLE_TYPE), denied.reason);
  });

  for (const strategy of ["antigravity_first", "antigravity_gemini_only"]) {
    test(`an unreadable subagent payload ${JSON.stringify(args)} is ignored under ${strategy}`, (t) => {
      assert.equal(setup(t).gate({ args, strategy }).decision, "allow");
    });
  }
}

test("a readable non-hunter payload with extra fields is allowed under headless_always", (t) => {
  assert.equal(setup(t).gate({ args: { TypeName: "research", Prompt: "x", Role: "y" } }).decision, "allow");
});
