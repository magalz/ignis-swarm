---
name: ignis-audit-docs
description: Use in Phase 3 (@doc-auditor) or whenever recording technical decisions (ADRs), business decisions (BDRs), or operational playbooks. Enforces 1 file per decision + INDEX.md in the repository and optional syncing to a connected issue tracker.
---

# Ignis Audit Docs (Phase 3 — Auditable Documentation)

Code explains **what**; ADRs, BDRs, and Playbooks explain **why**.
**Never** dump multiple ADRs or BDRs into one monolithic markdown file. Always create **1 file per decision** and keep a lean **`INDEX.md`** table for fast progressive lookup.

## Templates
- [index-template.md](./references/index-template.md) — `docs/adr/INDEX.md` and `docs/bdr/INDEX.md`
- [adr-template.md](./references/adr-template.md) — `docs/adr/ADR-NNN-kebab-slug.md`
- [bdr-template.md](./references/bdr-template.md) — `docs/bdr/BDR-NNN-kebab-slug.md`

## Step-by-Step Procedure

1. **Read existing indexes first:**
   - Open `docs/adr/INDEX.md` and `docs/bdr/INDEX.md` (create them from [index-template.md](./references/index-template.md) if absent).
   - Determine the next sequential number (`ADR-NNN` / `BDR-NNN`) and check if any prior decision is now `superseded-by:<NEW-ID>`, `refuted`, `deprecated`, or `stale`.
2. **Write 1 file per decision (hardcopy in repo):**
   - Technical architecture/library/data-model/concurrency choice → `docs/adr/ADR-NNN-kebab-slug.md`
   - Business rule, invariant, pricing/compliance/domain policy → `docs/bdr/BDR-NNN-kebab-slug.md` (must cite the exact BDD test file proving the rule!)
   - Operational/runbook/deploy change → `docs/playbooks/<kebab-slug>.md`
3. **Update `INDEX.md`:**
   - Add 1 row for every new file and update the `Status` / `Superseded By` columns of any affected older decision.
   - *(Enforced deterministically by `hooks/stop-gate.mjs`.)*
4. **Opt-In Tracker Audit Trail (only when `onboarding.json` `tracker.kind !== "none"`):**
   - Issue-tracker syncing is strictly **opt-in**. Follow [tracker-profiles.md](./references/tracker-profiles.md) for the active tracker profile (GitHub Issues, Jira, Linear, ClickUp, etc.).
   - When enabled, link or mirror the ADR/BDR in the connected tracker and post a concise decision audit comment on each affected card containing:
     - Decision ID (`ADR-NNN` / `BDR-NNN`) & repo path
     - 1–2 line summary of the decision and why alternatives were rejected
     - Verification proof (test file / command)
5. **Report to Coordinator:** List every created/updated file, `INDEX.md` status changes, and any tracker links/comments posted.
