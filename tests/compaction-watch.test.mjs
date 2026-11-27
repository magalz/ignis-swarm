import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, runNode, writeOnboardingState } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "compaction-watch.mjs");
const KB = 1024;
const CREATED_AT = "2026-11-25T01:35:53Z";

function entry(stepIndex, source, type, fields = {}) {
  return (
    JSON.stringify({ step_index: stepIndex, source, type, status: "DONE", created_at: CREATED_AT, ...fields }) + "\n"
  );
}

function userInput(stepIndex = 0) {
  return entry(stepIndex, "USER_EXPLICIT", "USER_INPUT", { content: "Please implement the plan." });
}

function systemMessage(stepIndex = 0) {
  return entry(stepIndex, "SYSTEM", "SYSTEM_MESSAGE", { content: "You are a swarm worker. Do the assigned task." });
}

function generic(stepIndex, content) {
  return entry(stepIndex, "MODEL", "GENERIC", { content });
}

function pad(stepIndex, bytes) {
  return generic(stepIndex, "x".repeat(bytes));
}

function checkpoint(stepIndex, summary = "# Resuming from a compaction\n\nYou are continuing work on the task described above...") {
  return entry(stepIndex, "SYSTEM", "CHECKPOINT", {
    input_tokens: 547522,
    cache_read_tokens: 0,
    output_tokens: 6547,
    content: summary,
  });
}

function setup(thresholdKb = 100) {
  const iso = isolatedEnv();
  writeOnboardingState(iso.dirs.brokerData, { compaction: { transcriptThresholdKb: thresholdKb } });
  const transcriptPath = path.join(iso.dirs.root, "transcript.jsonl");
  const statePath = (conversationId) => path.join(iso.dirs.brokerData, `compact-watch-${conversationId}.json`);
  return { iso, transcriptPath, statePath };
}

function runHook(payload, iso) {
  const res = runNode(HOOK, [], {
    input: JSON.stringify(payload),
    env: iso.env,
    cwd: PLUGIN_ROOT,
    timeoutMs: 8000,
  });
  assert.equal(res.status, 0, `compaction-watch failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function messageOf(out) {
  assert.ok(Array.isArray(out.injectSteps), `expected a compaction prompt, got ${JSON.stringify(out)}`);
  return out.injectSteps[0].systemMessage.systemMessage;
}

test("compaction-watch triggers at threshold, enforces +150KB cooldown, resets on a CHECKPOINT line, and skips subagents", () => {
  const { iso, transcriptPath } = setup();
  try {
    const payload = { conversationId: "conv-compact-1", transcriptPath };

    fs.writeFileSync(transcriptPath, userInput() + pad(1, 50 * KB));
    assert.deepEqual(runHook(payload, iso), {});

    fs.writeFileSync(transcriptPath, userInput() + pad(1, 110 * KB));
    const firstMsg = messageOf(runHook(payload, iso));
    assert.match(firstMsg, /\[ignis-swarm\]\[Compaction Checkpoint\]/);
    assert.match(firstMsg, /\/compact manually/);
    assert.match(firstMsg, /Preserve: /);

    assert.deepEqual(runHook(payload, iso), {});

    fs.appendFileSync(transcriptPath, pad(2, 160 * KB));
    assert.match(messageOf(runHook(payload, iso)), /\[ignis-swarm\]\[Compaction Checkpoint\]/);

    fs.appendFileSync(transcriptPath, checkpoint(3) + pad(4, 110 * KB));
    assert.match(messageOf(runHook(payload, iso)), /\[ignis-swarm\]\[Compaction Checkpoint\]/);

    assert.deepEqual(runHook({ ...payload, isSubagent: true }, iso), {});
  } finally {
    iso.cleanup();
  }
});

test("compaction-watch emits payload-only Preserve block without /compact in copyable text", () => {
  const { iso, transcriptPath } = setup();
  try {
    fs.writeFileSync(transcriptPath, pad(0, 110 * KB));
    const out = runHook(
      { conversationId: "conv-payload", transcriptPath, lastUserInput: "Continue with the plan." },
      iso
    );
    const m = messageOf(out);
    assert.match(m, /Preserve: /);
    assert.match(m, /slash menu/);
    assert.doesNotMatch(m, /`\/compact Preserve:/);
  } finally {
    iso.cleanup();
  }
});

