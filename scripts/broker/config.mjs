import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BROKER_VERSION = "1.0.0";

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

export function expandEnvVars(input, dotenv) {
  if (typeof input !== "string") return "";
  return input.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (dotenv && dotenv.has(name)) return dotenv.get(name);
    if (process.env[name] !== undefined) return process.env[name];
    return "";
  });
}

function expandRecord(rec, dotenv) {
  const out = {};
  if (!rec || typeof rec !== "object") return out;
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? expandEnvVars(v, dotenv) : String(v);
  }
  return out;
}

function normalizeServerConfig(raw, dotenv) {
  const transport = raw.transport || (raw.command ? "stdio" : raw.url ? "http" : "stdio");
  return {
    transport,
    command: raw.command ?? null,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: expandRecord(raw.env, dotenv),
    url: typeof raw.url === "string" ? expandEnvVars(raw.url, dotenv) : null,
    headers: expandRecord(raw.headers, dotenv),
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    perWorkspace: Boolean(raw.perWorkspace),
    enabled: raw.enabled !== false,
    cliFallback: typeof raw.cliFallback === "string" ? raw.cliFallback : null,
    requestTimeoutMs: typeof raw.requestTimeoutMs === "number" ? raw.requestTimeoutMs : null,
    startupTimeoutMs: typeof raw.startupTimeoutMs === "number" ? raw.startupTimeoutMs : null,
  };
}

export function discoverLocalConfig(cwd) {
  if (!cwd) return null;
  const home = path.resolve(os.homedir());
  let current = path.resolve(cwd);
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    return null;
  }

  while (true) {
    const isHome =
      process.platform === "win32"
        ? current.toLowerCase() === home.toLowerCase()
        : current === home;
    if (isHome) return null;
    const candidate = path.join(current, ".agents", "ignis-broker.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    if (fs.existsSync(path.join(current, ".git"))) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
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
        return fs.realpathSync(current);
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      try {
        return fs.realpathSync(start);
      } catch {
        return start;
      }
    }
    current = parent;
  }
}

export function resolveConfig(home, cwd) {
  const globalPath = path.join(home, "servers.json");
  const dotenv = loadDotenv(home);

  let globalFile = { version: 1, defaults: {}, servers: {} };
  if (fs.existsSync(globalPath)) {
    try {
      const raw = fs.readFileSync(globalPath, "utf8");
      const parsed = JSON.parse(raw);
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

  if (cwd) {
    const found = discoverLocalConfig(cwd);
    if (found) {
      localPath = found;
      try {
        const raw = fs.readFileSync(found, "utf8");
        const parsed = JSON.parse(raw);
        localFile = {
          version: parsed.version ?? 1,
          defaults: parsed.defaults ?? {},
          servers: parsed.servers ?? {},
        };
      } catch (err) {
        localConfigError = `invalid local config ${found}: ${err.message}`;
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
          config: normalizeServerConfig(rawLocal, dotenv),
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
  };
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
    env: redactMap(cfg.env),
    headers: redactMap(cfg.headers),
  };
}

export function importMcpConfig(fromPath, onlyServers = null) {
  const raw = fs.readFileSync(fromPath, "utf8");
  const json = JSON.parse(raw);
  if (!json.mcpServers || typeof json.mcpServers !== "object") {
    throw new Error(`missing mcpServers object in ${fromPath}`);
  }

  const filter = onlyServers ? new Set(onlyServers) : null;
  const servers = {};

  for (const [name, entry] of Object.entries(json.mcpServers)) {
    if (filter && !filter.has(name)) continue;
    if (name === "ignis-broker" || name === "broker" || name === "ignis-swarm_broker") continue;
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

  return {
    version: 1,
    defaults: { ...DEFAULT_CONFIG },
    servers,
  };
}

const BROKER_SELF_NAMES = new Set(["ignis-broker", "broker", "ignis-swarm_broker"]);
const PER_WORKSPACE_HINT_RE = /context|serena|lsp|git|fs|filesystem|workspace|repo|sqlite/i;

function readServersFile(home) {
  const dest = path.join(home, "servers.json");
  if (!fs.existsSync(dest)) {
    return { dest, data: { version: 1, defaults: { ...DEFAULT_CONFIG }, servers: {} } };
  }
  const parsed = JSON.parse(fs.readFileSync(dest, "utf8"));
  return {
    dest,
    data: {
      version: parsed.version ?? 1,
      defaults: parsed.defaults ?? { ...DEFAULT_CONFIG },
      servers: parsed.servers && typeof parsed.servers === "object" ? { ...parsed.servers } : {},
    },
  };
}

export function discoverMcpConfig(fromPath, home) {
  if (!fromPath || !fs.existsSync(fromPath)) return [];
  let json;
  try {
    json = JSON.parse(fs.readFileSync(fromPath, "utf8"));
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

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  return { dest, ...data };
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
  fs.writeFileSync(dest, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  return true;
}
