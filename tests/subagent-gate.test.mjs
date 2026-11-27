import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_STATE_TTL_MS, recordReviewState } from "../scripts/broker/review-state.mjs";
import { headSha } from "../scripts/lib/git-changes.mjs";
import { initGitRepo, isolatedEnv, runGit, runNode, writeOnboardingState } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "pre-tool-use.mjs");
const RUNNER = path.join(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");
const HUNTER = { TypeName: "blind-edge-hunter" };

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

  return { env, dirs, repo, other, plain, sub, mark, gate };
}

test("headless_always denies blind-edge-hunter without a review state, whatever the spelling", (t) => {
  const { gate } = setup(t);
  const denied = gate();
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reason.includes(`node "${RUNNER}" --base <base-sha> --backend auto`));
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

test("a record made for a subdirectory is the repository record, and another repository stays denied", (t) => {
  const { mark, gate, repo, other, sub } = setup(t);
  mark(sub, "fallback");
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
  assert.equal(gate({ cwd: plain }).decision, "deny");
});

test("empty workspace values deny", (t) => {
  const { mark, gate, repo } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate({ cwd: "", workspacePaths: [""] }).decision, "deny");
});

test("the gate denies when git cannot be run", (t) => {
  const { mark, gate, repo, env, dirs } = setup(t);
  mark(repo, "fallback");
  assert.equal(gate().decision, "allow");
  const emptyBin = path.join(dirs.root, "no-git-here");
  fs.mkdirSync(emptyBin);
  const noGit = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"));
  noGit.PATH = emptyBin;
  assert.equal(gate({ hookEnv: noGit }).decision, "deny");
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
