import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initGitRepo, isolatedEnv, mkTemp, runGit, runNode } from "./helpers.mjs";

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "stop-gate.mjs");
const LIB = "export function add(a, b) { return a + b; }\n";

function sandbox(t) {
  const iso = isolatedEnv();
  const root = mkTemp("ignis-stop-");
  t.after(() => {
    iso.cleanup();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const env = { ...iso.env, GIT_CEILING_DIRECTORIES: path.dirname(root) };
  return { root, env };
}

function runStopGate({ root, env }, cwd, extra = {}) {
  const res = runNode(HOOK, [], {
    input: JSON.stringify({ cwd, terminationReason: "NO_TOOL_CALL", ...extra }),
    env,
    cwd: root,
    timeoutMs: 60_000,
  });
  assert.equal(res.timedOut, false, "stop-gate timed out");
  assert.equal(res.status, 0, `stop-gate failed: ${res.stderr}`);
  return { out: JSON.parse(res.stdout.trim()), stderr: res.stderr };
}

function repoIn({ root, env }, files = { "src/lib.js": LIB }, name = "repo") {
  return initGitRepo(path.join(root, name), { env, files });
}

function append(repo, relPath, text) {
  fs.appendFileSync(path.join(repo, relPath), text);
}

/** A repository whose ADR folder holds ADR-001-cache.md but whose INDEX lists only another record. */
function repoWithUnindexedAdr(t) {
  const box = sandbox(t);
  const repoDir = repoIn(box);
  fs.mkdirSync(path.join(repoDir, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "docs", "adr", "INDEX.md"), "| ID | File |\n|---|---|\n| ADR-0010 | ADR-0010-other.md |\n");
  fs.writeFileSync(path.join(repoDir, "docs", "adr", "ADR-001-cache.md"), "# ADR-001\n");
  return { box, repoDir };
}

test("stop-gate asks to continue when an ADR file is missing from the INDEX", (t) => {
  const { box, repoDir } = repoWithUnindexedAdr(t);
  const out = runStopGate(box, repoDir, { continuationActive: false }).out;
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /ADR-001-cache\.md/);
});

test("stop-gate does not loop: an active continuation gets no verdict", (t) => {
  const { box, repoDir } = repoWithUnindexedAdr(t);
  assert.deepEqual(runStopGate(box, repoDir, { continuationActive: true }).out, {});
});

test("stop-gate accepts an ADR INDEX that lists every ADR file", (t) => {
  const { box, repoDir } = repoWithUnindexedAdr(t);
  fs.writeFileSync(
    path.join(repoDir, "docs", "adr", "INDEX.md"),
    "| ID | File |\n|---|---|\n| ADR-001 | ADR-001-cache.md |\n"
  );
  assert.deepEqual(runStopGate(box, repoDir, { continuationActive: false }).out, {});
});

test("stop-gate catches a skipped test added to a tracked file", (t) => {
  const box = sandbox(t);
  const repoDir = repoIn(box);
  append(repoDir, "src/lib.js", "test.skip('skipped', () => {});\n");
  const out = runStopGate(box, repoDir, { continuationActive: false }).out;
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /src\/lib\.js: detected skipped test/);
});

test("stop-gate flags a focused test in an untracked file", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box);
  fs.writeFileSync(path.join(repo, "a.test.js"), "it.only('focused', () => {});\n");

  const { out } = runStopGate(box, repo);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /a\.test\.js: detected focused test/);
});

test("stop-gate scans from the repository root when cwd is a subdirectory", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box, { "src/lib.js": LIB, "other/util.js": LIB });
  append(repo, "src/lib.js", "test.skip('later', () => {});\n");
  append(repo, "other/util.js", "it.only('elsewhere', () => {});\n");

  const { out } = runStopGate(box, path.join(repo, "src"));
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /src\/lib\.js: detected skipped test/);
  assert.match(out.reason, /other\/util\.js: detected focused test/);
});

test("stop-gate checks the ADR INDEX at the repository root when cwd is a subdirectory", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box);
  fs.mkdirSync(path.join(repo, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "adr", "ADR-002-queue.md"), "# ADR-002\n");

  const { out } = runStopGate(box, path.join(repo, "src"));
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /Missing docs\/adr\/INDEX\.md/);
});

test("stop-gate finds a shortcut next to a generated change larger than 1 MB", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box, { "data.json": "[]\n", "src/spec.test.js": "export {};\n" });
  const generated = Array.from({ length: 25_000 }, (_, i) => `  {"id": ${i}, "label": "generated-item-${i}", "ok": true},`).join("\n");
  assert.ok(Buffer.byteLength(generated) > 1_400_000, "the generated change must exceed 1.4 MB");
  fs.writeFileSync(path.join(repo, "data.json"), `[\n${generated}\n]\n`);
  append(repo, "src/spec.test.js", "it.only('focused', () => {});\n");

  const { out } = runStopGate(box, repo);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /src\/spec\.test\.js: detected focused test/);
});

