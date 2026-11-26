import fs from "node:fs";

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

function main() {
  const payload = readStdin();
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
