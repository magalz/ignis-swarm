import fs from "node:fs";
import { evaluateCommand } from "./command-rules.mjs";

function noOpinion() {
  return { decision: "allow" };
}

function normalizeToolName(name) {
  return typeof name === "string" ? name.toLowerCase().replace(/[_\s-]/g, "") : "";
}

function readPayload() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function evaluate(payload) {
  const tool = normalizeToolName(payload.toolCall?.name);
  if (tool === "invokesubagent") {
    try {
      const gate = await import("./subagent-gate.mjs");
      return await gate.evaluateSubagent(payload);
    } catch (err) {
      process.stderr.write(`ignis-swarm pre-tool-use: subagent gate failed: ${err?.message ?? err}\n`);
      return null;
    }
  }
  if (tool === "runcommand") {
    return evaluateCommand(String(payload.toolCall?.args?.CommandLine || ""));
  }
  return null;
}

async function main() {
  const payload = readPayload();
  if (payload === null) {
    process.stderr.write("ignis-swarm pre-tool-use: unreadable hook payload\n");
    process.stdout.write(JSON.stringify(noOpinion()));
    return;
  }
  const result = await evaluate(payload);
  process.stdout.write(JSON.stringify(result ?? noOpinion()));
}

main().catch((err) => {
  process.stderr.write(`ignis-swarm pre-tool-use: ${err?.message ?? err}\n`);
  process.stdout.write(JSON.stringify(noOpinion()));
});
