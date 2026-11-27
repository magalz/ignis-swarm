# ADR-006: Enforced Phase 4 Blind Review Routing, 2-Stage Onboarding QOL & Payload-Only Slash Handoffs

- **Status:** Accepted
- **Date:** 2026-11-26
- **Refines:** ADR-004, ADR-005

## Context

- In session `eeed8181-e56a-48a0-89db-566e29030e94`, `blind-edge-hunter` ran on native Gemini Pro instead of external Claude Opus. Phase 4 routing relied on prose instructions, not hooks, so nothing enforced the configured `headless_always` strategy.
- Onboarding asked for a routing strategy before asking whether the user wanted a cross-family reviewer at all. It also gave no per-choice explanations.
- Pasting a fenced `/compact` or `/swarm` block in the Antigravity UI sends plain text. It does not activate the slash command.

## Decisions

1. **`SessionStart` routing notice.** Interactive sessions get a `[ignis-swarm][Phase 4 Review Routing]` notice containing the exact resolved `scripts/run-blind-review.mjs` path. It is emitted for `headless_always` and `antigravity_first` (displaying `model=none` when `headlessBackend` is unconfigured). It stays silent for subagents and for `antigravity_gemini_only`. It appears only when onboarding is completed.
2. **`PreToolUse` deterministic gate** (hook matcher `run_command|invoke_subagent`). Under `headless_always`, `invoke_subagent` calls targeting `blind-edge-hunter` are blocked using normalized lowercase matching across `TypeName`/`typeName` (without empty-string shadowing) and namespace suffixes (`*:blind-edge-hunter`, `*/blind-edge-hunter`). The exception is a fresh marker, at most 10 minutes old (TTL), with `fallbackToNative: true` for the workspace. `scripts/run-blind-review.mjs` writes that marker to `blind-review-state.json` when the configured external backend fails or is unconfigured.
   - State writes create the data directory with mode `0o700` and write atomically (temp file + rename, mode `0o600`), cleaning up `.tmp` on failure and falling back to direct `0o600` write on Windows `EPERM`/`EACCES`. Stale or invalid entries are pruned on write. Reads never rewrite the file.
   - The key is `normalizeWorkspaceKey(dir)`: `fs.realpathSync.native` canonicalization of `path.resolve(dir)` (falling back to `path.resolve(dir)` if missing), lowercased on `win32`. `hasFreshNativeFallback` matches fresh entries (finite `timestampMs`, `0 <= delta <= TTL`) by exact key or parent/subdirectory `path.sep` boundary (handling filesystem roots and rejecting sibling prefixes such as `repo` vs `repo-other`). Empty `dir` values are skipped.
   - The gate fails closed on a missing or corrupt `blind-review-state.json`: `hasFreshNativeFallback` returns `false`, so under `headless_always` the invocation is denied. Only onboarding read errors fail open, falling back to `defaultOnboardingState()` (`antigravity_gemini_only`).
   - Strict runner input validation: `--backend` accepts only `auto`, `native`, `claude`, or `codex` (unknown or empty values throw immediately without writing state), and fallback state is persisted only when `--backend` is `auto` or matches `routing.headlessBackend`. `--base` rejects empty or `-`-prefixed values, requires `git merge-base <base> HEAD` to succeed without silent 2-dot fallback, and runs `git diff <mergeBase> --` covering committed and uncommitted tracked working-tree changes from the merge-base.
   - `--smoke-test`, `antigravity_gemini_only`, `antigravity_first` without `--fallback`, and `backend=native` never write state. A thrown error (missing/invalid `--base`, invalid `--backend`, git merge-base/diff failure) writes no state either.
   - Success or an empty diff clears the marker to `fallbackToNative: false` (when state persistence applies).
   - State write errors are swallowed, so they never crash a review.
3. **2-stage cross-family onboarding.** Batch 1 Q4 is a binary gate ("Yes — configure an external cross-family reviewer" / "No — Antigravity native Gemini only"). Batch 2 asks Q5 (strategy) and Q6 (CLI) only when Q4=Yes. The `reviewRouting.strategy` enum keeps its 3 values, so existing configs stay compatible. A mandatory neutral Pre-Question Briefing (What it is / What it does / Why & trade-offs) precedes the questions, with no `(Recommended)` or `(default)` labels.
4. **Payload-only `/compact` and `/swarm` handoffs.** `compaction-watch.mjs`, skills, rules and README now tell the user to type the slash command manually and show only the copyable payload. The old assertion `/compact Preserve:` became `/compact manually` plus `Preserve: `. This refines ADR-004.

## Consequences

- **Positive:** Phase 4 routing is enforced by hooks, so a model cannot skip the external reviewer by ignoring prose. Users who decline cross-family review are not asked about strategies. Handoffs work in the UI.
- **Negative / risks:**
  - A missing or corrupt state file blocks native fallback even when the external backend is down, until the runner writes a fresh marker. An onboarding read error fails open to `antigravity_gemini_only`, so the gate is not enforced.
  - There is a 10-minute window after a failure in which native fallback is allowed.
  - Users must type `/compact` or `/swarm` themselves.
- **Mitigations:** Failing closed on the marker preserves enforcement. Failing open on onboarding errors avoids hard-blocking sessions. The short TTL and pruning bound staleness. Marker writes are atomic with `0o600` permissions. Clearing on success or empty diff prevents a stale fallback.

## Verification & Affected Artifacts

- Version bump to `1.0.1`: `BROKER_VERSION` in `scripts/broker/config.mjs`, `plugin.json`, README.
- State: `scripts/broker/onboarding.mjs` (5 frozen exports), `tests/onboarding-cli.test.mjs` (`AGYSWM-1`).
- Runner: `scripts/run-blind-review.mjs`, `tests/blind-review-runner.test.mjs` (`AGYSWM-2`).
- Hooks: `hooks.json`, `hooks/session-start.mjs`, `hooks/pre-tool-use.mjs`, `hooks/compaction-watch.mjs`, `tests/hooks.test.mjs` (`AGYSWM-3`).
- Skills, rules, README: `skills/ignis-onboarding/SKILL.md` and related docs (`AGYSWM-4`).
- ADR and tracker mirror: this file, `docs/adr/INDEX.md` (`AGYSWM-5`).
- Evidence: `blind-review-runner` 12/12, `hooks` 11/11, Wave 1 full suite 49/49 (#17), and `agy plugin validate --strict .` passed.
