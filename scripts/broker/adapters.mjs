import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { BROKER_VERSION, safeUrl } from "./config.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const STDERR_RING_LIMIT = 200;
const DEFAULT_WIN_EXTS = [".exe", ".com", ".cmd", ".bat"];

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getWindowsPathExts(env) {
  const raw = env?.PATHEXT || env?.PathExt || "";
  const parsed = raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith(".") && ext.length > 1);
  if (parsed.length === 0) return DEFAULT_WIN_EXTS;
  const seen = new Set(parsed);
  for (const fallback of DEFAULT_WIN_EXTS) {
    if (!seen.has(fallback)) parsed.push(fallback);
  }
  return parsed;
}

export function resolveWindowsExecutable(command, env = process.env) {
  if (!command || typeof command !== "string") return command;
  const exts = getWindowsPathExts(env);
  const hasSep = command.includes("\\") || command.includes("/");
  const hasExt = path.extname(command).length > 0;

  if (hasSep) {
    if (hasExt && isFile(command)) return command;
    for (const ext of exts) {
      const candidate = `${command}${ext}`;
      if (isFile(candidate)) return candidate;
    }
    if (isFile(command)) return command;
    return command;
  }

  const pathVar = env?.PATH || env?.Path || "";
  const dirs = pathVar
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);

  for (const dir of dirs) {
    if (hasExt) {
      const direct = path.join(dir, command);
      if (isFile(direct)) return direct;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }

  return command;
}

function quoteWindowsCmdArg(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  if (!/[\s&|<>^()%!]/.test(s)) return s;
  return `"${s}"`;
}

export function unwrapNodeCmdShim(cmdPath) {
  if (!cmdPath || !isFile(cmdPath)) return null;
  let content;
  try {
    const stat = fs.statSync(cmdPath);
    if (stat.size > 65_536) return null;
    content = fs.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const cmdDir = path.dirname(cmdPath);
  const patterns = [
    /"%_prog%"\s+"(?:%dp0%|%~dp0)[\\/]?([^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*/i,
    /(?:^|\r?\n)\s*@?(?:"[^"\r\n]*[\\/]node(?:\.exe)?"|node(?:\.exe)?)\s+(?:"([^"\r\n]+\.(?:js|mjs|cjs))"|([^\s"\r\n]+\.(?:js|mjs|cjs)))\s+%\*/i,
  ];
  for (const re of patterns) {
    const match = content.match(re);
    if (!match) continue;
    let target = (match[1] || match[2] || "").trim();
    if (!target) continue;
    target = target.replace(/^(?:%dp0%|%~dp0)[\\/]?/i, "");
    const resolved = path.isAbsolute(target) ? target : path.resolve(cmdDir, target);
    if (isFile(resolved)) return resolved;
  }
  return null;
}

export function resolvePlatformCommand(command, args = [], env = process.env) {
  const safeArgs = Array.isArray(args) ? args.map(String) : [];
  if (process.platform !== "win32") {
    return { command, args: safeArgs, options: {} };
  }

  const resolved = resolveWindowsExecutable(command, env);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const unwrapped = unwrapNodeCmdShim(resolved);
    if (unwrapped) {
      return {
        command: process.execPath,
        args: [unwrapped, ...safeArgs],
        options: { shell: false },
      };
    }
    if (/[\r\n\0]/.test(resolved) || resolved.includes('"')) {
      throw new BrokerError("protocol", "unsafe character in Windows batch command");
    }
    for (const arg of safeArgs) {
      if (/[\r\n\0]/.test(arg)) {
        throw new BrokerError("protocol", "control characters are not allowed in Windows batch arguments");
      }
      if (arg.includes('"')) {
        throw new BrokerError("protocol", "double quotes are not allowed in Windows batch arguments");
      }
    }
    const comspec = env?.ComSpec || env?.COMSPEC || "cmd.exe";
    const cmdLine = `"${[quoteWindowsCmdArg(resolved), ...safeArgs.map(quoteWindowsCmdArg)].join(" ")}"`;
    return {
      command: comspec,
      args: ["/d", "/s", "/c", cmdLine],
      options: { shell: false, windowsVerbatimArguments: true },
    };
  }

  return {
    command: resolved,
    args: safeArgs,
    options: { shell: false },
  };
}

export class BrokerError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }

  isRetryable() {
    return this.kind === "transport" || this.kind === "timeout";
  }

  isFailoverEligible() {
    return (
      this.kind === "config" ||
      this.kind === "transport" ||
      this.kind === "startup" ||
      this.kind === "timeout"
    );
  }
}

const KILL_GRACE_MS = 1500;
const KILL_TIMEOUT_MS = 4000;

function signalTree(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {}
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function killProcessTree(pid) {
  if (!pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: KILL_TIMEOUT_MS,
        });
        killer.on("error", () => resolve());
        killer.on("exit", () => resolve());
      } catch {
        resolve();
      }
    });
  }
  if (!signalTree(pid, "SIGTERM")) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = Date.now() + KILL_GRACE_MS;
    const poll = setInterval(() => {
      if (!signalTree(pid, 0)) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(poll);
        signalTree(pid, "SIGKILL");
        resolve();
      }
    }, 50);
    poll.unref();
  });
}

