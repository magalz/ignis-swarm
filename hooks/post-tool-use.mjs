import fs from "node:fs";
import path from "node:path";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import { readStdin, sanitizeConversationId } from "./lib.mjs";

const REDACTED = "[REDACTED]";
const MAX_SCANNED_CHARS = 8192;
const MAX_STORED_COMMAND_CHARS = 240;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const SECRET_KEYWORD = String.raw`(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key)`;
const VALUE = String.raw`(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s"';&|]+)`;

const REDACTION_RULES = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)[^\s/'"]+@/gi, `$1${REDACTED}@`],
  [/(\bauthorization\s*[:=]\s*(?:(?:bearer|basic|digest|negotiate|token)\s+)?)[^\s"']+/gi, `$1${REDACTED}`],
  [new RegExp(String.raw`(${SECRET_KEYWORD}[\w-]*["']?\s*[:=]\s*)${VALUE}`, "gi"), `$1${REDACTED}`],
  [new RegExp(String.raw`((?<![\w.-])--[\w.-]*${SECRET_KEYWORD}[\w.-]*\s+)(?!--)${VALUE}`, "gi"), `$1${REDACTED}`],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|A[SK]IA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
    REDACTED,
  ],
];

function redactSecrets(text) {
  return REDACTION_RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function isTestCommand(cmd) {
  return /\b(cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|vitest|jest|pytest|node\s+--test|dotnet\s+test|ctest|mutants|stryker|mutmut)\b/i.test(
    cmd
  );
}

function rotateIfLarge(logFile, rotatedFile) {
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, rotatedFile);
  } catch {}
}

function main() {
  try {
    const payload = readStdin();
    const convId = sanitizeConversationId(payload.conversationId);
    const baseDir = path.join(brokerDataDir(brokerHome()), "audit");
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });

    const toolName = String(payload?.toolCall?.name || "");
    const args = payload?.toolCall?.args || {};
    const entry = {
      ts: new Date().toISOString(),
      stepIdx: payload.stepIdx ?? null,
      tool: toolName,
      error: payload.error || null,
    };

    if (toolName === "run_command") {
      const cmd = String(args.CommandLine || "");
      entry.isTest = isTestCommand(cmd);
      entry.command = redactSecrets(cmd.slice(0, MAX_SCANNED_CHARS)).slice(0, MAX_STORED_COMMAND_CHARS);
    } else if (args.Path) {
      entry.path = String(args.Path);
    }

    const logFile = path.join(baseDir, `${convId}.jsonl`);
    rotateIfLarge(logFile, path.join(baseDir, `${convId}.1.jsonl`));
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}

  process.stdout.write(JSON.stringify({}));
}

main();
