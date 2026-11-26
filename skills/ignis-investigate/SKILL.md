---
name: ignis-investigate
description: On-demand read-only playbook for parallel codebase investigations or root-cause forensics using targeted symbol lookup and read-only /swarm workers. Never modifies code; separates verified facts from inferences.
---

# Ignis Investigate (On-Demand Read-Only Playbook)

Use for read-only architectural questions, incident forensics, or pre-planning deep dives.

## Steps
1. **Targeted Map:** Use symbol/code search and read `docs/adr/INDEX.md` / `docs/bdr/INDEX.md` to partition the question cleanly before broad file reads.
2. **Parallel Read-Only Tracks (when broad):**
   - Spawn 2–4 read-only `/swarm` workers (use lightweight/mechanical tier for log/import collection, standard/balanced tier for semantic tracing).
   - Every worker brief explicitly states: **read-only — do not edit any files**.
3. **Evidence Discipline:**
   - Every claim must cite `file:line`, command output, or git commit/ADR record.
   - Explicitly label each statement as **Observed**, **Inferred**, or **Unknown**.
4. **Consolidated Report:** Synthesize into a single ranked answer without pasting raw worker dumps.
