---
name: ignis-bug-fix
description: On-demand playbook for standalone bugs or regressions outside a full slice. Enforces targeted root-cause tracing, mandatory failing reproduction test (TDD), attack-the-premise after 2 failed attempts, minimal YAGNI fix, and real runtime verification.
---

# Ignis Bug Fix (On-Demand Playbook)

Use for standalone bugs or regressions when a full multi-wave slice is unnecessary.

## Steps
1. **Targeted Localization:** Trace callers, callees, and blast radius using symbol search (and connected code-intelligence MCPs if available) plus relevant `docs/adr/INDEX.md` / `docs/bdr/INDEX.md` entries before editing.
2. **Mandatory Failing Repro (Red):** Write a minimal automated test (or reproducible command) that **fails on the current HEAD** and proves the exact symptom. Never edit production code before observing the failure.
3. **Root Cause (`fix-root-causes`):** Trace the symptom to the first place the invariant breaks. A defensive guard is only valid if the state is genuinely legitimate.
4. **Escalation Guard (`attack-the-premise`):** If 2 fixes sharing an assumption fail the repro gate, **stop**. Write down the shared premise explicitly and test that premise directly before attempting fix #3.
5. **Minimal Fix (Green + YAGNI):** Apply the smallest clean fix with zero narrative inline comments.
6. **Verify (`prove-it-works`):** Re-run the repro test + affected suite. If the fix changes a technical invariant or business rule, record an `[ADR]`/`[BDR]` via `ignis-audit-docs`.
