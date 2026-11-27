import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, BROKER_VERSION } from "../scripts/broker/config.mjs";
import {
  BLIND_REVIEW_FALLBACK_TTL_MS,
  blindReviewStatePath,
  normalizeWorkspaceKey,
  recordBlindReviewState,
  hasFreshNativeFallback,
} from "../scripts/broker/onboarding.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_BIN = path.resolve(__dirname, "..", "scripts", "ignis-broker.mjs");

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, env = {}) {
  return execFileSync(process.execPath, [BROKER_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("discover-mcp --json returns all candidate MCPs with transport and zero secret values leaked", () => {
  const home = mkTemp("ignis-disc-home-");
  const srcDir = mkTemp("ignis-disc-src-");
  try {
    const mcpPath = path.join(srcDir, "mcp_config.json");

    fs.writeFileSync(
      path.join(home, "servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          linear: { transport: "http", url: "https://mcp.linear.app/mcp" },
        },
      })
    );

    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          linear: {
            serverUrl: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer super-secret-linear-token" },
          },
          sqlite: {
            command: "node",
            args: ["sqlite-mcp.mjs"],
            env: { DB_SECRET: "top-secret-db-pass" },
          },
          disabledSrv: {
            command: "node",
            args: ["off.mjs"],
            disabled: true,
          },
          "ignis-broker": {
            command: "node",
            args: ["ignis-broker.mjs", "mcp-bridge"],
          },
        },
      })
    );

    const out = runCli(["discover-mcp", "--from", mcpPath, "--json"], {
      IGNIS_BROKER_HOME: home,
    });

    assert.equal(out.includes("super-secret-linear-token"), false);
    assert.equal(out.includes("top-secret-db-pass"), false);

    const items = JSON.parse(out);
    assert.equal(items.length, 3);

    const linear = items.find((x) => x.name === "linear");
    assert.equal(linear.transport, "http");
    assert.equal(linear.alreadyManaged, true);
    assert.equal(linear.disabled, false);

    const sqlite = items.find((x) => x.name === "sqlite");
    assert.equal(sqlite.transport, "stdio");
    assert.equal(sqlite.alreadyManaged, false);
    assert.equal(sqlite.suggestedPerWorkspace, true);

    const disabledSrv = items.find((x) => x.name === "disabledSrv");
    assert.equal(disabledSrv.disabled, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test("register-mcp --servers b merges with pre-existing server a and prints registered list", () => {
  const home = mkTemp("ignis-reg-home-");
  const srcDir = mkTemp("ignis-reg-src-");
  try {
    const mcpPath = path.join(srcDir, "mcp_config.json");

    fs.writeFileSync(
      path.join(home, "servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          a: { transport: "stdio", command: "node", args: ["a.mjs"], perWorkspace: false, enabled: true },
        },
      })
    );

    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          b: { command: "node", args: ["b.mjs"] },
          c: { serverUrl: "https://c.example.com/mcp" },
        },
      })
    );

    const out = runCli(
      [
        "register-mcp",
        "--servers",
        "b",
        "--from",
        mcpPath,
        "--per-workspace",
        "b",
        "--cli-fallback",
        "b=linear",
      ],
      { IGNIS_BROKER_HOME: home }
    );

    assert.match(out, /Registered 2 server\(s\)/);
    assert.match(out, /- a \[stdio\]/);
    assert.match(out, /- b \[stdio\] \(perWorkspace, cliFallback=linear\)/);

    const saved = JSON.parse(fs.readFileSync(path.join(home, "servers.json"), "utf8"));
    assert.ok(saved.servers.a);
    assert.ok(saved.servers.b);
    assert.equal(saved.servers.c, undefined);
    assert.equal(saved.servers.b.perWorkspace, true);
    assert.equal(saved.servers.b.cliFallback, "linear");

    const resolved = resolveConfig(home, null);
    assert.equal(resolved.candidates.get("a")[0].config.cliFallback, null);
    assert.equal(resolved.candidates.get("b")[0].config.cliFallback, "linear");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test("add-http-mcp and unregister-mcp round-trip cleanly with ${VAR} header indirection", () => {
  const home = mkTemp("ignis-http-home-");
  try {
    const addOut = runCli(
      [
        "add-http-mcp",
        "itsaplan",
        "https://api.itsaplan.dev/mcp",
        "--auth-env",
        "ITSAPLAN_TOKEN",
        "--header-name",
        "Authorization",
      ],
      { IGNIS_BROKER_HOME: home }
    );
    assert.match(addOut, /Added HTTP server itsaplan/);

    const saved = JSON.parse(fs.readFileSync(path.join(home, "servers.json"), "utf8"));
    assert.equal(saved.servers.itsaplan.transport, "http");
    assert.equal(saved.servers.itsaplan.url, "https://api.itsaplan.dev/mcp");
    assert.equal(saved.servers.itsaplan.headers.Authorization, "Bearer ${ITSAPLAN_TOKEN}");

    const rmOut = runCli(["unregister-mcp", "itsaplan"], { IGNIS_BROKER_HOME: home });
    assert.match(rmOut, /Removed server itsaplan/);

    const after = JSON.parse(fs.readFileSync(path.join(home, "servers.json"), "utf8"));
    assert.equal(after.servers.itsaplan, undefined);

    const rmAgain = runCli(["unregister-mcp", "itsaplan"], { IGNIS_BROKER_HOME: home });
    assert.match(rmAgain, /not found/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("onboarding --probe parses mock models_cache.json and config.toml", () => {
  const home = mkTemp("ignis-probe-home-");
  const codexHome = mkTemp("ignis-probe-codex-");
  try {
    const mcpPath = path.join(home, "mcp_config.json");

    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    fs.writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-6.1-sol", visibility: "list" },
          { slug: "gpt-6.2-sol", visibility: "list" },
          { slug: "old-sol", visibility: "hide" },
          { slug: "o4-mini", visibility: "list" },
        ],
      })
    );
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      ['# root config', 'model = "gpt-6.2-sol"', "", "[profiles.fast]", 'model = "o4-mini"'].join("\n")
    );

    const out = runCli(["onboarding", "--probe", "--from", mcpPath], {
      IGNIS_BROKER_HOME: home,
      IGNIS_BROKER_DATA: home,
      CODEX_HOME: codexHome,
    });

    const probed = JSON.parse(out);
    assert.deepEqual(probed.codex.solModels, ["gpt-6.2-sol", "gpt-6.1-sol"]);
    assert.deepEqual(probed.codex.otherModels, ["o4-mini"]);
    assert.equal(probed.codex.configDefaultModel, "gpt-6.2-sol");
    assert.equal(typeof probed.clis.codex.available, "boolean");
    assert.equal(probed.onboarding.completed, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("onboarding --get, --save, --skip, --reset persist and transition state cleanly", () => {
  const home = mkTemp("ignis-onb-home-");
  try {
    const env = { IGNIS_BROKER_HOME: home, IGNIS_BROKER_DATA: home };

    const initial = JSON.parse(runCli(["onboarding", "--get"], env));
    assert.equal(initial.version, 1);
    assert.equal(initial.completed, false);
    assert.equal(initial.skipped, false);
    assert.equal(initial.tracker.kind, "none");
    assert.equal(initial.reviewRouting.strategy, "antigravity_gemini_only");
    assert.equal(initial.compaction.transcriptThresholdKb, 550);

    const saved = JSON.parse(
      runCli(
        [
          "onboarding",
          "--save",
          JSON.stringify({
            completed: true,
            brokerManagedServers: ["linear", "sqlite"],
            tracker: { kind: "linear", mcpServer: "linear" },
            memtrace: { enabled: true },
            reviewRouting: {
              strategy: "antigravity_first",
              headlessBackend: "codex",
              headlessModel: "gpt-6.2-sol",
              effort: "high",
            },
            compaction: { transcriptThresholdKb: 600 },
          }),
        ],
        env
      )
    );
    assert.equal(saved.completed, true);
    assert.ok(typeof saved.completedAt === "string");
    assert.deepEqual(saved.brokerManagedServers, ["linear", "sqlite"]);
    assert.equal(saved.tracker.kind, "linear");
    assert.equal(saved.reviewRouting.strategy, "antigravity_first");
    assert.equal(saved.compaction.transcriptThresholdKb, 600);

    const skipped = JSON.parse(runCli(["onboarding", "--skip"], env));
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.completed, false);
    assert.equal(skipped.completedAt, null);

    const completedAfterSkip = JSON.parse(
      runCli(["onboarding", "--save", JSON.stringify({ completed: true })], env)
    );
    assert.equal(completedAfterSkip.completed, true);
    assert.equal(completedAfterSkip.skipped, false);
    assert.ok(typeof completedAfterSkip.completedAt === "string");

    const reset = JSON.parse(runCli(["onboarding", "--reset"], env));
    assert.equal(reset.completed, false);
    assert.equal(reset.skipped, false);
    assert.equal(reset.completedAt, null);
    assert.deepEqual(reset.brokerManagedServers, []);
    assert.equal(reset.tracker.kind, "none");
    assert.deepEqual(reset.trackers, []);

    const multi = JSON.parse(
      runCli(
        [
          "onboarding",
          "--save",
          JSON.stringify({
            completed: true,
            trackers: [
              { kind: "itsaplan", mcpServer: "itsaplan" },
              { kind: "github", mcpServer: null },
              { kind: "none", mcpServer: null },
            ],
          }),
        ],
        env
      )
    );
    assert.deepEqual(multi.trackers, [
      { kind: "itsaplan", mcpServer: "itsaplan" },
      { kind: "github", mcpServer: null },
    ]);
    assert.deepEqual(multi.tracker, { kind: "itsaplan", mcpServer: "itsaplan" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("detectCli on Windows prefers .cmd over extensionless POSIX shim on PATH", { skip: process.platform !== "win32" }, () => {
  const home = mkTemp("ignis-win-cli-home-");
  const posixDir = mkTemp("ignis-win-cli-posix-");
  const cmdDir = mkTemp("ignis-win-cli-cmd-");
  try {
    const mcpPath = path.join(home, "mcp_config.json");
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));

    fs.writeFileSync(path.join(posixDir, "claude"), "#!/bin/sh\necho posix\n");
    fs.writeFileSync(path.join(cmdDir, "claude.cmd"), "@echo off\r\necho win\r\n");

    const probed = JSON.parse(
      runCli(["onboarding", "--probe", "--from", mcpPath], {
        IGNIS_BROKER_HOME: home,
        IGNIS_BROKER_DATA: home,
        PATH: `${posixDir}${path.delimiter}${cmdDir}`,
      })
    );

    assert.equal(probed.clis.claude.available, true);
    assert.equal(probed.clis.claude.path.toLowerCase(), path.join(cmdDir, "claude.cmd").toLowerCase());

    const posixOnly = JSON.parse(
      runCli(["onboarding", "--probe", "--from", mcpPath], {
        IGNIS_BROKER_HOME: home,
        IGNIS_BROKER_DATA: home,
        PATH: posixDir,
      })
    );
    assert.equal(posixOnly.clis.claude.available, false);
    assert.equal(posixOnly.clis.claude.path, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(posixDir, { recursive: true, force: true });
    fs.rmSync(cmdDir, { recursive: true, force: true });
  }
});

test("BROKER_VERSION is 1.0.1", () => {
  assert.equal(BROKER_VERSION, "1.0.1");
});

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

test("hasFreshNativeFallback matches parent/subdir boundaries, resolves symlinks, and rejects sibling prefixes", () => {
  const parentData = mkTemp("ignis-blind-parent-");
  const subData = mkTemp("ignis-blind-sub-");
  const rootData = mkTemp("ignis-blind-root-");
  const wsRoot = mkTemp("ignis-blind-ws-");
  try {
    const repo = path.join(wsRoot, "repo");
    const sub = path.join(repo, "packages", "app");
    const otherSub = path.join(repo, "packages", "other");
    const sibling = path.join(wsRoot, "repo-other");
    const link = path.join(wsRoot, "repo-link");
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(otherSub, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");

    const now = 1795740000000;

    recordBlindReviewState(parentData, repo, { fallbackToNative: true, reason: "parent", nowMs: now });
    assert.equal(hasFreshNativeFallback(parentData, [repo], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [sub], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [link], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [path.join(link, "packages", "app")], now), true);
    assert.equal(hasFreshNativeFallback(parentData, [sibling], now), false);
    assert.equal(hasFreshNativeFallback(parentData, [path.join(sibling, "packages", "app")], now), false);

    recordBlindReviewState(subData, sub, { fallbackToNative: true, reason: "sub", nowMs: now });
    assert.equal(hasFreshNativeFallback(subData, [repo], now), true);
    assert.equal(hasFreshNativeFallback(subData, [link], now), true);
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

test("recordBlindReviewState cleans up temp file when rename fails", () => {
  const dir = mkTemp("ignis-blind-tmp-");
  try {
    fs.mkdirSync(blindReviewStatePath(dir));
    assert.throws(() => recordBlindReviewState(dir, "/work", { fallbackToNative: true }));
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
