import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import { defaultOnboardingState, loadOnboardingState } from "../scripts/broker/onboarding.mjs";
import { reviewGateDecision } from "../scripts/broker/review-state.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function evaluateSubagent(payload) {
  const args = payload?.toolCall?.args ?? {};
  const typeNames = [args.TypeName, args.typeName]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const isBlindEdgeHunter = typeNames.some(
    (norm) =>
      norm === "blind-edge-hunter" ||
      norm.endsWith(":blind-edge-hunter") ||
      norm.endsWith("/blind-edge-hunter"),
  );
  if (!isBlindEdgeHunter) return null;
  const dataDir = brokerDataDir(brokerHome());
  let onboarding = defaultOnboardingState();
  try {
    onboarding = loadOnboardingState(dataDir);
  } catch {
    onboarding = defaultOnboardingState();
  }
  const routing = onboarding?.reviewRouting ?? {};
  if (routing.strategy !== "headless_always") return null;
  const dirs = [payload.cwd, ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [])]
    .filter((dir) => typeof dir === "string" && dir.trim());
  let allowed = false;
  try {
    allowed = reviewGateDecision(dataDir, dirs).allow;
  } catch {
    allowed = false;
  }
  if (allowed) return null;
  const backend = routing.headlessBackend || "unconfigured";
  const model =
    routing.headlessModel ||
    (backend === "claude" ? "opus" : backend === "unconfigured" ? "none" : "config-default");
  const runnerPath = path.resolve(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");
  return {
    decision: "deny",
    reason: `Blocked by ignis-swarm: reviewRouting.strategy is "headless_always" (backend=${backend}, model=${model}). Run \`node "${runnerPath}" --base <base-sha> --backend auto\` first. Invoke native \`blind-edge-hunter\` ONLY if that command returns \`fallbackToNative: true\`.`,
  };
}
