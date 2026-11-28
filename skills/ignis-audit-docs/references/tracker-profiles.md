# Opt-In Issue Tracker Profiles

> **All trackers are opt-in.** `onboarding.json` holds a `trackers` list of `{ kind, mcpServer }` entries (`kind`: `linear`, `itsaplan`, `github`, or `other`). When `trackers` is empty (the default), skip all tracker calls and keep plans, ADRs (`docs/adr/`), BDRs (`docs/bdr/`), and playbooks (`docs/playbooks/`) strictly in the local repository. When it has entries, apply each action to **every** entry using that entry's profile column (`tracker` is a legacy single-entry field; use `trackers`).

## Action Mapping by Tracker Profile

| Action | none (empty `trackers`) | `linear` (`https://mcp.linear.app/mcp`) | `itsaplan` (Streamable HTTP MCP) | `github` (GitHub Issues MCP) |
| :--- | :--- | :--- | :--- | :--- |
| **1. Fetch epic / issues** | Skip — read local plan & `docs/adr/INDEX.md`, `docs/bdr/INDEX.md` | `list_issues` / `get_issue` / `get_project` | `list_projects` / `get_project` / `list_issues` / `search_issues` / `get_issue` / `get_issue_by_number` | `list_issues` / `get_issue` (or `gh issue view`) |
| **2. Create / update tasks** | Skip — track tasks in local plan / `/swarm` board | `create_issue` / `update_issue` | `create_issue` / `update_issue` / `move_issue` | `create_issue` / `update_issue` |
| **3. Create ADR / BDR doc** | Write `docs/adr/ADR-NNN-*.md` or `docs/bdr/BDR-NNN-*.md` + update `INDEX.md` | Write repo file + `INDEX.md`, optionally mirror via `create_document` | Write repo file + `INDEX.md`, optionally mirror via `create_document` | Write repo file + `INDEX.md` (repo is source of truth) |
| **4. Link doc to issue** | Skip — cross-reference in `INDEX.md` | `update_issue` / `create_attachment` with repo path or doc URL | `link_document_issue` (doc to issue) / `link_issues` (issue to issue) | Reference repo path / commit URL in issue body or comment |
| **5. Post decision audit comment** | Skip — record in `INDEX.md` & board report | `create_comment` with `ADR-NNN`/`BDR-NNN`, repo path, 1–2 line rationale, verification proof | `add_comment` with the same content | `add_issue_comment` with the same content |

For `other`, use the tools of the entry's `mcpServer` that match each action; skip an action that has no tool.

## Notes
- Prefer routing managed MCP calls through `ignis-broker` (`ignis-swarm_broker` meta-tools or CLI) when registered.
- Never block Phase 3 (`@doc-auditor`) on a tracker outage; commit the local repo ADR/BDR + `INDEX.md` first and report any skipped tracker sync in the board report.
