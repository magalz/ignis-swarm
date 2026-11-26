# Context Compaction Checkpoints

Keeping the Coordinator's active context lean yields higher-quality summaries, lower latency, and sharper attention across multi-wave slices.

> **Important Antigravity fact:** `/compact` **never removes** `AGENTS.md` / `GEMINI.md` rules, skills, built-in tools, MCP servers, artifacts, or live subagents. Do **not** waste compaction prompt tokens trying to preserve static rules or MCP lists—focus strictly on **dynamic workflow state**.

## 1. Hard Checkpoints (Always Compact Regardless of Token Count)
Trigger a clean `/compact` at every natural phase boundary:
1. **Post-`/plan` (Mandatory 2-Step Handoff):** Right after plan approval and opt-in issue sync, before launching `/swarm`. Because Antigravity requires the user to trigger `/compact` and `/swarm` explicitly (agents cannot auto-launch native `/swarm`), always emit:
   - **Step 1 (Recommended):** A complete, pre-filled `/compact Preserve: ...` command.
   - **Step 2 (Required to start Swarm):** `/swarm Execute the approved plan starting at Wave 0/1 using ignis-swarm.`
2. **Pre-Phase 4:** Right after all coding waves and `@doc-auditor` (Phase 3) complete, before running the Phase 4 Final 3-Lens Audit.
3. **Post-Slice / Post-PR Merge:** Right after Phase 4 Final Audit passes and the slice is closed/merged, before starting the next slice.

## 2. Deterministic Watcher & Active Threshold Checkpoints
- **Deterministic `PostInvocation` watcher (`hooks/compaction-watch.mjs`):** Automatically tracks turn/invocation pressure and emits a compaction alert when the context threshold is approached.
- At the end of each wave (or whenever `hooks/compaction-watch.mjs` alerts), the Coordinator must check context budget:
  - Inspect current context usage (`/context` in CLI, or context indicator in App; if not directly visible, rely on `hooks/compaction-watch.mjs` alerts and wave count — e.g., after every 2 waves or 5+ verbose verifier reports).
  - **Target band:** keep active context well below 50% of the model's window (e.g., ~150k–250k tokens on a 512k window).
  - If approaching or above the threshold: **do NOT start the next wave**. Pause at the wave boundary and present a ready-to-paste `/compact` command.

## 3. Mandatory Rule: Always Emit Complete, Pre-Filled `/compact` Commands
At **every** checkpoint (Post-`/plan`, Wave boundary alert, Pre-Phase 4, Post-Slice), the Coordinator **MUST** emit a **complete, pre-filled `/compact Preserve: ...`** command populated with the real live state (actual issue IDs, task IDs, commit SHAs, file paths, contracts, and next action). **Never** emit raw `<placeholder>` text for the user to fill in.

### Reference Shapes (Replace Every Detail With Live State Before Emitting)

#### Post-`/plan` → Start `/swarm` Wave 0/1 (2-Step Handoff)
- **Step 1 (Recommended):**
  ```text
  /compact Preserve: [real issue IDs or "local-only"], approved Wave 0..N tasks & exclusive file ownership, frozen interface contracts, BDD criteria per task, and [ADR]/[BDR] flags.
  ```
- **Step 2 (Required to start Swarm):**
  ```text
  /swarm Execute the approved plan starting at Wave 0/1 using ignis-swarm.
  ```

#### Between Waves (Wave N → Wave N+1)
```text
/compact Preserve: [real epic/issue IDs], completed tasks & SHAs (Waves 0..N), remaining tasks (Waves N+1..end), frozen interface contracts, rejected approaches/escalations, and pending [ADR]/[BDR] notes. Now dispatch Wave N+1.
```

#### Pre-Phase 4 (All Coding + Docs Done → Final Audit)
```text
/compact Preserve: [real epic/issue IDs], base commit SHA vs HEAD for full slice diff, created ADR/BDR paths, and observed coverage summary. Now run Phase 4 Final 3-Lens Audit.
```

#### Post-Slice / Post-PR Merge
```text
/compact Preserve: closed slice summary, merged commit/PR SHA, created ADR/BDR paths, and any deferred follow-up items. Ready for next /plan.
```
