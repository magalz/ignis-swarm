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

function writeCompletedOnboarding(dataDir, overrides = {}) {
  const state = {
    version: 1,
    completed: true,
    skipped: false,
    completedAt: "2026-01-01T00:00:00.000Z",
    brokerManagedServers: [],
    tracker: { kind: "none", mcpServer: null },
    memtrace: { enabled: false },
    reviewRouting: {
      strategy: "antigravity_gemini_only",
      headlessBackend: null,
      headlessModel: null,
      effort: "high",
    },
    compaction: { transcriptThresholdKb: 550 },
    ...overrides,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "onboarding.json"), JSON.stringify(state, null, 2), "utf8");
}

test("compaction-watch triggers at threshold, enforces +150KB cooldown, resets on compact_boundary, and skips subagents", () => {
  const dataDir = makeTempDir("ignis-compact-");
  writeCompletedOnboarding(dataDir, { compaction: { transcriptThresholdKb: 100 } });

  const transcriptPath = path.join(dataDir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "a".repeat(50 * 1024));

  const below = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(below, {});

  fs.writeFileSync(transcriptPath, "a".repeat(110 * 1024));
  const firstTrigger = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  const firstMsg = firstTrigger.injectSteps[0].systemMessage.systemMessage;
  assert.match(firstMsg, /\[ignis-swarm\]\[Compaction Checkpoint\]/);
  assert.match(firstMsg, /\/compact manually/);
  assert.match(firstMsg, /Preserve: /);

  const cooldownHit = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(cooldownHit, {});

  fs.appendFileSync(transcriptPath, "b".repeat(160 * 1024));
  const secondTrigger = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.match(
    secondTrigger.injectSteps[0].systemMessage.systemMessage,
    /\[ignis-swarm\]\[Compaction Checkpoint\]/
  );

  fs.appendFileSync(transcriptPath, `\n{"type":"compact_boundary"}\n${"c".repeat(110 * 1024)}`);
  const postCompactTrigger = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.match(
    postCompactTrigger.injectSteps[0].systemMessage.systemMessage,
    /\[ignis-swarm\]\[Compaction Checkpoint\]/
  );

  const subagentOut = runHook(
    "hooks/compaction-watch.mjs",
    { conversationId: "conv-compact-1", transcriptPath, isSubagent: true },
    { IGNIS_BROKER_DATA: dataDir }
  );
  assert.deepEqual(subagentOut, {});

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("compaction-watch emits payload-only Preserve block without /compact in copyable text", () => {
  const dataDir = makeTempDir("ignis-compact-payload-");
  try {
    writeCompletedOnboarding(dataDir, { compaction: { transcriptThresholdKb: 100 } });
    const transcriptPath = path.join(dataDir, "t.jsonl");
    fs.writeFileSync(transcriptPath, "x".repeat(110 * 1024));
    const out = runHook(
      "hooks/compaction-watch.mjs",
      { conversationId: "conv-payload", transcriptPath },
      { IGNIS_BROKER_HOME: dataDir, IGNIS_BROKER_DATA: dataDir }
    );
    const m = out.injectSteps[0].systemMessage.systemMessage;
    assert.match(m, /Preserve: /);
    assert.match(m, /slash menu/);
    assert.doesNotMatch(m, /`\/compact Preserve:/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
