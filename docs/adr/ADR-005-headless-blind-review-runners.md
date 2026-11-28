---
id: ADR-005
title: "Cross-Platform Headless Blind Review Runners"
status: accepted
date: 2026-11-26
superseded_by: null
issues: [AGYSWM-58]
scope: [scripts/run-blind-review.mjs, scripts/broker/onboarding.mjs, scripts/broker/review-state.mjs]
---

# ADR-005: Cross-Platform Headless Blind Review Runners

Refined by ADR-006, which enforces the routing and records the review state. The sections below describe the runner at v1.1.0.

## Context
Phase 4 blind diff auditing benefits from model diversity: Claude Code Opus or Codex CLI alongside Antigravity's bundled `blind-edge-hunter` (native Gemini Pro). Invoking external reviewers through OS-specific shell scripts with hardcoded model identifiers or harness flags broke across Windows, macOS and Linux, and could expose host MCP servers to a review that should see only a diff.

## Options Considered
1. **One shell script per OS:** breaks on the other platforms and drifts.
2. **One zero-dependency Node.js runner (chosen):** one code path on all platforms, no install step.
3. **Hardcode model slugs:** simple, but slugs drift across CLI releases, so the model comes from the user's config instead.

## Decision
1. **Single runner, `scripts/run-blind-review.mjs`.** It collects the diff and runs the headless review on Windows, macOS and Linux. The diff is everything since `git merge-base <base> HEAD` (or against the empty tree when HEAD is unborn, so every file counts as new): committed, staged, unstaged, and untracked files that git does not ignore (`collectChanges` marks the untracked ones with `git add -N` on a scratch copy of the index). `--base` is required (except where the strategy returns before the diff is collected, see decision 6), must not start with `-`, and a `merge-base` that exits non-zero or prints nothing is an error, not a silent two-dot fallback; a `merge-base` spawn error or timeout is recorded as a fallback instead. A diff over 20 MiB (`IGNIS_REVIEW_MAX_DIFF_BYTES` overrides it) is treated as a failed extraction.
2. **Three `reviewRouting.strategy` values** in `onboarding.json`. *Corrected: the first text called the external CLI optional augmentation; the code treats it as a quota fallback.*
   - `antigravity_gemini_only`: the native `blind-edge-hunter` only. The runner with `--backend auto` returns `useNative: true` and does nothing else.
   - `antigravity_first`: the native `blind-edge-hunter` runs first. The external CLI is a **quota fallback**, not an addition to the native review: without `--fallback` the runner returns `useNative: true`; with `--fallback` (the user or agent passes it after the native reviewer ran out of quota) it runs the configured headless backend.
   - `headless_always`: the runner runs first. The native reviewer is allowed only when the runner records a fallback (ADR-006 enforces this).
3. **The headless reviewer is diff-only.** The prompt asks for review of only the diff on stdin. For `claude` the prompt is the `-p` argument and the diff is stdin. The invocation is `-p <prompt> --model <model|opus> --effort <effort|high> --permission-mode dontAsk --tools "" --setting-sources "" --disable-slash-commands --strict-mcp-config --mcp-config <empty config> --no-session-persistence`. With no tools, no settings sources, no slash commands and an empty MCP config, the reviewer cannot read the repository, host MCP servers or plans. For `codex` the invocation is `exec [-m <model>] --sandbox read-only -c approval_policy=never -`, with the prompt and the diff on stdin. The Codex flags are **unverified**: Codex is not installed where this was built, so they follow the documented CLI and have not been run. A read-only sandbox is not the same isolation as `--tools ""`: a Codex reviewer might read files in its working directory.
4. **Models come from configuration.** *Superseded: the first text said the runner probes `~/.codex` at runtime; only `onboarding --probe` does.* `--model`, then `reviewRouting.headlessModel`, then a default: `opus` for `claude`, none (the CLI's own default) for `codex`. The runner does not probe model catalogs. Only `onboarding --probe` calls `probeCodexModels` (`~/.codex/models_cache.json`, `config.toml`) to suggest a model during onboarding.
5. **Verdict contract.** The reviewer must end with one line, `Status: PASS` or `Status: ISSUES`. `parseVerdict` takes the last such line (template echoes like `Status: PASS | ISSUES` are ignored). A missing or unparseable line is not a pass: the runner returns `fallbackToNative: true` with a `no verdict` reason, as it does for a missing CLI, a spawn error, a non-zero exit, a failed diff extraction or an unconfigured backend. Success returns `fallbackToNative: false` with the verdict, and an empty diff returns `fallbackToNative: false` with `diffBytes: 0`.
6. **Review state.** After each real run the runner records one state file per workspace (`status` `fallback`, `reviewed` or `empty`, bound to HEAD; see ADR-006). `--smoke-test`, `--backend native`, and (with `--backend auto`) `antigravity_gemini_only` and `antigravity_first` without `--fallback` write nothing, and neither does a thrown error (bad `--base`, bad `--backend`, non-zero merge-base exit). State is written only when `--backend` is `auto` or equals `reviewRouting.headlessBackend`; `--backend` accepts only `auto`, `native`, `claude` or `codex`.

## Consequences
- **Positive:** one code path on every platform. The Claude reviewer sees only the diff. Users without external CLIs run `antigravity_gemini_only` with no setup. A reviewer that fails or gives no verdict degrades to the native reviewer instead of passing silently.
- **Negative / Risks:** the Codex path is untested and less isolated than the Claude path. A diff-only review cannot find problems that need repository context. The default 180 s timeout can turn a slow review into a fallback.

## Verification & Links
- **Code / Contracts:** `scripts/run-blind-review.mjs` (`buildClaudeArgs`, `buildCodexArgs`, `parseVerdict`, `runBlindReview`), `scripts/broker/onboarding.mjs` (`probeCodexModels`), `scripts/lib/git-changes.mjs` (`collectChanges`)
- **Tests:** `tests/blind-review-runner.test.mjs`, `tests/blind-review-verdict.test.mjs`, `tests/git-changes.test.mjs`
- **Tracker:** AGYSWM-58
