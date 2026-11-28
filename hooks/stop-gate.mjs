import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readStdin, resolveWorkspace } from "./lib.mjs";
import { collectChanges, gitEnv, gitToplevel } from "../scripts/lib/git-changes.mjs";

const TOO_LARGE_REASON =
  "ignis-swarm stop-gate: the working diff is larger than 64 MB and could not be scanned for test shortcuts; review it manually.";
const TEST_CALLEE = "(?:it|test|describe|context|suite|specify)";

function checkDecisionIndexes(cwd) {
  const issues = [];
  const pairs = [
    { dir: path.join(cwd, "docs", "adr"), prefix: /^ADR-\d+.*\.md$/i, label: "docs/adr/INDEX.md" },
    { dir: path.join(cwd, "docs", "bdr"), prefix: /^BDR-\d+.*\.md$/i, label: "docs/bdr/INDEX.md" },
  ];

  for (const { dir, prefix, label } of pairs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => prefix.test(f));
    if (files.length === 0) continue;

    const indexPath = path.join(dir, "INDEX.md");
    if (!fs.existsSync(indexPath)) {
      issues.push(`Missing ${label} while decision files exist: ${files.join(", ")}`);
      continue;
    }

    const indexContent = fs.readFileSync(indexPath, "utf8");
    for (const file of files) {
      const idMatch = file.match(/^(ADR|BDR)-\d+/i);
      const id = idMatch ? idMatch[0] : file;
      const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const idBoundaryRe = new RegExp(`(?<![A-Z0-9-])${escapedId}(?![0-9])`, "i");
      if (!indexContent.includes(file) && !idBoundaryRe.test(indexContent)) {
        issues.push(`Unindexed decision file: ${file} is not listed in ${label}`);
      }
    }
  }

  return issues;
}

const BANNED_DIFF_PATTERNS = [
  { name: "focused test (.only)", regex: new RegExp(`\\b${TEST_CALLEE}\\.only\\s*\\(`) },
  { name: "skipped test (.skip)", regex: new RegExp(`\\b${TEST_CALLEE}\\.skip\\s*\\(`) },
  { name: "Rust ignored test (#[ignore])", regex: /#\[\s*ignore\b/ },
  { name: "Go skipped test (t.Skip)", regex: /\bt\.Skip(f|Now)?\s*\(/ },
  { name: "TypeScript suppression (@ts-ignore/@ts-nocheck)", regex: /@ts-(ignore|nocheck)\b/ },
  { name: "ESLint suppression (eslint-disable)", regex: /\beslint-disable\b/ },
  { name: "Go nolint without reason", regex: /\/\/\s*nolint(?::[^\s/]+)?\s*$/ },
  { name: "Unresolved TODO/FIXME in new code", regex: /(\/\/|#|\/\*)\s*(TODO|FIXME)\b/ },
];

function gitText(root, args, env) {
  const res = spawnSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 1000, windowsHide: true });
  return res.error || res.status !== 0 ? "" : res.stdout.trim();
}

function resolveBase(root, env) {
  const upstream = gitText(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], env);
  const target = upstream || (gitText(root, ["rev-parse", "--verify", "-q", "origin/HEAD"], env) ? "origin/HEAD" : "");
  const mergeBase = target ? gitText(root, ["merge-base", "HEAD", target], env) : "";
  return mergeBase || "HEAD";
}

function scanDiff(diffText) {
  const findings = [];
  let currentFile = "";
  let inHunk = false;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentFile = "";
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("@@")) {
        inHunk = true;
      } else if (line.startsWith("+++ ")) {
        const target = line.slice(4).replace(/\t$/, "");
        currentFile = target.startsWith("b/") ? target.slice(2) : "";
      }
      continue;
    }
    if (!line.startsWith("+")) continue;
    if (/\.(md|markdown|txt)$/i.test(currentFile) || /(^|\/)hooks\.test\./i.test(currentFile)) continue;

    const added = line.slice(1);
    for (const rule of BANNED_DIFF_PATTERNS) {
      if (rule.regex.test(added)) {
        findings.push(`${currentFile}: detected ${rule.name} -> \`${added.trim().slice(0, 100)}\``);
        if (findings.length >= 10) return findings;
      }
    }
  }

  return findings;
}

function main() {
  const payload = readStdin();

  if (payload.continuationActive === true) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (payload.terminationReason && payload.terminationReason !== "NO_TOOL_CALL") {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const cwd = resolveWorkspace(payload);
  if (!cwd) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const env = gitEnv();
  const top = gitToplevel(cwd, { env, timeoutMs: 1500 });
  const issues = checkDecisionIndexes(top.root ?? cwd);
  let tooLarge = false;

  if (top.root) {
    const changes = collectChanges(top.root, { base: resolveBase(top.root, env), unified: 0, timeoutMs: 2500, env });
    if (changes.error?.code === "too_large") {
      tooLarge = true;
    } else if (changes.error) {
      process.stderr.write(`ignis-swarm stop-gate: ${changes.error.message}\n`);
    } else {
      issues.push(...scanDiff(changes.diff));
    }
  } else if (top.error) {
    process.stderr.write(`ignis-swarm stop-gate: ${top.error.message}\n`);
  }

  const sections = [];
  if (issues.length > 0) {
    sections.push(
      [
        "[ignis-swarm Stop Gate] Resolve the following audit/hygiene issues before finishing:",
        ...issues.map((i) => `- ${i}`),
      ].join("\n")
    );
  }
  if (tooLarge) sections.push(TOO_LARGE_REASON);

  if (sections.length > 0) {
    process.stdout.write(JSON.stringify({ decision: "continue", reason: sections.join("\n") }));
    return;
  }

  process.stdout.write(JSON.stringify({}));
}

try {
  main();
} catch {
  process.stdout.write(JSON.stringify({}));
}
