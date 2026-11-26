# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.x` | Yes |
| `< 1.0` | No |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities via public GitHub issues, discussions, or pull requests.**

Instead, use **GitHub Private Vulnerability Reporting** to submit a confidential report directly to the maintainer:

- **[Report a vulnerability privately](https://github.com/magalz/ignis-swarm/security/advisories/new)**

Please include:
- A clear description of the vulnerability and its potential impact.
- Exact steps to reproduce (or a minimal proof-of-concept).
- Affected file(s), OS/platform (macOS, Linux, Windows), and Node.js version.

### Response Timeline
- **Acknowledgement:** Within 72 hours.
- **Triage & Fix Plan:** Within 7 days for confirmed issues.
- **Coordinated Disclosure:** A patched release and advisory will be published once a fix is verified.

---

## Security Architecture & Scope

Because `ignis-swarm` bundles local lifecycle hooks, a localhost MCP broker daemon, and a headless blind review runner, security boundaries are enforced structurally:

- **Localhost-only broker daemon:** `ignis-broker` binds exclusively to `127.0.0.1` on an ephemeral port, authenticates every HTTP request with a per-run random Bearer token compared via `crypto.timingSafeEqual`, and caps HTTP request bodies at 16 MB.
- **Restrictive local permissions:** State directories (`~/.ignis-broker`, `audit/`, `spill/`) are created with mode `0o700` and sensitive files (`servers.json`, `onboarding.json`, audit JSONL, compaction state) with mode `0o600`.
- **Secret isolation & redaction:** Environment/header secrets referenced as `${VAR}` are expanded from `~/.ignis-broker/.env` or process environment only at backend invocation time, redacted in diagnostics/probes, and `~/.gemini/config/mcp_config.json` is never modified.
- **Command & shim execution safety:** Node/npm `.cmd` shims on Windows are unwrapped directly to `process.execPath` with `shell: false`; non-Node `.cmd`/`.bat` invocations reject `\r`, `\n`, `\0`, and quote/metacharacter breakout characters.
- **Adversarial review isolation:** The bundled `blind-edge-hunter` subagent runs read-only with `inheritMcp: false` and `commandExecutionPolicy: sandbox`; headless Claude Code runs use `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode dontAsk --allowedTools Read Grep Glob --no-session-persistence`, and Codex CLI runs use `--sandbox read-only`.
- **Destructive command guardrails:** `hooks/pre-tool-use.mjs` blocks `--no-verify`, force-pushes to `main`/`master`, `git reset --hard`, and destructive root/wildcard deletions.

### In Scope
- Command injection, shell/argument breakout, or path traversal in `scripts/` or `hooks/`.
- Secret leakage in `discover-mcp`, `onboarding --probe`, broker status/logs, or spill files.
- Authentication bypass or unauthorized local access against `ignis-broker` HTTP endpoints.
- Guardrail bypasses in `hooks/pre-tool-use.mjs` or `hooks/stop-gate.mjs`.

### Out of Scope
- Vulnerabilities in third-party MCP servers or external CLIs (`claude`, `codex`, `memtrace`) configured by the user.
- Issues requiring pre-existing local arbitrary code execution as the same OS user.
