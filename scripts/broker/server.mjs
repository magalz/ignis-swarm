import crypto from "node:crypto";
import http from "node:http";
import { BrokerError } from "./adapters.mjs";
import { BROKER_VERSION } from "./config.mjs";
import {
  generateToken,
  removeDaemonInfoIfOwner,
  writeDaemonInfoAtomic,
} from "./lifecycle.mjs";
import { Supervisor } from "./supervisor.mjs";

const PROTOCOL_VERSION = "2025-06-18";

export function metaToolsCatalog() {
  return [
    {
      name: "broker_list",
      description:
        "List managed MCP servers or compact tool summaries for a server. Omit `server` to list servers; pass `server` to list its tools.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Optional server name to list tools for." },
          filter: {
            type: "string",
            description: "Optional case-insensitive substring filter for tool names/descriptions.",
          },
          cwd: {
            type: "string",
            description: "Workspace directory path for local config resolution and per-workspace servers.",
          },
        },
      },
    },
    {
      name: "broker_describe",
      description:
        "Return the full JSON parameter schema and description for a single backend tool on demand.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Managed server name." },
          tool: { type: "string", description: "Exact tool name on that server." },
          cwd: { type: "string", description: "Workspace directory path." },
        },
        required: ["server", "tool"],
      },
    },
    {
      name: "broker_call",
      description:
        "Invoke a backend tool through the resilient supervisor (auto-reconnect, retry, local->global failover, and spill-to-file truncation).",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Managed server name." },
          tool: { type: "string", description: "Exact tool name to invoke." },
          arguments: { type: "object", description: "JSON arguments object for the tool." },
          cwd: { type: "string", description: "Workspace directory path." },
          full: { type: "boolean", description: "Set true to bypass output truncation." },
        },
        required: ["server", "tool"],
      },
    },
    {
      name: "broker_status",
      description:
        "Inspect daemon health, workspace pool entries, config warnings, and recent local->global fallback events.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Workspace directory path." },
        },
      },
    },
  ];
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function isAuthorized(authHeader, token) {
  if (typeof authHeader !== "string") return false;
  const expected = `Bearer ${token}`;
  const a = Buffer.from(authHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function mapErrorStatus(err) {
  const kind = err?.kind;
  if (kind === "server_not_found" || kind === "tool_not_found") return 404;
  if (kind === "config" || kind === "protocol") return 400;
  if (kind === "timeout") return 504;
  return 502;
}

async function readBodyJson(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new BrokerError("protocol", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BrokerError("protocol", `invalid JSON body: ${err.message}`);
  }
}

async function handleMcpRpc(supervisor, body, res) {
  const method = typeof body.method === "string" ? body.method : "";
  const hasId = body.id !== undefined && body.id !== null;
  if (!hasId || method.startsWith("notifications/")) {
    res.writeHead(202);
    res.end();
    return;
  }

  const rpcOk = (result) => sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result });
  const rpcErr = (code, message) =>
    sendJson(res, 200, { jsonrpc: "2.0", id: body.id, error: { code, message } });

  if (method === "initialize") {
    rpcOk({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "ignis-broker", version: BROKER_VERSION },
      instructions:
        "Use broker_list -> broker_describe -> broker_call. Pass `cwd` for workspace-scoped servers. Inspect `_meta` for local->global fallback or spillPath.",
    });
    return;
  }

  if (method === "ping") {
    rpcOk({});
    return;
  }

  if (method === "tools/list") {
    rpcOk({ tools: metaToolsCatalog() });
    return;
  }

  if (method !== "tools/call") {
    rpcErr(-32601, `method not found: ${method}`);
    return;
  }

  const params = body.params || {};
  const toolName = params.name || "";
  const args = params.arguments || {};

  try {
    if (toolName === "broker_list") {
      const out = await supervisor.list({
        server: args.server,
        filter: args.filter,
        cwd: args.cwd,
      });
      rpcOk({
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: false,
      });
      return;
    }

    if (toolName === "broker_describe") {
      if (!args.server || !args.tool) {
        rpcErr(-32602, "missing required parameters `server` and `tool`");
        return;
      }
      const out = await supervisor.describe({
        server: args.server,
        tool: args.tool,
        cwd: args.cwd,
      });
      rpcOk({
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: false,
      });
      return;
    }

    if (toolName === "broker_call") {
      if (!args.server || !args.tool) {
        rpcErr(-32602, "missing required parameters `server` and `tool`");
        return;
      }
      const out = await supervisor.call({
        server: args.server,
        tool: args.tool,
        arguments: args.arguments || {},
        cwd: args.cwd,
        maxBytes: args.maxBytes,
        full: Boolean(args.full),
      });
      const content = [
        ...out.content,
        { type: "text", text: `_meta: ${JSON.stringify(out.meta)}` },
      ];
      rpcOk({ content, isError: out.isError });
      return;
    }

    if (toolName === "broker_status") {
      const out = await supervisor.status({ cwd: args.cwd });
      rpcOk({
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: false,
      });
      return;
    }

    rpcErr(-32602, `unknown meta-tool: ${toolName}`);
  } catch (err) {
    rpcOk({
      content: [{ type: "text", text: err.message || String(err) }],
      isError: true,
    });
  }
}

export async function runDaemon(home, dataDir, port = 0) {
  const token = generateToken();
  const supervisor = new Supervisor(home, dataDir, port);
  let shuttingDown = false;

  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (!isAuthorized(auth, token)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }

    const url = req.url || "/";
    try {
      if (req.method === "GET" && url === "/health") {
        sendJson(res, 200, { ok: true, version: BROKER_VERSION, pid: process.pid });
        return;
      }
      if (req.method === "POST" && url === "/admin/shutdown") {
        sendJson(res, 200, { ok: true, shuttingDown: true });
        setTimeout(() => void shutdown(), 20);
        return;
      }
      if (req.method === "POST" && url === "/mcp") {
        const body = await readBodyJson(req);
        await handleMcpRpc(supervisor, body, res);
        return;
      }
      if (req.method === "POST" && url === "/v1/list") {
        sendJson(res, 200, await supervisor.list(await readBodyJson(req)));
        return;
      }
      if (req.method === "POST" && url === "/v1/describe") {
        sendJson(res, 200, await supervisor.describe(await readBodyJson(req)));
        return;
      }
      if (req.method === "POST" && url === "/v1/call") {
        sendJson(res, 200, await supervisor.call(await readBodyJson(req)));
        return;
      }
      if (req.method === "POST" && url === "/v1/status") {
        sendJson(res, 200, await supervisor.status(await readBodyJson(req)));
        return;
      }
      if (req.method === "POST" && url === "/v1/restart") {
        sendJson(res, 200, await supervisor.restart(await readBodyJson(req)));
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, mapErrorStatus(err), { error: err.message || String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const actualPort = server.address().port;
  supervisor.port = actualPort;

  writeDaemonInfoAtomic(dataDir, {
    pid: process.pid,
    port: actualPort,
    token,
    version: BROKER_VERSION,
    startedAt: String(Math.floor(Date.now() / 1000)),
  });

  const sweepTimer = setInterval(() => {
    void supervisor.maintenanceSweep();
  }, 60_000);
  sweepTimer.unref();

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweepTimer);
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await new Promise((r) => server.close(r));
    await supervisor.shutdown();
    removeDaemonInfoIfOwner(dataDir, process.pid);
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
