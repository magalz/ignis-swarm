import test from "node:test";
import assert from "node:assert/strict";
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

test("pre-tool-use denies dangerous shortcuts and allows normal commands", () => {
  const denyNoVerify = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: 'git commit -m "wip" --no-verify' } },
  });
  assert.equal(denyNoVerify.decision, "deny");

  const denyForceMain = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "git push --force origin main" } },
  });
  assert.equal(denyForceMain.decision, "deny");

  const denyResetHard = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "git reset --hard HEAD~1" } },
  });
  assert.equal(denyResetHard.decision, "deny");

  const askForceLease = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "git push --force-with-lease origin feat/a" } },
  });
  assert.equal(askForceLease.decision, "ask");

  const allowTest = runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
  });
  assert.equal(allowTest.decision, "allow");

  for (const dangerous of [
    "rm -fr /",
    "rm -r -f /",
    "rm -rf E:\\ && echo done",
    "Remove-Item -Force -Recurse C:\\",
  ]) {
    const denied = runHook("hooks/pre-tool-use.mjs", {
      toolCall: { name: "run_command", args: { CommandLine: dangerous } },
    });
    assert.equal(denied.decision, "deny", `Expected deny for: ${dangerous}`);
  }
});
