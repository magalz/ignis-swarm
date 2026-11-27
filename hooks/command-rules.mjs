const NO_VERIFY_REASON = "Blocked by ignis-swarm: `--no-verify` bypasses deterministic git hooks and audit gates.";
const HOOKS_PATH_REASON = "Blocked by ignis-swarm: overriding core.hooksPath bypasses deterministic git hooks and audit gates.";
const FORCE_MAIN_REASON = "Blocked by ignis-swarm: force-pushing to main/master is forbidden.";
const DELETE_MAIN_REASON = "Blocked by ignis-swarm: deleting main/master on a remote is forbidden.";
const RESET_HARD_REASON = "Blocked by ignis-swarm: `git reset --hard` destroys uncommitted work. Ask the user or use a reversible operation.";
const FORCE_PUSH_REASON = "ignis-swarm requires explicit user confirmation before any force push.";
const MIRROR_REASON = "ignis-swarm requires explicit user confirmation before `git push --mirror` overwrites remote refs.";
const CLEAN_FORCE_REASON = "ignis-swarm requires explicit user confirmation before `git clean -f` deletes untracked files.";
const NESTING_REASON = "ignis-swarm requires explicit user confirmation before running deeply nested shell wrappers.";
const WORK_REASON = "ignis-swarm requires explicit user confirmation before analysing an oversized command line.";

const DELETE_ROOT_REASON = "Blocked by ignis-swarm: destructive root/home deletion command.";
const TRUST_REASON = "ignis-swarm requires explicit user confirmation before trusting a repository-local broker config.";

const ROOT_TARGET = /^(?:[A-Za-z]:[\\/]*(?:\*(?:\.\*)?)?|[\\/]+\*?)$/;
const HOME_TARGET = /^(?:~|\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOME))(?:[\\/]+\*?)?$/i;
const CMD_TARGET = /^(?:[A-Za-z]:|%USERPROFILE%)[\\/]*(?:\*(?:\.\*)?)?$/i;
const RM_CLUSTER = /^[dfiIPrRvWx]*$/;
const CMD_SWITCHES = /^(?:\/[a-z?])+$/i;
const POWERSHELL_PARAMETER = /^-([A-Za-z]+)(?::(.*))?$/s;
const POWERSHELL_VALUE_PARAMETERS = [
  ["-path", 2, true],
  ["-literalpath", 2, true],
  ["-lp", 3, true],
  ["-pspath", 3, true],
  ["-include", 2, false],
  ["-exclude", 2, false],
  ["-filter", 3, false],
  ["-credential", 3, false],
  ["-stream", 2, false],
];

