---
name: ignis-swarm
description: Use as the /swarm Coordinator to orchestrate an approved slice plan across waves of nuclear workers, enforce 5-field briefs, apply capability-tier model routing, manage context compaction checkpoints, and run Phase 3 (@doc-auditor) and Phase 4 (3-lens final audit).
---

# Ignis Swarm (Phases 1–4 — Coordinator Playbook)

You are the **`/swarm` Coordinator** (high-reasoning coordination tier).
You do **not** write production code yourself—you dispatch waves, enforce contracts, resolve conflicts, track issue state, manage compaction checkpoints, and judge verification reports.

Read these bundled references as needed:
- [brief-template.md](./references/brief-template.md) — mandatory 5-field nuclear brief
- [model-routing.md](./references/model-routing.md) — coding vs. mechanical tier allowlist, escalation, and Phase 4 review routing
- [compaction-checkpoints.md](./references/compaction-checkpoints.md) — hard checkpoints + active threshold protocol

## Phase 1: Wave Dispatch
1. Verify Wave 0 (frozen interface contracts / deletions from `subtract-before-you-add`) is complete before fanning out dependent waves.
2. For each wave, spawn 1 named worker per nuclear task using [brief-template.md](./references/brief-template.md).
3. Use `workspace: "share"` whenever 2+ workers might build/test concurrently or touch shared build artifacts; otherwise keep exclusive file ownership strict.
4. Assign model tiers per [model-routing.md](./references/model-routing.md).

## Phase 2: Per-Task Verification & Escalation
1. Pair every 2–4 coding workers with a `@verifier` following `ignis-review` Level 1.
2. A task is **not** done until `@verifier` posts `PASS` with real command outputs, BDD compliance, anti-mock check, zero narrative comments, and observed coverage %.
3. **Escalation rules:**
   - A mechanical worker returns logic `ISSUES` → respawn/switch task to the standard coding tier.
   - A coding worker fails the same verification gate twice → invoke **`attack-the-premise`**: stop patching, write down the shared premise, inspect at Coordinator tier, and fix the plan/contract before retrying.
4. Update issue status/checklists in your connected issue tracker (if active) as each wave completes.

## Wave Boundary: Active Compaction Check
At the end of **every wave**, follow [compaction-checkpoints.md](./references/compaction-checkpoints.md):
- The deterministic `PostInvocation` compaction watcher (`hooks/compaction-watch.mjs`) monitors turn/context pressure and alerts when a compaction boundary is reached.
- Pause cleanly at a wave boundary (never mid-task) and emit a **complete, pre-filled `/compact Preserve: ...`** command populated with the real live slice state (never `<placeholder>` text) before dispatching the next wave.

## Phase 3: Auditable Documentation Gate (`@doc-auditor`)
Once the final coding wave passes `@verifier`:
- Spawn `@doc-auditor` following `ignis-audit-docs` to:
  1. Write 1 file per `[ADR]` and `[BDR]` flagged in the plan/diff (`docs/adr/`, `docs/bdr/`) + update `INDEX.md`.
  2. Only when `onboarding.json` has `tracker.kind !== "none"` (strictly opt-in), mirror/link each ADR/BDR in the connected issue tracker and post a concise decision audit comment on affected cards.

## Phase 4: 3-Lens Final Slice Audit
Spawn the final audit per `ignis-review` Level 2:
1. **`@blind-edge-hunter`** — route via `reviewRouting.strategy` in `onboarding.json` (`antigravity_gemini_only`, `antigravity_first`, or `headless_always`), using `node <plugin-root>/scripts/run-blind-review.mjs --base <base-sha> --backend auto` or the bundled read-only `blind-edge-hunter` subagent (`inheritMcp: false`, `model: pro`), passing **only** the git diff range (`<base-sha>...HEAD`) with zero access to plans or issue trackers.
2. **`@acceptance-auditor`** — independent high-reasoning reviewer with full access to the plan, opt-in issue tracker (if active), and `docs/{adr,bdr}/`.

## Phase 5: Closure & Hard Compaction Checkpoint
1. Fix any proven `HIGH`/`MEDIUM` findings from Phase 4 and re-verify.
2. Present a concise **Audit Summary** (waves completed, issues closed, ADRs/BDRs created, observed coverage by module, Phase 4 verdict).
3. Emit a **complete, pre-filled post-slice `/compact Preserve: ...`** command with the real closed-slice state (never `<placeholder>` text).
