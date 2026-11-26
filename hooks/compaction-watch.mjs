import fs from "node:fs";
import path from "node:path";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import { loadOnboardingState } from "../scripts/broker/onboarding.mjs";

const DEFAULT_THRESHOLD_KB = 550;
const COOLDOWN_BYTES = 150 * 1024;
const COMPACT_MARKER_RE = /"(?:compact_boundary|compaction_boundary|isCompactSummary)"/;

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function sanitizeConvId(id) {
  const raw = typeof id === "string" && id.trim() ? id.trim() : "default";
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
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

  let lastMarkerEnd = 0;
  let offset = 0;
  while (offset < buf.length) {
    let nl = buf.indexOf(0x0a, offset);
    if (nl === -1) nl = buf.length;
    const line = buf.subarray(offset, nl).toString("utf8");
    if (COMPACT_MARKER_RE.test(line)) {
      lastMarkerEnd = nl < buf.length ? nl + 1 : buf.length;
    }
    offset = nl + 1;
  }

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
  if (
    payload.isSubagent === true ||
    payload.subagent === true ||
    Boolean(payload.parentConversationId)
  ) {
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

  const convId = sanitizeConvId(payload.conversationId);
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
    `Pause at the end of the current step/wave and emit a complete, pre-filled ` +
    `\`/compact Preserve: <exact dynamic state>\` command (active goal, modified files, key decisions/ADRs, open blockers, and exact next step) so the user can compact cleanly without losing state.`;

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
