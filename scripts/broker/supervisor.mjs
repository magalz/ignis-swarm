import path from "node:path";
import { BrokerError, McpHttpAdapter, McpStdioAdapter, redactSecrets, tryCliFallback } from "./adapters.mjs";
import { BROKER_VERSION, resolveConfig, resolveRepoRoot } from "./config.mjs";
import { cleanupExpiredSpills, truncateContentBlocks } from "./spill.mjs";

const MAX_FALLBACK_EVENTS = 32;
const MAX_SWEEP_ERRORS = 10;

function poolKeyString(candidate, cwd) {
  let scope = "global";
  if (candidate.config.perWorkspace) {
    if (candidate.config.cwd) {
      scope = resolveRepoRoot(candidate.config.cwd);
    } else if (cwd) {
      scope = resolveRepoRoot(cwd);
    } else {
      scope = "default";
    }
  }
  return {
    key: `${candidate.name}::${candidate.source}::${scope}`,
    server: candidate.name,
    source: candidate.source,
    scope,
  };
}

function sanitizeError(err, configs) {
  const bErr = err instanceof BrokerError ? err : new BrokerError("transport", err.message);
  let message = bErr.message;
  for (const cfg of configs) message = redactSecrets(message, cfg);
  if (message === bErr.message) return bErr;
  return new BrokerError(bErr.kind, message);
}

function compactSummary(desc) {
  const single = String(desc || "").replace(/\s+/g, " ").trim();
  const first = (single.split(". ")[0] || single).trim();
  return first.length <= 140 ? first : `${first.slice(0, 137)}...`;
}

function routeMeta({ server, source, idx, primarySource, localError, cwd, retried, truncated, spillPath }) {
  const fallbackFrom =
    idx > 0 ? primarySource : localError && source === "global" ? "local" : null;
  return {
    server,
    source,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    ...(localError ? { localError } : {}),
    ...(cwd ? { cwd } : {}),
    retried,
    truncated,
    ...(spillPath ? { spillPath } : {}),
  };
}

function fallbackEvent(server, from, to, reason, cwd) {
  return {
    ts: String(Math.floor(Date.now() / 1000)),
    server,
    from,
    to,
    reason,
    ...(cwd ? { cwd } : {}),
  };
}

function summarizeServers(candidates, poolSnap) {
  const servers = [];
  for (const [name, chain] of candidates.entries()) {
    const primary = chain[0];
    const activeWorkspaces = poolSnap.filter((p) => p.server === name && p.alive).length;
    servers.push({
      name,
      primarySource: primary.source,
      hasGlobalFallback: chain.length > 1,
      perWorkspace: primary.config.perWorkspace,
      transport: primary.config.transport,
      state: activeWorkspaces > 0 ? "connected" : "idle",
      activeWorkspaces,
    });
  }
  return servers;
}

export class Supervisor {
  constructor(brokerHome, dataDir, port = 0) {
    this.brokerHome = brokerHome;
    this.dataDir = dataDir;
    this.port = port;
    this.startedAt = Date.now();
    this.pool = new Map();
    this.pendingConnects = new Map();
    this.retiredEntries = new Set();
    this.recentFallbacks = [];
    this.sweepErrors = [];
  }

  async _connectCandidate(candidate, defaults, cwd) {
    const cfg = candidate.config;
    const startupTimeoutMs = cfg.startupTimeoutMs ?? defaults.startupTimeoutMs;
    const requestTimeoutMs = cfg.requestTimeoutMs ?? defaults.requestTimeoutMs;

    if (cfg.transport === "stdio") {
      if (!cfg.command) {
        throw new BrokerError("config", `stdio server \`${candidate.name}\` missing command`);
      }
      const effectiveCwd = cfg.cwd
        ? cfg.cwd
        : cfg.perWorkspace && cwd
          ? resolveRepoRoot(cwd)
          : undefined;
      return McpStdioAdapter.start({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        cwd: effectiveCwd,
        startupTimeoutMs,
        requestTimeoutMs,
        redact: cfg,
      });
    }

    if (cfg.transport === "http") {
      if (!cfg.url) {
        throw new BrokerError("config", `http server \`${candidate.name}\` missing url`);
      }
      return McpHttpAdapter.connect({
        url: cfg.url,
        headers: cfg.headers,
        startupTimeoutMs,
        requestTimeoutMs,
        redact: cfg,
      });
    }

    throw new BrokerError("config", `unsupported transport \`${cfg.transport}\``);
  }

