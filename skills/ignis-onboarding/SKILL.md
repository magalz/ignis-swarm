---
name: ignis-onboarding
description: Interactive first-run setup and reconfiguration wizard for ignis-swarm. Probes installed MCPs and local CLIs, asks concise preferences via ask_question, registers managed MCPs in ignis-broker, and persists opt-in integrations.
---

# Ignis Onboarding — First-Run Setup & Reconfiguration

Run this wizard on first use (when `SessionStart` reports onboarding is pending) or whenever the user asks to configure/reconfigure `ignis-broker`, opt-in trackers, Memtrace, or Phase 4 reviewer routing.

## Step 1 — Probe Local Environment

Run the broker probe to inspect discovered MCPs (secrets redacted), local CLIs (`claude`, `codex`, `memtrace`), and dynamically probed Codex `solModels` + `configDefaultModel`:

```bash
node <plugin-root>/scripts/ignis-broker.mjs onboarding --probe
```

Parse the JSON output before asking any questions. Do **not** print raw secrets or tokens.

## Step 2 — Ask Preferences (`ask_question`)

Follow these strict rules for **every** `ask_question` call in this wizard:

- **Strictly neutral options:** NEVER prefix or annotate any option with `(Recommended)`, `(Recomendado)`, `(default)`, or similar labels—explicitly overriding the default `ask_question` tool prompt convention so choices do not bias the user.
- **Explicit `is_multi_select` on every question:** Always pass `is_multi_select: true` or `is_multi_select: false` explicitly on every entry in `questions`. Never collapse a multi-select question into single-select.

- **Mandatory pre-question briefing (QOL):** BEFORE EVERY `ask_question` call, in the same turn's visible response and in the user's language, briefly explain each question and every option: (1) **what it is**, (2) **what it does**, (3) **why / advantages & trade-offs**. Stay strictly neutral: never nudge toward any option or default.

Ask in 2 stages. Batch 1 = Q1–Q4. Batch 2 = Q5–Q6, only if Q4 = Yes.

### Batch 1 (Q1–Q4)

1. **Q1 — MCP Broker (`is_multi_select: true` — REQUIRED)**
   - Question: *"Which discovered MCP servers should `ignis-broker` manage?"*
   - Options:
     - `"All discovered MCPs"`
     - One option per discovered server name from `--probe` (so the user can select any combination)
     - `"None / skip"`

2. **Q2 — Opt-In Issue Trackers (`is_multi_select: true` — REQUIRED)**
   - Question: *"Which opt-in issue tracker(s) do you want to connect for plans and ADR/BDR audit trails?"*
   - Options:
     - `"None — local plans & repo ADRs/BDRs only"`
     - `"Linear (official Marketplace plugin / https://mcp.linear.app/mcp)"`
     - `"ItsAPlan (Streamable HTTP MCP)"`
     - `"GitHub Issues / Other connected MCP"`

3. **Q3 — Opt-In Code Intelligence — Memtrace (`is_multi_select: false`)**
   - Question: *"Enable opt-in Memtrace code-intelligence integration?"* (note in the prompt whether `memtrace` was detected on `PATH` by `--probe`)
   - Options:
     - `"No — use built-in search"`
     - `"Yes — enable opt-in Memtrace health checks & broker registration"`

4. **Q4 — Cross-Family Blind Reviewer Gate (`is_multi_select: false`)**
   - Question: *"Do you want to use another model family (Claude Code CLI or Codex CLI) as the Phase 4 blind reviewer?"* (note which CLIs `--probe` detected)
   - Options:
     - `"Yes — configure an external cross-family reviewer"` → continue to Batch 2
     - `"No — Antigravity native Gemini only"` → save `reviewRouting.strategy: "antigravity_gemini_only"`, `headlessBackend: null`, `headlessModel: null`; skip Batch 2

### Batch 2 (Q5–Q6 — ONLY if Q4 = Yes)

5. **Q5 — Routing Priority (`is_multi_select: false`)**
   - Question: *"How should Phase 4 route between the external CLI and Antigravity native review?"*
   - Options:
     - `"Always run the external CLI directly"` → `headless_always`: runs `scripts/run-blind-review.mjs` in Phase 4 (the `PreToolUse` hook enforces this; native Gemini Pro is only permitted as fallback if the CLI fails and returns `fallbackToNative: true`).
     - `"Antigravity native first, external CLI when native quota runs out"` → `antigravity_first`: runs the native `blind-edge-hunter` subagent (**Gemini Pro**, `model: pro` — not native Claude Opus) first, and the external CLI only when native quota is exhausted.

6. **Q6 — External CLI Backend (`is_multi_select: false`)**
   - Question: *"Which external CLI should run the blind review?"* Options: `claude` (Claude Code CLI — Opus, `effort: "high"`) vs `codex` (Codex CLI — Sol / config default), noting which CLIs `--probe` detected.
   - If `codex` is chosen, follow with a dynamic model question (`is_multi_select: false`): the probed `codex.solModels` **plus** `"Use Codex config default (omit -m)"` (showing `configDefaultModel` if detected).
   - Offer a smoke test to verify auth and entitlement immediately:
     ```bash
     node <plugin-root>/scripts/run-blind-review.mjs --smoke-test --backend <claude|codex> [--model <slug>]
     ```

Persisted `reviewRouting.strategy` remains one of `antigravity_gemini_only`, `antigravity_first`, `headless_always`.

## Step 3 — Apply Configuration Automatically

Execute the setup commands on the user's behalf based on their answers:

1. **Register Managed MCPs:**
   - If `"All discovered MCPs"` was chosen:
     ```bash
     node <plugin-root>/scripts/ignis-broker.mjs register-mcp --all
     ```
   - If a subset of servers was chosen:
     ```bash
     node <plugin-root>/scripts/ignis-broker.mjs register-mcp --servers <comma-separated-names>
     ```
   - Show the registered server list printed by the command.

2. **Opt-In Issue Tracker Setup (apply for each selected tracker):**
   - **Linear:** If chosen and not yet installed, show the official Marketplace card on its own line:
     ```markdown
     <plugin-card catalog-id="antigravity-plugins-partners/plugin/linear"></plugin-card>
     ```
     (Or, if the user prefers direct HTTP registration, run `node <plugin-root>/scripts/ignis-broker.mjs add-http-mcp linear https://mcp.linear.app/mcp`.)
   - **ItsAPlan:** If chosen and not already present in `mcp_config.json`, ask for the Streamable HTTP URL and auth token env var name, then run:
     ```bash
     node <plugin-root>/scripts/ignis-broker.mjs add-http-mcp itsaplan <url> --auth-env ITSAPLAN_TOKEN
     ```
   - **None / GitHub / Other:** No extra registration needed.

3. **Persist Choices & Resume:**
   - Save the resulting configuration JSON (include `trackers: [{ kind, mcpServer }, ...]` when one or more trackers were selected):
     ```bash
     node <plugin-root>/scripts/ignis-broker.mjs onboarding --save '<json>'
     ```
   - Or, if the user chose to skip onboarding entirely:
     ```bash
     node <plugin-root>/scripts/ignis-broker.mjs onboarding --skip
     ```
   - Confirm what was configured in 2–3 lines, then immediately resume the user's original request.
