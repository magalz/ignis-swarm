import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BLIND_REVIEW_FALLBACK_TTL_MS,
  blindReviewStatePath,
  normalizeWorkspaceKey,
  recordBlindReviewState,
  hasFreshNativeFallback,
} from "../scripts/broker/onboarding.mjs";

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("blind review fallback is fresh within TTL and false after expiry, skew, or opt-out", () => {
  const dir = mkTemp("ignis-blind-");
  try {
    const cwd = path.join(dir, "Work");
    const now = 1795740000000;
    recordBlindReviewState(dir, cwd, { fallbackToNative: true, reason: "r", nowMs: now });
    assert.equal(path.basename(blindReviewStatePath(dir)), "blind-review-state.json");
    assert.equal(hasFreshNativeFallback(dir, [cwd], now + 1000), true);
    assert.equal(hasFreshNativeFallback(dir, ["", cwd], now + BLIND_REVIEW_FALLBACK_TTL_MS), true);
    assert.equal(hasFreshNativeFallback(dir, [cwd], now + BLIND_REVIEW_FALLBACK_TTL_MS + 1), false);
    assert.equal(hasFreshNativeFallback(dir, [cwd], now - 1), false);
    if (process.platform === "win32") {
      assert.equal(hasFreshNativeFallback(dir, [cwd.toUpperCase()], now), true);
    }
    recordBlindReviewState(dir, cwd, { fallbackToNative: false, nowMs: now });
    assert.equal(hasFreshNativeFallback(dir, [cwd], now), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordBlindReviewState prunes expired entries", () => {
  const dir = mkTemp("ignis-blind-");
  try {
    const now = 1795740000000;
    recordBlindReviewState(dir, "/old", { fallbackToNative: true, nowMs: now - BLIND_REVIEW_FALLBACK_TTL_MS - 5 });
    const state = recordBlindReviewState(dir, "/new", { fallbackToNative: true, nowMs: now });
    const disk = JSON.parse(fs.readFileSync(blindReviewStatePath(dir), "utf8"));
    assert.deepEqual(Object.keys(disk.workspaces), [normalizeWorkspaceKey("/new")]);
    assert.deepEqual(state, disk);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hasFreshNativeFallback fails safe on missing or corrupt state", () => {
  const dir = mkTemp("ignis-blind-");
  try {
    assert.equal(hasFreshNativeFallback(dir, ["/x"]), false);
    fs.writeFileSync(blindReviewStatePath(dir), "{not json");
    assert.equal(hasFreshNativeFallback(dir, ["/x"]), false);
    fs.writeFileSync(blindReviewStatePath(dir), "null");
    assert.equal(hasFreshNativeFallback(dir, ["/x"]), false);
    fs.writeFileSync(
      blindReviewStatePath(dir),
      JSON.stringify({
        workspaces: {
          [normalizeWorkspaceKey("/x")]: { fallbackToNative: true, timestampMs: null },
        },
      })
    );
    assert.equal(hasFreshNativeFallback(dir, ["/x"], 1000), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hasFreshNativeFallback matches ancestor-or-equal boundaries directionally, resolves symlinks, and rejects nested-to-parent and sibling prefixes", () => {
  const parentData = mkTemp("ignis-blind-parent-");
  const subData = mkTemp("ignis-blind-sub-");
  const rootData = mkTemp("ignis-blind-root-");
  const wsRoot = mkTemp("ignis-blind-ws-");
  try {
    const repo = path.join(wsRoot, "repo");
    const sub = path.join(repo, "packages", "app");
    const subChild = path.join(sub, "src");
    const otherSub = path.join(repo, "packages", "other");
    const sibling = path.join(wsRoot, "repo-other");
    const link = path.join(wsRoot, "repo-link");
    fs.mkdirSync(subChild, { recursive: true });
    fs.mkdirSync(otherSub, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");

    const now = 1795740000000;

    recordBlindReviewState(parentData, repo, { fallbackToNative: true, reason: "parent", nowMs: now });
    assert.equal(hasFreshNativeFallback(parentData, [repo], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [sub], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [repo, sub], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [repo, sibling], now), false);
    assert.equal(hasFreshNativeFallback(parentData, [], now), false);
    assert.equal(hasFreshNativeFallback(parentData, ["", "   "], now), false);
    assert.equal(hasFreshNativeFallback(parentData, [link], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [path.join(link, "packages", "app")], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [sibling], now), false);
    assert.equal(hasFreshNativeFallback(parentData, [path.join(sibling, "packages", "app")], now), false);

    recordBlindReviewState(parentData, sub, { fallbackToNative: false, reason: "sub-cleared", nowMs: now + 1 });
    assert.equal(hasFreshNativeFallback(parentData, [sub], now + 1), false);
    assert.equal(hasFreshNativeFallback(parentData, [subChild], now + 1), false);
    assert.equal(hasFreshNativeFallback(parentData, [repo, sub], now + 1), false);
    assert.equal(hasFreshNativeFallback(parentData, [repo], now + 1), true);
    assert.equal(hasFreshNativeFallback(parentData, [otherSub], now + 1), true);

    recordBlindReviewState(subData, sub, { fallbackToNative: true, reason: "sub", nowMs: now });
    assert.equal(hasFreshNativeFallback(subData, [sub], now), true);
    assert.equal(hasFreshNativeFallback(subData, [subChild], now), true);
    assert.equal(hasFreshNativeFallback(subData, [path.join(link, "packages", "app")], now), true);
    assert.equal(hasFreshNativeFallback(subData, [repo], now), false);
    assert.equal(hasFreshNativeFallback(subData, [link], now), false);
    assert.equal(hasFreshNativeFallback(subData, [otherSub], now), false);
    assert.equal(hasFreshNativeFallback(subData, [sibling], now), false);

    const rootPath = path.parse(repo).root;
    recordBlindReviewState(rootData, rootPath, { fallbackToNative: true, reason: "root", nowMs: now });
    assert.equal(hasFreshNativeFallback(rootData, [rootPath], now), true);
    assert.equal(hasFreshNativeFallback(rootData, [repo], now), true);
  } finally {
    fs.rmSync(parentData, { recursive: true, force: true });
    fs.rmSync(subData, { recursive: true, force: true });
    fs.rmSync(rootData, { recursive: true, force: true });
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
});

test("recordBlindReviewState cleans up temp and lock files when rename fails", () => {
  const dir = mkTemp("ignis-blind-tmp-");
  try {
    fs.mkdirSync(blindReviewStatePath(dir));
    assert.throws(() => recordBlindReviewState(dir, "/work", { fallbackToNative: true }));
    const leftovers = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordBlindReviewState recovers stale lock and serializes concurrent multi-process writes", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkTemp("ignis-blind-conc-");
  const wsBase = mkTemp("ignis-blind-conc-ws-");
  try {
    const lockPath = `${blindReviewStatePath(dir)}.lock`;
    fs.writeFileSync(lockPath, "999999\n", "utf8");
    const staleDate = new Date(Date.now() - 15000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const staleTarget = path.join(wsBase, "stale-recovered");
    fs.mkdirSync(staleTarget, { recursive: true });
    recordBlindReviewState(dir, staleTarget, { fallbackToNative: true, reason: "recovered" });
    assert.equal(hasFreshNativeFallback(dir, [staleTarget]), true);
    assert.equal(fs.existsSync(lockPath), false);

    fs.writeFileSync(lockPath, "888888:stale\n", "utf8");
    fs.utimesSync(lockPath, staleDate, staleDate);

    const modUrl = new URL("../scripts/broker/onboarding.mjs", import.meta.url).href;
    const workerCount = 6;
    const targets = Array.from({ length: workerCount }, (_, idx) => {
      const p = path.join(wsBase, `ws-${idx}`);
      fs.mkdirSync(p, { recursive: true });
      return p;
    });

    await Promise.all(
      targets.map(
        (wsDir, idx) =>
          new Promise((resolve, reject) => {
            const script = [
              `import { recordBlindReviewState } from ${JSON.stringify(modUrl)};`,
              `recordBlindReviewState(${JSON.stringify(dir)}, ${JSON.stringify(wsDir)}, { fallbackToNative: true, reason: "w-${idx}" });`,
            ].join("\n");
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
              stdio: "pipe",
              windowsHide: true,
            });
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("exit", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`worker ${idx} exited ${code}: ${stderr}`));
            });
          }),
      ),
    );

    assert.equal(hasFreshNativeFallback(dir, [staleTarget]), true);
    for (const wsDir of targets) {
      assert.equal(hasFreshNativeFallback(dir, [wsDir]), true, `missing marker for ${wsDir}`);
    }
    const leftovers = fs
      .readdirSync(dir)
      .filter(
        (name) =>
          name.endsWith(".tmp") ||
          name.endsWith(".lock") ||
          name.endsWith(".reclaim") ||
          name.endsWith(".stale"),
      );
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wsBase, { recursive: true, force: true });
  }
});
