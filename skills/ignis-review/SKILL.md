---
name: ignis-review
description: Use for Level 1 per-task @verifier checks and Level 2 slice-end 3-lens final audit using the bundled read-only blind-edge-hunter subagent and an independent @acceptance-auditor.
---

# Ignis Review (Per-Task & 3-Lens Final Slice Audit)

## Level 1: Per-Task `@verifier`
Run after each nuclear worker reports completion on the `/swarm` board:
1. **Scope check:** Verify `git diff --name-only` touches **only** the worker's assigned files.
2. **BDD + TDD proof:** Confirm Red → Green evidence and that every `Given / When / Then` criterion has a real behavioral test.
3. **Anti-cheat / Anti-mock:** Flag over-mocked internal units, weak/tautological assertions, skipped tests, or weakened pre-existing assertions.
4. **Code hygiene:** Confirm zero narrative inline comments and no YAGNI bloat.
5. **Run verification:** Execute the real test/build command yourself and report `PASS | ISSUES | BLOCKED` + observed coverage %.

---

## Level 2: Slice-End 3-Lens Final Audit
Run **once** after all waves and `@doc-auditor` (Phase 3) finish. Combines 3 non-overlapping lenses across 2 isolated reviewers:

### Reviewer A — `@blind-edge-hunter` (Blind Hunting + Edge Case Hunting)

#### Phase 4 Review Routing
Routes by `reviewRouting.strategy` in `~/.ignis-broker/onboarding.json` (set via `/ignis-onboarding`). Native `blind-edge-hunter` (`subagent: true`, `mainAgent: false`, `model: pro`, `inheritMcp: false`, read-only tools) runs Gemini Pro, not Claude Opus; the cross-family reviewers (`claude` Opus, `codex` Sol) run only through `scripts/run-blind-review.mjs`. For `headless_always` and `antigravity_first`, `SessionStart` injects `[ignis-swarm][Phase 4 Review Routing]` with the exact resolved script path.

- **`antigravity_gemini_only`:** Invoke the native `blind-edge-hunter` subagent.
- **`antigravity_first`:** Invoke the native `blind-edge-hunter` subagent first; if native quota is exhausted, run the headless fallback:
  ```bash
  node <plugin-root>/scripts/run-blind-review.mjs --base <base-sha> --backend auto --fallback
  ```
- **`headless_always`:** Run the headless reviewer BEFORE native `blind-edge-hunter`:
  ```bash
  node <plugin-root>/scripts/run-blind-review.mjs --base <base-sha> --backend auto
  ```
  `PreToolUse` blocks `invoke_subagent(TypeName: "blind-edge-hunter")` until `run-blind-review.mjs` records a fresh `fallbackToNative: true` marker; only then fall back to the native subagent.

In all routing modes:
1. Pass **only** the diff scope and repository path — **never** include implementation plan files, issue tracker notes, or author rationales. `run-blind-review.mjs --base <base-sha>` diffs from the merge-base of `<base-sha>` through the current working tree (committed and uncommitted tracked changes); for native `blind-edge-hunter`, pass the same scope (`<base-sha>...HEAD` plus any uncommitted tracked changes).
2. Require concrete proof (`file:line` + trace or read-only command output) for every `HIGH`/`MEDIUM` finding and post the verbatim verdict (`PASS | ISSUES`) onto the `/swarm` board.

### Reviewer B — `@acceptance-auditor` (Acceptance + Integration + Audit Compliance)
Runs as an independent high-reasoning reviewer with full access to the approved plan, every tracker in `onboarding.json` `trackers` (if any), and `docs/{adr,bdr}/`:

- **Checklist:**
  1. Every planned task, issue, and checklist item in the slice is genuinely satisfied by code + passing behavioral tests.
  2. Cross-task integration seams across all tasks hold together end-to-end.
  3. Every `[ADR]` / `[BDR]` flagged in the plan exists as its own file, is indexed in `INDEX.md`, and (when `trackers` is non-empty) is linked/commented on the relevant card(s).
  4. If UI/web files changed, run `/browser` verification on the live flow.
  5. In **Critical Mode** (auth, concurrency, persistence/billing), run incremental mutation testing on the diff (`ignis-tdd-bdd`).
