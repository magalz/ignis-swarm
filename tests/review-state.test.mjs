import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { headSha } from "../scripts/lib/git-changes.mjs";
import {
  REVIEW_STATE_TTL_MS,
  normalizeWorkspaceKey,
  readReviewState,
  recordReviewState,
  reviewGateDecision,
  reviewStatePath,
} from "../scripts/broker/review-state.mjs";
import { initGitRepo, isolatedEnv, runGit } from "./helpers.mjs";

const MODULE_URL = new URL("../scripts/broker/review-state.mjs", import.meta.url).href;
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function setup(t) {
  const iso = isolatedEnv();
  t.after(() => iso.cleanup());
  const base = iso.dirs.root;
  const env = iso.env;
  const dataDir = path.join(base, "data");
  const stateDir = path.join(dataDir, "blind-review");
  const fixture = {
    base,
    env,
    dataDir,
    stateDir,
    repo: (name, options = {}) => initGitRepo(path.join(base, name), { env, ...options }),
    plain(name) {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    record(dir, status, extra = {}) {
      return recordReviewState(dataDir, dir, { status, headSha: headSha(dir, { env }), nowMs: NOW, ...extra });
    },
    gate: (dirs, extra = {}) => reviewGateDecision(dataDir, dirs, { nowMs: NOW, env, ...extra }),
    keys: (roots) => roots.map(normalizeWorkspaceKey),
    stateFiles: () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []),
  };
  return fixture;
}

function envWithoutGit(fixture) {
  const emptyBin = fixture.plain("empty-bin");
  const env = Object.fromEntries(Object.entries(fixture.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = emptyBin;
  return env;
}

function fsError(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function runWorker(source, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("recording then reading round-trips the record from a per-workspace file under blind-review/", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  const sha = headSha(repo, { env: s.env });
  const record = recordReviewState(s.dataDir, repo, { status: "fallback", reason: "codex unavailable", headSha: sha, nowMs: NOW });
  const key = normalizeWorkspaceKey(repo);
  assert.deepEqual(record, { version: 1, key, status: "fallback", reason: "codex unavailable", headSha: sha, timestampMs: NOW });
  assert.deepEqual(readReviewState(s.dataDir, repo), record);

  const file = reviewStatePath(s.dataDir, repo);
  assert.equal(file, path.join(s.dataDir, "blind-review", `${crypto.createHash("sha256").update(key).digest("hex")}.json`));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), record);
  assert.deepEqual(s.stateFiles(), [path.basename(file)]);
});

test("reason defaults to null and a later record replaces the earlier one", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  assert.equal(s.record(repo, "empty").reason, null);
  s.record(repo, "reviewed", { reason: "second pass", nowMs: NOW + 1 });
  assert.deepEqual(readReviewState(s.dataDir, repo), {
    version: 1,
    key: normalizeWorkspaceKey(repo),
    status: "reviewed",
    reason: "second pass",
    headSha: headSha(repo, { env: s.env }),
    timestampMs: NOW + 1,
  });
  assert.equal(s.stateFiles().length, 1);
});

