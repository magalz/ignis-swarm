# Ignis Swarm — Core Rules

## 1. Discovery & Context Discipline
- Before broad file dumps, read `docs/adr/INDEX.md` and `docs/bdr/INDEX.md` (if present) and use targeted symbol/code search (built-in search or connected MCPs via `ignis-swarm_broker`) to map callers, callees, and blast radius.
- If `SessionStart` reported an `ignis-broker` local config error or fallback, note it clearly before relying on local MCP overrides.

## 2. Core Principles (Cite only when a principle changed a concrete decision)
1. **subtract-before-you-add**: Remove dead weight and redundant layers before adding new code.
2. **laziness-protocol (YAGNI)**: Build the smallest change satisfying the requirement; no speculative abstractions.
3. **prove-it-works**: Verify the real artifact (tests, runtime output, diff), never "it compiles".
4. **fix-root-causes**: Reproduce and trace to the origin before editing.
5. **test-behavior-not-implementation**: Assert observable behavior; mock only external boundaries (network, clock, I/O).
6. **boundary-discipline**: Validate at boundaries; trust internal types and keep core logic pure.
7. **attack-the-premise**: After 2 failed attempts on the same gate, test the shared premise directly before fix #3.
8. **encode-lessons-in-structure**: Turn repeated corrections into a lint, test, script, or hook—not prose.

## 3. Code & Audit Documentation Policy
- **Zero narrative inline comments** in code. Exported API docstrings (`///`, Go doc comments, JSDoc) are allowed when idiomatic.
- Record **why** in auditable files (**1 file per decision + `INDEX.md`**):
  - Technical decisions → `docs/adr/ADR-NNN-slug.md` + `docs/adr/INDEX.md`
  - Business rules → `docs/bdr/BDR-NNN-slug.md` + `docs/bdr/INDEX.md`
- Mirror/link decisions in every tracker listed in `trackers` of `onboarding.json` (see `skills/ignis-audit-docs/references/tracker-profiles.md`).

## 4. Model Routing (Antigravity Capability Tiers)
- `@coordinator` is the main session: the agent the user talks to, which runs `/plan` and `/swarm`, dispatches workers and subagents, and judges their reports. It does not write production code during a swarm.
- `/plan` & `/swarm` Coordinator: High-reasoning tier
- Coding Workers (default): Fast/low-effort coding tier; Mechanical Workers (allowlist only): Lightweight tier
- Per-Task `@verifier` & `@doc-auditor`: Balanced verification tier
- Final `@acceptance-auditor`: Independent Pro / high-reasoning review tier; `@blind-edge-hunter`: routed per `reviewRouting.strategy` (see the "Phase 4 Review Routing" section of `skills/ignis-review/SKILL.md` and `skills/ignis-swarm/references/model-routing.md`)

## 5. Triggers → On-Demand Skills
- First-run setup / reconfiguring MCP broker or opt-in integrations → read `ignis-onboarding`
- Planning an epic/slice or `/plan` → read `ignis-plan`
- Running a `/swarm` slice in waves → read `ignis-swarm`
- Calling managed MCPs via resilient broker → read `ignis-broker`
- Implementing code or tests → read `ignis-tdd-bdd`
- Creating/updating ADRs, BDRs, playbooks, or tracker docs → read `ignis-audit-docs`
- Reviewing a task (`@verifier`) or closing a slice → read `ignis-review`
- Standalone bug/regression → read `ignis-bug-fix`
- Parallel read-only investigation → read `ignis-investigate`
- Performance measurement or speedup claim → read `ignis-benchmark`

> **Plan → Swarm Handoff:** After an approved `/plan`, tell the user in prose to run `/compact` manually via the slash menu, with a pre-filled `Preserve: ...` payload as a copyable block, then to run `/swarm` the same way with `Execute the approved plan...`. Fenced blocks hold the payload only — never start a block with `/compact` or `/swarm` (pasted, it is plain text and does not trigger the command). Agents cannot launch native `/swarm` or `/compact` themselves.

## 6. Board Report Contract
Every worker/verifier report on `/swarm` must end with:
- **Status:** `PASS` | `ISSUES` | `BLOCKED`
- **Evidence:** exact commands + real outputs
- **Coverage (if tests ran):** observed % factually
- **Issues (if any):** `file:line` + minimal repro
