---
id: ADR-004
title: "Opt-In Onboarding and Deterministic Compaction Checkpoints"
status: accepted
date: 2026-11-26
superseded_by: null
issues: [AGYSWM-58]
scope: [hooks/compaction-watch.mjs, hooks/session-start.mjs, scripts/broker/onboarding.mjs, skills/ignis-onboarding]
---

# ADR-004: Opt-In Onboarding and Deterministic Compaction Checkpoints

**Refined by ADR-006.** ADR-006 decision 3 changed the onboarding question flow (a binary cross-family gate before any routing question). ADR-006 decision 4 replaced the pre-filled `/compact` handoff with a payload-only handoff. Where this ADR and ADR-006 differ, ADR-006 wins; the affected points are marked below.

## Context
In Google Antigravity, slash commands such as `/compact` and `/swarm` are user-initiated UI controls that plugins and hooks cannot invoke programmatically. Relying on model memory alone to remember when to compact leads to silent context rot in long planning or multi-wave sessions. Assuming that external tools (issue trackers such as Linear, ItsAPlan or GitHub, Memtrace, third-party CLIs) are installed or wanted breaks portability and surprises new users.

## Options Considered
1. **Model self-estimation of context size:** needs no hook, but is unreliable.
2. **Transcript-size telemetry in a hook (chosen):** deterministic, but it measures bytes, not tokens.
3. **Enable detected integrations by default:** less friction, but it changes a user's setup without consent.

## Decision
1. **Deterministic `PostInvocation` transcript watching.** `hooks/compaction-watch.mjs` runs on `PostInvocation` (`hooks.json`, timeout 3 s). For an interactive session with a `transcriptPath` it measures the active transcript: the bytes after the last transcript line whose JSON `type` is `CHECKPOINT`, or the whole file when there is none. The threshold is 550 KB, or `compaction.transcriptThresholdKb` from `onboarding.json` when that is a positive number. Once the active size reaches the threshold it injects one `[ignis-swarm][Compaction Checkpoint]` system message, then stays quiet until the active size grows by another 150 KB. The reminder state is `compact-watch-<conversationId>.json` in the data directory. A new `CHECKPOINT` line moves the boundary, which resets the measure and the cooldown. Subagent and non-interactive payloads get no message, and any error produces an empty `{}` result (fail-open).
2. **Payload-only `/compact` and `/swarm` handoff.** *Refined by ADR-006 decision 4.* This ADR first said the checkpoint emits a ready-to-copy `/compact Preserve: ...` command. Pasted slash text does not activate the command in the UI, so the checkpoint now tells the user to type `/compact` manually and shows only a copyable `Preserve: <exact dynamic state>` payload. The handoff stays two user steps: run `/compact`, then run `/swarm` with the preserved plan path.
3. **Strictly opt-in integrations via `onboarding.json`.** `/ignis-onboarding` (`skills/ignis-onboarding/`) saves the user's choices to `onboarding.json` in the data directory. That is `~/.ignis-broker` by default; `IGNIS_BROKER_HOME` or `IGNIS_BROKER_DATA` move it (see ADR-001). Issue trackers, Memtrace, selective MCP registration (`discover-mcp`, `register-mcp`) and external headless review CLIs default to off until the user enables them.
4. **What counts as done.** `SessionStart` treats onboarding as done when the saved state has `completed: true` or `skipped: true`. `onboarding --skip` sets `skipped`, so a skip ends the first-run prompt; it enables nothing. Without either flag, an interactive main session gets one `[ignis-swarm][First-Run Onboarding Required]` notice. The question flow itself (the cross-family reviewer gate and the routing questions) is defined by ADR-006 decision 3.

## Consequences
- **Positive:** compaction reminders come from hook telemetry, not model self-estimation, and respect Antigravity's user-driven slash-command model. A fresh install needs no external accounts, CLIs or MCP changes.
- **Negative / Risks:** the threshold is a byte count, so it is only a proxy for context use. An unreadable transcript gives no reminder. The user must type `/compact` and `/swarm` themselves.

## Verification & Links
- **Code / Contracts:** `hooks/compaction-watch.mjs`, `hooks/session-start.mjs` (`onboardingDone`, `buildOnboardingNotice`), `scripts/broker/onboarding.mjs` (`skipOnboarding`, `saveOnboardingState`), `hooks.json`
- **Tests:** `tests/compaction-watch.test.mjs`, `tests/session-start.test.mjs`, `tests/onboarding-cli.test.mjs`
- **Tracker:** AGYSWM-58; see also ADR-006
