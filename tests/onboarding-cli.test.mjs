import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig, BROKER_VERSION } from "../scripts/broker/config.mjs";
import { probeEnvironment } from "../scripts/broker/onboarding.mjs";
import { BROKER_ENTRY as BROKER_BIN, initGitRepo, isolatedEnv, runNode, writeOnboardingState } from "./helpers.mjs";

const T = { timeoutMs: 30_000 };
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function cli(iso, args, opts = {}) {
  return runNode(BROKER_BIN, args, { env: iso.env, ...T, ...opts });
}

function cliJson(iso, args, opts) {
  const res = cli(iso, args, opts);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function withIso(fn) {
  const iso = isolatedEnv();
  try {
    return fn(iso);
  } finally {
    iso.cleanup();
  }
}

function writeServers(iso, servers) {
  fs.writeFileSync(path.join(iso.dirs.brokerHome, "servers.json"), JSON.stringify({ version: 1, servers }));
}

function readServers(iso) {
  return JSON.parse(fs.readFileSync(path.join(iso.dirs.brokerHome, "servers.json"), "utf8")).servers;
}

function writeMcpConfig(iso, mcpServers) {
  const file = path.join(iso.dirs.root, "mcp_config.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers }));
  return file;
}

const LINEAR_TOKEN = "super-secret-linear-token";
const SQLITE_SECRET = "top-secret-db-pass";

function discover(iso) {
  writeServers(iso, { linear: { transport: "http", url: "https://mcp.linear.app/mcp" } });
  const from = writeMcpConfig(iso, {
    linear: { serverUrl: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${LINEAR_TOKEN}` } },
    sqlite: { command: "node", args: ["sqlite-mcp.mjs"], env: { DB_SECRET: SQLITE_SECRET } },
    disabledSrv: { command: "node", args: ["off.mjs"], disabled: true },
    "ignis-broker": { command: "node", args: ["ignis-broker.mjs", "mcp-bridge"] },
  });
  const res = cli(iso, ["discover-mcp", "--from", from, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test("discover-mcp --json leaks no secret value", () => {
  withIso((iso) => {
    const out = discover(iso);
    assert.equal(out.includes(LINEAR_TOKEN), false);
    assert.equal(out.includes(SQLITE_SECRET), false);
  });
});

test("discover-mcp --json lists every candidate except the broker's own bridge", () => {
  withIso((iso) => {
    const names = JSON.parse(discover(iso)).map((x) => x.name);
    assert.deepEqual(names.sort(), ["disabledSrv", "linear", "sqlite"]);
  });
});

test("discover-mcp --json marks a server the broker already manages", () => {
  withIso((iso) => {
    const linear = JSON.parse(discover(iso)).find((x) => x.name === "linear");
    assert.equal(linear.transport, "http");
    assert.equal(linear.alreadyManaged, true);
    assert.equal(linear.disabled, false);
  });
});

test("discover-mcp --json suggests per-workspace for a new stdio server", () => {
  withIso((iso) => {
    const sqlite = JSON.parse(discover(iso)).find((x) => x.name === "sqlite");
    assert.equal(sqlite.transport, "stdio");
    assert.equal(sqlite.alreadyManaged, false);
    assert.equal(sqlite.suggestedPerWorkspace, true);
  });
});

test("discover-mcp --json reports a disabled server as disabled", () => {
  withIso((iso) => {
    assert.equal(JSON.parse(discover(iso)).find((x) => x.name === "disabledSrv").disabled, true);
  });
});

function registerB(iso) {
  writeServers(iso, { a: { transport: "stdio", command: "node", args: ["a.mjs"], perWorkspace: false, enabled: true } });
  const from = writeMcpConfig(iso, {
    b: { command: "node", args: ["b.mjs"] },
    c: { serverUrl: "https://c.example.com/mcp" },
  });
  const res = cli(iso, ["register-mcp", "--servers", "b", "--from", from, "--per-workspace", "b", "--cli-fallback", "b=linear"]);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test("register-mcp --servers b prints the registered list including pre-existing server a", () => {
  withIso((iso) => {
    const out = registerB(iso);
    assert.match(out, /Registered 2 server\(s\)/);
    assert.match(out, /- a \[stdio\]/);
    assert.match(out, /- b \[stdio\] \(perWorkspace, cliFallback=linear\)/);
  });
});

test("register-mcp --servers b keeps server a, adds b with its flags and does not add c", () => {
  withIso((iso) => {
    registerB(iso);
    const servers = readServers(iso);
    assert.deepEqual(Object.keys(servers).sort(), ["a", "b"]);
    assert.equal(servers.b.perWorkspace, true);
    assert.equal(servers.b.cliFallback, "linear");
  });
});

test("register-mcp --cli-fallback b=linear resolves for b only", () => {
  withIso((iso) => {
    registerB(iso);
    const resolved = resolveConfig(iso.dirs.brokerHome, null);
    assert.equal(resolved.candidates.get("a")[0].config.cliFallback, null);
    assert.equal(resolved.candidates.get("b")[0].config.cliFallback, "linear");
  });
});

function addItsaplan(iso) {
  const res = cli(iso, ["add-http-mcp", "itsaplan", "https://api.itsaplan.dev/mcp", "--auth-env", "ITSAPLAN_TOKEN", "--header-name", "Authorization"]);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test("add-http-mcp stores the server with ${VAR} header indirection", () => {
  withIso((iso) => {
    assert.match(addItsaplan(iso), /Added HTTP server itsaplan/);
    const saved = readServers(iso).itsaplan;
    assert.equal(saved.transport, "http");
    assert.equal(saved.url, "https://api.itsaplan.dev/mcp");
    assert.deepEqual(saved.headers, { Authorization: "Bearer ${ITSAPLAN_TOKEN}" });
  });
});

test("unregister-mcp removes a server it knows", () => {
  withIso((iso) => {
    addItsaplan(iso);
    const rm = cli(iso, ["unregister-mcp", "itsaplan"]);
    assert.equal(rm.status, 0, rm.stderr);
    assert.match(rm.stdout, /Removed server itsaplan/);
    assert.equal(readServers(iso).itsaplan, undefined);
  });
});

test("unregister-mcp reports a server it does not know as not found", () => {
  withIso((iso) => {
    addItsaplan(iso);
    cli(iso, ["unregister-mcp", "itsaplan"]);
    const again = cli(iso, ["unregister-mcp", "itsaplan"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /not found/);
  });
});

function probeWithPath(iso, pathValue) {
  const mcpPath = writeMcpConfig(iso, {});
  return cliJson(iso, ["onboarding", "--probe", "--from", mcpPath], { env: { ...iso.env, PATH: pathValue } });
}

function probeWithCodexFiles(iso) {
  fs.writeFileSync(
    path.join(iso.dirs.codexHome, "models_cache.json"),
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
    path.join(iso.dirs.codexHome, "config.toml"),
    ["# root config", 'model = "gpt-6.2-sol"', "", "[profiles.fast]", 'model = "o4-mini"'].join("\n")
  );
  const emptyBin = path.join(iso.dirs.root, "empty-bin");
  fs.mkdirSync(emptyBin);
  return probeWithPath(iso, emptyBin);
}

test("onboarding --probe lists the visible Sol models of the Codex models cache, newest first", () => {
  withIso((iso) => {
    assert.deepEqual(probeWithCodexFiles(iso).codex.solModels, ["gpt-6.2-sol", "gpt-6.1-sol"]);
  });
});

test("onboarding --probe lists the other visible Codex models", () => {
  withIso((iso) => {
    assert.deepEqual(probeWithCodexFiles(iso).codex.otherModels, ["o4-mini"]);
  });
});

test("onboarding --probe reads the root model of the Codex config.toml", () => {
  withIso((iso) => {
    assert.equal(probeWithCodexFiles(iso).codex.configDefaultModel, "gpt-6.2-sol");
  });
});

test("onboarding --probe reports codex unavailable when no codex CLI is on PATH", () => {
  withIso((iso) => {
    const probed = probeWithCodexFiles(iso);
    assert.equal(probed.clis.codex.available, false);
    assert.equal(probed.clis.codex.path, null);
  });
});

test("onboarding --probe reports a fresh state as not completed", () => {
  withIso((iso) => {
    assert.equal(probeWithCodexFiles(iso).onboarding.completed, false);
  });
});

function onb(iso, args, opts = {}) {
  return cli(iso, ["onboarding", ...args], opts);
}

function onbJson(iso, args, opts) {
  return cliJson(iso, ["onboarding", ...args], opts);
}

test("onboarding --get on a fresh install returns the defaults", () => {
  withIso((iso) => {
    const initial = onbJson(iso, ["--get"]);
    assert.equal(initial.version, 1);
    assert.equal(initial.completed, false);
    assert.equal(initial.skipped, false);
    assert.equal(initial.tracker.kind, "none");
    assert.equal(initial.reviewRouting.strategy, "antigravity_gemini_only");
    assert.equal(initial.compaction.transcriptThresholdKb, 550);
  });
});

const FULL_SAVE = {
  completed: true,
  brokerManagedServers: ["linear", "sqlite"],
  tracker: { kind: "linear", mcpServer: "linear" },
  memtrace: { enabled: true },
  reviewRouting: { strategy: "antigravity_first", headlessBackend: "codex", headlessModel: "gpt-6.2-sol", effort: "high" },
  compaction: { transcriptThresholdKb: 600 },
};

test("onboarding --save persists every field it is given and stamps completedAt", () => {
  withIso((iso) => {
    const saved = onbJson(iso, ["--save", JSON.stringify(FULL_SAVE)]);
    assert.equal(saved.completed, true);
    assert.match(saved.completedAt, ISO_STAMP);
    assert.deepEqual(saved.brokerManagedServers, ["linear", "sqlite"]);
    assert.deepEqual(saved.tracker, { kind: "linear", mcpServer: "linear" });
    assert.deepEqual(saved.memtrace, { enabled: true });
    assert.equal(saved.reviewRouting.strategy, "antigravity_first");
    assert.equal(saved.compaction.transcriptThresholdKb, 600);
  });
});

test("onboarding --skip marks the state skipped and not completed", () => {
  withIso((iso) => {
    onbJson(iso, ["--save", JSON.stringify(FULL_SAVE)]);
    const skipped = onbJson(iso, ["--skip"]);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.completed, false);
    assert.equal(skipped.completedAt, null);
  });
});

test("onboarding --save completed true after --skip clears skipped and stamps completedAt", () => {
  withIso((iso) => {
    onbJson(iso, ["--skip"]);
    const done = onbJson(iso, ["--save", JSON.stringify({ completed: true })]);
    assert.equal(done.completed, true);
    assert.equal(done.skipped, false);
    assert.match(done.completedAt, ISO_STAMP);
  });
});

test("onboarding --reset returns a completed state to the defaults", () => {
  withIso((iso) => {
    onbJson(iso, ["--save", JSON.stringify(FULL_SAVE)]);
    const reset = onbJson(iso, ["--reset"]);
    assert.equal(reset.completed, false);
    assert.equal(reset.skipped, false);
    assert.equal(reset.completedAt, null);
    assert.deepEqual(reset.brokerManagedServers, []);
    assert.equal(reset.tracker.kind, "none");
    assert.deepEqual(reset.trackers, []);
  });
});

test("onboarding --save keeps trackers in order, drops kind none and mirrors the first one into tracker", () => {
  withIso((iso) => {
    const multi = onbJson(iso, [
      "--save",
      JSON.stringify({
        completed: true,
        trackers: [
          { kind: "itsaplan", mcpServer: "itsaplan" },
          { kind: "github", mcpServer: null },
          { kind: "none", mcpServer: null },
        ],
      }),
    ]);
    assert.deepEqual(multi.trackers, [
      { kind: "itsaplan", mcpServer: "itsaplan" },
      { kind: "github", mcpServer: null },
    ]);
    assert.deepEqual(multi.tracker, { kind: "itsaplan", mcpServer: "itsaplan" });
  });
});

function windowsCliDirs(iso) {
  const posixDir = path.join(iso.dirs.root, "posix-bin");
  const cmdDir = path.join(iso.dirs.root, "cmd-bin");
  fs.mkdirSync(posixDir);
  fs.mkdirSync(cmdDir);
  fs.writeFileSync(path.join(posixDir, "claude"), "#!/bin/sh\necho posix\n");
  fs.writeFileSync(path.join(cmdDir, "claude.cmd"), "@echo off\r\necho win\r\n");
  return { posixDir, cmdDir };
}

test("detectCli on Windows prefers .cmd over an extensionless POSIX shim on PATH", { skip: process.platform !== "win32" }, () => {
  withIso((iso) => {
    const { posixDir, cmdDir } = windowsCliDirs(iso);
    const probed = probeWithPath(iso, `${posixDir}${path.delimiter}${cmdDir}`);
    assert.equal(probed.clis.claude.available, true);
    assert.equal(probed.clis.claude.path.toLowerCase(), path.join(cmdDir, "claude.cmd").toLowerCase());
  });
});

test("detectCli on Windows ignores an extensionless POSIX shim alone on PATH", { skip: process.platform !== "win32" }, () => {
  withIso((iso) => {
    const { posixDir } = windowsCliDirs(iso);
    const probed = probeWithPath(iso, posixDir);
    assert.equal(probed.clis.claude.available, false);
    assert.equal(probed.clis.claude.path, null);
  });
});

test("BROKER_VERSION is 1.1.0", () => {
  assert.equal(BROKER_VERSION, "1.1.0");
});

const SAMPLE_STATE = {
  brokerManagedServers: ["linear"],
  tracker: { kind: "linear", mcpServer: "linear" },
  memtrace: { enabled: true },
  reviewRouting: { strategy: "antigravity_first", headlessBackend: "codex", headlessModel: "m", effort: "high" },
};

function stateFile(iso) {
  return path.join(iso.dirs.brokerData, "onboarding.json");
}

function withoutStamp(state) {
  const { completedAt, ...rest } = state;
  assert.match(completedAt, ISO_STAMP);
  return rest;
}

test("onboarding --save and --reset write the state file atomically, leaving no temp file", () => {
  withIso((iso) => {
    onbJson(iso, ["--save", JSON.stringify(SAMPLE_STATE)]);
    onbJson(iso, ["--reset"]);
    assert.deepEqual(fs.readdirSync(iso.dirs.brokerData).filter((n) => n.endsWith(".tmp")), []);
    assert.equal(onbJson(iso, ["--get"]).completed, false);
  });
});

test("onboarding --save sets completed true and persists it", () => {
  withIso((iso) => {
    const saved = onbJson(iso, ["--save", JSON.stringify(SAMPLE_STATE)]);
    assert.equal(saved.completed, true);
    assert.match(saved.completedAt, ISO_STAMP);
    assert.equal(onbJson(iso, ["--get"]).completed, true);
  });
});

test("onboarding --save with skipped true leaves completed false", () => {
  withIso((iso) => {
    onbJson(iso, ["--save", JSON.stringify(SAMPLE_STATE)]);
    const skipped = onbJson(iso, ["--save", JSON.stringify({ skipped: true })]);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.completed, false);
    assert.equal(skipped.completedAt, null);
  });
});

test("onboarding --save honours an explicit completed false", () => {
  withIso((iso) => {
    const explicit = onbJson(iso, ["--save", JSON.stringify({ completed: false })]);
    assert.equal(explicit.completed, false);
    assert.equal(explicit.skipped, false);
  });
});

test("onboarding --save-file saves the same state as --save, byte-order mark included", () => {
  withIso((iso) => {
    const json = JSON.stringify(SAMPLE_STATE);
    const viaFlag = withoutStamp(onbJson(iso, ["--save", json]));
    assert.equal(viaFlag.completed, true);
    const file = path.join(iso.dirs.root, "input.json");
    fs.writeFileSync(file, `﻿${json}`);
    onbJson(iso, ["--reset"]);
    assert.deepEqual(withoutStamp(onbJson(iso, ["--save-file", file])), viaFlag);
  });
});

test("onboarding --stdin saves the same state as --save", () => {
  withIso((iso) => {
    const json = JSON.stringify(SAMPLE_STATE);
    const viaFlag = withoutStamp(onbJson(iso, ["--save", json]));
    onbJson(iso, ["--reset"]);
    assert.deepEqual(withoutStamp(onbJson(iso, ["--stdin"], { input: json })), viaFlag);
  });
});

test("onboarding --save-file with a missing file fails and writes nothing", () => {
  withIso((iso) => {
    const missing = onb(iso, ["--save-file", path.join(iso.dirs.root, "nope.json")]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /cannot read/);
    assert.equal(fs.existsSync(stateFile(iso)), false);
  });
});

test("onboarding --save-file with a directory fails and writes nothing", () => {
  withIso((iso) => {
    const dir = onb(iso, ["--save-file", iso.dirs.root]);
    assert.notEqual(dir.status, 0);
    assert.match(dir.stderr, /cannot read/);
    assert.equal(fs.existsSync(stateFile(iso)), false);
  });
});

test("onboarding --stdin with empty input fails and writes nothing", () => {
  withIso((iso) => {
    const empty = onb(iso, ["--stdin"], { input: "  \n" });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /empty/);
    assert.equal(fs.existsSync(stateFile(iso)), false);
  });
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
    withIso((iso) => {
      const file = writeOnboardingState(iso.dirs.brokerData);
      const before = fs.readFileSync(file, "utf8");
      const res = onb(iso, ["--save", JSON.stringify(bad)]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, pattern);
      assert.equal(fs.readFileSync(file, "utf8"), before);
    });
  });
}

function stateWithBackup(iso) {
  const file = writeOnboardingState(iso.dirs.brokerData);
  return { file, before: fs.readFileSync(file, "utf8") };
}

test("onboarding --save-file runs the same validation as --save", () => {
  withIso((iso) => {
    const { file, before } = stateWithBackup(iso);
    const input = path.join(iso.dirs.root, "bad.json");
    fs.writeFileSync(input, JSON.stringify({ memtrace: true }));
    const res = onb(iso, ["--save-file", input]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /memtrace.*object/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("onboarding --stdin runs the same validation as --save", () => {
  withIso((iso) => {
    const { file, before } = stateWithBackup(iso);
    const res = onb(iso, ["--stdin"], { input: JSON.stringify({ memtrace: true }) });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /memtrace.*object/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("onboarding --save reports invalid JSON by position and does not quote it back", () => {
  withIso((iso) => {
    const { file, before } = stateWithBackup(iso);
    const marker = ["leak", "me", String(Date.now())].join("-");
    const broken = onb(iso, ["--save", `{"note": "${marker}" "x"`]);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /invalid JSON at line 1, column \d+/);
    assert.equal(broken.stderr.includes(marker), false);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("onboarding --save rejects a JSON array", () => {
  withIso((iso) => {
    const array = onb(iso, ["--save", "[]"]);
    assert.notEqual(array.status, 0);
    assert.match(array.stderr, /JSON object/);
  });
});

test("a legacy onboarding state file with odd types still loads through --get", () => {
  withIso((iso) => {
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
    const state = onbJson(iso, ["--get"]);
    assert.equal(state.completed, true);
    assert.deepEqual(state.memtrace, { enabled: false });
    assert.deepEqual(state.brokerManagedServers, []);
    assert.equal(state.reviewRouting.headlessBackend, null);
    assert.equal(state.compaction.transcriptThresholdKb, 550);
  });
});

const LOCAL_SECRET = ["sek", "ret", String(process.pid), String(Date.now())].join("-");

function repoWithLocalConfig(iso) {
  const repo = initGitRepo(path.join(iso.dirs.root, "repo"), { env: iso.env });
  fs.mkdirSync(path.join(repo, ".agents"));
  const configFile = path.join(repo, ".agents", "ignis-broker.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      servers: {
        local: { command: "node", args: ["srv.mjs"], env: { API_TOKEN: LOCAL_SECRET } },
        remote: { url: `https://mcp.example.test/mcp?key=${LOCAL_SECRET}`, headers: { Authorization: `Bearer ${LOCAL_SECRET}` } },
      },
    })
  );
  return { repo, configFile };
}

test("onboarding --probe reports no localBrokerConfig outside a repository", () => {
  withIso((iso) => {
    const plainDir = path.join(iso.dirs.root, "plain");
    fs.mkdirSync(plainDir);
    const none = onbJson(iso, ["--probe"], { cwd: plainDir });
    assert.equal(none.localBrokerConfig, null);
  });
});

test("onboarding --probe reports no localBrokerConfig in a repository without one", () => {
  withIso((iso) => {
    const repo = initGitRepo(path.join(iso.dirs.root, "repo"), { env: iso.env });
    assert.equal(onbJson(iso, ["--probe"], { cwd: repo }).localBrokerConfig, null);
  });
});

test("onboarding --probe reports an untrusted local config with its path", () => {
  withIso((iso) => {
    const { repo, configFile } = repoWithLocalConfig(iso);
    const local = onbJson(iso, ["--probe"], { cwd: repo }).localBrokerConfig;
    assert.equal(local.trusted, false);
    assert.equal(fs.realpathSync.native(local.path).toLowerCase(), fs.realpathSync.native(configFile).toLowerCase());
  });
});

test("onboarding --probe redacts the env and headers of local config servers", () => {
  withIso((iso) => {
    const { repo } = repoWithLocalConfig(iso);
    const res = onb(iso, ["--probe"], { cwd: repo });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.includes(LOCAL_SECRET), false);
    const local = JSON.parse(res.stdout).localBrokerConfig;
    assert.deepEqual(local.servers.map((s) => s.name).sort(), ["local", "remote"]);
    assert.deepEqual(local.servers.find((s) => s.name === "local").env, { API_TOKEN: "***REDACTED***" });
    assert.deepEqual(local.servers.find((s) => s.name === "remote").headers, { Authorization: "***REDACTED***" });
    assert.equal(local.servers.find((s) => s.name === "remote").url, "https://mcp.example.test/mcp");
  });
});

test("onboarding --probe reports the local config trusted after `trust`, still without secrets", () => {
  withIso((iso) => {
    const { repo } = repoWithLocalConfig(iso);
    const trust = cli(iso, ["trust", "--cwd", repo]);
    assert.equal(trust.status, 0, trust.stderr);
    const trusted = onb(iso, ["--probe"], { cwd: repo });
    assert.equal(trusted.stdout.includes(LOCAL_SECRET), false);
    assert.equal(JSON.parse(trusted.stdout).localBrokerConfig.trusted, true);
  });
});

test("onboarding --probe reports the local config untrusted again after it changes", () => {
  withIso((iso) => {
    const { repo, configFile } = repoWithLocalConfig(iso);
    const trust = cli(iso, ["trust", "--cwd", repo]);
    assert.equal(trust.status, 0, trust.stderr);
    fs.appendFileSync(configFile, "\n");
    assert.equal(onbJson(iso, ["--probe"], { cwd: repo }).localBrokerConfig.trusted, false);
  });
});

test("probeEnvironment without a cwd reports localBrokerConfig null and does not throw", () => {
  withIso((iso) => {
    const probed = probeEnvironment(iso.dirs.brokerHome, iso.dirs.brokerData, path.join(iso.dirs.root, "none.json"), iso.dirs.codexHome);
    assert.equal(probed.localBrokerConfig, null);
  });
});
