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
`<broker-cli>` is the absolute path to `scripts/ignis-broker.mjs`. Take it from the `[ignis-swarm][First-Run Onboarding Required]` notice that `SessionStart` injects (only while onboarding is pending). Otherwise derive it from this skill's folder (`<plugin-root>/skills/ignis-broker/`): `<this SKILL.md's folder>/../../scripts/ignis-broker.mjs`. Quote the path.
```bash
node "<broker-cli>" status --json
node "<broker-cli>" list <server>
node "<broker-cli>" describe <server> <tool>
node "<broker-cli>" call <server> <tool> --args '{"key":"value"}'
```

## 2. Config Precedence & Failover Signals
- Local `.agents/ignis-broker.json` (discovered walking up to `.git`) takes precedence over global `~/.ignis-broker/servers.json`, but only after the user trusts that exact file: `node "<broker-cli>" trust --cwd <dir>`. Editing the file voids the trust. An agent running `trust` always gets a user prompt.
- In the global config, secrets referenced as `${VAR_NAME}` in `env` or `headers` are expanded inside the broker from `~/.ignis-broker/.env` or broker process environment. A local config is never expanded: `${VAR}` stays literal.
- Diagnostics and errors are masked: configured secrets and every own-env value of 4+ characters are redacted.
- If a local config or local backend fails, the broker automatically falls back to the global definition and attaches `_meta`:
  - `fallbackFrom: "local"` + `localError` → inform the user that local config/backend failed and global fallback was used.
  - `truncated: true` + `spillPath` → read targeted line ranges from `spillPath` with `read_file` instead of re-running with `full: true` unless needed.
- A config change lets in-flight calls finish before the affected servers restart. `restart` stops busy servers at once. `stop` waits for the daemon to exit and fails, naming the pid, if it survives.

## 3. Discovery, Registration & Onboarding CLI
For guided interactive setup of MCP servers, issue tracker opt-in, Memtrace, and review routing, run **`/ignis-onboarding`**.

Direct CLI commands for managing broker servers and probing the environment:
```bash
# Probe local environment, installed CLIs, and onboarding state
node "<broker-cli>" onboarding --probe

# Discover MCP servers configured in Antigravity / other clients
node "<broker-cli>" discover-mcp

# Register selected MCP servers into ~/.ignis-broker/servers.json (merging with existing);
# --per-workspace takes a comma-separated list of servers to pool per workspace
node "<broker-cli>" register-mcp --servers <name1,name2> --per-workspace <name1>

# Add a remote Streamable HTTP MCP server (bearer token read from the named env var)
node "<broker-cli>" add-http-mcp <name> <url> --auth-env <ENV_VAR>

# Unregister a server from the broker
node "<broker-cli>" unregister-mcp <name>

# Bulk import from ~/.gemini/config/mcp_config.json; merges into servers.json (same-named servers are replaced)
node "<broker-cli>" import-mcp --dry-run
node "<broker-cli>" import-mcp
```
`register-mcp` and `import-mcp` move literal `env` and `headers` secrets into `~/.ignis-broker/.env` as `IGNIS_<SERVER>_<KEY>` (values containing CR or LF are rejected) and reject colliding secret variable names. `import-mcp --dry-run` is redacted. `import-mcp` cannot set per-workspace pooling; use `register-mcp --per-workspace`.
