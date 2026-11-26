# ADR-001: Zero-Dependency Node.js ESM Dual-Interface Broker Daemon

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

Local `stdio` MCP servers connected directly to an agent session lose connectivity permanently when a child process crashes, times out, or hits lock contention. Furthermore, Antigravity Marketplace installs plugins as read-only bundles without running native compilers or package managers, requiring cross-platform zero-build execution.

## Decision

Bundle `ignis-broker` as a zero-dependency Node.js ESM tool under `scripts/ignis-broker.mjs` and `scripts/broker/*.mjs`, registered in `mcp_config.json` via `"command": "node"`, `"args": ["${PLUGIN_ROOT}/scripts/ignis-broker.mjs", "mcp-bridge"]`, and `"env": { "IGNIS_BROKER_DATA": "${PLUGIN_DATA}" }`.

Both the stateless `mcp-bridge` and CLI subcommands invoke `ensureDaemon()` to lazy-start a single detached localhost HTTP daemon (`127.0.0.1:0` with bearer-token auth in `daemon.json` and exclusive `daemon.lock`). The daemon exposes a REST API (`/v1/*`) and stateless Streamable HTTP `/mcp` with 4 compact meta-tools (`broker_list`, `broker_describe`, `broker_call`, `broker_status`).

## Consequences

- Works on first click across macOS, Linux, and Windows with zero compilation and zero `npm install`.
- If the daemon crashes or restarts mid-session, `mcp-bridge` remains alive and transparently reconnects on the next tool call.
- Exposing 4 compact meta-tools with on-demand `broker_describe` and spill-to-file output truncation avoids upfront schema bloat.
