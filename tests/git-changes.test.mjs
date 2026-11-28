import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectChanges, gitEnv, gitToplevel, headSha } from "../scripts/lib/git-changes.mjs";
import { initGitRepo, isolatedEnv, mkTemp, runGit } from "./helpers.mjs";

const ESC = String.fromCharCode(27);

function rmTemp(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Run fn in a fresh temp repo with an isolated git environment; clean up afterwards.
function withRepo(options, fn) {
  const iso = isolatedEnv(options.overrides);
  const dir = mkTemp("ignis-gc-");
  try {
    initGitRepo(dir, { env: iso.env, commit: options.commit, files: options.files });
    return fn({ dir, env: iso.env });
  } finally {
    iso.cleanup();
    rmTemp(dir);
  }
}

function write(dir, relPath, content) {
  const target = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function readIndex(dir, env) {
  const file = path.join(runGit(dir, ["rev-parse", "--absolute-git-dir"], { env }), "index");
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function sameIndex(a, b) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

// Run fn with process env variables patched (undefined deletes one), then restore them.
function withProcessEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("collectChanges: a modified tracked file and a new untracked file both appear; the real index is untouched", () => {
  withRepo({ files: { "tracked.txt": "one\n" } }, ({ dir, env }) => {
    write(dir, "tracked.txt", "two\n");
    write(dir, "new.txt", "brand new\n");
    const statusBefore = runGit(dir, ["status", "--porcelain"], { env });
    const indexBefore = readIndex(dir, env);

    const result = collectChanges(dir, { env });

    assert.equal(result.error, null);
    assert.match(result.diff, /^diff --git a\/tracked\.txt b\/tracked\.txt$/m);
    assert.match(result.diff, /^\+two$/m);
    assert.match(result.diff, /^diff --git a\/new\.txt b\/new\.txt$/m);
    assert.match(result.diff, /^new file mode /m);
    assert.match(result.diff, /^\+brand new$/m);
    assert.deepEqual(result.untracked, ["new.txt"]);
    assert.equal(result.bytes, Buffer.byteLength(result.diff));
    assert.equal(runGit(dir, ["status", "--porcelain"], { env }), statusBefore);
    assert.ok(sameIndex(readIndex(dir, env), indexBefore), "the real index must be byte-identical");
    assert.match(statusBefore, /\?\? new\.txt/, "new.txt must still be untracked for git");
  });
});

test("collectChanges: user git config (color.ui, diff.noprefix, diff.external) does not change the diff", () => {
  withRepo({ files: { "a.txt": "one\n" } }, ({ dir, env }) => {
    runGit(dir, ["config", "color.ui", "always"], { env });
    runGit(dir, ["config", "diff.noprefix", "true"], { env });
    runGit(dir, ["config", "diff.external", "ignis-no-such-diff-tool"], { env });
    write(dir, "a.txt", "two\n");
    write(dir, "b.txt", "fresh\n");
    const control = runGit(dir, ["diff", "--no-ext-diff"], { env });
    assert.ok(control.includes(ESC), "the control diff must be coloured");
    assert.ok(!control.includes("+++ b/a.txt"), "the control diff must have no b/ prefix");

    const result = collectChanges(dir, { env });

    assert.equal(result.error, null);
    assert.ok(!result.diff.includes(ESC), "no ANSI escape in the diff");
    assert.ok(result.diff.includes("+++ b/a.txt"));
    assert.ok(result.diff.includes("--- a/a.txt"));
    assert.ok(result.diff.includes("+++ b/b.txt"));
  });
});

test("collectChanges: a diff over maxBytes returns too_large without throwing", () => {
  withRepo({ files: { "big.txt": "start\n" } }, ({ dir, env }) => {
    write(dir, "big.txt", `${"x".repeat(50)}\n`.repeat(30));
    const full = collectChanges(dir, { env });
    assert.equal(full.error, null);
    assert.ok(full.bytes > 1024 && full.bytes < 2048, `fixture must sit between maxBytes and maxBytes + 1024, got ${full.bytes}`);

    const overSlack = collectChanges(dir, { env, maxBytes: 1024 });
    assert.equal(overSlack.error?.code, "too_large");
    assert.equal(overSlack.diff, "");
    assert.equal(overSlack.bytes, 0);

    const exact = collectChanges(dir, { env, maxBytes: full.bytes });
    assert.equal(exact.error, null, "exactly maxBytes is allowed");
    assert.equal(exact.diff, full.diff);
    assert.equal(collectChanges(dir, { env, maxBytes: full.bytes - 1 }).error?.code, "too_large", "one byte over maxBytes is refused");

    write(dir, "big.txt", `${"y".repeat(100)}\n`.repeat(1000));
    const overBuffer = collectChanges(dir, { env, maxBytes: 1024 });
    assert.equal(overBuffer.error?.code, "too_large");
    assert.equal(overBuffer.diff, "");
  });
});

test("gitToplevel finds the root from a subdirectory and collectChanges sees a change made there", () => {
  withRepo({ files: { "sub/deep/a.txt": "one\n" } }, ({ dir, env }) => {
    const sub = path.join(dir, "sub", "deep");
    write(dir, "sub/deep/a.txt", "two\n");
    write(dir, "sub/deep/n.txt", "new\n");

    const top = gitToplevel(sub, { env });

    assert.equal(top.error, undefined);
    assert.ok(top.root, "root expected");
    assert.equal(fs.realpathSync.native(top.root), fs.realpathSync.native(dir));
    assert.equal(top.root, path.resolve(top.root), "root uses native separators");
    const result = collectChanges(top.root, { env });
    assert.equal(result.error, null);
    assert.match(result.diff, /^diff --git a\/sub\/deep\/a\.txt b\/sub\/deep\/a\.txt$/m);
    assert.match(result.diff, /^diff --git a\/sub\/deep\/n\.txt b\/sub\/deep\/n\.txt$/m);
    assert.deepEqual(result.untracked, ["sub/deep/n.txt"]);
  });
});

test("collectChanges works in a linked worktree and leaves both indexes untouched", () => {
  withRepo({ files: { "tracked.txt": "one\n" } }, ({ dir, env }) => {
    const linked = mkTemp("ignis-gc-wt-");
    try {
      fs.rmSync(linked, { recursive: true, force: true });
      runGit(dir, ["worktree", "add", "-b", "linked", linked], { env });
      write(linked, "tracked.txt", "two\n");
      write(linked, "linked-new.txt", "in the linked worktree\n");
      write(dir, "main-only.txt", "in the main worktree\n");
      const linkedStatus = runGit(linked, ["status", "--porcelain"], { env });
      const mainIndex = readIndex(dir, env);
      const linkedIndex = readIndex(linked, env);
      assert.ok(linkedIndex, "the linked worktree has its own index");

      const top = gitToplevel(linked, { env });
      const result = collectChanges(top.root, { env });

      assert.equal(fs.realpathSync.native(top.root), fs.realpathSync.native(linked));
      assert.equal(result.error, null);
      assert.match(result.diff, /^diff --git a\/linked-new\.txt b\/linked-new\.txt$/m);
      assert.match(result.diff, /^\+two$/m);
      assert.ok(!result.diff.includes("main-only.txt"));
      assert.deepEqual(result.untracked, ["linked-new.txt"]);
      assert.ok(sameIndex(readIndex(dir, env), mainIndex), "the main worktree index must be untouched");
      assert.ok(sameIndex(readIndex(linked, env), linkedIndex), "the linked worktree index must be untouched");
      assert.equal(runGit(linked, ["status", "--porcelain"], { env }), linkedStatus);
    } finally {
      rmTemp(linked);
    }
  });
});

test("a repository with no commits: headSha is unborn and added and untracked files show up", () => {
  withRepo({ commit: false }, ({ dir, env }) => {
    assert.equal(headSha(dir, { env }), "unborn");
    assert.ok(!fs.existsSync(path.join(dir, ".git", "index")), "a fresh repository has no index file");

    const empty = collectChanges(dir, { env });
    assert.equal(empty.error, null);
    assert.equal(empty.diff, "");
    assert.deepEqual(empty.untracked, []);

    write(dir, "loose.txt", "untracked\n");
    const withoutIndex = collectChanges(dir, { env });
    assert.equal(withoutIndex.error, null);
    assert.match(withoutIndex.diff, /^diff --git a\/loose\.txt b\/loose\.txt$/m);
    assert.deepEqual(withoutIndex.untracked, ["loose.txt"]);
    assert.ok(!fs.existsSync(path.join(dir, ".git", "index")), "the missing real index must not be created");

    write(dir, "added.txt", "staged\n");
    runGit(dir, ["add", "added.txt"], { env });
    const indexBefore = readIndex(dir, env);
    const result = collectChanges(dir, { env });

    assert.equal(result.error, null);
    assert.match(result.diff, /^diff --git a\/added\.txt b\/added\.txt$/m);
    assert.match(result.diff, /^\+staged$/m);
    assert.match(result.diff, /^diff --git a\/loose\.txt b\/loose\.txt$/m);
    assert.deepEqual(result.untracked, ["loose.txt"]);
    assert.ok(sameIndex(readIndex(dir, env), indexBefore));
    assert.equal(headSha(dir, { env }), "unborn");
  });
});

test("headSha returns the commit sha once HEAD exists", () => {
  withRepo({ files: { "a.txt": "one\n" } }, ({ dir, env }) => {
    assert.equal(headSha(dir, { env }), runGit(dir, ["rev-parse", "HEAD"], { env }));
  });
});

test("headSha throws when the directory is not a repository", () => {
  const iso = isolatedEnv();
  const dir = mkTemp("ignis-gc-nogit-");
  try {
    const env = { ...iso.env, GIT_CEILING_DIRECTORIES: fs.realpathSync.native(path.dirname(dir)) };
    assert.throws(() => headSha(dir, { env }));
  } finally {
    iso.cleanup();
    rmTemp(dir);
  }
});

test("collectChanges skips a nested repository instead of listing it as untracked", () => {
  withRepo({ files: { "tracked.txt": "one\n" } }, ({ dir, env }) => {
    initGitRepo(path.join(dir, "nested"), { env, files: { "inner.txt": "inner\n" } });
    write(dir, "plain.txt", "plain\n");
    assert.match(runGit(dir, ["ls-files", "--others", "--exclude-standard"], { env }), /^nested\/$/m, "git itself reports the nested repository as nested/");

    const result = collectChanges(dir, { env });

    assert.equal(result.error, null);
    assert.deepEqual(result.untracked, ["plain.txt"]);
    assert.match(result.diff, /^diff --git a\/plain\.txt b\/plain\.txt$/m);
    assert.ok(!result.diff.includes("nested"));
    assert.ok(!result.diff.includes("inner.txt"));
  });
});

test("gitToplevel returns notGit for a plain directory and error when git cannot run", () => {
  const iso = isolatedEnv();
  const dir = mkTemp("ignis-gc-nogit-");
  const emptyBin = mkTemp("ignis-gc-nobin-");
  try {
    const env = { ...iso.env, GIT_CEILING_DIRECTORIES: fs.realpathSync.native(path.dirname(dir)) };
    assert.deepEqual(gitToplevel(dir, { env }), { notGit: true });

    const noGitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"));
    noGitEnv.PATH = emptyBin;
    const missing = gitToplevel(dir, { env: noGitEnv });
    assert.equal(missing.notGit, undefined);
    assert.equal(missing.root, undefined);
    assert.equal(missing.error?.code, "ENOENT");
    assert.equal(typeof missing.error?.message, "string");

    const absent = gitToplevel(path.join(dir, "does-not-exist"), { env });
    assert.equal(absent.notGit, undefined);
    assert.ok(absent.error, "a missing directory is an error, not notGit");
  } finally {
    iso.cleanup();
    rmTemp(dir, emptyBin);
  }
});

test("collectChanges handles file names with spaces, brackets and non-ASCII characters", () => {
  const names = ["sp ace.txt", "a[b].txt", "naïve.txt", "#hash.txt", "-dash.txt"];
  if (process.platform !== "win32") names.push("star*.txt", ":colon.txt");
  withRepo({ files: { ".gitignore": "ab.txt\nstarx.txt\n", "tracked.txt": "one\n" } }, ({ dir, env }) => {
    write(dir, "ab.txt", "ignored, matches the glob a[b].txt\n");
    write(dir, "starx.txt", "ignored, matches the glob star*.txt\n");
    for (const name of names) write(dir, name, `content of ${name}\n`);

    const result = collectChanges(dir, { env });

    assert.equal(result.error, null);
    assert.deepEqual([...result.untracked].sort(), [...names].sort());
    for (const name of names) {
      assert.ok(result.diff.includes(`diff --git a/${name} b/${name}`), `${name} must appear unquoted in the diff`);
    }
    assert.ok(!result.diff.includes("ab.txt"));
  });
});

test("collectChanges honours base and unified and rejects an unusable base", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`);
  withRepo({ files: { "f.txt": lines.join("") } }, ({ dir, env }) => {
    const first = runGit(dir, ["rev-parse", "HEAD"], { env });
    const changed = [...lines];
    changed[5] = "changed six\n";
    write(dir, "f.txt", changed.join(""));
    runGit(dir, ["commit", "-am", "second"], { env });
    write(dir, "f.txt", changed.join("").replace("line 12", "changed twelve"));

    const sinceFirst = collectChanges(dir, { env, base: first });
    assert.equal(sinceFirst.error, null);
    assert.match(sinceFirst.diff, /^\+changed six$/m);
    assert.match(sinceFirst.diff, /^\+changed twelve$/m);

    const sinceHead = collectChanges(dir, { env });
    assert.ok(!sinceHead.diff.includes("changed six"));
    assert.match(sinceHead.diff, /^\+changed twelve$/m);

    const noContext = collectChanges(dir, { env, unified: 0 });
    assert.equal(noContext.error, null);
    assert.doesNotMatch(noContext.diff, /^ line 11$/m, "unified 0 has no context lines");
    assert.match(noContext.diff, /^@@ -12 \+12 @@/m, "unified 0 reaches git as --unified=0");
    const wideContext = collectChanges(dir, { env, unified: 8 });
    assert.match(wideContext.diff, /^ line 4$/m, "unified 8 reaches eight lines back");

    for (const base of ["--output=ignis-injected.txt", "no-such-ref"]) {
      const bad = collectChanges(dir, { env, base });
      assert.equal(bad.error?.code, "git_failed", base);
      assert.equal(bad.diff, "");
      assert.deepEqual(bad.untracked, []);
    }
    assert.ok(!fs.existsSync(path.join(dir, "ignis-injected.txt")));
  });
});

test("collectChanges removes its temporary index directory, also when git fails", () => {
  withRepo({ files: { "a.txt": "one\n" } }, ({ dir, env }) => {
    const scratch = mkTemp("ignis-gc-tmp-");
    try {
      write(dir, "new.txt", "new\n");
      withProcessEnv({ TMPDIR: scratch, TEMP: scratch, TMP: scratch }, () => {
        assert.equal(collectChanges(dir, { env }).error, null);
        assert.deepEqual(fs.readdirSync(scratch), []);
        assert.equal(collectChanges(dir, { env, base: "no-such-ref" }).error?.code, "git_failed");
        assert.deepEqual(fs.readdirSync(scratch), []);
      });
    } finally {
      rmTemp(scratch);
    }
  });
});

test("collectChanges with no untracked files leaves a stat-dirty real index byte-identical", () => {
  withRepo({ files: { "a.txt": "one\n" } }, ({ dir, env }) => {
    const target = path.join(dir, "a.txt");
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(target, past, past);
    const indexBefore = readIndex(dir, env);
    assert.ok(indexBefore, "the repository has an index");

    const result = collectChanges(dir, { env });

    assert.equal(result.error, null);
    assert.equal(result.diff, "");
    assert.deepEqual(result.untracked, []);
    assert.ok(sameIndex(readIndex(dir, env), indexBefore), "the real index must be byte-identical");
    assert.ok(!fs.existsSync(path.join(runGit(dir, ["rev-parse", "--absolute-git-dir"], { env }), "index.lock")));
  });
});

// Windows CopyFile keeps the source mtime, Linux and macOS copies get a fresh one. The stand-in copy
// gives every platform the fresh mtime, so the racy-clean loss is reproduced deterministically.
test("collectChanges keeps git's racy-clean protection: a same-size edit in a racily clean index is in the diff", () => {
  withRepo({ files: { "a.txt": "value = 1\n" } }, ({ dir, env }) => {
    runGit(dir, ["config", "core.trustctime", "false"], { env });
    const file = path.join(dir, "a.txt");
    const T = new Date("2024-01-02T03:04:05.000Z");
    fs.utimesSync(file, T, T);
    runGit(dir, ["update-index", "--refresh"], { env });
    fs.writeFileSync(file, "value = 2\n");
    fs.utimesSync(file, T, T);
    const realIndex = path.join(runGit(dir, ["rev-parse", "--absolute-git-dir"], { env }), "index");
    fs.utimesSync(realIndex, T, T);
    const quiet = spawnSync("git", ["diff", "--quiet"], { cwd: dir, env, windowsHide: true });
    assert.equal(quiet.status, 1, "git itself must see the edit through its racy check");
    fs.utimesSync(realIndex, T, T);
    const nativeCopy = fs.copyFileSync;
    fs.copyFileSync = (src, dest) => fs.writeFileSync(dest, fs.readFileSync(src));
    let result;
    try {
      result = collectChanges(dir, { base: "HEAD", env });
    } finally {
      fs.copyFileSync = nativeCopy;
    }
    assert.equal(result.error, null);
    assert.ok(result.diff.includes("value = 2"), `expected the edit in the diff, got: ${JSON.stringify(result.diff)}`);
  });
});

test("gitEnv drops GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE and keeps the rest", () => {
  const out = gitEnv({ GIT_DIR: "a", GIT_WORK_TREE: "b", GIT_INDEX_FILE: "c", GIT_CONFIG_GLOBAL: "d", PATH: "p" });
  assert.deepEqual(out, { GIT_CONFIG_GLOBAL: "d", PATH: "p" });
});

test("gitEnv matches the names case-insensitively on win32", { skip: process.platform !== "win32" }, () => {
  assert.deepEqual(gitEnv({ git_index_file: "c", Git_Dir: "a", Path: "p" }), { Path: "p" });
});