const MIN_SECRET_LENGTH = 4;

function secretCandidates(config) {
  const found = [];
  const add = (v) => {
    if (typeof v === "string" && v.length >= MIN_SECRET_LENGTH) found.push(v);
  };
  for (const v of config?.secretValues || []) add(v);
  for (const v of Object.values(config?.headers || {})) {
    add(v);
    const m = /^\s*\S+\s+(\S.*)$/.exec(String(v));
    if (m) add(m[1].trim());
  }
  if (typeof config?.url === "string") {
    try {
      const u = new URL(config.url);
      add(u.username);
      add(u.password);
      for (const [, v] of u.searchParams) add(v);
      for (const pair of u.search.replace(/^\?/, "").split("&")) {
        const eq = pair.indexOf("=");
        if (eq >= 0) add(pair.slice(eq + 1));
      }
    } catch {}
  }
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text, config) {
  let out = String(text ?? "");
  for (const secret of secretCandidates(config)) out = out.split(secret).join("***");
  return out;
}

export class McpStdioAdapter {
  constructor({ command, args, env, cwd, startupTimeoutMs, requestTimeoutMs, redact }) {
    this.redactConfig = redact || null;
    this.command = command;
    this.args = args || [];
    this.env = env || {};
    this.cwd = cwd || undefined;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.alive = false;
    this.stderrRing = [];
  }

  _err(kind, message) {
    return new BrokerError(kind, redactSecrets(message, this.redactConfig));
  }

  static async start(opts) {
    const adapter = new McpStdioAdapter(opts);
    await adapter._connect();
    return adapter;
  }

