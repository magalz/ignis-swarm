---
id: ADR-009
title: "Node.js 22 Minimum and the CI Matrix"
status: accepted
date: 2026-11-27
superseded_by: null
issues: [AGYSWM-61, AGYSWM-10]
scope: [.github/workflows/ci.yml]
---

# ADR-009: Node.js 22 Minimum and the CI Matrix

**Refines ADR-001.** ADR-001 chose zero-dependency Node.js ESM and did not fix a minimum version.

## Context
- Node 20 is end of life, so it gets no fixes and is not worth testing.
- `node --test tests` (a directory argument) fails on Node 21 and later, so the suite runs through an unquoted shell glob: `node --test --test-timeout=180000 tests/*.test.mjs`.
- On Node 22, `--test-timeout` also limits each test file as a whole, not only each test. With 60000, CI on windows with Node 22 stopped `tests/blind-review-runner.test.mjs` at 60 seconds, before the file finished. The value is therefore 180000 (3 minutes), well above the 62 to 71 seconds that file takes on Node 26 locally; the job's `timeout-minutes: 15` still stops a hung run.
- The code uses only `node:*` built-ins (for example `AbortSignal.timeout`, `Object.hasOwn`, `fs.realpathSync.native`, `node:test`, and `import.meta.dirname` in tests). No code path found relies on an API that exists only from Node 22.

## Options Considered
1. **Keep Node 20 supported:** end of life, and CI would test a version nobody maintains.
2. **Test only the newest Node:** misses breakage on the oldest supported version.
3. **Support maintained releases and test the oldest and the newest (chosen).**

## Decision
The minimum supported Node.js is 22. CI (`.github/workflows/ci.yml`, introduced under AGYSWM-10) runs the full suite on:
- ubuntu on Node 22 and 24;
- windows on Node 22 and 24;
- macOS on Node 24.

The comment check (`.github/scripts/check-comments.mjs`) runs first. Coverage upload and `agy plugin validate` run on ubuntu with Node 24 only. Cells use `fail-fast: false`, and a final `ci` job requires every test cell to pass.

## Consequences
- **Positive:** the oldest and newest maintained versions are tested on the two platforms where process and path handling differ most.
- **Negative / Risks:**
  - macOS is tested on Node 24 only; macOS on Node 22 is untested.
  - The floor is a support policy backed by CI, not a version check in the code: nothing refuses to start on Node 20, and no Node 22-only API was identified. Older Node may work but is unsupported.
  - `README.md` and `CONTRIBUTING.md` said `>= 20` when this ADR was written; they must change to match it.

## Verification & Links
- **Code / Contracts:** `.github/workflows/ci.yml`
- **Tests:** the whole `tests/*.test.mjs` suite, run by the matrix
- **Tracker:** AGYSWM-61, AGYSWM-10
