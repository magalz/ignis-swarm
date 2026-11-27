import { evaluateCommand } from "./command-rules.mjs";
import { readStdin } from "./lib.mjs";

function noOpinion() {
  return { decision: "allow" };
}

function normalizeToolName(name) {
  return typeof name === "string" ? name.toLowerCase().replace(/[_\s-]/g, "") : "";
}

function isReadablePayload(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
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
  const payload = readStdin();
  if (!isReadablePayload(payload)) {
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
