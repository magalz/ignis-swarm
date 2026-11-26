# ADR-004: Opt-In Onboarding and Deterministic Compaction Checkpoints

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

In Google Antigravity, slash commands such as `/compact` and `/swarm` are user-initiated UI controls that plugins and hooks cannot invoke programmatically. Attempting to rely on model memory alone to remember when to compact leads to silent context rot during long planning or multi-wave execution sessions. Additionally, assuming specific external tools (issue trackers like Linear, ItsAPlan, or GitHub, Memtrace memory servers, or third-party CLIs) are installed or desired breaks portability and violates least-surprise for new users.

## Decision

1. **Deterministic `PostInvocation` transcript watching:** Bundle `hooks/compaction-watch.mjs` on the `PostInvocation` lifecycle event to measure transcript growth deterministically and surface an actionable compaction alert before context degrades.
2. **Mandatory pre-filled `/compact` + explicit 2-step `/swarm` handoff:** Because plugins cannot auto-trigger `/compact` or `/swarm`, Phase 0 (`/plan`) and compaction checkpoints emit a ready-to-copy `/compact Preserve: ...` command followed by an explicit 2-step user handoff notice (run `/compact`, then run `/swarm` with the preserved plan path).
3. **Strictly opt-in integrations via `~/.ignis-broker/onboarding.json`:** Provide `/ignis-onboarding` (`skills/ignis-onboarding/`) to persist user choices in `~/.ignis-broker/onboarding.json` (overridable via `IGNIS_BROKER_DATA`). All external integrations — issue trackers (Linear, ItsAPlan, GitHub), Memtrace, selective MCP server registration (`discover-mcp`/`register-mcp`), and external headless review CLIs — default to off until explicitly enabled by the user.

## Consequences

- Context compaction checkpoints are triggered deterministically by hook telemetry rather than fragile LLM self-estimation, while respecting Antigravity's user-driven slash-command model.
- Fresh installations work out-of-the-box with zero external accounts, CLIs, or MCP mutations, and users opt in only to the integrations they actually use.
