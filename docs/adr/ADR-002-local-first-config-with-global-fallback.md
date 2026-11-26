# ADR-002: Local-First Config Resolution with Automatic Global Fallback

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

Projects often need repository-specific MCP configurations (`.agents/ignis-broker.json`), while global defaults and credentials live in `~/.ignis-broker/servers.json` and `~/.ignis-broker/.env`. Hard overrides that discard global entries break developer flow if a repo-local override is misconfigured or its local binary fails.

## Decision

Always load both layers automatically and build an ordered candidate chain `[local, global]` per server name:

1. Walk up from `cwd` to `.git` (stopping before the user's home directory) for `.agents/ignis-broker.json`.
2. If the local file is malformed JSON, record `localConfigError` without aborting and serve from global.
3. If local sets `"enabled": false`, disable the server explicitly without falling back to global.
4. Otherwise attempt the `local` candidate first; if it fails validation, startup, or transport (after single reconnect retry), automatically fail over to `global` and populate `_meta.source = "global"`, `_meta.fallbackFrom = "local"`, and `_meta.localError`.

## Consequences

- Agents and users receive transparent resilience when a local override breaks, while explicitly seeing `_meta` failover diagnostics and `broker_status` warnings.
- Credentials expanded via `${VAR}` stay inside the broker process and are redacted in diagnostics.
