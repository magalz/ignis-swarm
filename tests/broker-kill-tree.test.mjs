import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkTemp, runNode } from "./helpers.mjs";

const ADAPTERS_URL = pathToFileURL(path.resolve(import.meta.dirname, "..", "scripts", "broker", "adapters.mjs")).href;

test("awaiting killProcessTree settles even when nothing else keeps the event loop alive", (t) => {
  const dir = mkTemp("ignis-kill-tree-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const script = path.join(dir, "kill.mjs");
  fs.writeFileSync(
    script,
    `
import { spawn } from "node:child_process";
import { killProcessTree } from ${JSON.stringify(ADAPTERS_URL)};
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  detached: process.platform !== "win32",
  windowsHide: true,
});
await new Promise((resolve) => child.once("spawn", resolve));
await killProcessTree(child.pid);
console.log("settled");
`
  );

  const res = runNode(script, [], { timeoutMs: 20_000 });

  assert.equal(res.timedOut, false);
  assert.equal(res.stdout.trim(), "settled", `killProcessTree never settled (exit ${res.status}): ${res.stderr}`);
  assert.equal(res.status, 0);
});
