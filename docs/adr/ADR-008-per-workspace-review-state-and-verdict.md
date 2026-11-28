---
id: ADR-008
title: "Per-Workspace Review State and Explicit Verdict Contract"
status: accepted
date: 2026-11-27
superseded_by: null
issues: [AGYSWM-61]
scope: [scripts/broker/review-state.mjs, hooks/subagent-gate.mjs, scripts/run-blind-review.mjs]
---

# ADR-008: Per-Workspace Review State and Explicit Verdict Contract

**Refines ADR-005 and ADR-006.** ADR-005 defines the headless runner and ADR-006 the `PreToolUse` gate. This ADR records the state contract between them and the verdict contract, without repeating their other rules (file modes, retries and pruning are in ADR-006).

## Context
- The v1.0.1 design was one marker file with a lockfile. Reviews of different workspaces contended on it, and a review of an older commit could unlock the native reviewer for newer code.
- A runner that exited cleanly with empty or free-form output could be counted as a review.

## Options Considered
1. **One shared marker with a lock (v1.0.1):** contention across workspaces, no link to the reviewed commit.
2. **Time-to-live only:** a new commit inside the window reuses the old state.
3. **One file per workspace root, bound to `HEAD`, plus a TTL (chosen).**

## Decision

### 1. State file
`scripts/broker/review-state.mjs` keeps one JSON file per workspace root: `<dataDir>/blind-review/<sha256(key)>.json`, where `key` is the real path of the git top-level (lowercased on Windows). It holds `{version, key, status, reason, headSha, timestampMs}`. Nothing is shared and nothing is locked.

### 2. States
- `fallback`: the headless reviewer gave no verdict (missing CLI, spawn error, non-zero exit, empty or verdict-less output, bad diff, unconfigured backend). Native review is allowed.
- `reviewed`: the reviewer returned a verdict. Native review is not needed.
- `empty`: the diff was empty. Native review is not needed.

`reviewStatus` in `scripts/run-blind-review.mjs` derives the state from the result: `fallbackToNative` gives `fallback`, a zero-byte diff gives `empty`, anything else `reviewed`. The runner is the only writer.

### 3. Freshness
A state counts only while it is at most 10 minutes old and its `headSha` equals the workspace's current `HEAD`. A new commit voids every earlier state, whatever its age.

### 4. Multi-root rule
`hooks/subagent-gate.mjs` resolves `cwd` and every workspace path to its git top-level and de-duplicates them. Then:
- a directory outside git is ignored;
- every git root must have a fresh state in one of the three statuses, so a missing or stale root denies;
- native review is allowed only when at least one root is `fallback`; if every root is `reviewed` or `empty`, the gate denies;
- any git or state error denies;
- if no supplied directory is in git, the gate has no opinion.

### 5. Verdict contract
The runner's prompt asks the reviewer to end with exactly one line, `Status: PASS` or `Status: ISSUES`. `parseVerdict` scans the output for such a line (case-insensitive, markdown decoration tolerated), ignores lines that look like the prompt's own template (for example `Status: PASS | ISSUES`), and takes the last match. Output with no such line, or empty output, becomes a `fallback` with the reason "headless reviewer returned no verdict", so native review is allowed. A zero exit code alone never counts as a review.

## Consequences
- **Positive:** workspaces do not contend; a review of an older commit never unlocks anything; a reviewer that said nothing is not mistaken for one that approved.
- **Negative / Risks:**
  - After each commit the runner must run again, even if the external backend is down.
  - A recorded `fallback` allows native review for every call inside its window.
  - The verdict contract checks form, not content: a reply that ends in a well-formed `Status:` line counts as reviewed.

## Verification & Links
- **Code / Contracts:** `scripts/broker/review-state.mjs`, `hooks/subagent-gate.mjs`, `scripts/run-blind-review.mjs` (`parseVerdict`, `reviewStatus`)
- **Tests:** `tests/review-state.test.mjs`, `tests/subagent-gate.test.mjs`, `tests/blind-review-runner.test.mjs`, `tests/blind-review-verdict.test.mjs`
- **Tracker:** AGYSWM-61; see ADR-005 and ADR-006
