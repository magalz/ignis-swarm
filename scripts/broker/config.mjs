import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonSafely, readTrustedLocalConfig } from "./trust.mjs";

export const BROKER_VERSION = "1.1.0";

export const DEFAULT_CONFIG = Object.freeze({
  requestTimeoutMs: 120_000,
  startupTimeoutMs: 30_000,
  idleTimeoutSecs: 900,
  maxWorkspaceInstances: 4,
  maxOutputBytes: 16_384,
  maxOutputLines: 200,
  spillTtlHours: 24,
  retryOnTransportError: true,
});

export function brokerHome() {
  const custom = (process.env.IGNIS_BROKER_HOME || "").trim();
  if (custom) return custom;
  return path.join(os.homedir(), ".ignis-broker");
}

export function brokerDataDir(home = brokerHome()) {
  const custom = (process.env.IGNIS_BROKER_DATA || "").trim();
  if (custom) return custom;
  return home;
}

export function loadDotenv(home) {
  const map = new Map();
  const envPath = path.join(home, ".env");
  if (!fs.existsSync(envPath)) return map;
  let raw = "";
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key) map.set(key, val);
  }
  return map;
}

export function expandEnvVars(input, dotenv, record = null) {
  if (typeof input !== "string") return "";
  return input.replace(/\$\{([^}]+)\}/g, (_, name) => {
    let value = "";
    if (dotenv && dotenv.has(name)) value = dotenv.get(name);
    else if (process.env[name] !== undefined) value = process.env[name];
    if (record && value) record.push(value);
    return value;
  });
}

function expandRecord(rec, dotenv, expand = true, record = null) {
  const out = {};
  if (!rec || typeof rec !== "object") return out;
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" && expand ? expandEnvVars(v, dotenv, record) : String(v);
  }
  return out;
}

function normalizeServerConfig(raw, dotenv, expand = true) {
  const transport = raw.transport || (raw.command ? "stdio" : raw.url ? "http" : "stdio");
  const secretValues = [];
  const cfg = {
    transport,
    command: raw.command ?? null,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: expandRecord(raw.env, dotenv, expand, secretValues),
    url:
      typeof raw.url === "string"
        ? expand
          ? expandEnvVars(raw.url, dotenv, secretValues)
          : raw.url
        : null,
    headers: expandRecord(raw.headers, dotenv, expand, secretValues),
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    perWorkspace: Boolean(raw.perWorkspace),
    enabled: raw.enabled !== false,
    cliFallback: typeof raw.cliFallback === "string" ? raw.cliFallback : null,
    requestTimeoutMs: typeof raw.requestTimeoutMs === "number" ? raw.requestTimeoutMs : null,
    startupTimeoutMs: typeof raw.startupTimeoutMs === "number" ? raw.startupTimeoutMs : null,
  };
  Object.defineProperty(cfg, "secretValues", { value: secretValues, enumerable: false });
  return cfg;
}

