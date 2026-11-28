---
id: ADR-001
title: "Zero-Dependency Node.js ESM Dual-Interface Broker Daemon"
status: accepted
date: 2026-11-26
superseded_by: null
issues: [AGYSWM-58]
scope: [scripts/ignis-broker.mjs, scripts/broker, mcp_config.json]
---

# ADR-001: Zero-Dependency Node.js ESM Dual-Interface Broker Daemon

## Context
Local `stdio` MCP servers connected directly to an agent session lose connectivity permanently when a child process crashes, times out, or hits lock contention. Antigravity Marketplace installs plugins as read-only bundles without running native compilers or package managers, so the broker must run cross-platform with no build step.

## Options Considered
1. **Direct `stdio` MCP servers in the host config:** simple, but a crashed child ends the connection for the session, and every server's tool schemas load up front.
2. **A compiled or npm-installed broker:** needs a toolchain the marketplace bundle does not run.
3. **Zero-dependency Node.js ESM broker with a lazy-started local daemon (chosen):** runs wherever Node runs, and the daemon can restart without dropping the host connection.

## Decision
Bundle `ignis-broker` as a zero-dependency Node.js ESM tool in `scripts/ignis-broker.mjs` and `scripts/broker/*.mjs`. `mcp_config.json` registers one server, `broker`, with `"command": "node"` and `"args": ["${PLUGIN_ROOT}/scripts/ignis-broker.mjs", "mcp-bridge"]`. It sets no `env`.

**How the data directory is chosen.** `brokerDataDir()` in `scripts/broker/config.mjs` returns `IGNIS_BROKER_DATA` when that variable is set and not blank. Otherwise it returns the broker home: `IGNIS_BROKER_HOME` when set, else `~/.ignis-broker`. `mcp_config.json` and the hooks never set either variable, and nothing uses `${PLUGIN_DATA}`. A bridge or CLI process resolves the directory this way, and `ensureDaemon()` then starts the daemon with `IGNIS_BROKER_HOME` and `IGNIS_BROKER_DATA` set to those resolved values, so both sides agree. `daemon.json`, `daemon.lock`, `onboarding.json`, the review state and the audit logs all live in this directory.

Both the stateless `mcp-bridge` and the CLI subcommands call `ensureDaemon()` (`scripts/broker/lifecycle.mjs`) to lazy-start a single detached localhost HTTP daemon. It listens on `127.0.0.1` on an ephemeral port, authenticates with a bearer token, and records its port and token in `daemon.json`; an exclusive `daemon.lock` serializes startup. The daemon exposes a REST API (`/v1/list`, `/v1/describe`, `/v1/call`, `/v1/status`, `/v1/restart`) and a stateless Streamable HTTP endpoint `/mcp` with four compact meta-tools: `broker_list`, `broker_describe`, `broker_call` and `broker_status` (`scripts/broker/server.mjs`).

## Consequences
- **Positive:** works on first click on macOS, Linux and Windows with zero compilation and zero `npm install`. If the daemon crashes or restarts mid-session, `mcp-bridge` stays alive and reconnects on the next tool call. Four meta-tools with on-demand `broker_describe` and spill-to-file output truncation avoid up-front schema bloat.
- **Negative / Risks:** the default data directory is per user, not per plugin install, so two plugin copies on one machine share a daemon and its state unless `IGNIS_BROKER_HOME` or `IGNIS_BROKER_DATA` differ. Node must be on `PATH`.

## Verification & Links
- **Code / Contracts:** `mcp_config.json`, `scripts/broker/config.mjs` (`brokerHome`, `brokerDataDir`), `scripts/broker/lifecycle.mjs` (`ensureDaemon`), `scripts/broker/bridge.mjs`, `scripts/broker/server.mjs`
- **Tests:** `tests/broker-lifecycle.test.mjs`, `tests/broker-bridge.test.mjs`, `tests/broker-e2e.test.mjs`
- **Tracker:** AGYSWM-58 (this rewrite corrects the data-directory claim)
