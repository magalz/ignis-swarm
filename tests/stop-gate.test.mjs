import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function runHook(scriptRelPath, inputObj, extraEnv = {}) {
  const scriptPath = path.join(PLUGIN_ROOT, scriptRelPath);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 8000,
    windowsHide: true,
  });
  assert.equal(res.status, 0, `Hook ${scriptRelPath} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  spawnSync("git", ["init"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, windowsHide: true });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, windowsHide: true });
}

test("stop-gate prevents loops, checks ADR INDEX integrity, and catches banned diff shortcuts", () => {
  const repoDir = makeTempDir("ignis-repo-");
  initGitRepo(repoDir);

  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "lib.js"), "export function add(a, b) { return a + b; }\n");
  spawnSync("git", ["add", "."], { cwd: repoDir, windowsHide: true });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repoDir, windowsHide: true });

  fs.mkdirSync(path.join(repoDir, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "docs", "adr", "INDEX.md"), "| ID | File |\n|---|---|\n| ADR-0010 | ADR-0010-other.md |\n");
  fs.writeFileSync(path.join(repoDir, "docs", "adr", "ADR-001-cache.md"), "# ADR-001\n");

  const unindexed = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: false,
  });
  assert.equal(unindexed.decision, "continue");
  assert.match(unindexed.reason, /ADR-001-cache\.md/);

  const noLoop = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: true,
  });
  assert.deepEqual(noLoop, {});

  fs.writeFileSync(
    path.join(repoDir, "docs", "adr", "INDEX.md"),
    "| ID | File |\n|---|---|\n| ADR-001 | ADR-001-cache.md |\n"
  );
  const cleanOut = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: false,
  });
  assert.deepEqual(cleanOut, {});

  fs.writeFileSync(
    path.join(repoDir, "src", "lib.js"),
    "export function add(a, b) { return a + b; }\ntest.skip('skipped', () => {});\n"
  );
  const bannedDiff = runHook("hooks/stop-gate.mjs", {
    cwd: repoDir,
    terminationReason: "NO_TOOL_CALL",
    continuationActive: false,
  });
  assert.equal(bannedDiff.decision, "continue");
  assert.match(bannedDiff.reason, /\.skip/);

  fs.rmSync(repoDir, { recursive: true, force: true });
});
