# ADR-003: Per-Workspace Process Pooling and Cross-Platform Tree Cleanup

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

Workspace-scoped local MCP servers anchor their indexes or state on their working directory and often spawn nested subprocesses (such as `.cmd` shims on Windows or worker trees on Unix). Sharing a single global child across repositories causes cross-repo state leaks, while killing only the top process leaves orphaned grandchildren holding file locks.

## Decision

1. Key `Supervisor` pool entries by `(server, source, scope)` where `perWorkspace: true` servers resolve `scope` to canonical `repoRoot` (`.git` root), bounded by `maxWorkspaceInstances` (LRU eviction) and `idleTimeoutSecs` reaping.
2. Terminate evicted or stopped child process trees using `taskkill /PID <pid> /T /F` on Windows and process-group signaling (`-pid`) on Unix.

## Consequences

- Multi-repository sessions stay isolated without unbounded RAM growth or orphaned child locks across Windows, macOS, and Linux.
