import readline from "node:readline";
import { ensureDaemon } from "./lifecycle.mjs";

function injectDefaultCwd(msg, defaultCwd) {
  if (!defaultCwd || msg?.method !== "tools/call") return;
  if (!msg.params || typeof msg.params !== "object") msg.params = {};
  if (!msg.params.arguments || typeof msg.params.arguments !== "object") {
    msg.params.arguments = {};
  }
  if (!msg.params.arguments.cwd) {
    msg.params.arguments.cwd = defaultCwd;
  }
}

async function forwardWithReconnect(home, dataDir, entryScript, msg) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const info = await ensureDaemon(home, dataDir, entryScript);
    let resp;
    try {
      resp = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${info.token}`,
          Connection: "close",
        },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw err;
      }
      if (attempt === 0) continue;
      throw err;
    }
    if (resp.status === 202) return null;
    if (resp.ok) return await resp.json();
    if (resp.status === 401 && attempt === 0) continue;
    const body = await resp.text().catch(() => "");
    throw new Error(`daemon /mcp HTTP ${resp.status}: ${body}`);
  }
  throw new Error("bridge failed to reach daemon after reconnect");
}

export async function runMcpBridge(home, dataDir, entryScript, defaultCwd) {
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      continue;
    }

    const isNotification =
      msg.id === undefined ||
      msg.id === null ||
      (typeof msg.method === "string" && msg.method.startsWith("notifications/"));

    injectDefaultCwd(msg, defaultCwd);

    try {
      const out = await forwardWithReconnect(home, dataDir, entryScript, msg);
      if (!isNotification && out !== null) {
        process.stdout.write(`${JSON.stringify(out)}\n`);
      }
    } catch (err) {
      if (!isNotification) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id ?? null,
            error: { code: -32000, message: err.message || String(err) },
          })}\n`
        );
      }
    }
  }
}
