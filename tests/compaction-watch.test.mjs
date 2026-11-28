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
const HOOK_TIMEOUT_MS = 60_000;
const PROMPT_TAG = /\[ignis-swarm\]\[Compaction Checkpoint\]/;
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

function setup(t, thresholdKb = 100) {
  const iso = isolatedEnv();
  t.after(() => iso.cleanup());
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
    timeoutMs: HOOK_TIMEOUT_MS,
  });
  assert.equal(res.timedOut, false, "compaction-watch timed out");
  assert.equal(res.status, 0, `compaction-watch failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function messageOf(out) {
  assert.ok(Array.isArray(out.injectSteps), `expected a compaction prompt, got ${JSON.stringify(out)}`);
  return out.injectSteps[0].systemMessage.systemMessage;
}

/** A user transcript of the given size, already prompted once, ready for cooldown scenarios. */
function promptedOnce(t, conversationId) {
  const box = setup(t);
  const payload = { conversationId, transcriptPath: box.transcriptPath };
  fs.writeFileSync(box.transcriptPath, userInput() + pad(1, 110 * KB));
  messageOf(runHook(payload, box.iso));
  return { ...box, payload };
}

test("compaction-watch stays silent below the threshold", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, userInput() + pad(1, 50 * KB));
  assert.deepEqual(runHook({ conversationId: "conv-below", transcriptPath }, iso), {});
});

test("compaction-watch prompts at the threshold with the checkpoint tag", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, userInput() + pad(1, 110 * KB));
  assert.match(messageOf(runHook({ conversationId: "conv-over", transcriptPath }, iso)), PROMPT_TAG);
});

test("compaction-watch prompt names the manual /compact and the Preserve block", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, userInput() + pad(1, 110 * KB));
  const message = messageOf(runHook({ conversationId: "conv-text", transcriptPath }, iso));
  assert.match(message, /\/compact manually/);
  assert.match(message, /Preserve: /);
});

test("compaction-watch does not prompt again straight after a prompt", (t) => {
  const { iso, payload } = promptedOnce(t, "conv-cooldown");
  assert.deepEqual(runHook(payload, iso), {});
});

test("compaction-watch prompts again once the transcript grew 150 KB past the last prompt", (t) => {
  const { iso, payload, transcriptPath } = promptedOnce(t, "conv-regrow");
  fs.appendFileSync(transcriptPath, pad(2, 160 * KB));
  assert.match(messageOf(runHook(payload, iso)), PROMPT_TAG);
});

test("compaction-watch prompts again when a CHECKPOINT line resets the size and it grows past the threshold", (t) => {
  const { iso, payload, transcriptPath } = promptedOnce(t, "conv-reset");
  fs.appendFileSync(transcriptPath, checkpoint(3) + pad(4, 110 * KB));
  assert.match(messageOf(runHook(payload, iso)), PROMPT_TAG);
});

test("compaction-watch skips subagents even above the threshold", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, userInput() + pad(1, 110 * KB));
  assert.deepEqual(runHook({ conversationId: "conv-sub", transcriptPath, isSubagent: true }, iso), {});
});

test("compaction-watch emits a Preserve block that points to the slash menu", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, pad(0, 110 * KB));
  const message = messageOf(
    runHook({ conversationId: "conv-payload", transcriptPath, lastUserInput: "Continue with the plan." }, iso),
  );
  assert.match(message, /Preserve: /);
  assert.match(message, /slash menu/);
});

test("compaction-watch keeps /compact out of the copyable Preserve text", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, pad(0, 110 * KB));
  const message = messageOf(
    runHook({ conversationId: "conv-copy", transcriptPath, lastUserInput: "Continue with the plan." }, iso),
  );
  assert.doesNotMatch(message, /`\/compact Preserve:/);
});

test("compaction-watch does not prompt when a real CHECKPOINT line leaves the active size below the threshold", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(
    transcriptPath,
    userInput() + pad(1, 110 * KB) + checkpoint(557) + generic(558, "short follow-up after the compaction"),
  );
  assert.ok(fs.statSync(transcriptPath).size > 100 * KB);
  assert.deepEqual(runHook({ conversationId: "conv-checkpoint", transcriptPath }, iso), {});
});

