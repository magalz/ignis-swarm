import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function resolveWorkspace(payload) {
  if (payload.cwd && fs.existsSync(payload.cwd)) return payload.cwd;
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    return payload.workspacePaths[0];
  }
  return "";
}

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
  { name: "focused test (.only)", regex: /\.(only)\s*\(/ },
  { name: "skipped test (.skip)", regex: /\.(skip)\s*\(/ },
  { name: "Rust ignored test (#[ignore])", regex: /#\[\s*ignore\b/ },
  { name: "Go skipped test (t.Skip)", regex: /\bt\.Skip(f|Now)?\s*\(/ },
  { name: "TypeScript suppression (@ts-ignore/@ts-nocheck)", regex: /@ts-(ignore|nocheck)\b/ },
  { name: "ESLint suppression (eslint-disable)", regex: /\beslint-disable\b/ },
  { name: "Go nolint without reason", regex: /\/\/\s*nolint(?::[^\s/]+)?\s*$/ },
  { name: "Unresolved TODO/FIXME in new code", regex: /(\/\/|#|\/\*)\s*(TODO|FIXME)\b/ },
];

function checkGitDiffShortcuts(cwd) {
  if (!fs.existsSync(path.join(cwd, ".git"))) return [];

  const diffParts = [];
  for (const args of [
    ["diff", "--unified=0", "--no-color"],
    ["diff", "--cached", "--unified=0", "--no-color"],
  ]) {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout) diffParts.push(res.stdout);
  }

  const diffText = diffParts.join("\n");
  if (!diffText.trim()) return [];

  const findings = [];
  let currentFile = "";

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
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

  const issues = [...checkDecisionIndexes(cwd), ...checkGitDiffShortcuts(cwd)];

  if (issues.length > 0) {
    const reason = [
      "[ignis-swarm Stop Gate] Resolve the following audit/hygiene issues before finishing:",
      ...issues.map((i) => `- ${i}`),
    ].join("\n");
    process.stdout.write(JSON.stringify({ decision: "continue", reason }));
    return;
  }

  process.stdout.write(JSON.stringify({}));
}

try {
  main();
} catch {
  process.stdout.write(JSON.stringify({}));
}