function sameDir(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function discoverLocalConfig(cwd) {
  if (!cwd) return null;
  const home = path.resolve(os.homedir());
  let start = path.resolve(cwd);
  try {
    if (fs.existsSync(start) && fs.statSync(start).isFile()) {
      start = path.dirname(start);
    }
  } catch {
    return null;
  }

  let root = null;
  for (let current = start; ; ) {
    if (sameDir(current, home)) return null;
    if (fs.existsSync(path.join(current, ".git"))) {
      root = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }

  for (let current = start; ; ) {
    const candidate = path.join(current, ".agents", "ignis-broker.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    if (current === root) return null;
    current = path.dirname(current);
  }
}

export function resolveRepoRoot(cwd) {
  if (!cwd) return "default";
  let current = path.resolve(cwd);
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    return current;
  }
  const start = current;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      try {
        return fs.realpathSync.native(current);
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      try {
        return fs.realpathSync.native(start);
      } catch {
        return start;
      }
    }
    current = parent;
  }
}

export function resolveConfig(home, cwd, dataDir = brokerDataDir(home)) {
  const globalPath = path.join(home, "servers.json");
  const dotenv = loadDotenv(home);

  let globalFile = { version: 1, defaults: {}, servers: {} };
  if (fs.existsSync(globalPath)) {
    try {
      const parsed = parseJsonSafely(fs.readFileSync(globalPath, "utf8"));
      globalFile = {
        version: parsed.version ?? 1,
        defaults: parsed.defaults ?? {},
        servers: parsed.servers ?? {},
      };
    } catch (err) {
      const cfgErr = new Error(`invalid global config ${globalPath}: ${err.message}`);
      cfgErr.kind = "config";
      throw cfgErr;
    }
  }

  let localPath = null;
  let localConfigError = null;
  let localFile = null;
  let localTrusted = false;

  if (cwd) {
    const found = discoverLocalConfig(cwd);
    if (found) {
      localPath = found;
      const read = readTrustedLocalConfig(dataDir, found);
      if (read.error) {
        localConfigError = `invalid local config ${found}: ${read.error.message}`;
      } else if (read.status !== "trusted") {
        const dir = path.dirname(path.dirname(found));
        const why = read.status === "changed" ? "changed since it was trusted" : "not trusted yet";
        localConfigError = `untrusted local config ${found}: ${why}; review it, then run: ignis-broker trust --cwd "${dir}"`;
      } else {
        localTrusted = true;
        localFile = {
          version: read.parsed.version ?? 1,
          defaults: read.parsed.defaults ?? {},
          servers: read.parsed.servers ?? {},
        };
      }
    }
  }

  const defaults = {
    ...DEFAULT_CONFIG,
    ...(globalFile.defaults || {}),
    ...(localFile?.defaults || {}),
  };

  const allNames = new Set([
    ...Object.keys(globalFile.servers || {}),
    ...Object.keys(localFile?.servers || {}),
  ]);

  const candidates = new Map();
  for (const name of [...allNames].sort()) {
    const chain = [];
    let locallyDisabled = false;

    if (localFile?.servers && Object.hasOwn(localFile.servers, name)) {
      const rawLocal = localFile.servers[name];
      if (rawLocal && rawLocal.enabled === false) {
        locallyDisabled = true;
      } else if (rawLocal) {
        chain.push({
          name,
          source: "local",
          config: normalizeServerConfig(rawLocal, null, false),
        });
      }
    }

    if (!locallyDisabled && globalFile.servers && Object.hasOwn(globalFile.servers, name)) {
      const rawGlobal = globalFile.servers[name];
      if (rawGlobal && rawGlobal.enabled !== false) {
        chain.push({
          name,
          source: "global",
          config: normalizeServerConfig(rawGlobal, dotenv),
        });
      }
    }

    if (chain.length > 0) {
      candidates.set(name, chain);
    }
  }

  return {
    defaults,
    candidates,
    localPath,
    globalPath,
    localConfigError,
    localTrusted,
  };
}

export function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

export function redactServerConfig(cfg) {
  const redactMap = (obj) => {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      out[k] = "***REDACTED***";
    }
    return out;
  };
  return {
    ...cfg,
    url: cfg.url ? safeUrl(cfg.url) : cfg.url,
    env: redactMap(cfg.env),
    headers: redactMap(cfg.headers),
  };
}

const BROKER_SELF_NAMES = new Set(["ignis-broker", "broker", "ignis-swarm_broker"]);

