# Contributing to Ignis Swarm (`ignis-swarm`)

Thank you for your interest in contributing to **`ignis-swarm`**! This project is a **zero-dependency, cross-platform (macOS, Linux, Windows)** Node.js ESM plugin for Google Antigravity.

---

## Development Prerequisites

- **Node.js `>= 20`** (no `npm install` needed — zero external dependencies)
- **Git**
- **Google Antigravity CLI (`agy`)** for `agy plugin validate --strict .`

---

## Ground Rules

`ignis-swarm` follows the same engineering discipline it teaches in [`rules/AGENTS.md`](rules/AGENTS.md):

1. **Zero external dependencies:** Keep all runtime scripts, hooks, broker modules, and tests in pure Node.js ESM built-ins (`node:*`).
2. **Cross-platform parity:** Every change to hooks, `scripts/ignis-broker.mjs`, `scripts/broker/*`, or `scripts/run-blind-review.mjs` must work on macOS, Linux, and Windows (watch out for `.cmd`/`.bat` shims, `path.join`, and case-insensitive paths).
3. **BDD + TDD:** Write a failing behavioral test first (Red → Green → Refactor). Assert observable behavior and mock only external boundaries.
4. **Zero narrative inline comments:** Do not add narrative `//` comments in `.mjs`/`.js` files. Document architectural **why** in a 1-file ADR (`docs/adr/ADR-NNN-slug.md`) and update [`docs/adr/INDEX.md`](docs/adr/INDEX.md).
5. **Minimal, focused PRs (YAGNI):** Keep pull requests scoped to a single cohesive fix or feature.

---

## Local Verification Checklist

Before opening a pull request, run all checks locally and ensure they exit `0`:

```bash
# 1. Run the full automated test suite
node --test tests/*.test.mjs

# 2. Run strict Antigravity plugin validation (must pass with 0 errors and 0 warnings)
agy plugin validate --strict .

# 3. Verify zero narrative inline comments in hooks/ and scripts/
rg -n "(^|\s)//" hooks scripts
```

If you added or changed an architectural decision:
- Create `docs/adr/ADR-NNN-kebab-slug.md` (1 file per decision).
- Add its row to [`docs/adr/INDEX.md`](docs/adr/INDEX.md).

---

## Pull Request Process

1. Fork the repository and create a branch from `main` (e.g., `fix/windows-shim-quoting` or `feat/broker-timeout-flag`).
2. Implement your change with tests covering happy paths and edge cases.
3. Run the **Local Verification Checklist** above.
4. Open a Pull Request against `main` with:
   - A concise summary of **what** changed and **why**.
   - Exact test & validation commands run (and observed results).
   - Linked issue number (if applicable).

All PRs to `main` require passing CI checks (`ubuntu-latest` and `windows-latest`), resolved review threads, and maintainer approval.

---

## Security Reports

Please do **not** report security vulnerabilities in public issues or pull requests. Follow the private reporting process in [`SECURITY.md`](SECURITY.md).