  async _evictLruWorkspaceIfNeeded(maxInstances, keyInfo) {
    if (!maxInstances || maxInstances <= 0) return;
    const siblings = [...this.pool.entries()].filter(
      ([, e]) => e.perWorkspace && e.server === keyInfo.server && e.source === keyInfo.source
    );
    const idle = siblings.filter(([, e]) => e.inFlight === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let excess = siblings.length - maxInstances + 1;
    while (excess > 0 && idle.length > 0) {
      const [key, entry] = idle.shift();
      this.pool.delete(key);
      await entry.adapter.shutdown();
      excess -= 1;
    }
  }

  async _callTracked(entry, tool, args) {
    entry.inFlight += 1;
    try {
      return await entry.adapter.callTool(tool, args);
    } finally {
      entry.inFlight -= 1;
      entry.lastUsed = Date.now();
    }
  }

  _recordSweepError(err, configs, entry) {
    const message = sanitizeError(err, configs).message;
    this.sweepErrors.push({
      ts: String(Math.floor(Date.now() / 1000)),
      ...(entry ? { server: entry.server, scope: entry.scope } : {}),
      message,
    });
    if (this.sweepErrors.length > MAX_SWEEP_ERRORS) this.sweepErrors.shift();
  }

  async _getOrConnect(keyInfo, candidate, defaults, cwd) {
    const configDigest = JSON.stringify(candidate.config);
    const existing = this.pool.get(keyInfo.key);
    if (existing) {
      if (existing.configDigest === configDigest && (await existing.adapter.isAlive())) {
        existing.lastUsed = Date.now();
        return existing;
      }
      this.pool.delete(keyInfo.key);
      await existing.adapter.shutdown();
    }

    const inflight = this.pendingConnects.get(keyInfo.key);
    if (inflight) {
      return inflight;
    }

    const connectPromise = (async () => {
      if (candidate.config.perWorkspace) {
        await this._evictLruWorkspaceIfNeeded(defaults.maxWorkspaceInstances, keyInfo);
      }

      const adapter = await this._connectCandidate(candidate, defaults, cwd);
      const entry = {
        ...keyInfo,
        adapter,
        lastUsed: Date.now(),
        inFlight: 0,
        redact: candidate.config,
        cachedTools: null,
        perWorkspace: candidate.config.perWorkspace,
        configDigest,
      };
      this.pool.set(keyInfo.key, entry);
      return entry;
    })();

    this.pendingConnects.set(keyInfo.key, connectPromise);
    try {
      return await connectPromise;
    } finally {
      if (this.pendingConnects.get(keyInfo.key) === connectPromise) {
        this.pendingConnects.delete(keyInfo.key);
      }
    }
  }

  async _evictEntry(entry) {
    if (this.pool.get(entry.key) !== entry) return false;
    this.pool.delete(entry.key);
    await entry.adapter.shutdown();
    return true;
  }

  _recordFallback(ev) {
    this.recentFallbacks.push(ev);
    if (this.recentFallbacks.length > MAX_FALLBACK_EVENTS) {
      this.recentFallbacks.shift();
    }
  }

  async _fetchToolsWithFailover(chain, defaults, cwd, initialLocalError) {
    let localError = initialLocalError;
    let lastError = null;
    const primarySource = chain[0].source;
    const serverName = chain[0].name;

    for (let idx = 0; idx < chain.length; idx += 1) {
      const candidate = chain[idx];
      const keyInfo = poolKeyString(candidate, cwd);
      const existing = this.pool.get(keyInfo.key);
      const configDigest = JSON.stringify(candidate.config);

      if (existing?.cachedTools && existing.configDigest === configDigest && (await existing.adapter.isAlive())) {
        existing.lastUsed = Date.now();
        return {
          tools: existing.cachedTools,
          meta: routeMeta({
            server: serverName,
            source: candidate.source,
            idx,
            primarySource,
            localError,
            cwd,
            retried: false,
            truncated: false,
          }),
        };
      }

      let retried = false;
      try {
        let entry = await this._getOrConnect(keyInfo, candidate, defaults, cwd);
        let tools;
        try {
          tools = await entry.adapter.listTools();
        } catch (err) {
          if (err instanceof BrokerError && err.isRetryable() && defaults.retryOnTransportError) {
            if (err.kind !== "timeout") await this._evictEntry(entry);
            retried = true;
            entry = await this._getOrConnect(keyInfo, candidate, defaults, cwd);
            tools = await entry.adapter.listTools();
          } else {
            throw err;
          }
        }
        entry.cachedTools = tools;
        return {
          tools,
          meta: routeMeta({
            server: serverName,
            source: candidate.source,
            idx,
            primarySource,
            localError,
            cwd,
            retried,
            truncated: false,
          }),
        };
      } catch (err) {
        const bErr = sanitizeError(err, [candidate.config]);
        if (candidate.source === "local") localError = bErr.message;
        if (idx + 1 < chain.length && bErr.isFailoverEligible()) {
          this._recordFallback(
            fallbackEvent(serverName, candidate.source, chain[idx + 1].source, bErr.message, cwd)
          );
          lastError = bErr;
          continue;
        }
        throw bErr;
      }
    }

    throw lastError || new BrokerError("server_not_found", `server not found: ${serverName}`);
  }

  async _poolSnapshot() {
    const now = Date.now();
    const out = [];
    for (const entry of this.pool.values()) {
      const alive = await entry.adapter.isAlive();
      out.push({
        server: entry.server,
        source: entry.source,
        scope: entry.scope,
        alive,
        idleSecs: Math.floor((now - entry.lastUsed) / 1000),
        cachedTools: entry.cachedTools ? entry.cachedTools.length : 0,
      });
    }
    return out;
  }

  async list(req = {}) {
    const resolved = resolveConfig(this.brokerHome, req.cwd, this.dataDir);
    if (!req.server) {
      const poolSnap = await this._poolSnapshot();
      return {
        servers: summarizeServers(resolved.candidates, poolSnap),
        ...(resolved.localConfigError ? { localConfigError: resolved.localConfigError } : {}),
      };
    }

    const chain = resolved.candidates.get(req.server);
    if (!chain) {
      throw new BrokerError("server_not_found", `server not found: ${req.server}`);
    }

    const { tools, meta } = await this._fetchToolsWithFailover(
      chain,
      resolved.defaults,
      req.cwd,
      resolved.localConfigError
    );
    const filter = req.filter ? String(req.filter).toLowerCase() : null;
    const filtered = tools
      .filter(
        (t) =>
          !filter ||
          t.name.toLowerCase().includes(filter) ||
          t.description.toLowerCase().includes(filter)
      )
      .map((t) => ({ name: t.name, summary: compactSummary(t.description) }));

    return { tools: filtered, meta };
  }

  async describe(req) {
    const resolved = resolveConfig(this.brokerHome, req.cwd, this.dataDir);
    const chain = resolved.candidates.get(req.server);
    if (!chain) {
      throw new BrokerError("server_not_found", `server not found: ${req.server}`);
    }

    const { tools, meta } = await this._fetchToolsWithFailover(
      chain,
      resolved.defaults,
      req.cwd,
      resolved.localConfigError
    );
    const schema = tools.find((t) => t.name === req.tool);
    if (!schema) {
      throw new BrokerError("tool_not_found", `tool not found: ${req.server}/${req.tool}`);
    }
    return { schema, meta };
  }

  async call(req) {
    const resolved = resolveConfig(this.brokerHome, req.cwd, this.dataDir);
    const chain = resolved.candidates.get(req.server);
    if (!chain) {
      throw new BrokerError("server_not_found", `server not found: ${req.server}`);
    }

    const spillDir = path.join(this.dataDir, "spill");
    const maxBytes = req.maxBytes ?? resolved.defaults.maxOutputBytes;
    const maxLines = resolved.defaults.maxOutputLines;
    let localError = resolved.localConfigError;
    let lastError = null;
    const primarySource = chain[0].source;
    const cliFallback = chain.find((c) => c.config.cliFallback)?.config.cliFallback || null;

    for (let idx = 0; idx < chain.length; idx += 1) {
      const candidate = chain[idx];
      const keyInfo = poolKeyString(candidate, req.cwd);
      let retried = false;

      try {
        let entry = await this._getOrConnect(keyInfo, candidate, resolved.defaults, req.cwd);
        let res;
        try {
          res = await this._callTracked(entry, req.tool, req.arguments || {});
        } catch (err) {
          if (
            err instanceof BrokerError &&
            err.kind === "transport" &&
            resolved.defaults.retryOnTransportError
          ) {
            await this._evictEntry(entry);
            retried = true;
            entry = await this._getOrConnect(keyInfo, candidate, resolved.defaults, req.cwd);
            res = await this._callTracked(entry, req.tool, req.arguments || {});
          } else {
            throw err;
          }
        }

        const trunc = truncateContentBlocks(
          res.content,
          maxBytes,
          maxLines,
          spillDir,
          Boolean(req.full)
        );

        return {
          content: trunc.content,
          isError: res.isError,
          meta: routeMeta({
            server: req.server,
            source: candidate.source,
            idx,
            primarySource,
            localError,
            cwd: req.cwd,
            retried,
            truncated: trunc.truncated,
            spillPath: trunc.spillPath,
          }),
        };
      } catch (err) {
        const bErr = sanitizeError(err, [candidate.config]);
        if (bErr.kind === "timeout") throw bErr;
        if (candidate.source === "local") localError = bErr.message;
        if (idx + 1 < chain.length && bErr.isFailoverEligible()) {
          this._recordFallback(
            fallbackEvent(req.server, candidate.source, chain[idx + 1].source, bErr.message, req.cwd)
          );
          lastError = bErr;
          continue;
        }
        if (bErr.isFailoverEligible()) {
          lastError = bErr;
          break;
        }
        throw bErr;
      }
    }

    if (lastError && lastError.isFailoverEligible() && cliFallback) {
      const timeoutMs = chain[0].config.requestTimeoutMs ?? resolved.defaults.requestTimeoutMs;
      const effectiveCwd = req.cwd ? resolveRepoRoot(req.cwd) : undefined;
      let cliRes;
      try {
        cliRes = await tryCliFallback(
          cliFallback,
          req.tool,
          req.arguments || {},
          effectiveCwd,
          timeoutMs
        );
      } catch (err) {
        throw sanitizeError(err, chain.map((c) => c.config));
      }
      if (cliRes) {
        this._recordFallback(
          fallbackEvent(req.server, chain[chain.length - 1].source, "cli_fallback", lastError.message, req.cwd)
        );
        const trunc = truncateContentBlocks(
          cliRes.content,
          maxBytes,
          maxLines,
          spillDir,
          Boolean(req.full)
        );
        return {
          content: trunc.content,
          isError: cliRes.isError,
          meta: {
            server: req.server,
            source: "cli_fallback",
            fallbackFrom: primarySource,
            ...(localError ? { localError } : {}),
            mcpError: lastError.message,
            ...(req.cwd ? { cwd: req.cwd } : {}),
            retried: true,
            truncated: trunc.truncated,
            ...(trunc.spillPath ? { spillPath: trunc.spillPath } : {}),
          },
        };
      }
    }

    throw lastError || new BrokerError("server_not_found", `server not found: ${req.server}`);
  }

  async status(req = {}) {
    const resolved = resolveConfig(this.brokerHome, req.cwd, this.dataDir);
    const poolSnap = await this._poolSnapshot();

    return {
      pid: process.pid,
      version: BROKER_VERSION,
      uptimeSecs: Math.floor((Date.now() - this.startedAt) / 1000),
      port: this.port,
      ...(resolved.localPath ? { localConfigPath: resolved.localPath } : {}),
      ...(resolved.localConfigError ? { localConfigError: resolved.localConfigError } : {}),
      servers: summarizeServers(resolved.candidates, poolSnap),
      pool: poolSnap,
      recentFallbacks: [...this.recentFallbacks],
      sweepErrors: [...this.sweepErrors],
    };
  }

  async restart(req = {}) {
    const targetScope = req.cwd ? resolveRepoRoot(req.cwd) : null;
    const toRemove = [];
    for (const [key, entry] of this.pool.entries()) {
      const serverMatch = !req.server || entry.server === req.server;
      const scopeMatch = !targetScope || entry.scope === targetScope;
      if (serverMatch && scopeMatch) {
        toRemove.push([key, entry]);
      }
    }
    for (const [key, entry] of toRemove) {
      this.pool.delete(key);
      await entry.adapter.shutdown();
    }
    return { evicted: toRemove.length };
  }

  async maintenanceSweep() {
    let resolved;
    try {
      resolved = resolveConfig(this.brokerHome, null, this.dataDir);
    } catch (err) {
      this._recordSweepError(err, []);
      return;
    }
    const maxIdleMs = resolved.defaults.idleTimeoutSecs * 1000;
    const now = Date.now();
    for (const [key, entry] of [...this.pool.entries()]) {
      try {
        if (
          entry.perWorkspace &&
          entry.inFlight === 0 &&
          maxIdleMs > 0 &&
          now - entry.lastUsed >= maxIdleMs
        ) {
          this.pool.delete(key);
          await entry.adapter.shutdown();
        }
      } catch (err) {
        this._recordSweepError(err, [entry.redact], entry);
      }
    }
    try {
      cleanupExpiredSpills(path.join(this.dataDir, "spill"), resolved.defaults.spillTtlHours);
    } catch (err) {
      this._recordSweepError(err, []);
    }
  }

  async shutdown() {
    const entries = [...this.pool.values()];
    this.pool.clear();
    for (const entry of entries) {
      await entry.adapter.shutdown();
    }
  }
}
