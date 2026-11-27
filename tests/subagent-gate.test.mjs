import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordBlindReviewState } from "../scripts/broker/onboarding.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function runHook(scriptRelPath, inputObj, extraEnv = {}) {
  const scriptPath = path.join(PLUGIN_ROOT, scriptRelPath);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 8000,
    windowsHide: true,
  });
  assert.equal(res.status, 0, `Hook ${scriptRelPath} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCompletedOnboarding(dataDir, overrides = {}) {
  const state = {
    version: 1,
    completed: true,
    skipped: false,
    completedAt: "2026-01-01T00:00:00.000Z",
    brokerManagedServers: [],
    tracker: { kind: "none", mcpServer: null },
    memtrace: { enabled: false },
    reviewRouting: {
      strategy: "antigravity_gemini_only",
      headlessBackend: null,
      headlessModel: null,
      effort: "high",
    },
    compaction: { transcriptThresholdKb: 550 },
    ...overrides,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "onboarding.json"), JSON.stringify(state, null, 2), "utf8");
}

const RUNNER = path.resolve(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");

function routing(strategy) {
  return {
    reviewRouting: {
      strategy,
      headlessBackend: strategy === "antigravity_gemini_only" ? null : "claude",
      headlessModel: null,
      effort: "high",
    },
  };
}

test("pre-tool-use gates blind-edge-hunter under headless_always", () => {
  const wsRoot = makeTempDir("ignis-gate-ws-");
  const projDir = path.join(wsRoot, "repo");
  const subDir = path.join(projDir, "packages", "app");
  const siblingDir = path.join(wsRoot, "repo-other");
  const homeDir = makeTempDir("ignis-gate-home-");
  const tempDirs = [wsRoot, homeDir];
  try {
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    const run = (strategy, args, seed, { cwd = projDir, workspacePaths = null, routingOverride = null } = {}) => {
      const dataDir = makeTempDir("ignis-gate-data-");
      tempDirs.push(dataDir);
      writeCompletedOnboarding(dataDir, routingOverride ? { reviewRouting: routingOverride } : routing(strategy));
      if (seed) seed(dataDir);
      const payload = { cwd, toolCall: { name: "invoke_subagent", args } };
      if (workspacePaths !== null) payload.workspacePaths = workspacePaths;
      return runHook(
        "hooks/pre-tool-use.mjs",
        payload,
        { IGNIS_BROKER_HOME: homeDir, IGNIS_BROKER_DATA: dataDir }
      );
    };
    const denied = run("headless_always", { TypeName: "blind-edge-hunter" });
    assert.equal(denied.decision, "deny");
    assert.ok(denied.reason.includes(`node "${RUNNER}" --base <base-sha> --backend auto`));
    assert.equal(run("headless_always", { typeName: "blind-edge-hunter" }).decision, "deny");
    assert.equal(run("headless_always", { TypeName: "", typeName: "blind-edge-hunter" }).decision, "deny");
    assert.equal(run("headless_always", { TypeName: "research", typeName: "blind-edge-hunter" }).decision, "deny");
    assert.equal(run("headless_always", { TypeName: "blind-edge-hunter", typeName: "research" }).decision, "deny");
    assert.equal(run("headless_always", { TypeName: "Blind-Edge-Hunter" }).decision, "deny");
    assert.equal(run("headless_always", { TypeName: "ignis-swarm:blind-edge-hunter" }).decision, "deny");
    assert.equal(run("headless_always", { TypeName: "ignis-swarm/blind-edge-hunter" }).decision, "deny");

    const seeded = run("headless_always", { TypeName: "blind-edge-hunter" }, (d) =>
      recordBlindReviewState(d, projDir, { fallbackToNative: true })
    );
    assert.equal(seeded.decision, "allow");

    const subFromParentSeeded = run(
      "headless_always",
      { TypeName: "blind-edge-hunter" },
      (d) => recordBlindReviewState(d, projDir, { fallbackToNative: true }),
      { cwd: subDir }
    );
    assert.equal(subFromParentSeeded.decision, "allow");

    const parentFromSubDenied = run("headless_always", { TypeName: "blind-edge-hunter" }, (d) =>
      recordBlindReviewState(d, subDir, { fallbackToNative: true })
    );
    assert.equal(parentFromSubDenied.decision, "deny");

    const siblingDenied = run(
      "headless_always",
      { TypeName: "blind-edge-hunter" },
      (d) => recordBlindReviewState(d, subDir, { fallbackToNative: true }),
      { cwd: siblingDir }
    );
    assert.equal(siblingDenied.decision, "deny");

    const mixedWorkspaceDenied = run(
      "headless_always",
      { TypeName: "blind-edge-hunter" },
      (d) => recordBlindReviewState(d, projDir, { fallbackToNative: true }),
      { cwd: projDir, workspacePaths: [projDir, siblingDir] }
    );
    assert.equal(mixedWorkspaceDenied.decision, "deny");

    const bothWorkspacesAllowed = run(
      "headless_always",
      { TypeName: "blind-edge-hunter" },
      (d) => {
        recordBlindReviewState(d, projDir, { fallbackToNative: true });
        recordBlindReviewState(d, siblingDir, { fallbackToNative: true });
      },
      { cwd: projDir, workspacePaths: [projDir, siblingDir] }
    );
    assert.equal(bothWorkspacesAllowed.decision, "allow");

    const emptyWorkspaceDenied = run(
      "headless_always",
      { TypeName: "blind-edge-hunter" },
      (d) => recordBlindReviewState(d, projDir, { fallbackToNative: true }),
      { cwd: "", workspacePaths: [""] }
    );
    assert.equal(emptyWorkspaceDenied.decision, "deny");

    const unconfDenied = run("headless_always", { TypeName: "blind-edge-hunter" }, null, {
      routingOverride: {
        strategy: "headless_always",
        headlessBackend: null,
        headlessModel: null,
        effort: "high",
      },
    });
    assert.equal(unconfDenied.decision, "deny");
    assert.match(unconfDenied.reason, /\(backend=unconfigured, model=none\)/);

    assert.equal(run("antigravity_first", { TypeName: "blind-edge-hunter" }).decision, "allow");
    assert.equal(run("antigravity_gemini_only", { TypeName: "blind-edge-hunter" }).decision, "allow");
    assert.equal(run("headless_always", { TypeName: "research" }).decision, "allow");
  } finally {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
