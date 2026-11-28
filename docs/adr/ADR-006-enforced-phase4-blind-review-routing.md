---
id: ADR-006
title: "Enforced Phase 4 Blind Review Routing, 2-Stage Onboarding QOL & Payload-Only Slash Handoffs"
status: accepted
date: 2026-11-26
superseded_by: null
issues: [AGYSWM-58, AGYSWM-16]
scope: [hooks, scripts/broker/review-state.mjs, scripts/run-blind-review.mjs, skills/ignis-onboarding]
---

# ADR-006: Enforced Phase 4 Blind Review Routing, 2-Stage Onboarding QOL & Payload-Only Slash Handoffs

**Refines ADR-004 and ADR-005.** This text describes v1.1.0. The v1.0.1 text described a single marker file with a lockfile; that design was replaced by per-workspace state files bound to the reviewed commit (decision 2).

## Context
- In session `eeed8181-e56a-48a0-89db-566e29030e94`, `blind-edge-hunter` ran on native Gemini Pro instead of external Claude Opus. Phase 4 routing relied on prose instructions, not hooks, so nothing enforced the configured `headless_always` strategy.
- Onboarding asked for a routing strategy before asking whether the user wanted a cross-family reviewer at all, and gave no per-choice explanations.
- Pasting a fenced `/compact` or `/swarm` block in the Antigravity UI sends plain text. It does not activate the slash command.

## Options Considered
1. **Prose rules only:** cannot stop a model that ignores them (the original failure).
2. **A hook gate on the native reviewer, driven by recorded runner state (chosen):** the runner records what happened, and the hook checks that record.
3. **Block every external or native review from a hook:** too broad. The gate only matters for `headless_always` and for one subagent type.

## Decision

### 1. What is enforced and what is not
Enforced, by `PreToolUse` (matcher `run_command|invoke_subagent`):
- Under `reviewRouting.strategy: "headless_always"`, an `invoke_subagent` call for `blind-edge-hunter` is denied unless the review state allows it (decision 2).
- A fixed set of destructive or hook-bypassing shell commands is denied or sent to the user for confirmation (`--no-verify`, a `core.hooksPath` override, force-push to `main`/`master`, `git reset --hard`, root or home deletion, and similar; the full list is `hooks/command-rules.mjs`).

Not enforced:
- The other two strategies. `antigravity_gemini_only` and `antigravity_first` get a `SessionStart` notice and nothing else. `antigravity_first` has no gate: the native reviewer runs first by design (ADR-005).
- Running Phase 4, or any review, at all. Nothing forces the model to call the runner or a reviewer: the gate reacts only when the model invokes the native `blind-edge-hunter`. A model that skips Phase 4 entirely is not stopped.
- Any subagent type other than `blind-edge-hunter`. A different agent can review a diff and the hook does not look at it.
- Whether the external reviewer actually reviewed what the model then reports. The hook sees only the recorded state, not the model's later use of the verdict.
- Shell commands outside the rule list. The command rules are a best-effort pattern scan, not a sandbox.
- Anything the host does after the hook speaks: the hook returns `allow` (no objection) and never grants permission (see "Host decision semantics").

### 2. Per-workspace review state
`scripts/broker/review-state.mjs` stores one JSON file per workspace root at `<dataDir>/blind-review/<sha256(key)>.json`, where `key` is `normalizeWorkspaceKey(root)`: the `realpath` of the git top-level, lowercased on Windows. The record is `{version, key, status, reason, headSha, timestampMs}`. There is no shared file and no lock: each write goes to a unique temp file (mode `0o600`, directory `0o700`) and is renamed into place, with a short retry on `EPERM`/`EACCES`/`EBUSY`. Files older than 7 days are pruned on write. A read never rewrites anything, and a record whose stored `key` differs from the requested root is ignored.

`status` is one of:
- `fallback`: the headless reviewer could not give a verdict (missing CLI, spawn error, non-zero exit, no `Status:` line, bad diff, unconfigured backend). Native review is allowed.
- `reviewed`: the headless reviewer returned a verdict. Native review is not needed.
- `empty`: the diff was empty. Native review is not needed.

A record counts only while it is fresh (`0 <= now - timestampMs <= 10 minutes`) **and** its `headSha` equals the workspace's current `HEAD`. A new commit therefore invalidates every earlier state, in addition to the TTL. `scripts/run-blind-review.mjs` is the only writer, and a failed write does not throw, so a review never crashes on state; the failure is reported as `stateError` in the runner result.

**Multi-root rule.** `reviewGateDecision(dataDir, dirs)` takes `payload.cwd` plus `payload.workspacePaths`, resolves each to its git top-level, and de-duplicates by key. Directories outside any git repository are skipped. It returns `allow: true` only when all three hold: there are no errors, no root is missing (no fresh state at the current `HEAD`), and **at least one** root has status `fallback`. So with several roots, every root must have a current state, and native review is allowed only if one of them recorded a fallback. If every root is `reviewed` or `empty`, the gate denies with "the headless reviewer already completed for every workspace root". If none of the supplied directories is in a git repository, the gate has no opinion.

