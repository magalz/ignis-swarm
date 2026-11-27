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

function neverReached(err) {
  return (err?.cause?.code ?? err?.code) === "ECONNREFUSED";
}

export async function postToDaemon({ ensure, path, body, timeoutMs = 300_000 }) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const info = await ensure();
    let resp;
    try {
      resp = await fetch(`http://127.0.0.1:${info.port}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${info.token}`,
          Connection: "close",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (!neverReached(err)) throw err;
      lastError = err;
      continue;
    }
    if (resp.ok) return resp;
    const text = await resp.text().catch(() => "");
    lastError = new Error(`HTTP ${resp.status}: ${text}`);
    if (resp.status !== 401) throw lastError;
  }
  throw lastError;
}

async function forward(home, dataDir, entryScript, msg) {
  const resp = await postToDaemon({
    ensure: () => ensureDaemon(home, dataDir, entryScript),
    path: "/mcp",
    body: msg,
  });
  if (resp.status === 202) return null;
  return await resp.json();
}

async function handle(home, dataDir, entryScript, msg, isNotification) {
  try {
    const out = await forward(home, dataDir, entryScript, msg);
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

export async function runMcpBridge(home, dataDir, entryScript, defaultCwd) {
  const rl = readline.createInterface({ input: process.stdin });
  const inFlight = new Set();

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

    const task = handle(home, dataDir, entryScript, msg, isNotification).finally(() =>
      inFlight.delete(task)
    );
    inFlight.add(task);
  }

  await Promise.allSettled([...inFlight]);
}