test("state directory and file are private on POSIX", { skip: process.platform === "win32" }, (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  s.record(repo, "fallback");
  assert.equal(fs.statSync(s.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(reviewStatePath(s.dataDir, repo)).mode & 0o777, 0o600);
});

test("six processes recording different workspaces at once lose nothing and leave no temp files", async (t) => {
  const s = setup(t);
  const statuses = ["fallback", "reviewed", "empty", "fallback", "reviewed", "empty"];
  const repos = statuses.map((_, index) => s.repo(`w${index}`));
  const shas = repos.map((repo) => headSha(repo, { env: s.env }));
  const startAt = Date.now() + 1500;
  const source = `
    import { recordReviewState } from ${JSON.stringify(MODULE_URL)};
    const [dataDir, root, status, sha, startAt] = process.argv.slice(1);
    while (Date.now() < Number(startAt)) {}
    recordReviewState(dataDir, root, { status, headSha: sha, nowMs: ${NOW} });
  `;
  const results = await Promise.all(
    repos.map((repo, index) => runWorker(source, [s.dataDir, repo, statuses[index], shas[index], String(startAt)]))
  );
  results.forEach((result, index) => assert.equal(result.status, 0, `worker ${index}: ${result.stderr}`));

  const files = s.stateFiles();
  assert.equal(files.length, 6, files.join(", "));
  assert.deepEqual(files.filter((name) => !name.endsWith(".json")), []);
  repos.forEach((repo, index) => {
    const record = readReviewState(s.dataDir, repo);
    assert.equal(record?.status, statuses[index]);
    assert.equal(record?.headSha, shas[index]);
    assert.equal(record?.key, normalizeWorkspaceKey(repo));
  });
});

test("a headSha mismatch leaves the root missing", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  s.record(repo, "fallback");
  assert.deepEqual(s.gate([repo]), { allow: true, missing: [], errors: [] });

  runGit(repo, ["commit", "--allow-empty", "-m", "second commit"], { env: s.env });
  const decision = s.gate([repo]);
  assert.equal(decision.allow, false);
  assert.deepEqual(s.keys(decision.missing), [normalizeWorkspaceKey(repo)]);
  assert.deepEqual(decision.errors, []);
});

test("an unborn repository is satisfied by a record with headSha 'unborn'", (t) => {
  const s = setup(t);
  const repo = s.repo("fresh", { commit: false });
  assert.equal(headSha(repo, { env: s.env }), "unborn");
  assert.equal(s.gate([repo]).allow, false);
  recordReviewState(s.dataDir, repo, { status: "fallback", headSha: "unborn", nowMs: NOW });
  assert.deepEqual(s.gate([repo]), { allow: true, missing: [], errors: [] });
});

test("a record whose stored key differs from the workspace is treated as missing", (t) => {
  const s = setup(t);
  const a = s.repo("a");
  const b = s.repo("b");
  s.record(a, "fallback");
  fs.copyFileSync(reviewStatePath(s.dataDir, a), reviewStatePath(s.dataDir, b));
  assert.equal(readReviewState(s.dataDir, b), null);
  assert.notEqual(readReviewState(s.dataDir, a), null);
  const decision = s.gate([a, b]);
  assert.equal(decision.allow, false);
  assert.deepEqual(s.keys(decision.missing), [normalizeWorkspaceKey(b)]);
});

test("readReviewState returns null for a missing, unreadable or malformed file", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  assert.equal(readReviewState(s.dataDir, repo), null);
  const file = reviewStatePath(s.dataDir, repo);
  fs.mkdirSync(s.stateDir, { recursive: true });
  for (const content of ["", "{not json", "null", "[]", '"text"', "42"]) {
    fs.writeFileSync(file, content);
    assert.equal(readReviewState(s.dataDir, repo), null, `content ${JSON.stringify(content)}`);
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(readReviewState(s.dataDir, repo), null);
});

test("a git failure puts the entry in errors and denies", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  s.record(repo, "fallback");
  const decision = s.gate([repo], { env: envWithoutGit(s) });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.errors.length, 1);
  assert.equal(decision.errors[0].dir, repo);
  assert.match(decision.errors[0].message, /\S/);
});

test("a git failure on one directory denies even when another has a fresh fallback", (t) => {
  const s = setup(t);
  const a = s.repo("a");
  s.record(a, "fallback");
  const decision = s.gate([a, path.join(s.base, "does-not-exist")]);
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.errors.length, 1);
  assert.equal(decision.errors[0].dir, path.join(s.base, "does-not-exist"));
});

test("a failure to read HEAD puts the root in errors and denies", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  s.record(repo, "fallback");
  const original = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (Array.isArray(args) && args.includes("--verify")) {
      return { error: undefined, status: 128, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: simulated failure") };
    }
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const decision = s.gate([repo]);
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.missing, []);
  assert.equal(decision.errors.length, 1);
  assert.equal(decision.errors[0].dir, repo);
  assert.match(decision.errors[0].message, /simulated failure/);
});