test("compaction-watch writes no state file when a CHECKPOINT line leaves the active size below the threshold", (t) => {
  const { iso, transcriptPath, statePath } = setup(t);
  fs.writeFileSync(
    transcriptPath,
    userInput() + pad(1, 110 * KB) + checkpoint(557) + generic(558, "short follow-up after the compaction"),
  );
  runHook({ conversationId: "conv-checkpoint-state", transcriptPath }, iso);
  assert.equal(fs.existsSync(statePath("conv-checkpoint-state")), false);
});

/** A transcript whose lines only mention markers, so none of them is a real boundary. */
function mentionsOnlyTranscript() {
  return (
    userInput() +
    pad(1, 110 * KB) +
    generic(2, "COMPACT_MARKER_RE matches compact_boundary, compaction_boundary and the CHECKPOINT type") +
    entry(3, "MODEL", "GENERIC", { content: "old marker fields", compact_boundary: true, isCompactSummary: true }) +
    entry(4, "MODEL", "GENERIC", { content: "nested", details: { type: "CHECKPOINT" } }) +
    `{"step_index":5,"source":"MODEL","type":"GENERIC","status":"DONE","content":"cut off","note":"CHECKPOINT"` +
    "\n" +
    generic(6, "short follow-up")
  );
}

test("compaction-watch still prompts when lines only mention compaction markers or CHECKPOINT inside other content", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, mentionsOnlyTranscript());
  assert.match(messageOf(runHook({ conversationId: "conv-mention", transcriptPath }, iso)), PROMPT_TAG);
});

test("compaction-watch records no boundary when lines only mention compaction markers", (t) => {
  const { iso, transcriptPath, statePath } = setup(t);
  fs.writeFileSync(transcriptPath, mentionsOnlyTranscript());
  runHook({ conversationId: "conv-mention-state", transcriptPath }, iso);
  assert.equal(JSON.parse(fs.readFileSync(statePath("conv-mention-state"), "utf8")).lastMarkerEnd, 0);
});

test("compaction-watch does not prompt a swarm worker whose transcript has no USER_INPUT", (t) => {
  const { iso, transcriptPath } = setup(t);
  fs.writeFileSync(transcriptPath, systemMessage() + pad(1, 150 * KB));
  assert.deepEqual(runHook({ conversationId: "conv-worker", transcriptPath }, iso), {});
});

test("compaction-watch writes no state file for a swarm worker", (t) => {
  const { iso, transcriptPath, statePath } = setup(t);
  fs.writeFileSync(transcriptPath, systemMessage() + pad(1, 150 * KB));
  runHook({ conversationId: "conv-worker-state", transcriptPath }, iso);
  assert.equal(fs.existsSync(statePath("conv-worker-state")), false);
});

/** Transcript with two CHECKPOINT lines; the active part after the last one is 30 KB, so below the threshold. */
function twoCheckpoints(t, conversationId) {
  const box = setup(t);
  const upToLastCheckpoint =
    userInput() +
    pad(1, 60 * KB) +
    checkpoint(2, "# Resuming from a compaction, first résumé") +
    pad(3, 110 * KB) +
    checkpoint(4, "# Resuming from a compaction, second résumé");
  fs.writeFileSync(box.transcriptPath, upToLastCheckpoint + pad(5, 30 * KB));
  return { ...box, payload: { conversationId, transcriptPath: box.transcriptPath }, boundary: Buffer.byteLength(upToLastCheckpoint) };
}

test("compaction-watch measures the size from the last of several CHECKPOINT lines", (t) => {
  const { iso, payload } = twoCheckpoints(t, "conv-two-a");
  assert.deepEqual(runHook(payload, iso), {});
});

test("compaction-watch prompts once the part after the last CHECKPOINT reaches the threshold", (t) => {
  const { iso, payload, transcriptPath } = twoCheckpoints(t, "conv-two-b");
  fs.appendFileSync(transcriptPath, pad(6, 90 * KB));
  assert.match(messageOf(runHook(payload, iso)), PROMPT_TAG);
});

test("compaction-watch stores the last CHECKPOINT end and the active size in its state", (t) => {
  const { iso, payload, transcriptPath, statePath, boundary } = twoCheckpoints(t, "conv-two-c");
  fs.appendFileSync(transcriptPath, pad(6, 90 * KB));
  runHook(payload, iso);
  const state = JSON.parse(fs.readFileSync(statePath("conv-two-c"), "utf8"));
  assert.equal(state.lastMarkerEnd, boundary);
  assert.equal(state.lastPromptedBytes, fs.statSync(transcriptPath).size - boundary);
});

