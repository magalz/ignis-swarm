---
name: ignis-tdd-bdd
description: Use when implementing code or tests in ignis-swarm. Enforces outer-loop BDD (Given/When/Then) paired with inner-loop TDD (Red-Green-Refactor), anti-Goodhart/anti-over-mocking discipline, zero narrative inline comments, and optional incremental mutation testing on the diff.
---

# Ignis TDD + BDD Discipline

## 1. Outer Loop — BDD (Behavior First)
Before writing implementation code, translate the task's `Given / When / Then` acceptance criteria into executable behavioral tests:
- Assert **observable outcomes** (return values, state transitions, persisted records, HTTP/CLI outputs, emitted events)—never internal helper call counts or private fields.
- Cover happy path, boundary values, invalid inputs, and failure/error paths specified in the brief.

## 2. Inner Loop — TDD (`Red → Green → Refactor`)
1. **Red:** Write the failing test first and run it. Record the failing output as evidence that the test actually detects missing behavior.
2. **Green:** Write the **smallest YAGNI implementation** that makes the test pass. Validate at boundaries (`boundary-discipline`); keep core logic pure.
3. **Refactor:** Simplify duplication and collapse unnecessary wrappers while keeping tests green.
4. **Zero narrative comments:** Remove any inline explanatory comments. If a non-obvious technical or business constraint drove the design, note it in your board report for `@doc-auditor` (`[ADR]` / `[BDR]`).

## 3. Anti-Goodhart & Anti-Over-Mocking Rules
- **No coverage gaming:** Never write tautological tests (getters/setters, constant assertions, `expect(x).toBeDefined()` alone) just to inflate line coverage.
- **Mock boundaries only:** Mock external I/O, network calls, system clock, or third-party APIs. Do **not** mock sibling domain units or internal collaborators you just wrote.
- **Factual reporting:** Run the project's coverage command if available and report the real percentage on the board—the human operator owns the quality threshold and decides if a hardening pass is needed.

## 4. Incremental Mutation Testing (On-Demand Hardening / Slice Closure)
When running a hardening pass or critical slice audit, test only modified lines to prove tests kill real logic faults:
- **Rust:** `cargo mutants --in-diff <(git diff main...HEAD)` (or `--file <path>`)
- **Go:** `gremlins unleash --diff main` (or targeted package run)
- **TypeScript / JS:** `npx stryker run --incremental` (or `--mutate <changed-files>`)
- **Python:** `mutmut run --paths-to-mutate <changed-files>`

Any surviving mutant in core domain logic is treated as a proven test gap.
