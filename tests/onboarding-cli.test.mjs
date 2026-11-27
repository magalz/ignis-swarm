import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, BROKER_VERSION } from "../scripts/broker/config.mjs";
import { probeEnvironment } from "../scripts/broker/onboarding.mjs";
import { initGitRepo, isolatedEnv, runNode, writeOnboardingState } from "./helpers.mjs";

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

const T = { timeoutMs: 30_000 };

function onb(iso, args, opts = {}) {
  return runNode(BROKER_BIN, ["onboarding", ...args], { env: iso.env, ...T, ...opts });
}

function stateFile(iso) {
  return path.join(iso.dirs.brokerData, "onboarding.json");
}

const SAMPLE_STATE = {
  brokerManagedServers: ["linear"],
  tracker: { kind: "linear", mcpServer: "linear" },
  memtrace: { enabled: true },
  reviewRouting: { strategy: "antigravity_first", headlessBackend: "codex", headlessModel: "m", effort: "high" },
};

function withoutStamp(state) {
  const { completedAt, ...rest } = state;
  assert.equal(typeof completedAt === "string" || completedAt === null, true);
  return rest;
}

test("onboarding --save sets completed true unless skipped, and honours an explicit completed false", () => {
  const iso = isolatedEnv();
  try {
    const plain = onb(iso, ["--save", JSON.stringify(SAMPLE_STATE)]);
    assert.equal(plain.status, 0, plain.stderr);
    const saved = JSON.parse(plain.stdout);
    assert.equal(saved.completed, true);
    assert.equal(typeof saved.completedAt, "string");
    assert.equal(JSON.parse(onb(iso, ["--get"]).stdout).completed, true);

    const skipped = JSON.parse(onb(iso, ["--save", JSON.stringify({ skipped: true })]).stdout);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.completed, false);
    assert.equal(skipped.completedAt, null);

    const explicit = JSON.parse(onb(iso, ["--save", JSON.stringify({ completed: false })]).stdout);
    assert.equal(explicit.completed, false);
    assert.equal(explicit.skipped, false);
  } finally {
    iso.cleanup();
  }
});

test("onboarding --save-file and --stdin save the same state as --save", () => {
  const iso = isolatedEnv();
  try {
    const json = JSON.stringify(SAMPLE_STATE);
    const viaFlag = withoutStamp(JSON.parse(onb(iso, ["--save", json]).stdout));
    assert.equal(viaFlag.completed, true);

    const file = path.join(iso.dirs.root, "input.json");
    fs.writeFileSync(file, `﻿${json}`);

    onb(iso, ["--reset"]);
    const viaFile = onb(iso, ["--save-file", file]);
    assert.equal(viaFile.status, 0, viaFile.stderr);
    assert.deepEqual(withoutStamp(JSON.parse(viaFile.stdout)), viaFlag);

    onb(iso, ["--reset"]);
    const viaStdin = onb(iso, ["--stdin"], { input: json });
    assert.equal(viaStdin.status, 0, viaStdin.stderr);
    assert.deepEqual(withoutStamp(JSON.parse(viaStdin.stdout)), viaFlag);
  } finally {
    iso.cleanup();
  }
});

test("onboarding --save-file with a missing file and --stdin with empty input fail and write nothing", () => {
  const iso = isolatedEnv();
  try {
    const missing = onb(iso, ["--save-file", path.join(iso.dirs.root, "nope.json")]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /cannot read/);
    assert.equal(fs.existsSync(stateFile(iso)), false);

    const empty = onb(iso, ["--stdin"], { input: "  \n" });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /empty/);
    assert.equal(fs.existsSync(stateFile(iso)), false);

    const dir = onb(iso, ["--save-file", iso.dirs.root]);
    assert.notEqual(dir.status, 0);
    assert.match(dir.stderr, /cannot read/);
    assert.equal(fs.existsSync(stateFile(iso)), false);
  } finally {
    iso.cleanup();
  }
});

const REJECTED = [
  ["memtrace not an object", { memtrace: true }, /memtrace.*object/],
  ["memtrace.enabled not a boolean", { memtrace: { enabled: "yes" } }, /memtrace\.enabled.*boolean/],
  ["tracker kind outside the known kinds", { tracker: { kind: "jira" } }, /tracker\.kind.*one of/],
  ["tracker kind in the wrong case", { tracker: { kind: "Linear" } }, /tracker\.kind.*one of/],
  ["trackers entry with an unknown kind", { trackers: [{ kind: "nope" }] }, /trackers\[0\]\.kind.*one of/],
  ["reviewRouting.headlessBackend not a known backend", { reviewRouting: { headlessBackend: "gemini" } }, /reviewRouting\.headlessBackend.*one of/],
  ["reviewRouting.strategy not a known strategy", { reviewRouting: { strategy: "sometimes" } }, /reviewRouting\.strategy.*one of/],
  ["brokerManagedServers not an array of strings", { brokerManagedServers: ["a", 3] }, /brokerManagedServers.*array of strings/],
  ["brokerManagedServers a plain string", { brokerManagedServers: "linear" }, /brokerManagedServers.*array of strings/],
  ["completed not a boolean", { completed: "true" }, /completed.*boolean/],
  ["compaction.transcriptThresholdKb not a number", { compaction: { transcriptThresholdKb: "big" } }, /transcriptThresholdKb.*number/],
  ["unknown top-level key", { completd: true }, /unknown key.*completd/],
];