On a denial for missing state, the message lists one runner command per missing root (`node "<plugin>/scripts/run-blind-review.mjs" --base <base-sha> --backend auto --cwd "<root>"`) and says to use native `blind-edge-hunter` only if every command returns `fallbackToNative: true`.

### 3. Hook modules after the split, and who loads what
- `hooks/pre-tool-use.mjs` is the dispatcher. It statically imports only `command-rules.mjs` and `lib.mjs`. It normalizes the tool name, then sends `runcommand` to `evaluateCommand` and `invokesubagent` to `subagent-gate.mjs`, which it imports **lazily**, only for that tool. Any other tool gets no opinion.
- `hooks/command-rules.mjs` holds the shell-command rules and loads no broker code.
- `hooks/subagent-gate.mjs` holds the `blind-edge-hunter` gate. Within PreToolUse, it alone loads `scripts/broker/config.mjs`, `onboarding.mjs`, `review-state.mjs` and `scripts/lib/git-changes.mjs`. A `run_command` call therefore never loads the onboarding or state code, and a failure to load the gate cannot affect command rules.
- `hooks/lib.mjs` is shared by every hook: `readStdin`, `resolveWorkspace`, `isInteractiveUserSession`, `isSubagentPayload`, `sanitizeConversationId`.
- `hooks/session-start.mjs` prints the routing notice, the onboarding notice and the broker and decision-index hints. `hooks/stop-gate.mjs` scans the working diff and checks the decision indexes. `hooks/post-tool-use.mjs` writes the redacted audit log. `hooks/compaction-watch.mjs` is the compaction reminder (ADR-004).

### 4. Fail-open or fail-closed, per hook
"Closed" means the hook blocks or holds the action when it cannot decide. "Open" means the action proceeds as if the hook had no opinion.

| Hook | Condition | Result |
| :--- | :--- | :--- |
| `PreToolUse` dispatcher | stdin empty, not JSON, not an object, or `{}` | open: no-opinion output, with a stderr line |
| `PreToolUse` dispatcher | any other tool name | open: no-opinion output |
| `PreToolUse` dispatcher | error thrown inside `main()` | open: caught, no-opinion output |
| `PreToolUse` hook process | the process itself crashes (exit 1, or killed by the 5 s timeout) | closed: the host fails the tool call with "hook failed" (observed for exit 1; the timeout case is not observed) |
| `PreToolUse` command rules | rule matches a destructive command | closed: `deny` or `force_ask` |
| `PreToolUse` command rules | command too deeply nested or too large to analyse | closed: `force_ask` |
| `PreToolUse` command rules | empty or non-string command | open: no opinion |
| `PreToolUse` subagent gate | strategy is not `headless_always` | open: no opinion |
| `PreToolUse` subagent gate | subagent type is another agent | open: no opinion |
| `PreToolUse` subagent gate | onboarding state unreadable | open: treated as `antigravity_gemini_only`, so no gate |
| `PreToolUse` subagent gate | gate module fails to load or throws | open: no opinion, with a stderr line |
| `PreToolUse` subagent gate | no supplied directory is in a git repository | open: no opinion |
| `PreToolUse` subagent gate | `headless_always` and the type field cannot be read | closed: `deny` |
| `PreToolUse` subagent gate | `blind-edge-hunter`, no fresh `fallback` state, or any git or state error, or no workspace | closed: `deny` |
| `PostToolUse` | any error while logging | open: `{}`; the audit entry is lost |
| `Stop` | any error, no workspace, or a non-normal termination | open: `{}`, no continuation |
| `Stop` | scan finds issues, or the diff is over 64 MB | the agent is told to continue and fix (`decision: "continue"`); a git failure while scanning is open |
| `SessionStart` | any error or a non-project workspace | open: `{}`, no notice |
| `PostInvocation` (compaction watch) | any error, or a non-interactive payload | open: `{}`, no reminder |

The asymmetry is deliberate. Only the two checks whose job is to stop something (the command rules and the `headless_always` gate) can hold an action. Hooks that inform or log never block the session. The accepted cost is that an unreadable onboarding state or a gate that cannot load switches the review gate off.

### 5. Host decision semantics
Recorded from card AGYSWM-16, an experiment on the `agy` CLI 1.5.18 in headless mode, run on 2026-11-27 with a session-only `toolPermission: "request-review"` and the plugin disabled. The probe was `echo hook-probe`.

| `PreToolUse` stdout | Result |
| :--- | :--- |
| no hook | needs approval (soft-denied in headless mode) |
| `{"decision":"deny"}` | denied by the hook |
| `{}` | **denied by the hook** |
| `{"reason":"probe"}` | **denied by the hook**, with that reason |
| `{"decision":"allow"}` | needs approval: the user's policy still decides |
| empty output | needs approval: the user's policy still decides |
| `{"decision":"force_ask"}` | needs approval |
| `{"decision":"allow"}` plus a `deny` rule for `command(echo)` | the command did not run |
| hook exits with status 1 | the tool call fails with "hook failed" (the host fails closed) |

