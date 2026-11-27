---
name: ignis-swarm
description: Use as the /swarm Coordinator to orchestrate an approved slice plan across waves of nuclear workers, enforce 5-field briefs, apply capability-tier model routing, handle compaction checkpoints, and run Phase 3 (@doc-auditor) and Phase 4 (3-lens final audit).
---

# Ignis Swarm (Phases 1–5 — Coordinator Playbook)

You are the **`/swarm` Coordinator** (`@coordinator`, the main session; high-reasoning coordination tier).
You do **not** write production code yourself—you dispatch waves, enforce contracts, resolve conflicts, track issue state, ask the user to compact at checkpoints, and judge verification reports.

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
4. Update issue status/checklists in every tracker of `onboarding.json` `trackers` (if any) as each wave completes.

## Wave Boundary: Compaction Check
At the end of **every wave**, follow [compaction-checkpoints.md](./references/compaction-checkpoints.md). The `PostInvocation` hook `hooks/compaction-watch.mjs` counts transcript growth since the last `CHECKPOINT` line and, on interactive sessions, injects a `[ignis-swarm][Compaction Checkpoint]` message once the threshold is passed. When it does, pause at the wave boundary (never mid-task), tell the user to run `/compact` manually via the slash menu, and emit a complete, pre-filled `Preserve: ...` payload as a copyable block (never `<placeholder>` text, never a block starting with `/compact` or `/swarm`).

## Phase 3: Auditable Documentation Gate (`@doc-auditor`)
Once the final coding wave passes `@verifier`:
- Spawn `@doc-auditor` following `ignis-audit-docs` to:
  1. Write 1 file per `[ADR]` and `[BDR]` flagged in the plan/diff (`docs/adr/`, `docs/bdr/`) + update `INDEX.md`.
  2. Only when `onboarding.json` `trackers` is non-empty (strictly opt-in), mirror/link each ADR/BDR in every tracker of that list and post a concise decision audit comment on affected cards.

## Phase 4: 3-Lens Final Slice Audit
Spawn the final audit per `ignis-review` Level 2:
1. **`@blind-edge-hunter`** — route via `reviewRouting.strategy` as defined in [ignis-review](../ignis-review/SKILL.md) ("Phase 4 Review Routing"). Pass **only** the git diff scope, with zero access to plans or issue trackers.
2. **`@acceptance-auditor`** — independent high-reasoning reviewer with full access to the plan, `trackers` (if any), and `docs/{adr,bdr}/`.

## Phase 5: Closure & Hard Compaction Checkpoint
1. Fix any proven `HIGH`/`MEDIUM` findings from Phase 4 and re-verify.
2. Present a concise **Audit Summary** (waves completed, issues closed, ADRs/BDRs created, observed coverage by module, Phase 4 verdict).
3. Tell the user to run `/compact` manually via the slash menu, and emit a complete, pre-filled `Preserve: ...` payload reflecting the real closed-slice state (never `<placeholder>` text).
