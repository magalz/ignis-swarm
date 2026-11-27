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

test("post-tool-use returns empty object and appends audit log", () => {
  const dataDir = makeTempDir("ignis-data-");
  const out = runHook(
    "hooks/post-tool-use.mjs",
    {
      conversationId: "conv-123",
      stepIdx: 4,
      toolCall: { name: "run_command", args: { CommandLine: "go test ./..." } },
    },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(out, {});

  const logPath = path.join(dataDir, "audit", "conv-123.jsonl");
  assert.equal(fs.existsSync(logPath), true);
  const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(record.isTest, true);
  assert.equal(record.tool, "run_command");

  fs.rmSync(dataDir, { recursive: true, force: true });
});