test("a directory that is not a git repository is skipped", (t) => {
  const s = setup(t);
  const a = s.repo("a");
  const plain = s.plain("plain");
  s.record(a, "fallback");
  assert.deepEqual(s.gate([plain, a]), { allow: true, missing: [], errors: [] });
  assert.deepEqual(s.gate([a, plain]), { allow: true, missing: [], errors: [] });
});

test("when every directory is outside git there is no fallback and the gate does not allow", (t) => {
  const s = setup(t);
  assert.deepEqual(s.gate([s.plain("p1"), s.plain("p2")]), { allow: false, missing: [], errors: [] });
});

test("no usable directory is an error", (t) => {
  const s = setup(t);
  const expected = { allow: false, missing: [], errors: [{ dir: null, message: "no workspace supplied" }] };
  assert.deepEqual(s.gate([]), expected);
  assert.deepEqual(s.gate(["", null, undefined, 7, {}]), expected);
});

test("allow needs every root satisfied and at least one fallback", (t) => {
  const s = setup(t);
  const a = s.repo("a");
  const b = s.repo("b");

  s.record(a, "fallback");
  s.record(b, "empty");
  assert.deepEqual(s.gate([a, b]), { allow: true, missing: [], errors: [] });

  s.record(b, "reviewed");
  assert.deepEqual(s.gate([a, b]), { allow: true, missing: [], errors: [] });

  s.record(a, "reviewed");
  assert.deepEqual(s.gate([a, b]), { allow: false, missing: [], errors: [] });

  s.record(a, "empty");
  s.record(b, "empty");
  assert.deepEqual(s.gate([a, b]), { allow: false, missing: [], errors: [] });

  fs.rmSync(reviewStatePath(s.dataDir, b));
  s.record(a, "fallback");
  const decision = s.gate([a, b]);
  assert.equal(decision.allow, false);
  assert.deepEqual(s.keys(decision.missing), [normalizeWorkspaceKey(b)]);
  assert.deepEqual(decision.errors, []);
});

test("a record is fresh for the TTL, not after it and never when dated in the future", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  s.record(repo, "fallback");
  assert.equal(REVIEW_STATE_TTL_MS, 10 * 60 * 1000);
  assert.equal(s.gate([repo], { nowMs: NOW }).allow, true);
  assert.equal(s.gate([repo], { nowMs: NOW + REVIEW_STATE_TTL_MS }).allow, true);

  const stale = s.gate([repo], { nowMs: NOW + REVIEW_STATE_TTL_MS + 1 });
  assert.equal(stale.allow, false);
  assert.deepEqual(s.keys(stale.missing), [normalizeWorkspaceKey(repo)]);

  const future = s.gate([repo], { nowMs: NOW - 1 });
  assert.equal(future.allow, false);
  assert.deepEqual(s.keys(future.missing), [normalizeWorkspaceKey(repo)]);
});

test("a record with an unknown status or a non-numeric timestamp is missing", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  const file = reviewStatePath(s.dataDir, repo);
  const record = s.record(repo, "fallback");
  for (const patch of [{ status: "approved" }, { status: undefined }, { timestampMs: String(NOW) }, { timestampMs: null }, { headSha: undefined }]) {
    fs.writeFileSync(file, JSON.stringify({ ...record, ...patch }));
    const decision = s.gate([repo]);
    assert.equal(decision.allow, false, JSON.stringify(patch));
    assert.equal(decision.missing.length, 1, JSON.stringify(patch));
  }
});

test("two directories inside one repository count as one root", (t) => {
  const s = setup(t);
  const repo = s.repo("a", { files: { "src/lib/x.txt": "x\n" } });
  const sub = path.join(repo, "src", "lib");
  const unrecorded = s.gate([repo, sub]);
  assert.equal(unrecorded.missing.length, 1);
  assert.deepEqual(unrecorded.errors, []);
  s.record(repo, "fallback");
  assert.deepEqual(s.gate([repo, sub]), { allow: true, missing: [], errors: [] });
  assert.deepEqual(s.gate([sub]), { allow: true, missing: [], errors: [] });
});

