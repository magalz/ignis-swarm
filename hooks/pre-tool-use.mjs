import { evaluateCommand } from "./command-rules.mjs";
import { readStdin } from "./lib.mjs";

async function evaluate(payload) {
  if (payload?.toolCall?.name === "invoke_subagent") {
    try {
      const gate = await import("./subagent-gate.mjs");
      return await gate.evaluateSubagent(payload);
    } catch (err) {
      process.stderr.write(`ignis-swarm pre-tool-use: subagent gate failed: ${err?.message ?? err}\n`);
      return null;
    }
  }
  return evaluateCommand(String(payload?.toolCall?.args?.CommandLine || ""));
}

async function main() {
  const result = await evaluate(readStdin());
  process.stdout.write(JSON.stringify(result ?? { decision: "allow" }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