const HOOKED_SUBCOMMANDS = new Set(["commit", "push", "merge", "rebase", "cherry-pick"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
const NO_VALUE_LETTERS = /(?!)/;
const VALUE_LETTERS = new Map([
  ["commit", /[mFCct]/],
  ["clean", /e/],
  ["push", /o/],
]);
const SHORT_OPTION = /^-([A-Za-z]+)(.*)$/s;
const PREFIX_WORDS = new Map([
  ["sudo", /^-[ughpCDRTU]$/],
  ["doas", /^-[uC]$/],
  ["env", /^-[uCS]$/],
  ["timeout", /^(?:-[sk]|--signal|--kill-after)$/],
  ["nice", /^(?:-n|--adjustment)$/],
  ["xargs", /^(?:-[InPLdsaE]|--max-args|--max-procs|--max-lines|--max-chars|--delimiter|--arg-file|--eof|--process-slot-var)$/],
  ["watch", /^(?:-n|--interval)$/],
  ["stdbuf", /^(?:-[ioe]|--input|--output|--error)$/],
  ["command", null],
  ["exec", null],
  ["nohup", null],
  ["time", null],
  ["if", null],
  ["then", null],
  ["elif", null],
  ["else", null],
  ["while", null],
  ["until", null],
  ["do", null],
  ["!", null],
]);
const PREFIX_POSITIONALS = new Map([["timeout", 1]]);
const SH_FAMILY = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const POWERSHELL = new Set(["pwsh", "powershell"]);
const POWERSHELL_REMOVE = new Set(["remove-item", "ri", "rm", "del", "erase", "rmdir", "rd"]);
const CMD_DELETE = new Set(["del", "erase", "rd", "rmdir"]);
const EXPRESSION_COMMANDS = new Set(["iex", "invoke-expression"]);
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const EXEC_END = new Set([";", "+", "\\"]);
const SH_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const CMD_FLAG = /^\/[ck]$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEREDOC_OPERATOR = /-?[ \t]*(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)"|([A-Za-z_][\w.-]*))/y;
const DELIMITER_LINE = /^\t*[A-Za-z_][\w.-]*$/;
const ESCAPABLE = "\"'\\;()`";
const BRACE_NEIGHBOUR = /[\s;|&()<>]/;
const RANK = { deny: 2, force_ask: 1 };
const TICK_SUBSTITUTE = "substitute";
const TICK_LITERAL = "literal";
const TICK_ESCAPE = "escape";
const MAX_DEPTH = 8;
const MAX_WORK = 3_000_000;
let work = 0;

const deny = (reason) => ({ decision: "deny", reason });
const forceAsk = (reason) => ({ decision: "force_ask", reason });

function strongest(current, candidate) {
  return (RANK[candidate?.decision] ?? 0) > (RANK[current?.decision] ?? 0) ? candidate : current;
}

function makeWord(text, quoted, partial) {
  const cmp = text.replace(/\\/g, "");
  const names = [text, cmp].map((value) => value.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ""));
  return { text, cmp, names, quoted, partial };
}

function newFrame(kind, string) {
  return {
    kind,
    string,
    arith: false,
    quote: string ? '"' : null,
    quoted: false,
    opened: false,
    current: string ? "" : null,
    hereString: false,
    afterPipe: false,
    words: [],
    blanked: "",
    docs: [],
    strings: [],
    pipe: { segs: [] },
    pending: [],
    parens: 0,
  };
}

function indexLines(script) {
  const exact = new Map();
  const stripped = new Map();
  const add = (map, key, start) => {
    const starts = map.get(key);
    if (starts === undefined) map.set(key, [start]);
    else starts.push(start);
  };
  let start = 0;
  while (start <= script.length) {
    let end = script.indexOf("\n", start);
    if (end === -1) end = script.length;
    const line = script.slice(start, end).replace(/\r$/, "");
    if (DELIMITER_LINE.test(line)) {
      const name = line.replace(/^\t+/, "");
      add(stripped, name, start);
      if (name === line) add(exact, name, start);
    }
    start = end + 1;
  }
  return { exact, stripped };
}

function firstAtOrAfter(starts, position) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] < position) low = middle + 1;
    else high = middle;
  }
  return low < starts.length ? starts[low] : -1;
}