test("compaction-watch does not prompt when a real CHECKPOINT line leaves the active size below the threshold", () => {
  const { iso, transcriptPath, statePath } = setup();
  try {
    fs.writeFileSync(
      transcriptPath,
      userInput() + pad(1, 110 * KB) + checkpoint(557) + generic(558, "short follow-up after the compaction")
    );
    assert.ok(fs.statSync(transcriptPath).size > 100 * KB);
    const out = runHook({ conversationId: "conv-checkpoint", transcriptPath }, iso);
    assert.deepEqual(out, {});
    assert.equal(fs.existsSync(statePath("conv-checkpoint")), false);
  } finally {
    iso.cleanup();
  }
});

test("compaction-watch ignores lines that only mention compaction markers or CHECKPOINT inside other content", () => {
  const { iso, transcriptPath, statePath } = setup();
  try {
    fs.writeFileSync(
      transcriptPath,
      userInput() +
        pad(1, 110 * KB) +
        generic(2, "COMPACT_MARKER_RE matches compact_boundary, compaction_boundary and the CHECKPOINT type") +
        entry(3, "MODEL", "GENERIC", { content: "old marker fields", compact_boundary: true, isCompactSummary: true }) +
        entry(4, "MODEL", "GENERIC", { content: "nested", details: { type: "CHECKPOINT" } }) +
        `{"step_index":5,"source":"MODEL","type":"GENERIC","status":"DONE","content":"cut off","note":"CHECKPOINT"` +
        "\n" +
        generic(6, "short follow-up")
    );
    const out = runHook({ conversationId: "conv-mention", transcriptPath }, iso);
    assert.match(messageOf(out), /\[ignis-swarm\]\[Compaction Checkpoint\]/);
    assert.equal(JSON.parse(fs.readFileSync(statePath("conv-mention"), "utf8")).lastMarkerEnd, 0);
  } finally {
    iso.cleanup();
  }
});

test("compaction-watch does not prompt a swarm worker whose transcript has no USER_INPUT", () => {
  const { iso, transcriptPath, statePath } = setup();
  try {
    fs.writeFileSync(transcriptPath, systemMessage() + pad(1, 150 * KB));
    const out = runHook({ conversationId: "conv-worker", transcriptPath }, iso);
    assert.deepEqual(out, {});
    assert.equal(fs.existsSync(statePath("conv-worker")), false);
  } finally {
    iso.cleanup();
  }
});

test("compaction-watch takes the last of several CHECKPOINT lines as the boundary", () => {
  const { iso, transcriptPath, statePath } = setup();
  try {
    const payload = { conversationId: "conv-two-checkpoints", transcriptPath };
    const upToLastCheckpoint =
      userInput() +
      pad(1, 60 * KB) +
      checkpoint(2, "# Resuming from a compaction, first résumé") +
      pad(3, 110 * KB) +
      checkpoint(4, "# Resuming from a compaction, second résumé");
    fs.writeFileSync(transcriptPath, upToLastCheckpoint + pad(5, 30 * KB));
    assert.deepEqual(runHook(payload, iso), {});

    fs.appendFileSync(transcriptPath, pad(6, 90 * KB));
    const out = runHook(payload, iso);
    assert.match(messageOf(out), /\[ignis-swarm\]\[Compaction Checkpoint\]/);
    const boundary = Buffer.byteLength(upToLastCheckpoint);
    const state = JSON.parse(fs.readFileSync(statePath("conv-two-checkpoints"), "utf8"));
    assert.equal(state.lastMarkerEnd, boundary);
    assert.equal(state.lastPromptedBytes, fs.statSync(transcriptPath).size - boundary);
  } finally {
    iso.cleanup();
  }
});