test("an invalid status or headSha throws TypeError and writes nothing", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  const sha = headSha(repo, { env: s.env });
  const attempts = [
    { status: "approved", headSha: sha },
    { status: "", headSha: sha },
    { status: undefined, headSha: sha },
    { status: "fallback" },
    { status: "fallback", headSha: "" },
    { status: "fallback", headSha: 12345 },
    { status: "fallback", headSha: null },
  ];
  for (const options of attempts) {
    assert.throws(() => recordReviewState(s.dataDir, repo, { ...options, nowMs: NOW }), TypeError, JSON.stringify(options));
  }
  assert.deepEqual(s.stateFiles(), []);
});

test("a rename that cannot succeed throws and leaves no temp file or in-place write", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  const target = reviewStatePath(s.dataDir, repo);
  fs.mkdirSync(target, { recursive: true });
  assert.throws(() => s.record(repo, "fallback"));
  assert.deepEqual(s.stateFiles(), [path.basename(target)]);
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test("a rename blocked by EPERM, EACCES or EBUSY is retried and then succeeds", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  const original = fs.renameSync;
  const codes = ["EPERM", "EACCES", "EBUSY"];
  let calls = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    calls += 1;
    if (calls <= codes.length) throw fsError(codes[calls - 1]);
    return original(from, to);
  });
  const record = s.record(repo, "fallback");
  assert.equal(calls, codes.length + 1);
  assert.deepEqual(readReviewState(s.dataDir, repo), record);
  assert.deepEqual(s.stateFiles(), [path.basename(reviewStatePath(s.dataDir, repo))]);
});

test("a rename that keeps failing gives up after five retries and removes the temp file", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  const rename = t.mock.method(fs, "renameSync", () => {
    throw fsError("EPERM");
  });
  assert.throws(() => s.record(repo, "fallback"), { code: "EPERM" });
  assert.equal(rename.mock.callCount(), 6);
  assert.deepEqual(s.stateFiles(), []);
});

test("a rename failing with another code is not retried", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  const rename = t.mock.method(fs, "renameSync", () => {
    throw fsError("ENOSPC");
  });
  assert.throws(() => s.record(repo, "fallback"), { code: "ENOSPC" });
  assert.equal(rename.mock.callCount(), 1);
  assert.deepEqual(s.stateFiles(), []);
});

test("recording prunes sibling state files older than seven days and keeps the rest", (t) => {
  const s = setup(t);
  const repo = s.repo("a");
  fs.mkdirSync(s.stateDir, { recursive: true });
  const now = Date.now();
  const sibling = (name, ageMs) => {
    const file = path.join(s.stateDir, name);
    fs.writeFileSync(file, "{}");
    const when = new Date(now - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const old = sibling("old.json", 8 * DAY_MS);
  const recent = sibling("recent.json", 6 * DAY_MS);
  const farFuture = sibling("future.json", -8 * DAY_MS);
  const nearFuture = sibling("soon.json", -DAY_MS);
  const foreign = sibling("notes.txt", 30 * DAY_MS);
  s.record(repo, "fallback");
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(farFuture), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(nearFuture), true);
  assert.equal(fs.existsSync(foreign), true);
  assert.notEqual(readReviewState(s.dataDir, repo), null);
});

test("normalizeWorkspaceKey resolves relative paths, follows links and falls back for missing paths", (t) => {
  const s = setup(t);
  const real = s.plain("real");
  const link = path.join(s.base, "link");
  fs.symlinkSync(real, link, "junction");
  const key = normalizeWorkspaceKey(real);
  assert.equal(path.isAbsolute(key), true);
  assert.equal(normalizeWorkspaceKey(link), key);
  assert.equal(normalizeWorkspaceKey(path.join(real, "..", "real")), key);
  assert.equal(normalizeWorkspaceKey(path.relative(process.cwd(), real)), key);
  if (process.platform === "win32") assert.equal(key, key.toLowerCase());

  const missing = path.join(s.base, "Missing", "Dir");
  const expected = path.resolve(missing);
  assert.equal(normalizeWorkspaceKey(missing), process.platform === "win32" ? expected.toLowerCase() : expected);
});
