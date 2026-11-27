import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import {
  defaultOnboardingState,
  hasFreshNativeFallback,
  loadOnboardingState,
} from "../scripts/broker/onboarding.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const DENY_RULES = [
  {
    pattern: /\bgit\s+(commit|push|merge|cherry-pick)\b[^\n]*\s--no-verify\b/i,
    reason: "Blocked by ignis-swarm: `--no-verify` bypasses deterministic git hooks and audit gates.",
  },
  {
    pattern: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b)(?!-with-lease)[^\n]*\b(main|master)\b/i,
    reason: "Blocked by ignis-swarm: force-pushing to main/master is forbidden.",
  },
  {
    pattern: /\bgit\s+push\b[^\n]*\b(main|master)\b[^\n]*(\s--force\b|\s-f\b)(?!-with-lease)/i,
    reason: "Blocked by ignis-swarm: force-pushing to main/master is forbidden.",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "Blocked by ignis-swarm: `git reset --hard` destroys uncommitted work. Ask the user or use a reversible operation.",
  },
  {
    pattern:
      /\brm\s+(?:-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*|(?:-r|-R|--recursive)\s+(?:-f|--force)|(?:-f|--force)\s+(?:-r|-R|--recursive))\s+(\/|\/\*|\*|~|[A-Za-z]:[\\/]?)(?=\s*(?:$|;|&&|\|\||\|))/i,
    reason: "Blocked by ignis-swarm: destructive root/wildcard deletion command.",
  },
  {
    pattern:
      /\bRemove-Item\b(?:(?=[^\n]*\s-Recurse\b)(?=[^\n]*\s-Force\b)[^\n]*\s([A-Za-z]:\\?|\/|\*)(?=\s*(?:$|;|&&|\|\||\|))|\s+(?:-Path\s+)?([A-Za-z]:\\?|\/)(?=\s+-(?:Recurse|Force)\b))/i,
    reason: "Blocked by ignis-swarm: destructive recursive root deletion command.",
  },
];

const ASK_RULES = [
  {
    pattern: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i,
    reason: "ignis-swarm requires explicit user confirmation before any force push.",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-z]*f/i,
    reason: "ignis-swarm requires explicit user confirmation before `git clean -f` deletes untracked files.",
  },
];

function gateSubagent(payload) {
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
  if (!isBlindEdgeHunter) return { decision: "allow" };
  const dataDir = brokerDataDir(brokerHome());
  let onboarding = defaultOnboardingState();
  try {
    onboarding = loadOnboardingState(dataDir);
  } catch {
    onboarding = defaultOnboardingState();
  }
  const routing = onboarding?.reviewRouting ?? {};
  if (routing.strategy !== "headless_always") return { decision: "allow" };
  const dirs = [payload.cwd, ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [])];
  let fresh = false;
  try {
    fresh = hasFreshNativeFallback(dataDir, dirs);
  } catch {
    fresh = false;
  }
  if (fresh) return { decision: "allow" };
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

function main() {
  const payload = readStdin();
  if (payload?.toolCall?.name === "invoke_subagent") {
    process.stdout.write(JSON.stringify(gateSubagent(payload)));
    return;
  }
  const cmd = String(payload?.toolCall?.args?.CommandLine || "");

  if (!cmd.trim()) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  for (const rule of DENY_RULES) {
    if (rule.pattern.test(cmd)) {
      process.stdout.write(JSON.stringify({ decision: "deny", reason: rule.reason }));
      return;
    }
  }

  for (const rule of ASK_RULES) {
    if (rule.pattern.test(cmd)) {
      process.stdout.write(JSON.stringify({ decision: "ask", reason: rule.reason }));
      return;
    }
  }

  process.stdout.write(JSON.stringify({ decision: "allow" }));
}

main();
