# ADR-005: Cross-Platform Headless Blind Review Runners

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

Phase 4 blind diff auditing benefits from independent model diversity (e.g., Claude Code Opus and Codex CLI Sol alongside Antigravity's bundled `blind-edge-hunter`). Previously, invoking external reviewers relied on OS-specific shell scripts and hardcoded model identifiers or harness flags that broke across Windows/macOS/Linux, leaked host MCP servers into blind reviews, or failed when Codex updated its model catalog.

## Decision

1. **Single cross-platform Node.js runner (`scripts/run-blind-review.mjs`):** Replace OS-specific harnesses with one zero-dependency ESM script that captures the raw `git diff` and executes headless reviews consistently on Windows, macOS, and Linux.
2. **Three explicit `reviewRouting` strategies:** Configure Phase 4 routing in `~/.ignis-broker/onboarding.json` via `antigravity_gemini_only` (bundled `blind-edge-hunter` only), `antigravity_first` (`blind-edge-hunter` first, with optional external augmentation), or `headless_always` (always invoke headless external reviewers).
3. **Isolated Claude Code invocation (`--strict-mcp-config`):** Pass `--strict-mcp-config` with an empty MCP config when invoking Claude Code Opus so the blind reviewer cannot access host MCP servers, while preserving compatibility with both OAuth sessions and API key authentication.
4. **Dynamic Codex CLI Sol probing:** Probe `~/.codex/models_cache.json` and `~/.codex/config.toml` at runtime to select the available Sol/reasoning model instead of hardcoding model slugs that drift across Codex CLI releases.

## Consequences

- Blind diff reviews remain strictly isolated from host MCP tools and planning artifacts across all supported platforms.
- Users without external CLIs can run `antigravity_gemini_only` with zero setup, while users with Claude Code or Codex CLI get resilient, auto-probed headless reviews without maintaining custom wrapper scripts.