for (const [label, bad, pattern] of REJECTED) {
  test(`onboarding --save rejects ${label} and leaves the state file unchanged`, () => {
    const iso = isolatedEnv();
    try {
      const file = writeOnboardingState(iso.dirs.brokerData);
      const before = fs.readFileSync(file, "utf8");
      const res = onb(iso, ["--save", JSON.stringify(bad)]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, pattern);
      assert.equal(fs.readFileSync(file, "utf8"), before);
    } finally {
      iso.cleanup();
    }
  });
}

test("onboarding --save-file and --stdin run the same validation, and invalid JSON is not quoted back", () => {
  const iso = isolatedEnv();
  try {
    const file = writeOnboardingState(iso.dirs.brokerData);
    const before = fs.readFileSync(file, "utf8");
    const input = path.join(iso.dirs.root, "bad.json");
    fs.writeFileSync(input, JSON.stringify({ memtrace: true }));
    const viaFile = onb(iso, ["--save-file", input]);
    assert.notEqual(viaFile.status, 0);
    assert.match(viaFile.stderr, /memtrace.*object/);
    const viaStdin = onb(iso, ["--stdin"], { input: JSON.stringify({ memtrace: true }) });
    assert.notEqual(viaStdin.status, 0);
    assert.match(viaStdin.stderr, /memtrace.*object/);

    const marker = ["leak", "me", String(Date.now())].join("-");
    const broken = onb(iso, ["--save", `{"note": "${marker}" "x"`]);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /invalid JSON at line 1, column \d+/);
    assert.equal(broken.stderr.includes(marker), false);
    assert.equal(fs.readFileSync(file, "utf8"), before);

    const array = onb(iso, ["--save", "[]"]);
    assert.notEqual(array.status, 0);
    assert.match(array.stderr, /JSON object/);
  } finally {
    iso.cleanup();
  }
});

test("a legacy onboarding state file with odd types still loads through --get", () => {
  const iso = isolatedEnv();
  try {
    fs.mkdirSync(iso.dirs.brokerData, { recursive: true });
    fs.writeFileSync(
      stateFile(iso),
      JSON.stringify({
        version: "1",
        completed: "yes",
        memtrace: true,
        brokerManagedServers: "linear",
        compaction: { transcriptThresholdKb: "big" },
        reviewRouting: { headlessBackend: 7 },
        legacyKey: 1,
      })
    );
    const res = onb(iso, ["--get"]);
    assert.equal(res.status, 0, res.stderr);
    const state = JSON.parse(res.stdout);
    assert.equal(state.completed, true);
    assert.deepEqual(state.memtrace, { enabled: false });
    assert.deepEqual(state.brokerManagedServers, []);
    assert.equal(state.reviewRouting.headlessBackend, null);
    assert.equal(state.compaction.transcriptThresholdKb, 550);
  } finally {
    iso.cleanup();
  }
});

test("onboarding --probe reports localBrokerConfig with its trust and redacted servers", () => {
  const iso = isolatedEnv();
  try {
    const plainDir = path.join(iso.dirs.root, "plain");
    fs.mkdirSync(plainDir);
    const none = onb(iso, ["--probe"], { cwd: plainDir });
    assert.equal(none.status, 0, none.stderr);
    assert.equal(JSON.parse(none.stdout).localBrokerConfig, null);

    const repo = initGitRepo(path.join(iso.dirs.root, "repo"), { env: iso.env });
    const bare = onb(iso, ["--probe"], { cwd: repo });
    assert.equal(JSON.parse(bare.stdout).localBrokerConfig, null);

    const secret = ["sek", "ret", String(process.pid), String(Date.now())].join("-");
    fs.mkdirSync(path.join(repo, ".agents"));
    const configFile = path.join(repo, ".agents", "ignis-broker.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        servers: {
          local: { command: "node", args: ["srv.mjs"], env: { API_TOKEN: secret } },
          remote: { url: "https://mcp.example.test/mcp?key=" + secret, headers: { Authorization: `Bearer ${secret}` } },
        },
      })
    );

    const untrusted = onb(iso, ["--probe"], { cwd: repo });
    assert.equal(untrusted.status, 0, untrusted.stderr);
    assert.equal(untrusted.stdout.includes(secret), false);
    const local = JSON.parse(untrusted.stdout).localBrokerConfig;
    assert.equal(local.trusted, false);
    assert.equal(fs.realpathSync.native(local.path).toLowerCase(), fs.realpathSync.native(configFile).toLowerCase());
    assert.deepEqual(local.servers.map((s) => s.name).sort(), ["local", "remote"]);
    assert.deepEqual(local.servers.find((s) => s.name === "local").env, { API_TOKEN: "***" });
    assert.deepEqual(local.servers.find((s) => s.name === "remote").headers, { Authorization: "***" });

    const trust = runNode(BROKER_BIN, ["trust", "--cwd", repo], { env: iso.env, ...T });
    assert.equal(trust.status, 0, trust.stderr);
    const trusted = onb(iso, ["--probe"], { cwd: repo });
    assert.equal(trusted.stdout.includes(secret), false);
    assert.equal(JSON.parse(trusted.stdout).localBrokerConfig.trusted, true);

    fs.appendFileSync(configFile, "\n");
    assert.equal(JSON.parse(onb(iso, ["--probe"], { cwd: repo }).stdout).localBrokerConfig.trusted, false);
  } finally {
    iso.cleanup();
  }
});

test("probeEnvironment without a cwd reports localBrokerConfig null and does not throw", () => {
  const iso = isolatedEnv();
  try {
    const probed = probeEnvironment(iso.dirs.brokerHome, iso.dirs.brokerData, path.join(iso.dirs.root, "none.json"), iso.dirs.codexHome);
    assert.equal(probed.localBrokerConfig, null);
  } finally {
    iso.cleanup();
  }
});
