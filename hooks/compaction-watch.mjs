import fs from "node:fs";
import path from "node:path";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import { loadOnboardingState } from "../scripts/broker/onboarding.mjs";
import { isInteractiveUserSession, readStdin, sanitizeConversationId } from "./lib.mjs";

const DEFAULT_THRESHOLD_KB = 550;
const COOLDOWN_BYTES = 150 * 1024;
const CHECKPOINT_NEEDLE = Buffer.from('"CHECKPOINT"');

function isCheckpointLine(line) {
  try {
    return JSON.parse(line)?.type === "CHECKPOINT";
  } catch {
    return false;
  }
}

function findLastCheckpointEnd(buf) {
  let lastEnd = 0;
  let from = 0;
  while (from < buf.length) {
    const hit = buf.indexOf(CHECKPOINT_NEEDLE, from);
    if (hit === -1) break;
    const start = buf.lastIndexOf(0x0a, hit) + 1;
    let nl = buf.indexOf(0x0a, hit);
    if (nl === -1) nl = buf.length;
    if (isCheckpointLine(buf.toString("utf8", start, nl))) {
      lastEnd = nl < buf.length ? nl + 1 : buf.length;
    }
    from = nl + 1;
  }
  return lastEnd;
}

function measureActiveBytes(transcriptPath, thresholdBytes) {
  if (!transcriptPath || typeof transcriptPath !== "string") {
    return { activeBytes: 0, lastMarkerEnd: 0 };
  }
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { activeBytes: 0, lastMarkerEnd: 0 };
  }
  if (!stat.isFile() || stat.size < thresholdBytes) {
    return { activeBytes: stat.size, lastMarkerEnd: 0 };
  }

  let buf;
  try {
    buf = fs.readFileSync(transcriptPath);
  } catch {
    return { activeBytes: stat.size, lastMarkerEnd: 0 };
  }

  const lastMarkerEnd = findLastCheckpointEnd(buf);
  return { activeBytes: buf.length - lastMarkerEnd, lastMarkerEnd };
}

function readState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return { lastPromptedBytes: 0, lastMarkerEnd: 0 };
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      lastPromptedBytes:
        typeof parsed?.lastPromptedBytes === "number" ? parsed.lastPromptedBytes : 0,
      lastMarkerEnd:
        typeof parsed?.lastMarkerEnd === "number" ? parsed.lastMarkerEnd : 0,
    };
  } catch {
    return { lastPromptedBytes: 0, lastMarkerEnd: 0 };
  }
}

function writeState(statePath, activeBytes, lastMarkerEnd) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          lastPromptedBytes: activeBytes,
          lastMarkerEnd,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { encoding: "utf8", mode: 0o600 }
    );
  } catch {}
}

function main() {
  const payload = readStdin();
  if (!isInteractiveUserSession(payload)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const transcriptPath = payload.transcriptPath;
  if (!transcriptPath) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const dataDir = brokerDataDir(brokerHome());
  let thresholdKb = DEFAULT_THRESHOLD_KB;
  try {
    const onboarding = loadOnboardingState(dataDir);
    if (
      typeof onboarding?.compaction?.transcriptThresholdKb === "number" &&
      onboarding.compaction.transcriptThresholdKb > 0
    ) {
      thresholdKb = onboarding.compaction.transcriptThresholdKb;
    }
  } catch {}

  const thresholdBytes = thresholdKb * 1024;
  const { activeBytes, lastMarkerEnd } = measureActiveBytes(transcriptPath, thresholdBytes);
  if (activeBytes < thresholdBytes) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const convId = sanitizeConversationId(payload.conversationId);
  const statePath = path.join(dataDir, `compact-watch-${convId}.json`);
  const state = readState(statePath);

  const sameBoundary = state.lastMarkerEnd === lastMarkerEnd;
  if (
    sameBoundary &&
    state.lastPromptedBytes > 0 &&
    activeBytes >= state.lastPromptedBytes &&
    activeBytes < state.lastPromptedBytes + COOLDOWN_BYTES
  ) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  writeState(statePath, activeBytes, lastMarkerEnd);

  const activeKb = Math.round(activeBytes / 1024);
  const message =
    `[ignis-swarm][Compaction Checkpoint] Active transcript is ~${activeKb} KB (threshold: ${thresholdKb} KB). ` +
    `Pause at the end of the current step/wave and tell the user to run /compact manually via the slash menu. ` +
    `Emit only the payload as a copyable block starting with \`Preserve: <exact dynamic state>\` ` +
    `(active goal, modified files, key decisions/ADRs, open blockers, and exact next step); do NOT put /compact inside the copyable block.`;

  process.stdout.write(
    JSON.stringify({
      injectSteps: [{ systemMessage: { systemMessage: message } }],
    })
  );
}

try {
  main();
} catch {
  process.stdout.write(JSON.stringify({}));
}