function scan(script, escapes, stringMode, ticks) {
  const segments = [];
  const stack = [];
  let frame = newFrame("top", stringMode);
  let lines = null;

  const endWord = (cut = false) => {
    if (frame.current !== null) {
      const word = makeWord(frame.current, frame.quoted, cut || frame.opened);
      if (frame.hereString) frame.strings.push(word);
      else frame.words.push(word);
      frame.hereString = false;
    }
    frame.current = null;
    frame.quoted = false;
    frame.opened = false;
  };
  const endSegment = (keepPipe) => {
    endWord();
    const { words, blanked, docs, strings, pipe } = frame;
    if (!frame.string && (words.length > 0 || strings.length > 0 || docs.length > 0)) {
      segments.push({ words, blanked, docs, strings, pipe });
    }
    frame.words = [];
    frame.blanked = "";
    frame.docs = [];
    frame.strings = [];
    frame.afterPipe = false;
    if (!keepPipe) frame.pipe = { segs: [] };
  };
  const open = (kind) => {
    frame.current ??= "";
    frame.opened = true;
    frame.blanked += " ";
    stack.push(frame);
    frame = newFrame(kind, false);
  };
  const close = () => {
    endSegment(false);
    frame = stack.pop();
  };
  const skipHeredocs = (position) => {
    lines ??= indexLines(script);
    for (const doc of frame.pending) {
      const starts = (doc.strip ? lines.stripped : lines.exact).get(doc.delimiter);
      const at = starts === undefined ? -1 : firstAtOrAfter(starts, position);
      if (at === -1) break;
      doc.text = script.slice(position, at);
      const newline = script.indexOf("\n", at);
      position = newline === -1 ? script.length : newline + 1;
    }
    frame.pending = [];
    return position;
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    const next = script[i + 1] ?? "";
    if (frame.kind === "tick" && ch === "`") {
      close();
    } else if (frame.quote === "'") {
      if (ch === "'") {
        frame.quote = null;
        frame.blanked += ch;
      } else {
        frame.current += ch;
        frame.blanked += " ";
      }
    } else if (ticks === TICK_SUBSTITUTE && ch === "`") {
      open("tick");
    } else if (ticks === TICK_ESCAPE && ch === "`") {
      frame.current = (frame.current ?? "") + ch + next;
      frame.blanked += next === "" ? " " : "  ";
      i += next === "" ? 0 : 1;
    } else if (ch === "$" && next === "(") {
      open("dollar");
      frame.arith = script[i + 2] === "(";
      i += 1;
    } else if (frame.quote === '"') {
      if (escapes && ch === "\\" && (next === '"' || next === "\\" || next === "`" || next === "$")) {
        frame.current += next;
        frame.blanked += "  ";
        i += 1;
      } else if (ch === '"' && !frame.string) {
        frame.quote = null;
        frame.blanked += ch;
      } else {
        frame.current += ch;
        frame.blanked += " ";
      }
    } else if (escapes && ch === "\\" && ESCAPABLE.includes(next) && next !== "") {
      frame.current = (frame.current ?? "") + next;
      frame.blanked += "  ";
      i += 1;
    } else if (ch === "'" || ch === '"') {
      frame.quote = ch;
      frame.quoted = true;
      frame.current ??= "";
      frame.blanked += ch;
    } else if (ch === "\n") {
      endSegment(frame.afterPipe && frame.words.length === 0);
      if (frame.pending.length > 0) i = skipHeredocs(i + 1) - 1;
    } else if (ch === ";") {
      endSegment(false);
    } else if (ch === "|") {
      const doubled = next === "|";
      endSegment(!doubled);
      frame.afterPipe = !doubled;
      if (doubled || next === "&") i += 1;
    } else if (ch === "(") {
      frame.parens += 1;
      endSegment(true);
    } else if (ch === ")") {
      if (frame.kind === "dollar" && frame.parens === 0) {
        close();
      } else {
        frame.parens = Math.max(0, frame.parens - 1);
        endSegment(true);
      }
    } else if ((ch === "{" && next !== "}" && !/[$@]$/.test(frame.current ?? "")) || (ch === "}" && (next === "" || BRACE_NEIGHBOUR.test(next)) && !(frame.current ?? "").includes("{"))) {
      endWord(ch === "{");
      endSegment(true);
    } else if (ch === "&" && next === "&") {
      endSegment(false);
      i += 1;
    } else if (ch === "&" && next === ">") {
      endWord();
      frame.blanked += ch;
    } else if (ch === "&" && script[i - 1] !== ">" && script[i - 1] !== "<") {
      endSegment(false);
    } else if (ch === "<" && next === "<" && !frame.arith) {
      endWord();
      if (script[i + 2] === "<") {
        frame.hereString = true;
        frame.blanked += "   ";
        i += 2;
      } else {
        HEREDOC_OPERATOR.lastIndex = i + 2;
        const match = HEREDOC_OPERATOR.exec(script);
        if (match === null) {
          frame.blanked += "  ";
          i += 1;
        } else {
          const doc = {
            text: "",
            delimiter: match[1] ?? match[2] ?? match[3],
            strip: script[i + 2] === "-",
            expand: match[3] !== undefined,
          };
          frame.docs.push(doc);
          frame.pending.push(doc);
          frame.blanked += " ";
          i = HEREDOC_OPERATOR.lastIndex - 1;
        }
      }
    } else if (/\s/.test(ch) || ch === ">" || ch === "<") {
      endWord();
      frame.blanked += ch;
    } else {
      frame.current = (frame.current ?? "") + ch;
      frame.blanked += ch;
    }
  }
  while (stack.length > 0) close();
  endSegment(false);
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
    i += PREFIX_POSITIONALS.get(prefix) ?? 0;
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

function isPowerShellFlag({ cmp }, full) {
  return cmp.length >= 2 && full.startsWith(cmp.toLowerCase());
}

function shellPayload(words, start) {
  const { names } = words[start];
  const rest = words.slice(start + 1);
  if (names.some((name) => SH_FAMILY.has(name))) {
    const flag = rest.findIndex((word) => SH_COMMAND_FLAG.test(word.cmp));
    if (flag === -1) return null;
    let at = flag + 1;
    while (at < rest.length && !rest[at].quoted && rest[at].cmp.startsWith("-")) {
      at += 1;
      if (rest[at - 1].cmp === "--") break;
    }
    return rest[at]?.text ?? null;
  }
  if (names.some((name) => POWERSHELL.has(name))) {
    const flag = rest.findIndex((word) => isPowerShellFlag(word, "-command"));
    if (flag === -1) return null;
    const body = rest.slice(flag + 1);
    if (body[0]?.cmp === "--") body.shift();
    return joinWords(body);
  }
  if (names.includes("cmd")) {
    const flag = rest.findIndex((word) => CMD_FLAG.test(word.cmp));
    return flag === -1 ? null : joinWords(rest.slice(flag + 1));
  }
  return null;
}

function readsStdin(words, start) {
  const { names } = words[start];
  const rest = words.slice(start + 1);
  if (names.some((name) => SH_FAMILY.has(name))) return !rest.some((word) => SH_COMMAND_FLAG.test(word.cmp));
  if (names.some((name) => POWERSHELL.has(name))) {
    return !rest.some((word) => isPowerShellFlag(word, "-command") || isPowerShellFlag(word, "-file"));
  }
  if (names.includes("cmd")) return !rest.some((word) => CMD_FLAG.test(word.cmp));
  return names.some((name) => EXPRESSION_COMMANDS.has(name));
}

function wordScripts(words, first, scripts) {
  for (const word of words) {
    if (word.quoted) scripts.push(word.text);
  }
  if (words.length - first > 1) scripts.push(words.slice(first).map(({ text }) => text).join(" "));
}

function inputScripts(segment, scripts) {
  for (const doc of segment.docs) scripts.push(doc.text);
  for (const word of segment.strings) scripts.push(word.text);
}

function findScripts(args) {
  const scripts = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].quoted || !EXEC_FLAGS.has(args[i].text)) continue;
    let end = i + 1;
    while (end < args.length && !EXEC_END.has(args[end].text)) end += 1;
    const script = joinWords(args.slice(i + 1, end));
    if (script !== null) scripts.push(script);
    i = end;
  }
  return scripts;
}