  async _connect() {
    const mergedEnv = { ...process.env, ...this.env };
    const resolved = resolvePlatformCommand(this.command, this.args, mergedEnv);
    try {
      this.proc = spawn(resolved.command, resolved.args, {
        cwd: this.cwd,
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        ...resolved.options,
      });
    } catch (err) {
      throw this._err("startup", `failed spawning \`${this.command}\`: ${err.message}`);
    }

    this.alive = true;

    this.proc.on("error", (err) => {
      this._failAll(this._err("startup", `spawn error for \`${this.command}\`: ${err.message}`));
    });

    this.proc.stdin?.on("error", (err) => {
      this._failAll(this._err("transport", `stdin error: ${err.message}`));
    });

    this.proc.on("exit", (code, signal) => {
      const tail = this.stderrRing.slice(-5).join(" | ");
      const msg = tail
        ? `stdio child exited (code=${code}, signal=${signal}); stderr: ${tail}`
        : `stdio child exited (code=${code}, signal=${signal})`;
      this._failAll(this._err("transport", msg));
    });

    if (this.proc.stderr) {
      const errRl = readline.createInterface({ input: this.proc.stderr });
      errRl.on("line", (line) => {
        this.stderrRing.push(line);
        if (this.stderrRing.length > STDERR_RING_LIMIT) this.stderrRing.shift();
      });
    }

    if (this.proc.stdout) {
      const outRl = readline.createInterface({ input: this.proc.stdout });
      outRl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if (typeof msg.method === "string") {
          if (msg.id !== undefined && msg.id !== null) {
            this._write(
              msg.method === "ping"
                ? { jsonrpc: "2.0", id: msg.id, result: {} }
                : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }
            );
          }
          return;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(
              this._err("tool_execution", msg.error.message || "MCP JSON-RPC error")
            );
          } else {
            entry.resolve(msg.result ?? null);
          }
        }
      });
      outRl.on("close", () => {
        this._failAll(this._err("transport", "stdio child stdout closed (EOF)"));
      });
    }

    try {
      await this._request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "ignis-broker", version: BROKER_VERSION },
        },
        this.startupTimeoutMs
      );
      this._notify("notifications/initialized", {});
    } catch (err) {
      await this.shutdown();
      throw this._err("startup", `MCP initialize failed: ${err.message}`);
    }
  }

  _failAll(err) {
    this.alive = false;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  _write(message, callback) {
    const stdin = this.proc?.stdin;
    if (!stdin || !this.alive || stdin.destroyed || !stdin.writable) {
      callback?.(new Error("stdin is not writable"));
      return;
    }
    try {
      stdin.write(`${JSON.stringify(message)}\n`, callback);
    } catch (err) {
      callback?.(err);
    }
  }

  _notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  _request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.alive || !this.proc?.stdin) {
        reject(this._err("transport", "stdio child is not alive"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          if (method !== "initialize") {
            this._notify("notifications/cancelled", { requestId: id, reason: "timeout" });
          }
          reject(this._err("timeout", `timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: "2.0", id, method, params }, (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer);
          this.alive = false;
          reject(this._err("transport", `stdin write error: ${err.message}`));
        }
      });
    });
  }

  async listTools() {
    const res = await this._request("tools/list", {}, this.requestTimeoutMs);
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools
      .filter((t) => t && typeof t.name === "string")
      .map((t) => ({
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
  }

  async callTool(tool, args) {
    const res = await this._request(
      "tools/call",
      { name: tool, arguments: args && typeof args === "object" ? args : {} },
      this.requestTimeoutMs
    );
    return {
      content: Array.isArray(res?.content) ? res.content : [],
      isError: Boolean(res?.isError),
    };
  }

  async isAlive() {
    return Boolean(this.alive && this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  async shutdown() {
    this.alive = false;
    const pid = this.proc?.pid;
    try {
      this.proc?.stdin?.end();
    } catch {}
    this.proc = null;
    if (pid) await killProcessTree(pid);
  }

  lastStderr() {
    return this.stderrRing.length > 0
      ? redactSecrets(this.stderrRing.join("\n"), this.redactConfig)
      : null;
  }
}

function parseSseJsonRpc(body, expectedId) {
  let dataLines = [];
  let sawAnyJson = false;

  const flushEvent = () => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return null;
    try {
      const val = JSON.parse(payload);
      if (val && typeof val === "object") {
        sawAnyJson = true;
        if (val.id === expectedId) return val;
        if (val.error && (val.id === null || val.id === undefined)) return val;
      }
    } catch {}
    return null;
  };

  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") {
      const matched = flushEvent();
      if (matched) return matched;
      continue;
    }
    if (line.startsWith("data:")) {
      let chunk = line.slice(5);
      if (chunk.startsWith(" ")) chunk = chunk.slice(1);
      dataLines.push(chunk);
    }
  }

  const trailing = flushEvent();
  if (trailing) return trailing;

  throw new BrokerError(
    "protocol",
    sawAnyJson ? "SSE stream missing matching JSON-RPC response" : "empty SSE response stream"
  );
}

export class McpHttpAdapter {
  constructor({ url, headers, startupTimeoutMs, requestTimeoutMs, redact }) {
    this.redactConfig = redact || { url, headers };
    this.url = url;
    this.headers = headers || {};
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessionId = null;
    this.nextId = 1;
    this.alive = true;
  }

  _err(kind, message) {
    return new BrokerError(kind, redactSecrets(message, this.redactConfig));
  }

  static async connect(opts) {
    const adapter = new McpHttpAdapter(opts);
    try {
      await adapter._request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "ignis-broker", version: BROKER_VERSION },
        },
        adapter.startupTimeoutMs
      );
      await adapter._notify("notifications/initialized", {}, adapter.startupTimeoutMs);
    } catch (err) {
      adapter.alive = false;
      throw adapter._err("startup", `HTTP MCP initialize failed: ${err.message}`);
    }
    return adapter;
  }

  async _notify(method, params, timeoutMs) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
    try {
      await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {}
  }

  async _request(method, params, timeoutMs) {
    const id = this.nextId++;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };

    let resp;
    try {
      resp = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        if (method !== "initialize") {
          void this._notify("notifications/cancelled", { requestId: id, reason: "timeout" }, 5000);
        }
        throw this._err("timeout", `timeout after ${timeoutMs}ms`);
      }
      this.alive = false;
      throw this._err("transport", `HTTP request failed: ${err.message}`);
    }

    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (resp.status === 404 || resp.status >= 500) {
      this.alive = false;
      const body = await resp.text().catch(() => "");
      throw this._err("transport", `HTTP ${resp.status} from ${safeUrl(this.url)}: ${body.slice(0, 240)}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw this._err("protocol", `HTTP ${resp.status} from ${safeUrl(this.url)}: ${body.slice(0, 240)}`);
    }

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    const text = await resp.text();
    const msg = ct.includes("text/event-stream") ? parseSseJsonRpc(text, id) : JSON.parse(text);

    if (msg.error) {
      throw this._err("tool_execution", msg.error.message || "MCP HTTP JSON-RPC error");
    }
    return msg.result ?? null;
  }

  async listTools() {
    const res = await this._request("tools/list", {}, this.requestTimeoutMs);
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools
      .filter((t) => t && typeof t.name === "string")
      .map((t) => ({
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
  }

  async callTool(tool, args) {
    const res = await this._request(
      "tools/call",
      { name: tool, arguments: args && typeof args === "object" ? args : {} },
      this.requestTimeoutMs
    );
    return {
      content: Array.isArray(res?.content) ? res.content : [],
      isError: Boolean(res?.isError),
    };
  }

  async isAlive() {
    return this.alive;
  }

  async shutdown() {
    this.alive = false;
  }

  lastStderr() {
    return null;
  }
}

const MEMTRACE_COMMANDS = [
  { sub: "find", tools: ["find_symbol", "find_code", "find"], keys: ["query", "symbol", "name", "pattern"] },
  { sub: "callers", tools: ["callers", "get_callers"], keys: ["symbol", "name", "target", "query"] },
  { sub: "callees", tools: ["callees", "get_callees"], keys: ["symbol", "name", "target", "query"] },
  { sub: "impact", tools: ["get_impact", "impact"], keys: ["target", "symbol", "name", "query"] },
];

function buildMemtraceArgs(tool, args) {
  const safeArgs = args && typeof args === "object" ? args : {};
  const entry = MEMTRACE_COMMANDS.find((c) => c.tools.includes(tool));
  if (!entry) return null;

  let value;
  for (const key of entry.keys) {
    if (safeArgs[key] != null) {
      value = safeArgs[key];
      break;
    }
  }
  if (typeof value !== "string" || !value.trim()) return null;

  const cliArgs = [entry.sub];
  if (typeof safeArgs.limit === "number" && Number.isFinite(safeArgs.limit)) {
    cliArgs.push("--limit", String(safeArgs.limit));
  }
  cliArgs.push("--", value);
  return cliArgs;
}

export async function tryCliFallback(kind, tool, args, cwd, timeoutMs = 30_000) {
  if (kind !== "memtrace") return null;

  const cliArgs = buildMemtraceArgs(tool, args);
  if (!cliArgs) return null;

  const cmd = (process.env.IGNIS_MEMTRACE_CMD || "").trim() || "memtrace";
  const resolved = resolvePlatformCommand(cmd, cliArgs, process.env);

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(resolved.command, resolved.args, {
        cwd: cwd || undefined,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        ...resolved.options,
      });
    } catch (err) {
      reject(new BrokerError("transport", `CLI fallback spawn failed for \`${cmd}\`: ${err.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(val);
    };

    const timer =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            void killProcessTree(proc.pid);
            finish(reject, new BrokerError("timeout", `CLI fallback timeout after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

    if (proc.stdout) {
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    proc.on("error", (err) => {
      finish(reject, new BrokerError("transport", `CLI fallback error for \`${cmd}\`: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        finish(resolve, {
          content: [{ type: "text", text: stdout }],
          isError: false,
        });
      } else if (code === 1 && !stderr.trim()) {
        finish(resolve, {
          content: [{ type: "text", text: stdout || "No results found." }],
          isError: false,
        });
      } else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        finish(
          reject,
          new BrokerError("transport", `CLI fallback \`${cmd}\` exited with code ${code}${detail}`)
        );
      }
    });
  });
}
