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
    const res = runNode(HOOK, [], { input: JSON.stringify(payload), env: hookEnv, cwd: PLUGIN_ROOT, timeoutMs: 15_000 });
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

test("headless_always denies blind-edge-hunter without a review state, whatever the spelling", (t) => {
  const { gate, repo, command } = setup(t);
  const denied = gate();
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(command(repo)), denied.reason);
  const spellings = [
    { typeName: "blind-edge-hunter" },
    { TypeName: "", typeName: "blind-edge-hunter" },
    { TypeName: "research", typeName: "blind-edge-hunter" },
    { TypeName: "blind-edge-hunter", typeName: "research" },
    { TypeName: "Blind-Edge-Hunter" },
    { TypeName: "ignis-swarm:blind-edge-hunter" },
    { TypeName: "ignis-swarm/blind-edge-hunter" },
  ];
  for (const args of spellings) {
    assert.equal(gate({ args }).decision, "deny", JSON.stringify(args));
  }
});

test("a fresh fallback record for the repository allows blind-edge-hunter, also from a subdirectory", (t) => {
  const { mark, gate, repo, sub } = setup(t);
  mark(repo, "fallback", { reason: "claude exited with status 3" });
  assert.equal(gate().decision, "allow");
  assert.equal(gate({ cwd: sub }).decision, "allow");
});

test("a record belongs to one repository root only", (t) => {
  const { mark, gate, repo, other, sub } = setup(t);
  mark(sub, "fallback");
  assert.equal(gate({ cwd: repo }).decision, "deny");
  mark(repo, "fallback");
  assert.equal(gate({ cwd: repo }).decision, "allow");
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

test("a reviewed or empty record alone does not allow the native reviewer", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "reviewed");
  assert.equal(gate().decision, "deny");
  mark(repo, "empty");
  assert.equal(gate().decision, "deny");
});

test("every workspace needs a current record and at least one must be a fallback", (t) => {
  const { mark, gate, repo, other } = setup(t);
  const both = { cwd: repo, workspacePaths: [repo, other] };

  mark(repo, "fallback");
  assert.equal(gate(both).decision, "deny");

  mark(other, "empty");
  assert.equal(gate(both).decision, "allow");

  mark(other, "reviewed");
  assert.equal(gate(both).decision, "allow");

  mark(other, "fallback");
  assert.equal(gate(both).decision, "allow");
});

test("a workspace path outside any git repository is ignored", (t) => {
  const { mark, gate, repo, plain } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate({ cwd: repo, workspacePaths: [repo, plain] }).decision, "allow");
  assert.equal(gate({ cwd: plain, workspacePaths: [repo] }).decision, "allow");
});

test("a session whose every workspace path is outside a git repository is allowed", (t) => {
  const { gate, plain, dirs } = setup(t);
  const second = path.join(dirs.root, "ws", "plain-two");
  fs.mkdirSync(second, { recursive: true });
  assert.equal(gate({ cwd: plain }).decision, "allow");
  assert.equal(gate({ cwd: plain, workspacePaths: [plain, second] }).decision, "allow");
});

test("empty workspace values deny and say that no workspace was supplied", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "fallback");
  const denied = gate({ cwd: "", workspacePaths: [""] });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /no workspace supplied/);
});

test("the gate denies when git cannot be run, and the denial names the directory and the error", (t) => {
  const { mark, gate, repo, noGitEnv } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate().decision, "allow");
  const denied = gate({ hookEnv: noGitEnv() });
  assert.equal(denied.decision, "deny");
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

test("other strategies and other subagents are not gated", (t) => {
  const { gate } = setup(t);
  assert.equal(gate({ strategy: "antigravity_first" }).decision, "allow");
  assert.equal(gate({ strategy: "antigravity_gemini_only" }).decision, "allow");
  assert.equal(gate({ args: { TypeName: "research" } }).decision, "allow");
});

test("when every root already has a reviewed or empty record the denial says the headless review is complete", (t) => {
  const { mark, gate, repo, other } = setup(t);
  mark(repo, "reviewed");
  mark(other, "empty");
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(ALREADY_COMPLETED), denied.reason);
  assert.ok(!denied.reason.includes("--cwd"), denied.reason);
  assert.ok(gate({ cwd: repo }).reason.includes(ALREADY_COMPLETED));
});

test("the denial lists only the roots that lack a current record, each with its own runner command", (t) => {
  const { mark, gate, repo, other, command } = setup(t);
  mark(repo, "fallback");
  const denied = gate({ cwd: repo, workspacePaths: [repo, other] });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(command(other)), denied.reason);
  assert.ok(!denied.reason.includes(command(repo)), denied.reason);
  assert.ok(denied.reason.includes("fallbackToNative: true"), denied.reason);
  assert.ok(!denied.reason.includes(ALREADY_COMPLETED), denied.reason);

  const bothMissing = gate({ cwd: repo, workspacePaths: [repo, other], strategy: "headless_always" });
  assert.equal(bothMissing.decision, "deny");
  assert.equal(bothMissing.reason.includes(command(other)), true, bothMissing.reason);
  assert.equal(bothMissing.reason.includes(command(repo)), true, bothMissing.reason);
  assert.match(bothMissing.reason, /\(backend=claude, model=opus\)/);
});

test("GIT_DIR and GIT_WORK_TREE in the hook environment do not redirect root detection", (t) => {
  const { mark, gate, repo, other, sub, env } = setup(t);
  runGit(other, ["commit", "--allow-empty", "-m", "other moved"], { env });
  mark(repo, "fallback");
  assert.equal(gate({ cwd: sub }).decision, "allow");
  const pointedAtOther = { ...env, GIT_DIR: path.join(other, ".git") };
  assert.equal(gate({ cwd: sub, hookEnv: pointedAtOther }).decision, "allow");
  const withWorkTree = { ...pointedAtOther, GIT_WORK_TREE: other };
  assert.equal(gate({ cwd: repo, hookEnv: withWorkTree }).decision, "allow");
});

test("an unreadable subagent payload is denied under headless_always and ignored otherwise", (t) => {
  const { gate } = setup(t);
  const unreadable = [
    null,
    "blind-edge-hunter",
    ["blind-edge-hunter"],
    {},
    { Prompt: "review this" },
    { TypeName: 7 },
    { typeName: null },
  ];
  for (const args of unreadable) {
    const denied = gate({ args });
    assert.equal(denied.decision, "deny", JSON.stringify(args));
    assert.ok(denied.reason.includes(UNREADABLE_TYPE), denied.reason);
    assert.equal(gate({ args, strategy: "antigravity_first" }).decision, "allow", JSON.stringify(args));
    assert.equal(gate({ args, strategy: "antigravity_gemini_only" }).decision, "allow", JSON.stringify(args));
  }
  assert.equal(gate({ args: { TypeName: "research", Prompt: "x", Role: "y" } }).decision, "allow");
});
