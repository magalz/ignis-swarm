---
name: ignis-onboarding
description: Interactive first-run setup and reconfiguration wizard for ignis-swarm. Probes installed MCPs and local CLIs, asks concise preferences via ask_question, registers managed MCPs in ignis-broker, and persists opt-in integrations.
---

# Ignis Onboarding — First-Run Setup & Reconfiguration

Run this wizard on first use (when `SessionStart` reports onboarding is pending) or whenever the user asks to configure/reconfigure `ignis-broker`, opt-in trackers, Memtrace, or Phase 4 reviewer routing.

## Step 0 — Find the broker CLI

Every command below is `node "<broker-cli>" <command>`, where `<broker-cli>` is the absolute path to `scripts/ignis-broker.mjs`. `run-blind-review.mjs` sits in the same folder; `<broker-cli-dir>` below means that folder.

- Normal source: the `[ignis-swarm][First-Run Onboarding Required]` notice that `SessionStart` injected. It names the exact path (`node "<path>" onboarding --probe`); use that path.
- Fallback (reconfiguration, or no notice in context): this skill's folder is `<plugin-root>/skills/ignis-onboarding/`, so the CLI is `<this SKILL.md's folder>/../../scripts/ignis-broker.mjs`. Resolve it to an absolute path.

Quote the path (it may contain spaces). Run the commands from the user's repository, or pass `--cwd <repo-dir>` where shown, because the probe looks for a repository-local config from the working directory.

## Step 1 — Probe Local Environment

Run the broker probe to inspect discovered MCPs (secrets redacted), local CLIs (`claude`, `codex`, `memtrace`), probed Codex `solModels` + `configDefaultModel`, and any repository-local broker config:

```bash
node "<broker-cli>" onboarding --probe [--cwd <repo-dir>]
```

Parse the JSON output before asking any questions. Do **not** print raw secrets or tokens. Fields used later:

- `discoveredMcps[]`: `name`, `transport`, `alreadyManaged`, `disabled`, `suggestedPerWorkspace` (true when the server sets a `cwd` or its name looks workspace-bound, such as context, serena, lsp, git, fs, repo, sqlite).
- `localBrokerConfig`: `null` when the repository has no `.agents/ignis-broker.json`; otherwise `{ path, trusted, servers }` (servers redacted: `env` and header values are `***REDACTED***`, URLs have no credentials or query), or `{ path, trusted: false, servers: [], error }` when the file is unreadable.

### Trust step (only when `localBrokerConfig` is not null and `trusted` is false)

A repository-local config can start commands on the user's machine, so the broker ignores it until the user trusts that exact file. Do this before Step 2:

1. Show the file `path` and the redacted `servers` (name, type, command or URL; values are `***REDACTED***`, URLs carry no credentials or query). If `error` is set, show it and do not offer to trust.
2. Ask whether to trust that exact file (`ask_question`, `is_multi_select: false`, neutral options, with the Step 2 briefing). Say that `${VAR}` references are never expanded in a local config (the text is used literally), and that editing the file afterwards voids the trust.
3. On yes, run `node "<broker-cli>" trust --cwd <repo-dir>`. It prints the servers and records the file's hash. The permission hook always prompts the user to confirm `trust` (`force_ask`), even when you run it; expect that prompt. On no, change nothing: the broker keeps using the global config and reports the local one as untrusted.

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
   - Question: *"Enable opt-in Memtrace code-intelligence integration?"* (note whether `--probe` detected `memtrace` on `PATH` and whether a server named `memtrace` is in `discoveredMcps`)
   - Options:
     - `"No — use built-in search"`
     - `"Yes — enable opt-in Memtrace health checks, and route it through the broker when its MCP server is configured"`

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
     node "<broker-cli-dir>/run-blind-review.mjs" --smoke-test --backend <claude|codex> [--model <slug>]
     ```

## Step 3 — Apply Configuration Automatically

Execute the setup commands on the user's behalf based on their answers.

1. **Register Managed MCPs.** `register-mcp` reads `~/.gemini/config/mcp_config.json` (or `--from <path>`), moves literal `env`/`headers` secrets into `~/.ignis-broker/.env` as `IGNIS_<SERVER>_<KEY>`, and merges into `~/.ignis-broker/servers.json` (a server with the same name is replaced, and re-registering resets its `--per-workspace` and `--cli-fallback` settings, so pass them again). Pool a server per workspace with `--per-workspace <names>`: list the servers whose `suggestedPerWorkspace` is true in the probe, and let the user add or drop names. The flag takes a comma-separated list; a bare `--per-workspace` is ignored. Omit it when no registered server is suggested.
   - All discovered MCPs:
     ```bash
     node "<broker-cli>" register-mcp --all --per-workspace <comma-separated-names>
     ```
   - A subset:
     ```bash
     node "<broker-cli>" register-mcp --servers <comma-separated-names> --per-workspace <names-among-them>
     ```
   - `import-mcp` has no per-workspace flag, so use `register-mcp` in the wizard.
   - Show the registered server list printed by the command.

