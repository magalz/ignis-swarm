---
name: ignis-benchmark
description: On-demand methodological audit for performance measurements, speedups, latency/throughput claims, or regressions ("explain the number"). Use before trusting or reporting any benchmark result.
---

# Ignis Benchmark Audit (Explain the Number)

Before trusting, reporting, or acting on any measured performance number (latency, throughput, memory, speedup, or regression), answer all 6 checks with real evidence:

1. **What is the true limiter?** Identify whether the measured path is CPU-bound, memory/allocation-bound, I/O-bound, lock-contended, or dominated by harness/startup overhead.
2. **Did it measure the right work?** Rule out dead-code elimination, warm-cache artifacts, cold-start bias, or benchmark harness noise.
3. **Controlled baseline:** Compare before vs. after on the exact same machine, commit base, input dataset, and build mode (e.g., `--release` in Rust, `-bench` with `-count=5` in Go).
4. **Repeat runs & distribution:** Report multiple samples (median + p95/variance, not a single lucky run).
5. **Correctness & errors:** Confirm zero silent errors, dropped work, or degraded accuracy in the faster variant.
6. **End-to-end relevance:** State how much the micro-optimization actually moves the end-to-end user or system metric.

If any check fails, mark the number as **Unverified** and re-run with a corrected harness before claiming a win.
