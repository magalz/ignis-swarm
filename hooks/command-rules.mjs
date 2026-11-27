const NO_VERIFY_REASON = "Blocked by ignis-swarm: `--no-verify` bypasses deterministic git hooks and audit gates.";
const HOOKS_PATH_REASON = "Blocked by ignis-swarm: overriding core.hooksPath bypasses deterministic git hooks and audit gates.";
const FORCE_MAIN_REASON = "Blocked by ignis-swarm: force-pushing to main/master is forbidden.";
const RESET_HARD_REASON = "Blocked by ignis-swarm: `git reset --hard` destroys uncommitted work. Ask the user or use a reversible operation.";
const FORCE_PUSH_REASON = "ignis-swarm requires explicit user confirmation before any force push.";
const CLEAN_FORCE_REASON = "ignis-swarm requires explicit user confirmation before `git clean -f` deletes untracked files.";
const NESTING_REASON = "ignis-swarm requires explicit user confirmation before running deeply nested shell wrappers.";

const DESTRUCTIVE_RULES = [
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

const HOOKED_SUBCOMMANDS = new Set(["commit", "push", "merge", "rebase", "cherry-pick"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
const PREFIX_WORDS = new Map([
  ["sudo", /^-[ughpCDRTU]$/],
  ["env", /^-[uCS]$/],
  ["command", null],
  ["exec", null],
  ["nohup", null],
  ["time", null],
  ["builtin", null],
  ["if", null],
  ["then", null],
  ["elif", null],
  ["else", null],
  ["while", null],
  ["until", null],
  ["do", null],
  ["!", null],
  ["{", null],
]);
const SH_FAMILY = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const POWERSHELL = new Set(["pwsh", "powershell"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RANK = { deny: 2, force_ask: 1 };
const MAX_DEPTH = 8;

const deny = (reason) => ({ decision: "deny", reason });
const forceAsk = (reason) => ({ decision: "force_ask", reason });

function strongest(current, candidate) {
  return (RANK[candidate?.decision] ?? 0) > (RANK[current?.decision] ?? 0) ? candidate : current;
}

function makeWord(text) {
  const cmp = text.replace(/\\/g, "");
  const names = [text, cmp].map((value) => value.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ""));
  return { text, cmp, names };
}

function scan(script, escapes) {
  const segments = [];
  let words = [];
  let blanked = "";
  let current = null;
  let quote = null;

  const endWord = () => {
    if (current !== null) words.push(makeWord(current));
    current = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push({ words, blanked });
    words = [];
    blanked = "";
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    const next = script[i + 1] ?? "";
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        blanked += ch;
      } else {
        current += ch;
        blanked += " ";
      }
    } else if (quote === '"') {
      if (escapes && ch === "\\" && (next === '"' || next === "\\")) {
        current += next;
        blanked += "  ";
        i += 1;
      } else if (ch === '"') {
        quote = null;
        blanked += ch;
      } else {
        current += ch;
        blanked += " ";
      }
    } else if (escapes && ch === "\\" && (next === '"' || next === "'" || next === "\\")) {
      current = (current ?? "") + next;
      blanked += "  ";
      i += 1;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current ??= "";
      blanked += ch;
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "(" || ch === ")") {
      endSegment();
    } else if (ch === "&" && next === "&") {
      endSegment();
      i += 1;
    } else if (ch === "&" && script[i - 1] !== ">" && script[i - 1] !== "<" && next !== ">") {
      endSegment();
    } else if (/\s/.test(ch) || ch === ">" || ch === "<") {
      endWord();
      blanked += ch;
    } else {
      current = (current ?? "") + ch;
      blanked += ch;
    }
  }
  endSegment();
  return segments;
}

function commandStart(words) {
  let i = 0;
  while (i < words.length) {
    if (ASSIGNMENT.test(words[i].cmp)) {
      i += 1;
      continue;
    }
    const prefix = words[i].names.find((name) => PREFIX_WORDS.has(name));
    if (prefix === undefined) break;
    const valueFlag = PREFIX_WORDS.get(prefix);
    i += 1;
    while (i < words.length && words[i].cmp.startsWith("-")) {
      i += valueFlag?.test(words[i].cmp) ? 2 : 1;
    }
  }
  return i;
}

function joinWords(words) {
  if (words.length === 0) return null;
  if (words.length === 1) return words[0].text;
  return words
    .map(({ text }) => {
      if (!/[\s;&|()<>'"]/.test(text)) return text;
      return text.includes('"') ? `'${text}'` : `"${text}"`;
    })
    .join(" ");
}

function shellPayload(words, start) {
  const { names } = words[start];
  const rest = words.slice(start + 1);
  if (names.some((name) => SH_FAMILY.has(name))) {
    const flag = rest.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.cmp));
    return flag === -1 ? null : (rest[flag + 1]?.text ?? null);
  }
  if (names.some((name) => POWERSHELL.has(name))) {
    const flag = rest.findIndex((word) => word.cmp.length >= 2 && "-command".startsWith(word.cmp.toLowerCase()));
    return flag === -1 ? null : joinWords(rest.slice(flag + 1));
  }
  if (names.includes("cmd")) {
    const flag = rest.findIndex((word) => /^\/[ck]$/i.test(word.cmp));
    return flag === -1 ? null : joinWords(rest.slice(flag + 1));
  }
  return null;
}

function parseOptions(args) {
  const longs = [];
  const clusters = [];
  const positionals = [];
  let options = true;
  for (const { cmp } of args) {
    if (options && cmp === "--") options = false;
    else if (options && cmp.startsWith("--")) longs.push(cmp.split("=")[0].toLowerCase());
    else if (options && /^-[A-Za-z]+$/.test(cmp)) clusters.push(cmp.slice(1));
    else positionals.push(cmp);
  }
  return { longs, clusters, positionals };
}

function hasLongOption(longs, full, minLength) {
  return longs.some((option) => option.length >= minLength && full.startsWith(option));
}

function targetsProtectedBranch(refspec) {
  const destination = refspec.replace(/^\+/, "").replace(/^[^:]*:/, "").replace(/^refs\/heads\//, "");
  return PROTECTED_BRANCHES.has(destination.toLowerCase());
}

function evaluatePush({ longs, clusters, positionals }) {
  const plainForce =
    hasLongOption(longs, "--force", 7) ||
    clusters.some((cluster) => cluster.includes("f")) ||
    positionals.some((refspec) => refspec.startsWith("+"));
  const leaseForce = hasLongOption(longs, "--force-with-lease", 9) || hasLongOption(longs, "--force-if-includes", 9);
  if (!plainForce && !leaseForce) return null;
  if (plainForce && positionals.some(targetsProtectedBranch)) return deny(FORCE_MAIN_REASON);
  return forceAsk(FORCE_PUSH_REASON);
}

function evaluateGit(args) {
  let hooksPathOverridden = false;
  let i = 0;
  for (; i < args.length && args[i].cmp.startsWith("-"); i += 1) {
    const option = args[i].cmp;
    const eq = option.indexOf("=");
    const name = eq === -1 ? option : option.slice(0, eq);
    if (!GLOBAL_VALUE_OPTIONS.has(name)) continue;
    let value = option.slice(eq + 1);
    if (eq === -1) {
      i += 1;
      value = args[i]?.cmp ?? "";
    }
    if ((name === "-c" || name === "--config-env") && /^core\.hookspath(?:=|$)/i.test(value)) hooksPathOverridden = true;
  }
  const subcommand = args[i]?.cmp.toLowerCase();
  if (subcommand === undefined) return null;
  const { longs, clusters, positionals } = parseOptions(args.slice(i + 1));
  if (HOOKED_SUBCOMMANDS.has(subcommand)) {
    if (hooksPathOverridden) return deny(HOOKS_PATH_REASON);
    const skipsHooks =
      hasLongOption(longs, "--no-verify", 9) ||
      (subcommand === "commit" && clusters.some((cluster) => cluster.includes("n")));
    if (skipsHooks) return deny(NO_VERIFY_REASON);
  }
  if (subcommand === "push") return evaluatePush({ longs, clusters, positionals });
  if (subcommand === "reset" && hasLongOption(longs, "--hard", 4)) return deny(RESET_HARD_REASON);
  if (subcommand === "clean" && (hasLongOption(longs, "--force", 3) || clusters.some((cluster) => cluster.includes("f")))) {
    return forceAsk(CLEAN_FORCE_REASON);
  }
  return null;
}

function evaluateSegment({ words, blanked }, depth) {
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(blanked)) return deny(rule.reason);
  }
  const start = commandStart(words);
  if (start >= words.length) return null;
  if (words[start].names.includes("git")) return evaluateGit(words.slice(start + 1));
  const payload = shellPayload(words, start);
  return payload === null ? null : evaluateScript(payload, depth + 1);
}

function evaluateScript(script, depth) {
  if (depth > MAX_DEPTH) return forceAsk(NESTING_REASON);
  const joined = script.replace(/[\\^`]\r?\n/g, "");
  const modes = /\\["']/.test(joined) ? [true, false] : [false];
  let verdict = null;
  for (const escapes of modes) {
    for (const segment of scan(joined, escapes)) {
      verdict = strongest(verdict, evaluateSegment(segment, depth));
      if (verdict?.decision === "deny") return verdict;
    }
  }
  return verdict;
}

export function evaluateCommand(commandLine) {
  if (typeof commandLine !== "string" || !commandLine.trim()) return null;
  return evaluateScript(commandLine, 0);
}