export function importMcpConfig(fromPath, onlyServers = null) {
  let json;
  try {
    json = parseJsonSafely(fs.readFileSync(fromPath, "utf8"));
  } catch (err) {
    throw new Error(`invalid MCP config ${fromPath}: ${err.message}`);
  }
  if (!json.mcpServers || typeof json.mcpServers !== "object") {
    throw new Error(`missing mcpServers object in ${fromPath}`);
  }

  const filter = onlyServers ? new Set(onlyServers) : null;
  const servers = {};

  for (const [name, entry] of Object.entries(json.mcpServers)) {
    if (filter && !filter.has(name)) continue;
    if (BROKER_SELF_NAMES.has(name)) continue;
    if (!entry || typeof entry !== "object") continue;

    const command = typeof entry.command === "string" ? entry.command : null;
    const url = typeof entry.serverUrl === "string"
      ? entry.serverUrl
      : typeof entry.url === "string"
        ? entry.url
        : null;

    if (!command && !url) continue;

    const transport = command ? "stdio" : "http";
    const srv = {
      transport,
      ...(command ? { command } : {}),
      ...(Array.isArray(entry.args) && entry.args.length > 0 ? { args: entry.args.map(String) } : {}),
      ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
      ...(url ? { url } : {}),
      ...(entry.headers && Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {}),
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      perWorkspace: false,
      enabled: entry.disabled !== true,
      ...(typeof entry.timeoutSeconds === "number" && entry.timeoutSeconds > 0
        ? { requestTimeoutMs: entry.timeoutSeconds * 1000 }
        : {}),
    };
    servers[name] = srv;
  }

  return { version: 1, servers };
}

const PER_WORKSPACE_HINT_RE = /context|serena|lsp|git|fs|filesystem|workspace|repo|sqlite/i;

function readServersFile(home) {
  const dest = path.join(home, "servers.json");
  if (!fs.existsSync(dest)) {
    return { dest, data: { version: 1, defaults: {}, servers: {} } };
  }
  let parsed;
  try {
    parsed = parseJsonSafely(fs.readFileSync(dest, "utf8"));
  } catch (err) {
    throw new Error(`invalid global config ${dest}: ${err.message}`);
  }
  return {
    dest,
    data: {
      version: parsed.version ?? 1,
      defaults: parsed.defaults ?? {},
      servers: parsed.servers && typeof parsed.servers === "object" ? { ...parsed.servers } : {},
    },
  };
}

function writeServersFile(home, dest, data) {
  const { defaults, ...rest } = data;
  const out = defaults && Object.keys(defaults).length > 0 ? { ...rest, defaults } : rest;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function discoverMcpConfig(fromPath, home) {
  if (!fromPath || !fs.existsSync(fromPath)) return [];
  let json;
  try {
    json = parseJsonSafely(fs.readFileSync(fromPath, "utf8"));
  } catch {
    return [];
  }
  if (!json.mcpServers || typeof json.mcpServers !== "object") return [];

  let managed = {};
  if (home) {
    try {
      managed = readServersFile(home).data.servers;
    } catch {
      managed = {};
    }
  }

  const results = [];
  for (const [name, entry] of Object.entries(json.mcpServers)) {
    if (BROKER_SELF_NAMES.has(name)) continue;
    if (!entry || typeof entry !== "object") continue;

    const hasCommand = typeof entry.command === "string" && entry.command.length > 0;
    const hasUrl =
      (typeof entry.serverUrl === "string" && entry.serverUrl.length > 0) ||
      (typeof entry.url === "string" && entry.url.length > 0);
    if (!hasCommand && !hasUrl) continue;

    results.push({
      name,
      transport: hasCommand ? "stdio" : "http",
      alreadyManaged: Object.hasOwn(managed, name),
      disabled: entry.disabled === true,
      suggestedPerWorkspace:
        typeof entry.cwd === "string" || PER_WORKSPACE_HINT_RE.test(name),
    });
  }

  return results;
}

export function mergeServersConfig(home, incomingServers, opts = {}) {
  const perWorkspaceSet =
    opts.perWorkspaceSet instanceof Set
      ? opts.perWorkspaceSet
      : new Set(Array.isArray(opts.perWorkspaceSet) ? opts.perWorkspaceSet : []);
  const cliFallbackMap =
    opts.cliFallbackMap instanceof Map
      ? opts.cliFallbackMap
      : new Map(
          opts.cliFallbackMap && typeof opts.cliFallbackMap === "object"
            ? Object.entries(opts.cliFallbackMap)
            : []
        );

  const { dest, data } = readServersFile(home);
  const source = incomingServers?.servers && typeof incomingServers.servers === "object"
    ? incomingServers.servers
    : incomingServers || {};

  for (const [name, cfg] of Object.entries(source)) {
    if (BROKER_SELF_NAMES.has(name)) continue;
    if (!cfg || typeof cfg !== "object") continue;
    const mergedEntry = { ...cfg };
    if (perWorkspaceSet.has(name)) {
      mergedEntry.perWorkspace = true;
    }
    if (cliFallbackMap.has(name)) {
      mergedEntry.cliFallback = cliFallbackMap.get(name);
    }
    data.servers[name] = mergedEntry;
  }

  writeServersFile(home, dest, data);
  return { dest, ...data };
}

const ENV_REF_RE = /\$\{[^}]+\}/;

