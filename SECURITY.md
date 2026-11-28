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

`ignis-swarm` bundles local lifecycle hooks, a localhost MCP broker daemon and a headless blind review runner. This section states what each protects, and where the protection stops.

### Broker daemon
- **Localhost only.** `ignis-broker` binds to `127.0.0.1` on an ephemeral port, authenticates every HTTP request with a per-run random Bearer token compared with `crypto.timingSafeEqual`, and caps request bodies at 16 MiB.
- **Folder and file permissions.** On POSIX the broker data directory, `audit/` and `spill/` are created with mode `0700`, and the files it writes (`servers.json`, `.env`, `onboarding.json`, trust records, audit logs, spill files, daemon info) with mode `0600`; the data directory is tightened to `0700` if it was wider. On Windows these mode bits have no effect: the folders rely on the access control lists inherited from your user profile, so keep `~/.ignis-broker` inside it.
- **Shim execution.** Node/npm `.cmd` shims on Windows are unwrapped to `process.execPath` with `shell: false`; other `.cmd`/`.bat` invocations reject CR, LF, NUL and double quotes in the command and its arguments, and quote the remaining arguments for `cmd.exe`.

### Secrets
- **`import-mcp` and `register-mcp` move literal secrets to `.env`.** Literal `env` and header values go into `~/.ignis-broker/.env` (mode `0600` on POSIX) as `IGNIS_<SERVER>_<KEY>`, leaving a `${VAR}` reference in `servers.json`. `add-http-mcp --auth-env VAR` only writes a `${VAR}` reference and stores no value; a server you write into `servers.json` by hand keeps whatever you typed. A value containing CR or LF is rejected, because it cannot be stored safely in `.env`. `~/.gemini/config/mcp_config.json` is never modified.
- **`${VAR}` expansion is global-only.** References are expanded from `.env` or the process environment when the broker resolves the config for a call, in the global `servers.json` only. A repository-local config is never expanded.
- **Redaction.** Errors the broker returns (stdio, HTTP and MCP errors, fallback errors, and the errors and fallbacks shown by `status`) mask the expanded `${VAR}` values, header values (and the token after a scheme such as `Bearer`), URL credentials and URL query values, and every stdio `env` value of 4 or more characters, as `***`. Shorter values are not masked. The configs printed by `import-mcp` and `discover-mcp` are redacted separately: every `env` and header value becomes `***REDACTED***` whatever its length, and URL credentials and query are dropped. A JSON parse error in a local config reports only the line and column, never the file's text. A secret an upstream server echoes in a shape the broker does not know is not masked.
- **Audit log.** `PostToolUse` appends one JSON line per tool call to `audit/<conversation>.jsonl` in the broker data folder (`~/.ignis-broker/audit/` by default; `IGNIS_BROKER_DATA` or `IGNIS_BROKER_HOME` move it). The stored command is cut to 240 characters. Only the `run_command` text is redacted, by pattern (URL passwords, `Authorization` values, values after secret-looking keys or flags, and well-known token shapes such as GitHub, GitLab, Slack, OpenAI-style and AWS keys, and JWTs); a secret in another shape stays in the log. The tool's `error` field and `Path` argument are stored as they are. At 5 MiB the log is renamed to `<conversation>.1.jsonl`, replacing any earlier `.1` file, and a new log starts.

### Repository-local broker configs
A `.agents/ignis-broker.json` can start processes, so it is untrusted by default.
- It is found only inside a git repository, and is **ignored until you run `ignis-broker trust --cwd <repo>`**. The broker stores the SHA-256 of the file's exact bytes; **any edit voids the trust** until you trust it again. Run `trust --list` to review and `trust --revoke` to withdraw.
- `${VAR}` is never expanded in a local config, so a repository cannot make the broker read your `.env` or environment.
- A symlinked config, or one that resolves outside its own `.agents` folder, is refused both when you trust it and each time it is loaded.
- **Limits.** The hash covers the config file only: not the scripts or binaries a trusted command runs, which can change without voiding trust. A hard link to the config cannot be detected. Trust means "I accept what this file starts", so read the commands first.
- An agent that runs `node ... ignis-broker.mjs trust` always triggers a confirmation prompt (`force_ask`) from the command guard; only you can approve it.

### Command guard (`hooks/pre-tool-use.mjs`)
- **Denied:** `--no-verify` (and `commit -n`) or a `core.hooksPath` override on `commit`, `push`, `merge`, `rebase` and `cherry-pick`, plain force-pushes (`--force`, `-f` or a `+refspec`) whose refspec names `main` or `master`, and deleting those branches remotely, `git reset --hard`, and deleting a filesystem root or home directory.
- **Asks you first (`force_ask`):** other force-pushes (including a bare `git push --force`, and `--force-with-lease` or `--force-if-includes` to any branch, `main` included) and mirror pushes, `git clean` with force, `node ... ignis-broker.mjs trust`, and command lines nested or large enough that the parser stops analysing them.
- **Limits.** The guard reads the command words of the text the agent sends, through shells, `-c` payloads, pipes and a set of interpreters' expressions. It is not a sandbox: it does not watch what a program does once it runs, it cannot see a command assembled at run time or inside a script file, and a tool it does not know can still do harm. Treat it as a guardrail against common mistakes, not a security boundary against a hostile agent.

### Blind review isolation
- Headless Claude Code reviews run with the diff on standard input, no tools (`--tools ""`), no setting sources (`--setting-sources ""`), slash commands disabled, `--strict-mcp-config` with an empty MCP config, and no session persistence, so the reviewer sees only the diff. Codex CLI runs use `--sandbox read-only`; its flags have not been verified against every release.
- The native `blind-edge-hunter` subagent has `grep_search`, `find_by_name` and a `run_command` limited to `git diff`; it has no file viewer and no MCP. It is instructed, not technically prevented, to stay inside the diff.

### In Scope
- Command injection, shell/argument breakout, or path traversal in `scripts/` or `hooks/`.
- Secret leakage in `discover-mcp`, `onboarding --probe`, broker status/logs, or spill files.
- Authentication bypass or unauthorized local access against `ignis-broker` HTTP endpoints.
- Guardrail bypasses in `hooks/pre-tool-use.mjs` or `hooks/stop-gate.mjs` (the command guard is a guardrail, not a sandbox; a bypass is in scope when a documented deny or ask rule can be evaded).

### Out of Scope
- Vulnerabilities in third-party MCP servers or external CLIs (`claude`, `codex`, `memtrace`) configured by the user.
- Issues requiring pre-existing local arbitrary code execution as the same OS user.