What follows from it:
- `allow` means "no objection". It does not bypass the user's review policy or a `deny` rule, so the hook cannot approve a command. Documents must not describe the hook as granting approval.
- An object without a `decision` (`{}`, `{"reason":"..."}`) is treated as **deny**. A hook that means "no opinion" must print exactly `{"decision":"allow"}`. `hooks/pre-tool-use.mjs` does this through `noOpinion()`, and `tests/pre-tool-use-dispatch.test.mjs` pins the exact stdout string for the unmatched-command, unrelated-tool, unreadable-payload and non-gated-subagent paths.
- The payload's `toolCall.args` arrived as a plain object (`CommandLine`, `WaitMsBeforeAsync`, `toolSummary`), not JSON-encoded. The dispatcher still unwraps JSON-quoted string values defensively.
- A crash of the hook process (exit 1) is not a no-opinion: the host fails the call. That is why the dispatcher catches its own errors and prints the no-opinion string.

Limits of this evidence: one CLI version (1.5.18), headless mode only. Headless mode cannot show the difference between `ask` and `force_ask` (the "Always Allow" cache), so this ADR makes no claim about that difference; `force_ask` is used for confirmations because it asks in the one case that was observed. The interactive TUI and the desktop app were not exercised, so their handling of `allow`, `{}` and `force_ask` is unverified. Re-run the probe when the host version changes.

### 6. Runner and `SessionStart` notice
- `SessionStart` emits a `[ignis-swarm][Phase 4 Review Routing]` notice with the exact `scripts/run-blind-review.mjs` path for interactive sessions under `headless_always` and `antigravity_first`, showing `model=none` when no backend is configured. It is silent for subagents and for `antigravity_gemini_only`. It depends only on the strategy and on an interactive main session, not on the onboarding completion state (a skipped onboarding that kept a saved `reviewRouting` still shows it).
- The runner's input checks, verdict contract and state-writing rules are in ADR-005. In short: `--backend` accepts `auto`, `native`, `claude` or `codex`; `--base` is required when a diff is collected; `--smoke-test`, `backend=native`, and (with `--backend auto`) `antigravity_gemini_only` and `antigravity_first` without `--fallback` write no state; a thrown error writes none either.

### 7. Two-stage onboarding
Batch 1 Q4 is a binary gate ("Yes: configure an external cross-family reviewer" or "No: Antigravity native Gemini only"). Batch 2 asks the strategy and CLI questions only when Q4 is Yes. The `reviewRouting.strategy` enum keeps its three values, so existing configs stay valid. A neutral briefing (what it is, what it does, why and trade-offs) precedes the questions, with no `(Recommended)` or `(default)` labels. A skip (`onboarding --skip`) counts as done (ADR-004).

### 8. Payload-only `/compact` and `/swarm` handoffs
`compaction-watch.mjs`, the skills, rules and README tell the user to type the slash command manually and show only the copyable payload. This refines ADR-004.

## Consequences
- **Positive:** under `headless_always` the model cannot use the native `blind-edge-hunter` (matched case-insensitively by `TypeName`/`typeName`, exactly or with a `:` or `/` prefix) without a current runner state for every git root. State is per workspace and per commit, so concurrent reviews of different repositories do not contend and a stale review of an older commit never unlocks the native reviewer. Users who decline cross-family review are not asked about strategies. Handoffs work in the UI.
- **Negative / Risks:**
  - After a new commit, the native reviewer is blocked until the runner has run again, even if the external backend is down.
  - Within 10 minutes of a recorded fallback at the same `HEAD`, the native reviewer is allowed, for every call.
  - An unreadable onboarding state, or a gate module that cannot load, disables the gate (fail-open).
  - A multi-root workspace needs a runner pass per root.
  - The host semantics rest on one CLI version in headless mode.
  - Users must type `/compact` and `/swarm` themselves.
- **Mitigations:** the gate fails closed on every state or git error it can see. Short TTL, `HEAD` binding and pruning bound staleness. Writes are atomic with `0o600` permissions. The dispatcher's no-opinion string is pinned by tests.

## Verification & Links
- **Code / Contracts:** `hooks.json`, `hooks/pre-tool-use.mjs`, `hooks/command-rules.mjs`, `hooks/subagent-gate.mjs`, `hooks/lib.mjs`, `hooks/session-start.mjs`, `hooks/stop-gate.mjs`, `hooks/post-tool-use.mjs`, `hooks/compaction-watch.mjs`, `scripts/broker/review-state.mjs`, `scripts/run-blind-review.mjs`
- **Tests:** `tests/pre-tool-use-dispatch.test.mjs`, `tests/pre-tool-use.test.mjs`, `tests/subagent-gate.test.mjs`, `tests/review-state.test.mjs`, `tests/blind-review-runner.test.mjs`, `tests/session-start.test.mjs`, `tests/stop-gate.test.mjs`, `tests/post-tool-use.test.mjs`, `tests/compaction-watch.test.mjs`
- **Tracker:** AGYSWM-58 (ADR corrections), AGYSWM-16 (host decision semantics experiment)
