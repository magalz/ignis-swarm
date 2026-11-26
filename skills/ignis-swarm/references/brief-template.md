# Nuclear Worker Brief Template (Mandatory 5 Fields)

Every coding or mechanical worker brief posted on the `/swarm` board MUST follow this exact 5-field structure:

```markdown
@<worker-name>

### 1. Task & Goal
- **Task / Issue:** #<id> — <title>
- **Objective:** <1–2 crisp sentences stating the exact nuclear responsibility>

### 2. Exclusive File Ownership & Frozen Contracts
- **You own (writable):** `<file1>`, `<file2>`
- **Frozen contracts (read-only, do not alter):** `<contract/types file or exact signatures>`
- **Out of scope (do NOT touch):** everything outside your owned files.

### 3. Requirements (BDD + TDD)
- **Skill to follow:** `ignis-tdd-bdd`
- **Targeted Discovery:** read `docs/adr/INDEX.md` / `docs/bdr/INDEX.md` (if relevant) and use targeted symbol search before broad file reads.
- **BDD Criteria:**
  - Given <precondition>, when <action>, then <observable outcome>.
  - Edge case: <boundary / failure condition>.
- **Testing policy:** Write failing test first (Red), minimal YAGNI implementation (Green), clean refactor. Cover all behavioral paths and edge cases; mock only external boundaries. Do NOT chase arbitrary coverage percentages.

### 4. Code & Documentation Constraints
- **Zero narrative inline comments.** Public API docstrings allowed only where idiomatic.
- **Audit flags:** `<none | [ADR] note technical choice | [BDR] note business rule>` — record any decision notes in your board report for `@doc-auditor`.

### 5. Done Gate & Board Report Format
Run `<exact test/check command>` and report back to `@verifier` and `@coordinator`:
- **Status:** `PASS` | `ISSUES` | `BLOCKED`
- **Evidence:** exact command(s) + real output (including Red → Green proof)
- **Observed coverage:** `<% reported factually>`
- **Decisions for `@doc-auditor`:** `<none or bullet list>`
```
