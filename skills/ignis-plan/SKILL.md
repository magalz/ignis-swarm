---
name: ignis-plan
description: Use during /plan (Phase 0) to plan an epic, feature, or slice using targeted codebase discovery, YAGNI/subtract-before-you-add gates, frozen interface contracts, atomic waves of nuclear tasks, BDD criteria, and [ADR]/[BDR] documentation flags.
---

# Ignis Plan (Phase 0 — Slice Planning)

Run this skill during `/plan` (recommended: high-reasoning planning tier) before spawning a `/swarm`.

## Step 1: Deterministic Discovery
1. **Codebase map:** Use targeted symbol search, caller/callee tracing, and connected code-intelligence MCPs (when available) to map dependencies and blast radius before broad file reads.
2. **Opt-in Memtrace discovery:** Only when `~/.ignis-broker/onboarding.json` has `memtrace.enabled === true`, query Memtrace for prior slice context, decisions, or recurring gotchas before broad file reads.
3. **Opt-in issue tracker context:** Issue-tracker sync is strictly **opt-in**—only when `onboarding.json` has `tracker.kind !== "none"` (see `ignis-audit-docs/references/tracker-profiles.md`), inspect the target epic/milestone/issues and linked docs. Otherwise work directly from the user's spec and repository docs.
4. **Existing decisions:** Read `docs/adr/INDEX.md` and `docs/bdr/INDEX.md` (if present). Open **only** the individual ADR/BDR files whose scope touches this slice.

## Step 2: YAGNI & Subtract-Before-You-Add Gate (Mandatory Section)
Before proposing any new code, explicitly list in the plan:
- **Subtract first:** Dead code, obsolete adapters, duplicate validators, or unused flags to delete or simplify *before* building.
- **Explicitly out of scope (YAGNI):** Speculative abstractions, premature generalizations, or future-proofing cut from this slice.

## Step 3: Freeze Interface Contracts (Phase 0 Contract)
When 2+ parallel workers will write code that interacts across modules:
- Define exact types, traits/interfaces, function signatures, error variants, and data payloads upfront in the plan.
- Schedule a **Wave 0** task (if needed) to commit the shared contract/type definitions first so parallel workers never drift.

## Step 4: Decompose into Nuclear Tasks & Waves
Split the slice into **non-colliding Waves** respecting the dependency graph.
Each **nuclear task** must represent 1 cohesive responsibility (1–3 files, 0 interface ambiguity, verifiable independently):

| Field | Requirement |
| :--- | :--- |
| **Task / Issue ID** | Issue tracker ID (or local task ID `T0.1`, `T1.1`, ...) |
| **Exclusive Files** | Exact files this worker owns (no two workers in the same wave share a file) |
| **Model Tier** | Coding Worker (default) or Mechanical Worker (strict allowlist only—see `ignis-swarm/references/model-routing.md`) |
| **BDD Criteria** | 1–3 observable `Given / When / Then` scenarios (plus key edge cases) |
| **Audit Flags** | `[ADR]` if introducing/changing a technical decision; `[BDR]` if introducing/changing a business rule; `[PLAYBOOK]` if operational procedure changes |

## Step 5: Sync & Mandatory 2-Step Post-`/plan` Handoff
After the user approves the plan:
1. **Opt-in tracker sync:** Only if `onboarding.json` has `tracker.kind !== "none"` (see `ignis-audit-docs/references/tracker-profiles.md`), create/update issues and checklists so every nuclear task is tracked.
2. **Explain the manual handoff clearly:** Antigravity requires the user to trigger `/compact` and `/swarm` themselves (agents cannot auto-launch native `/swarm`), and a pasted code block starting with `/compact` or `/swarm` is sent as plain text and does NOT trigger the command. Instruct in prose, and keep fenced blocks to the **payload only**, pre-filled with the exact live slice state (never `<placeholder>` text):

   - **Step 1 (Compact context first):** Tell the user: "Run `/compact` (via the slash menu) with the following text in the same message:"
     ```text
     Preserve: <exact issue IDs, approved Wave 0..N tasks & file ownership, frozen interface contracts, BDD criteria, and [ADR]/[BDR] flags — never emit placeholders>.
     ```
   - **Step 2 (Required to start Swarm):** Tell the user: "Run `/swarm` (via the slash menu) with the following text in the same message:"
     ```text
     Execute the approved plan starting at Wave 0/1 using ignis-swarm.
     ```
