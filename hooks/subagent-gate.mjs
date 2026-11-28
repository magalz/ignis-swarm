import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import { defaultOnboardingState, loadOnboardingState } from "../scripts/broker/onboarding.mjs";
import { reviewGateDecision } from "../scripts/broker/review-state.mjs";
import { isPlainObject } from "../scripts/lib/common.mjs";
import { gitEnv } from "../scripts/lib/git-changes.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALREADY_COMPLETED =
  "the headless reviewer already completed for every workspace root; use its output instead of the native blind-edge-hunter.";
const UNREADABLE_TYPE = "could not read the subagent type; refusing native review under headless_always";

function isBlindEdgeHunter(typeName) {
  const norm = typeName.trim().toLowerCase();
  return norm === "blind-edge-hunter" || norm.endsWith(":blind-edge-hunter") || norm.endsWith("/blind-edge-hunter");
}

function deny(reason) {
  return { decision: "deny", reason };
}

export function evaluateSubagent(payload) {
  const args = payload?.toolCall?.args;
  const typeNames = isPlainObject(args)
    ? [args.TypeName, args.typeName].filter((value) => typeof value === "string")
    : [];
  const readable = typeNames.length > 0;
  if (readable && !typeNames.some(isBlindEdgeHunter)) return null;
  const dataDir = brokerDataDir(brokerHome());
  let onboarding = defaultOnboardingState();
  try {
    onboarding = loadOnboardingState(dataDir);
  } catch {
    onboarding = defaultOnboardingState();
  }
  const routing = onboarding?.reviewRouting ?? {};
  if (routing.strategy !== "headless_always") return null;
  if (!readable) return deny(`Blocked by ignis-swarm: ${UNREADABLE_TYPE}`);
  const dirs = [payload.cwd, ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [])]
    .filter((dir) => typeof dir === "string" && dir.trim());
  const env = gitEnv();
  let decision;
  try {
    decision = reviewGateDecision(dataDir, dirs, { env });
  } catch (err) {
    decision = { allow: false, missing: [], errors: [{ dir: null, message: `review state check failed: ${err.message}` }], gitRoots: 0 };
  }
  if (decision.allow) return null;
  const { missing, errors, gitRoots } = decision;
  const backend = routing.headlessBackend || "unconfigured";
  const model =
    routing.headlessModel ||
    (backend === "claude" ? "opus" : backend === "unconfigured" ? "none" : "config-default");
  const header = `Blocked by ignis-swarm: reviewRouting.strategy is "headless_always" (backend=${backend}, model=${model})`;
  if (missing.length === 0 && errors.length === 0) return gitRoots > 0 ? deny(`${header}: ${ALREADY_COMPLETED}`) : null;
  const runnerPath = path.resolve(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");
  const lines = [`${header}.`];
  if (missing.length > 0) {
    lines.push("Run each command below first, replacing <base-sha> with the commit to review against:");
    lines.push(...missing.map((root) => `- node "${runnerPath}" --base <base-sha> --backend auto --cwd "${root}"`));
    lines.push("Invoke native `blind-edge-hunter` ONLY if every command returns `fallbackToNative: true`.");
  }
  if (errors.length > 0) {
    lines.push("The review state could not be checked for:");
    lines.push(...errors.map(({ dir, message }) => `- ${dir ?? "(no directory)"}: ${message}`));
    lines.push("Resolve the error and retry; do not invoke native `blind-edge-hunter` meanwhile.");
  }
  return deny(lines.join("\n"));
}
