import { evaluateCommand } from "./command-rules.mjs";
import { readStdin } from "./lib.mjs";

function noOpinion() {
  return { decision: "allow" };
}

function normalizeToolName(name) {
  return typeof name === "string" ? name.toLowerCase().replace(/[_\s-]/g, "") : "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReadablePayload(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function unwrapJsonLiteral(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return value;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function normalizeArgs(payload) {
  const args = payload.toolCall?.args;
  if (!isPlainObject(args)) return;
  payload.toolCall.args = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, unwrapJsonLiteral(value)]));
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
  normalizeArgs(payload);
  const result = await evaluate(payload);
  process.stdout.write(JSON.stringify(result ?? noOpinion()));
}

main().catch((err) => {
  process.stderr.write(`ignis-swarm pre-tool-use: ${err?.message ?? err}\n`);
  process.stdout.write(JSON.stringify(noOpinion()));
});
