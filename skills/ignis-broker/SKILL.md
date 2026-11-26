---
name: ignis-broker
description: Use whenever calling managed MCP tools through the resilient ignis-swarm broker daemon via its 4 MCP meta-tools or cross-platform Node CLI fallback.
---

# Ignis Broker — Resilient MCP Tool Access

The bundled `ignis-broker` (`ignis-swarm_broker`) supervises local `stdio` and remote Streamable HTTP MCP backends behind a single localhost Node.js daemon with lazy auto-start, crash recovery, per-workspace pooling, local-first config with global fallback, and spill-to-file output truncation.

## 1. Dual Interface (MCP Gateway + CLI Fallback)

### Path A — MCP Gateway (`ignis-swarm_broker` — 4 Compact Meta-Tools)
1. `broker_list({ server?, filter?, cwd? })` — omit `server` to list servers; pass `server` to list compact tool summaries.
2. `broker_describe({ server, tool, cwd? })` — fetch full parameter schema for one tool on demand.
3. `broker_call({ server, tool, arguments?, cwd?, full? })` — execute through the resilient supervisor.
4. `broker_status({ cwd? })` — inspect daemon health, active workspace pools, config warnings, and recent fallbacks.

**Always pass `cwd`** when calling workspace-scoped servers (`perWorkspace: true`) via MCP so the broker resolves `.agents/ignis-broker.json` and anchors the right repository root.

### Path B — Cross-Platform CLI via `run_command` (Shell-Only Subagents & Fallback)
```bash
node <plugin-root>/scripts/ignis-broker.mjs status --json
node <plugin-root>/scripts/ignis-broker.mjs list <server>
node <plugin-root>/scripts/ignis-broker.mjs describe <server> <tool>
node <plugin-root>/scripts/ignis-broker.mjs call <server> <tool> --args '{"key":"value"}'
```

## 2. Config Precedence & Failover Signals
- Local `.agents/ignis-broker.json` (discovered walking up to `.git`) always takes precedence over global `~/.ignis-broker/servers.json`.
- Secrets referenced as `${VAR_NAME}` in `env` or `headers` are expanded inside the broker from `~/.ignis-broker/.env` or broker process environment and redacted in diagnostics.
- If a local config or local backend fails, the broker automatically falls back to the global definition and attaches `_meta`:
  - `fallbackFrom: "local"` + `localError` → inform the user that local config/backend failed and global fallback was used.
  - `truncated: true` + `spillPath` → read targeted line ranges from `spillPath` with `read_file` instead of re-running with `full: true` unless needed.

## 3. Discovery, Registration & Onboarding CLI
For guided interactive setup of MCP servers, issue tracker opt-in, Memtrace, and review routing, run **`/ignis-onboarding`**.

Direct CLI commands for managing broker servers and probing the environment:
```bash
# Probe local environment, installed CLIs, and onboarding state
node <plugin-root>/scripts/ignis-broker.mjs onboarding --probe

# Discover MCP servers configured in Antigravity / other clients
node <plugin-root>/scripts/ignis-broker.mjs discover-mcp

# Register selected stdio MCP servers into ~/.ignis-broker/servers.json (merging with existing)
node <plugin-root>/scripts/ignis-broker.mjs register-mcp --servers <name1,name2>

# Add a remote Streamable HTTP MCP server
node <plugin-root>/scripts/ignis-broker.mjs add-http-mcp <name> <url>

# Unregister a server from the broker
node <plugin-root>/scripts/ignis-broker.mjs unregister-mcp <name>

# Legacy bulk import from ~/.gemini/config/mcp_config.json (non-destructive)
node <plugin-root>/scripts/ignis-broker.mjs import-mcp --dry-run
node <plugin-root>/scripts/ignis-broker.mjs import-mcp
```
