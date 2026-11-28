---
id: ADR-007
title: "Trust Gate for Repository-Local Broker Configs"
status: accepted
date: 2026-11-27
superseded_by: null
issues: [AGYSWM-61]
scope: [scripts/broker/trust.mjs, scripts/broker/config.mjs, scripts/ignis-broker.mjs, hooks/command-rules.mjs, scripts/broker/onboarding.mjs]
---

# ADR-007: Trust Gate for Repository-Local Broker Configs

**Refines ADR-002.** ADR-002 added a repository-local `.agents/ignis-broker.json` that overrides the global config. In v1.0.x it was loaded as soon as it was found. This ADR records the trust gate added in v1.1.0.

## Context
- A local broker config names commands, URLs, environment values and headers. Opening a cloned repository would start whatever its author wrote, with the user's rights.
- The config belongs to the repository, so its author controls it, not the user.

## Options Considered
1. **Load it as found (v1.0.x):** simple, but any cloned repository can launch processes through the broker.
2. **Trust by directory or by repository:** one approval covers later edits, so a `git pull` can change what runs without a new prompt.
3. **Trust the exact bytes, per real path (chosen):** any edit asks again, at the cost of one command after each deliberate change.
4. **Sandbox the commands:** out of scope for a zero-dependency Node plugin.

## Decision

### 1. Discovery
`discoverLocalConfig` (`scripts/broker/config.mjs`) looks for `.agents/ignis-broker.json` only inside a git repository: it walks up from `cwd` to the first directory holding `.git`, and stops there. It finds nothing if it reaches the user's home directory first, or if there is no `.git`.

### 2. Trust is by exact bytes
`ignis-broker trust [--cwd <dir>]` calls `trustLocalConfig` (`scripts/broker/trust.mjs`). It reads the file once, parses those same bytes as a JSON object, and records the real path and the SHA-256 of those bytes in `<dataDir>/trusted-local-configs.json` (`{version, configs: {<path>: {sha256, trustedAt}}}`, written to a temp file with mode `0600` and renamed into place). The hash and the parse come from the same bytes, so the file cannot change between them. Paths are resolved with `realpath` and lowercased on Windows. The command prints the servers it trusts through `describeServers` (`scripts/broker/config.mjs`): env and header values show as `***REDACTED***`, and URL credentials, query and fragment are removed. `trust --list` shows each entry as `trusted`, `changed` or `missing` (from `trustStatus`); `trust --revoke` removes one.

`readTrustedLocalConfig` reports `trusted` when the stored hash equals the hash of the current bytes, `changed` when it differs, and `untrusted` when there is no entry. Editing the file voids trust.

### 3. An untrusted config is ignored entirely
In `resolveConfig`, a local config that is not `trusted` contributes nothing: neither its servers nor its `defaults`. The broker uses the global config alone. The result carries `localConfigError`, which names the file, the reason (`not trusted yet` or `changed since it was trusted`) and the command that trusts it: `ignis-broker trust --cwd "<repo>"`. An unreadable or invalid config is reported as `invalid local config`.

### 4. `${VAR}` is never expanded in a local config
`resolveConfig` calls `normalizeServerConfig` with `expand = false` for local servers, so `${VAR}` in `env`, `url` or `headers` stays literal. A repository cannot make the broker read the user's `~/.ignis-broker/.env` into a request the repository controls. Global servers still expand.

### 5. Links are refused
`assertContained` requires the file's `realpath` to equal `<real parent of .agents>/.agents/ignis-broker.json`. A config that is a symlink or junction, or that sits in an `.agents` folder that is itself linked, is refused, both when trusting and when reading. It is reported as invalid and never loaded.

### 6. Guard and onboarding
- `hooks/command-rules.mjs` returns `force_ask` for a `node` command that runs `ignis-broker ... trust`, so the host asks the user before an agent can trust a config. This is a pattern match, not a sandbox (ADR-006).
- Onboarding's probe (`probeEnvironment` in `scripts/broker/onboarding.mjs`) reports `localBrokerConfig` (`path`, `trusted`, the same redacted server summary from `describeServers`, or `error`). Reviewing and trusting the local config is part of onboarding.

## Consequences
- **Positive:** a cloned repository cannot start servers or change broker defaults until the user has seen its servers and run one command. A later edit, including one pulled from upstream, asks again.
- **Negative / Risks:**
  - The hash covers the config file only. It does not cover the scripts, binaries or packages a trusted command runs; changing those does not void trust.
  - Hard links cannot be detected: `realpath` shows no difference, so a hard-linked config passes the containment check.
  - An agent can run `trust` itself. The `force_ask` rule makes the host ask, but it is a best-effort pattern scan, so an unusual spelling of the command may pass.
  - Local configs cannot use `${VAR}` for secrets; secrets belong in the global config.
  - After every legitimate edit the user must run `trust` again.
  - A corrupt or unreadable trust store reads as empty (nothing is trusted); `trust` and `--revoke` refuse to overwrite it.

## Verification & Links
- **Code / Contracts:** `scripts/broker/trust.mjs`, `scripts/broker/config.mjs` (`discoverLocalConfig`, `resolveConfig`, `normalizeServerConfig`, `describeServers`), `scripts/ignis-broker.mjs` (`cmdTrust`), `hooks/command-rules.mjs`, `scripts/broker/onboarding.mjs` (`probeEnvironment`)
- **Tests:** `tests/broker-trust.test.mjs`, `tests/broker-trust-cli.test.mjs`, `tests/onboarding-cli.test.mjs`, `tests/pre-tool-use.test.mjs`
- **Tracker:** AGYSWM-61
