import path from "node:path";
import { BrokerError, McpHttpAdapter, McpStdioAdapter, tryCliFallback } from "./adapters.mjs";
import { BROKER_VERSION, resolveConfig, resolveRepoRoot } from "./config.mjs";
import { cleanupExpiredSpills, truncateContentBlocks } from "./spill.mjs";

const MAX_FALLBACK_EVENTS = 32;

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

function compactSummary(desc) {
  const single = String(desc || "").replace(/\s+/g, " ").trim();
  const first = (single.split(". ")[0] || single).trim();
  return first.length <= 140 ? first : `${first.slice(0, 137)}...`;
}

export class Supervisor {
  constructor(brokerHome, dataDir, port = 0) {
    this.brokerHome = brokerHome;
    this.dataDir = dataDir;
    this.port = port;
    this.startedAt = Date.now();
    this.pool = new Map();
    this.pendingConnects = new Map();
    this.recentFallbacks = [];
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
      });
    }

    throw new BrokerError("config", `unsupported transport \`${cfg.transport}\``);
  }

  async _evictLruWorkspaceIfNeeded(maxInstances) {
    if (!maxInstances || maxInstances <= 0) return;
    const wsEntries = [...this.pool.entries()].filter(([, e]) => e.perWorkspace);
    if (wsEntries.length < maxInstances) return;
    wsEntries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const [oldestKey, oldest] = wsEntries[0];
    this.pool.delete(oldestKey);
    await oldest.adapter.shutdown();
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
        await this._evictLruWorkspaceIfNeeded(defaults.maxWorkspaceInstances);
      }

      const adapter = await this._connectCandidate(candidate, defaults, cwd);
      const entry = {
        ...keyInfo,
        adapter,
        lastUsed: Date.now(),
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
        const fallbackFrom =
          idx > 0
            ? primarySource
            : localError && candidate.source === "global"
              ? "local"
              : null;
        return {
          tools: existing.cachedTools,
          meta: {
            server: serverName,
            source: candidate.source,
            ...(fallbackFrom ? { fallbackFrom } : {}),
            ...(localError ? { localError } : {}),
            ...(cwd ? { cwd } : {}),
            retried: false,
            truncated: false,
          },
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
        const fallbackFrom =
          idx > 0
            ? primarySource
            : localError && candidate.source === "global"
              ? "local"
              : null;
        return {
          tools,
          meta: {
            server: serverName,
            source: candidate.source,
            ...(fallbackFrom ? { fallbackFrom } : {}),
            ...(localError ? { localError } : {}),
            ...(cwd ? { cwd } : {}),
            retried,
            truncated: false,
          },
        };
      } catch (err) {
        const bErr = err instanceof BrokerError ? err : new BrokerError("transport", err.message);
        if (candidate.source === "local") localError = bErr.message;
        if (idx + 1 < chain.length && bErr.isFailoverEligible()) {
          this._recordFallback({
            ts: String(Math.floor(Date.now() / 1000)),
            server: serverName,
            from: candidate.source,
            to: chain[idx + 1].source,
            reason: bErr.message,
            ...(cwd ? { cwd } : {}),
          });
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
    const resolved = resolveConfig(this.brokerHome, req.cwd);
    if (!req.server) {
      const poolSnap = await this._poolSnapshot();
      const servers = [];
      for (const [name, chain] of resolved.candidates.entries()) {
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
      return {
        servers,
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
    const resolved = resolveConfig(this.brokerHome, req.cwd);
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
    const resolved = resolveConfig(this.brokerHome, req.cwd);
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
          res = await entry.adapter.callTool(req.tool, req.arguments || {});
        } catch (err) {
          if (
            err instanceof BrokerError &&
            err.kind === "transport" &&
            resolved.defaults.retryOnTransportError
          ) {
            await this._evictEntry(entry);
            retried = true;
            entry = await this._getOrConnect(keyInfo, candidate, resolved.defaults, req.cwd);
            res = await entry.adapter.callTool(req.tool, req.arguments || {});
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
        const fallbackFrom =
          idx > 0
            ? primarySource
            : localError && candidate.source === "global"
              ? "local"
              : null;

        return {
          content: trunc.content,
          isError: res.isError,
          meta: {
            server: req.server,
            source: candidate.source,
            ...(fallbackFrom ? { fallbackFrom } : {}),
            ...(localError ? { localError } : {}),
            ...(req.cwd ? { cwd: req.cwd } : {}),
            retried,
            truncated: trunc.truncated,
            ...(trunc.spillPath ? { spillPath: trunc.spillPath } : {}),
          },
        };
      } catch (err) {
        const bErr = err instanceof BrokerError ? err : new BrokerError("transport", err.message);
        if (bErr.kind === "timeout") throw bErr;
        if (candidate.source === "local") localError = bErr.message;
        if (idx + 1 < chain.length && bErr.isFailoverEligible()) {
          this._recordFallback({
            ts: String(Math.floor(Date.now() / 1000)),
            server: req.server,
            from: candidate.source,
            to: chain[idx + 1].source,
            reason: bErr.message,
            ...(req.cwd ? { cwd: req.cwd } : {}),
          });
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
      const cliRes = await tryCliFallback(
        cliFallback,
        req.tool,
        req.arguments || {},
        effectiveCwd,
        timeoutMs
      );
      if (cliRes) {
        this._recordFallback({
          ts: String(Math.floor(Date.now() / 1000)),
          server: req.server,
          from: chain[chain.length - 1].source,
          to: "cli_fallback",
          reason: lastError.message,
          ...(req.cwd ? { cwd: req.cwd } : {}),
        });
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
    const resolved = resolveConfig(this.brokerHome, req.cwd);
    const poolSnap = await this._poolSnapshot();
    const servers = [];

    for (const [name, chain] of resolved.candidates.entries()) {
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

    return {
      pid: process.pid,
      version: BROKER_VERSION,
      uptimeSecs: Math.floor((Date.now() - this.startedAt) / 1000),
      port: this.port,
      ...(resolved.localPath ? { localConfigPath: resolved.localPath } : {}),
      ...(resolved.localConfigError ? { localConfigError: resolved.localConfigError } : {}),
      servers,
      pool: poolSnap,
      recentFallbacks: [...this.recentFallbacks],
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
    try {
      const resolved = resolveConfig(this.brokerHome, null);
      const maxIdleMs = resolved.defaults.idleTimeoutSecs * 1000;
      const now = Date.now();
      for (const [key, entry] of [...this.pool.entries()]) {
        if (entry.perWorkspace && maxIdleMs > 0 && now - entry.lastUsed >= maxIdleMs) {
          this.pool.delete(key);
          await entry.adapter.shutdown();
        }
      }
      cleanupExpiredSpills(path.join(this.dataDir, "spill"), resolved.defaults.spillTtlHours);
    } catch {}
  }

  async shutdown() {
    const entries = [...this.pool.values()];
    this.pool.clear();
    for (const entry of entries) {
      await entry.adapter.shutdown();
    }
  }
}
