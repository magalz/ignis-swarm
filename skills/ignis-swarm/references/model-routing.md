# Model Routing Policy (Capability Tiers)

Centralized model policy for `ignis-swarm`. Map these capability tiers to whichever Antigravity models are active in your plan.

## 1. Planning & Orchestration
| Role | Capability Tier | Rationale |
| :--- | :--- | :--- |
| `/plan` (Phase 0) | **High-Reasoning Planning** (`pro` / highest reasoning effort) | Single high-leverage pass to freeze contracts, enforce YAGNI, and eliminate worker guesswork. |
| `/swarm` Coordinator | **High-Reasoning Coordination** | Resolves wave dependencies, conflicts, and escalations cleanly without editing code. |
| Per-Task `@verifier` | **Balanced Verification** | Fast, clean-context verification per nuclear task. |
| `@doc-auditor` (Phase 3) | **Balanced Verification** | Structured ADR/BDR/INDEX drafting + optional issue-tracker sync. |

## 2. Coding Workers: Standard Coding Tier (Default) vs. Mechanical Tier (Allowlist)
**Default is ALWAYS the Standard Coding Tier.** If a task sits in any gray area, use the standard coding tier.

Assign a **Lightweight / Mechanical Tier** ONLY when the task matches this strict allowlist (zero domain logic decisions):
- Mechanical exploration / data gathering (listing callers/imports, tabulating logs)
- Mechanical signature/import renames already fully specified in the plan
- Pure boilerplate / scaffolding: DTOs, simple schemas, fixtures, file moves
- Mechanical index/table updates (`INDEX.md`) or obvious formatting/lint fixes
- Running repetitive build/test/coverage commands and formatting results

Assign the **Standard Coding Tier** for everything else:
- Any business logic, domain branching, invariant validation, or non-trivial error handling
- Writing **BDD/TDD** tests (requires selecting real edge cases and meaningful assertions)
- Local refactors that must preserve subtle semantics
- Cross-module integration, state management, persistence, concurrency, or security boundaries

**Escalation:**
- Mechanical worker gets logic `ISSUES` from `@verifier` → immediately re-run task on the Standard Coding Tier.
- Coding worker fails the same verification gate 2x → trigger **`attack-the-premise`** and review the plan/contract at Coordinator tier.

## 3. Phase 4 Final Slice Audit (Independent Cross-Check)

| Lens | Subagent / Role | Isolation & Tier |
| :--- | :--- | :--- |
| **`@blind-edge-hunter`** *(100% blind — ONLY `git diff`, zero plan or tracker)* | Native `blind-edge-hunter` subagent (`inheritMcp: false`, read-only tools) runs **Gemini Pro** (`model: pro`), NOT native Claude Opus. Cross-family reviewers (Claude Opus / Codex Sol) run only via `scripts/run-blind-review.mjs` | Routed by `reviewRouting.strategy`: `antigravity_gemini_only` → native; `antigravity_first` → native, CLI on quota exhaustion; `headless_always` → CLI first (mandatory; `PreToolUse` blocks native `invoke_subagent` until a fresh `fallbackToNative: true` marker). `SessionStart` injects `[ignis-swarm][Phase 4 Review Routing]` with the resolved script path |
| **`@acceptance-auditor`** *(full access to plan, issue tracker, and ADRs/BDRs)* | Independent acceptance & integration reviewer | `model: pro` / highest reasoning tier |
