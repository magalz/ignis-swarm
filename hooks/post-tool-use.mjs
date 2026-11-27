import fs from "node:fs";
import path from "node:path";
import { brokerDataDir, brokerHome } from "../scripts/broker/config.mjs";
import { readStdin, sanitizeConversationId } from "./lib.mjs";

function isTestCommand(cmd) {
  return /\b(cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|vitest|jest|pytest|node\s+--test|dotnet\s+test|ctest|mutants|stryker|mutmut)\b/i.test(
    cmd
  );
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
      entry.command = cmd.slice(0, 240);
    } else if (args.Path) {
      entry.path = String(args.Path);
    }

    const logFile = path.join(baseDir, `${convId}.jsonl`);
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}

  process.stdout.write(JSON.stringify({}));
}

main();