function secretVarName(server, key) {
  return `IGNIS_${server}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function externalizeSecrets(servers) {
  const secrets = new Map();
  const owners = new Map();
  const out = {};
  for (const [name, cfg] of Object.entries(servers || {})) {
    const next = { ...cfg };
    for (const field of ["env", "headers"]) {
      const rec = cfg?.[field];
      if (!rec || typeof rec !== "object") continue;
      next[field] = {};
      for (const [key, raw] of Object.entries(rec)) {
        if (raw === null || raw === undefined) continue;
        const value = String(raw);
        if (ENV_REF_RE.test(value)) {
          next[field][key] = raw;
          continue;
        }
        if (/[\r\n]/.test(value)) {
          throw new Error(`${field} value ${key} of server ${name} contains a line break and cannot be stored in .env`);
        }
        const varName = secretVarName(name, key);
        if (secrets.has(varName) && secrets.get(varName) !== value) {
          throw new Error(`two different values map to ${varName} (server ${name}, ${field} ${key}); rename one key or server`);
        }
        secrets.set(varName, value);
        owners.set(varName, { server: name, field, key });
        next[field][key] = "${" + varName + "}";
      }
    }
    out[name] = next;
  }
  return { servers: out, secrets, owners };
}

export function prepareSecrets(home, servers) {
  const { data } = readServersFile(home);
  const ext = externalizeSecrets(servers);
  for (const [varName, owner] of ext.owners) {
    const ref = "${" + varName + "}";
    for (const [other, cfg] of Object.entries(data.servers)) {
      if (other === owner.server || !cfg || typeof cfg !== "object") continue;
      const strings = [cfg.url, ...Object.values(cfg.env || {}), ...Object.values(cfg.headers || {})];
      if (strings.some((v) => typeof v === "string" && v.includes(ref))) {
        throw new Error(
          `cannot store ${owner.field} ${owner.key} of server ${owner.server} as ${varName}: server ${other} already uses it; rename one server or key`
        );
      }
    }
  }
  return ext;
}

export function writeDotenvSecrets(home, secrets) {
  if (secrets.size === 0) return [];
  const envPath = path.join(home, ".env");
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(secrets);
  const rendered = (key, value) => `${key}="${value}"`;
  const updated = lines.map((line) => {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, eq).trim();
    if (!secrets.has(key)) return line;
    pending.delete(key);
    return rendered(key, secrets.get(key));
  });
  for (const [key, value] of pending) updated.push(rendered(key, value));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = path.join(home, `.env.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, updated.join(eol) + eol, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, envPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return [...secrets.keys()];
}

export function addHttpServer(home, { name, url, authEnv, headerName }) {
  if (!name || typeof name !== "string") throw new Error("server name is required");
  if (!url || typeof url !== "string") throw new Error("server url is required");

  const entry = {
    transport: "http",
    url,
    perWorkspace: false,
    enabled: true,
  };

  if (typeof authEnv === "string" && authEnv.trim()) {
    const envVar = authEnv.trim();
    const hdr = typeof headerName === "string" && headerName.trim() ? headerName.trim() : "Authorization";
    entry.headers = {
      [hdr]: hdr.toLowerCase() === "authorization" ? `Bearer \${${envVar}}` : `\${${envVar}}`,
    };
  }

  return mergeServersConfig(home, { [name]: entry });
}

export function removeServer(home, name) {
  const dest = path.join(home, "servers.json");
  if (!fs.existsSync(dest)) return false;
  const { data } = readServersFile(home);
  if (!Object.hasOwn(data.servers, name)) return false;
  delete data.servers[name];
  writeServersFile(home, dest, data);
  return true;
}
