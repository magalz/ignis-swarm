import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import { defaultOnboardingState, loadOnboardingState } from "../scripts/broker/onboarding.mjs";
import { reviewGateDecision } from "../scripts/broker/review-state.mjs";
import { gitToplevel } from "../scripts/lib/git-changes.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIT_REDIRECT_VARS = /^GIT_(DIR|WORK_TREE)$/i;
const ALREADY_COMPLETED =
  "the headless reviewer already completed for every workspace root; use its output instead of the native blind-edge-hunter.";
const UNREADABLE_TYPE = "could not read the subagent type; refusing native review under headless_always";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBlindEdgeHunter(typeName) {
  const norm = typeName.trim().toLowerCase();
  return norm === "blind-edge-hunter" || norm.endsWith(":blind-edge-hunter") || norm.endsWith("/blind-edge-hunter");
}

function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_REDIRECT_VARS.test(key)));
}

function probeRoots(dirs, env) {
  const errors = [];
  let git = false;
  for (const dir of dirs) {
    const top = gitToplevel(dir, { env });
    if (top.error) errors.push({ dir, message: top.error.message });
    else if (!top.notGit) git = true;
  }
  return { errors, git };
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
  const env = gitEnvironment();
  let decision;
  try {
    decision = reviewGateDecision(dataDir, dirs, { env });
  } catch (err) {
    decision = { allow: false, missing: [], errors: [{ dir: null, message: `review state check failed: ${err.message}` }] };
  }
  if (decision.allow) return null;
  const { missing } = decision;
  let { errors } = decision;
  const backend = routing.headlessBackend || "unconfigured";
  const model =
    routing.headlessModel ||
    (backend === "claude" ? "opus" : backend === "unconfigured" ? "none" : "config-default");
  const header = `Blocked by ignis-swarm: reviewRouting.strategy is "headless_always" (backend=${backend}, model=${model})`;
  if (missing.length === 0 && errors.length === 0) {
    const probe = probeRoots(dirs, env);
    if (probe.errors.length === 0) return probe.git ? deny(`${header}: ${ALREADY_COMPLETED}`) : null;
    errors = probe.errors;
  }
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