function shortCluster(cmp, valueLetters) {
  const match = SHORT_OPTION.exec(cmp);
  if (match === null) return null;
  const [, letters, rest] = match;
  const value = letters.search(valueLetters);
  if (value !== -1) return letters.slice(0, value);
  return rest === "" ? letters : null;
}

function parseOptions(args, valueLetters) {
  const longs = [];
  const clusters = [];
  const positionals = [];
  let options = true;
  for (const { cmp } of args) {
    if (options && cmp === "--") {
      options = false;
    } else if (options && cmp.startsWith("--")) {
      longs.push(cmp.split("=")[0].toLowerCase());
    } else {
      const cluster = options ? shortCluster(cmp, valueLetters) : null;
      if (cluster === null) positionals.push(cmp);
      else clusters.push(cluster);
    }
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
  const deleting = hasLongOption(longs, "--delete", 4) || clusters.some((cluster) => cluster.includes("d"));
  if (positionals.some((refspec) => (deleting || /^\+?:/.test(refspec)) && targetsProtectedBranch(refspec))) {
    return deny(DELETE_MAIN_REASON);
  }
  const plainForce =
    hasLongOption(longs, "--force", 7) ||
    clusters.some((cluster) => cluster.includes("f")) ||
    positionals.some((refspec) => refspec.startsWith("+"));
  const leaseForce = hasLongOption(longs, "--force-with-lease", 9) || hasLongOption(longs, "--force-if-includes", 9);
  const mirror = hasLongOption(longs, "--mirror", 3);
  if (!plainForce && !leaseForce && !mirror) return null;
  if (plainForce && positionals.some(targetsProtectedBranch)) return deny(FORCE_MAIN_REASON);
  return forceAsk(plainForce || leaseForce ? FORCE_PUSH_REASON : MIRROR_REASON);
}

function foreachScript(args) {
  let at = args.findIndex(({ cmp }) => !cmp.startsWith("-"));
  if (at === -1 || args[at].cmp !== "foreach") return null;
  at += 1;
  while (at < args.length && !args[at].quoted && args[at].cmp.startsWith("-")) at += 1;
  return joinWords(args.slice(at));
}

function evaluateGit(args, depth) {
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
  if (subcommand === "submodule") {
    const script = foreachScript(args.slice(i + 1));
    return script === null ? null : evaluateScript(script, depth + 1);
  }
  const { longs, clusters, positionals } = parseOptions(args.slice(i + 1), VALUE_LETTERS.get(subcommand) ?? NO_VALUE_LETTERS);
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

function deletesTarget(target, recursive) {
  return ROOT_TARGET.test(target) || (recursive && (target === "*" || HOME_TARGET.test(target)));
}

function posixRm(args) {
  const { longs, clusters, positionals } = parseOptions(args, NO_VALUE_LETTERS);
  const recursive =
    hasLongOption(longs, "--recursive", 3) || clusters.some((cluster) => RM_CLUSTER.test(cluster) && /[rR]/.test(cluster));
  return recursive && positionals.some((target) => deletesTarget(target, true));
}

function powershellRemove(args) {
  const targets = [];
  const addTargets = (value) => {
    for (const target of value.split(",")) targets.push(target);
  };
  let recursive = false;
  for (let i = 0; i < args.length; i += 1) {
    const { text, quoted } = args[i];
    const flag = quoted ? null : POWERSHELL_PARAMETER.exec(text);
    if (flag === null) {
      addTargets(text);
      continue;
    }
    const name = `-${flag[1].toLowerCase()}`;
    if (name.length >= 2 && "-recurse".startsWith(name)) {
      recursive = flag[2]?.toLowerCase() !== "$false";
      continue;
    }
    const parameter = POWERSHELL_VALUE_PARAMETERS.find(([full, minLength]) => name.length >= minLength && full.startsWith(name));
    if (parameter === undefined) continue;
    let value = flag[2];
    if (!value) {
      const next = args[i + 1];
      if (next === undefined || (!next.quoted && POWERSHELL_PARAMETER.test(next.text))) continue;
      value = next.text;
      i += 1;
    }
    if (parameter[2]) addTargets(value);
  }
  return targets.some((target) => deletesTarget(target, recursive));
}

function cmdDelete(args) {
  const isSwitch = ({ text }) => CMD_SWITCHES.test(text);
  const recursive = args.some((word) => isSwitch(word) && /\/s/i.test(word.text));
  return recursive && args.some((word) => !isSwitch(word) && CMD_TARGET.test(word.text));
}

function deletesRoot(names, args) {
  return (
    (names.includes("rm") && posixRm(args)) ||
    (names.some((name) => POWERSHELL_REMOVE.has(name)) && powershellRemove(args)) ||
    (names.some((name) => CMD_DELETE.has(name)) && cmdDelete(args))
  );
}

function trustsBrokerConfig(args) {
  const broker = args.findIndex(({ names }) => names.includes("ignis-broker.mjs"));
  return broker !== -1 && args[broker + 1]?.cmp === "trust";
}

function evaluateSegment(segment, depth) {
  const { words, docs, strings, pipe } = segment;
  let verdict = null;
  const decided = (candidate) => {
    verdict = strongest(verdict, candidate);
    return verdict?.decision === "deny";
  };
  const decidedAll = (scripts) => scripts.some((script) => decided(evaluateScript(script, depth + 1)));

  for (const doc of docs) {
    if (doc.expand && decided(evaluateScript(doc.text, depth + 1, true))) return verdict;
  }
  const start = commandStart(words);
  if (start >= words.length) return verdict;
  const { names } = words[start];
  const operands = words.slice(start + 1).filter((word) => !word.partial);
  if (deletesRoot(names, operands)) return deny(DELETE_ROOT_REASON);
  if (names.includes("node") && trustsBrokerConfig(operands)) decided(forceAsk(TRUST_REASON));
  if (names.includes("git")) return strongest(verdict, evaluateGit(words.slice(start + 1), depth));
  if (names.includes("find") && decidedAll(findScripts(words.slice(start + 1)))) return verdict;
  if (names.some((name) => EXPRESSION_COMMANDS.has(name))) {
    const args = words.slice(start + 1).filter((word) => word.quoted || !word.cmp.startsWith("-"));
    const scripts = [];
    wordScripts(args, 0, scripts);
    if (decidedAll(scripts)) return verdict;
  }
  const payload = shellPayload(words, start);
  if (payload !== null && decided(evaluateScript(payload, depth + 1))) return verdict;
  if (readsStdin(words, start)) {
    const scripts = [];
    for (const prior of pipe.segs) {
      inputScripts(prior, scripts);
      wordScripts(prior.words, 1, scripts);
    }
    inputScripts({ docs, strings }, scripts);
    pipe.segs.length = 0;
    decidedAll(scripts);
  } else {
    pipe.segs.push(segment);
  }
  return verdict;
}

function evaluateScript(script, depth, stringMode = false) {
  if (depth > MAX_DEPTH) return forceAsk(NESTING_REASON);
  const dialects = [
    [script.replace(/\\\r?\n/g, ""), true, TICK_SUBSTITUTE],
    [script.replace(/`\r?\n/g, ""), false, TICK_ESCAPE],
    [script.replace(/\^\r?\n/g, ""), false, TICK_LITERAL],
  ];
  let verdict = null;
  for (const [joined, escapes, ticks] of dialects) {
    work += joined.length;
    if (work > MAX_WORK) return strongest(verdict, forceAsk(WORK_REASON));
    for (const segment of scan(joined, escapes, stringMode, ticks)) {
      verdict = strongest(verdict, evaluateSegment(segment, depth));
      if (verdict?.decision === "deny") return verdict;
    }
  }
  return verdict;
}

export function evaluateCommand(commandLine) {
  if (typeof commandLine !== "string" || !commandLine.trim()) return null;
  work = 0;
  return evaluateScript(commandLine, 0);
}