test("stop-gate flags a shortcut that is committed but not pushed", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box);
  const remote = path.join(box.root, "remote.git");
  runGit(box.root, ["init", "--bare", "--initial-branch=main", remote], { env: box.env });
  runGit(repo, ["remote", "add", "origin", remote], { env: box.env });
  runGit(repo, ["push", "-u", "origin", "main"], { env: box.env });
  fs.writeFileSync(path.join(repo, "x.test.js"), "describe.only('suite', () => {});\n");
  runGit(repo, ["add", "-A"], { env: box.env });
  runGit(repo, ["commit", "-m", "wip"], { env: box.env });
  assert.equal(runGit(repo, ["status", "--porcelain"], { env: box.env }), "");

  const { out } = runStopGate(box, repo);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /x\.test\.js: detected focused test/);
});

test("stop-gate compares a branch without an upstream against origin/HEAD", (t) => {
  const box = sandbox(t);
  const seed = repoIn(box, { "src/lib.js": LIB }, "seed");
  const remote = path.join(box.root, "remote.git");
  runGit(box.root, ["init", "--bare", "--initial-branch=main", remote], { env: box.env });
  runGit(seed, ["remote", "add", "origin", remote], { env: box.env });
  runGit(seed, ["push", "origin", "main"], { env: box.env });
  const clone = path.join(box.root, "clone");
  runGit(box.root, ["clone", remote, clone], { env: box.env });
  runGit(clone, ["switch", "-c", "feature"], { env: box.env });
  fs.writeFileSync(path.join(clone, "y.test.js"), "test.only('focused', () => {});\n");
  runGit(clone, ["add", "-A"], { env: box.env });
  runGit(clone, ["commit", "-m", "wip"], { env: box.env });

  const { out } = runStopGate(box, clone);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /y\.test\.js: detected focused test/);
});

test("stop-gate does not flag iterator and collection skip calls", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box, { "src/main.rs": "fn main() {}\n", "src/rows.js": LIB });
  append(repo, "src/main.rs", "fn tail(v: &[i32]) { for x in v.iter().skip(1) { println!(\"{}\", x); } }\n");
  append(repo, "src/rows.js", "const rest = rows.skip(2);\nconst first = stream.only(1);\n");

  const { out } = runStopGate(box, repo);
  assert.deepEqual(out, {});
});

test("stop-gate reads added lines that start with ++ as content, not as diff headers", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box);
  append(repo, "src/lib.js", "++ b/notes.md\n++it.only('plus', () => {});\nit.only('plain', () => {});\n");

  const { out } = runStopGate(box, repo);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /src\/lib\.js: detected focused test .*\+\+it\.only\('plus'/);
  assert.match(out.reason, /src\/lib\.js: detected focused test .*it\.only\('plain'/);
  assert.doesNotMatch(out.reason, /notes\.md/);
});

test("stop-gate stays silent when a continuation is already active", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box);
  append(repo, "src/lib.js", "it.only('focused', () => {});\n");

  assert.deepEqual(runStopGate(box, repo, { continuationActive: true }).out, {});
});

test("stop-gate skips the diff scan outside a git repository without failing", (t) => {
  const box = sandbox(t);
  const plain = path.join(box.root, "plain");
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, "a.test.js"), "it.only('focused', () => {});\n");

  const { out, stderr } = runStopGate(box, plain);
  assert.deepEqual(out, {});
  assert.equal(stderr, "");
});

test("stop-gate checks the ADR INDEX in cwd when cwd is not in a git repository", (t) => {
  const box = sandbox(t);
  const plain = path.join(box.root, "plain");
  fs.mkdirSync(path.join(plain, "docs", "bdr"), { recursive: true });
  fs.writeFileSync(path.join(plain, "docs", "bdr", "BDR-001-rule.md"), "# BDR-001\n");

  const { out } = runStopGate(box, plain);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /Missing docs\/bdr\/INDEX\.md/);
});

test("stop-gate asks for a manual review when the working diff exceeds 64 MB", (t) => {
  const box = sandbox(t);
  const repo = repoIn(box);
  const chunk = `${"0123456789abcdef".repeat(8)}\n`.repeat(8192);
  const fd = fs.openSync(path.join(repo, "huge.dat"), "w");
  try {
    for (let i = 0; i < 66; i++) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }

  const { out } = runStopGate(box, repo);
  assert.deepEqual(out, {
    decision: "continue",
    reason:
      "ignis-swarm stop-gate: the working diff is larger than 64 MB and could not be scanned for test shortcuts; review it manually.",
  });
  assert.deepEqual(runStopGate(box, repo, { continuationActive: true }).out, {});
});