2. **Memtrace (when Q3 = Yes).** The CLI cannot create a stdio server; it registers one already present in `mcp_config.json`. If a server named `memtrace` was discovered, register it per workspace with the `memtrace` CLI as its failover (the broker calls the CLI when the server fails; it needs `memtrace` on `PATH`, or `IGNIS_MEMTRACE_CMD`):
   ```bash
   node "<broker-cli>" register-mcp --servers memtrace --per-workspace memtrace --cli-fallback memtrace=memtrace
   ```
   If it was not discovered, tell the user to add Memtrace's MCP server to their client config and re-run onboarding. Either way, save `memtrace.enabled: true` (it turns on the session-start Memtrace health check).

3. **Opt-In Issue Tracker Setup (apply for each selected tracker).** The broker sends a static `Authorization: Bearer` header; it does not run an OAuth flow. Never ask the user to paste a token into chat: tell them to add `NAME="value"` to `~/.ignis-broker/.env` themselves.
   - **Linear:** either (a) show the official Marketplace card on its own line and let the host handle sign-in:
     ```markdown
     <plugin-card catalog-id="antigravity-plugins-partners/plugin/linear"></plugin-card>
     ```
     or (b) register it in the broker, with a Linear API key or OAuth token in `LINEAR_API_KEY`:
     ```bash
     node "<broker-cli>" add-http-mcp linear https://mcp.linear.app/mcp --auth-env LINEAR_API_KEY
     ```
     Linear's MCP takes interactive OAuth or `Authorization: Bearer <token>` with an OAuth token or API key.
   - **ItsAPlan:** if not already in `mcp_config.json`, ask only for the Streamable HTTP URL. The token variable is fixed as `ITSAPLAN_TOKEN`:
     ```bash
     node "<broker-cli>" add-http-mcp itsaplan <url> --auth-env ITSAPLAN_TOKEN
     ```
   - **None / GitHub / Other:** No extra registration needed.
   - `add-http-mcp` registers a shared server (not per workspace).

4. **Persist Choices & Resume.** Write the JSON to a temporary file and save it with `--save-file` (or pipe it with `--stdin`). Prefer these over `--save '<json>'`: Windows PowerShell 5.1 strips the inner double quotes from a native-command argument, which breaks the JSON. Only one of `--save`, `--save-file`, `--stdin` per call.
   ```bash
   node "<broker-cli>" onboarding --save-file <path-to-json>
   ```
   Example with every accepted key (fill it from the answers):
   ```json
   {
     "version": 1,
     "completed": true,
     "skipped": false,
     "completedAt": null,
     "brokerManagedServers": ["context7", "serena"],
     "tracker": { "kind": "itsaplan", "mcpServer": "itsaplan" },
     "trackers": [
       { "kind": "itsaplan", "mcpServer": "itsaplan" },
       { "kind": "linear", "mcpServer": "linear" }
     ],
     "memtrace": { "enabled": true },
     "reviewRouting": {
       "strategy": "headless_always",
       "headlessBackend": "codex",
       "headlessModel": null,
       "effort": "high"
     },
     "compaction": { "transcriptThresholdKb": 550 }
   }
   ```
   - A save sets `completed: true` unless the input has `skipped: true`; an explicit `completed: false` is kept. `completedAt` is filled in when `null`.
   - Unknown top-level keys are rejected. Tracker `kind` is exactly `none`, `linear`, `itsaplan`, `github` or `other` (lowercase). `reviewRouting.strategy` is `antigravity_gemini_only`, `antigravity_first` or `headless_always`; `headlessBackend` is `null`, `claude` or `codex`; `headlessModel` is a string or `null`; `effort` is a string; `memtrace.enabled` is a boolean; `transcriptThresholdKb` is a number.
   - Invalid JSON reports only a line and column, not the text; fix the file and save again.
   - If the user chose to skip onboarding entirely:
     ```bash
     node "<broker-cli>" onboarding --skip
     ```
   - Confirm what was configured in 2–3 lines, then immediately resume the user's original request.
