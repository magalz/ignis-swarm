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

Present concise, user-friendly choices using `ask_question` (omit Q5 unless Q4 selects an external CLI strategy):

1. **Q1 — MCP Broker (`is_multi_select: true` — REQUIRED)**
   - `is_multi_select`: `true`
   - Question: *"Which discovered MCP servers should `ignis-broker` manage?"*
   - Options:
     - `"All discovered MCPs"`
     - One option per discovered server name from `--probe` (so the user can select any combination)
     - `"None / skip"`

2. **Q2 — Opt-In Issue Trackers (`is_multi_select: true` — REQUIRED)**
   - `is_multi_select`: `true`
   - Question: *"Which opt-in issue tracker(s) do you want to connect for plans and ADR/BDR audit trails?"*
   - Options:
     - `"None — local plans & repo ADRs/BDRs only"`
     - `"Linear (official Marketplace plugin / https://mcp.linear.app/mcp)"`
     - `"ItsAPlan (Streamable HTTP MCP)"`
     - `"GitHub Issues / Other connected MCP"`

3. **Q3 — Opt-In Code Intelligence — Memtrace (`is_multi_select: false`)**
   - `is_multi_select`: `false`
   - Question: *"Enable opt-in Memtrace code-intelligence integration?"* (note in the prompt whether `memtrace` was detected on `PATH` by `--probe`)
   - Options:
     - `"No — use built-in search"`
     - `"Yes — enable opt-in Memtrace health checks & broker registration"`

4. **Q4 — Phase 4 Reviewer Routing Strategy (`is_multi_select: false`)**
   - `is_multi_select`: `false`
   - Question: *"How should Phase 4 blind edge-case reviews be routed?"*
   - Options:
     - `"Antigravity native Gemini only (zero external CLIs)"` → `antigravity_gemini_only`
     - `"Antigravity native first, then external headless CLI fallback when quota runs out"` → `antigravity_first`
     - `"Always use external headless CLI directly (saves Antigravity native quota)"` → `headless_always`

5. **Q5 — External Reviewer CLI & Model (ONLY if Q4 is `antigravity_first` or `headless_always`; `is_multi_select: false`)**
   - `is_multi_select`: `false`
   - Ask which CLI to use: `claude` (Opus) vs `codex` (Sol), noting which CLIs `--probe` detected on `PATH` (without marking either as recommended).
   - If `codex` is chosen, present the dynamically probed `codex.solModels` from `--probe` **plus** `"Use Codex config default (omit -m)"` (showing `configDefaultModel` if detected), with `is_multi_select: false`.
   - Offer to run a quick smoke test to verify auth and entitlement immediately:
     ```bash
     node <plugin-root>/scripts/run-blind-review.mjs --smoke-test --backend <claude|codex> [--model <slug>]
     ```

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
