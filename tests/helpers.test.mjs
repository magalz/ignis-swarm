import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isPidAlive } from "../scripts/broker/lifecycle.mjs";
import { loadOnboardingState } from "../scripts/broker/onboarding.mjs";
import {
  BROKER_ENTRY,
  initGitRepo,
  isolatedEnv,
  mkTemp,
  runGit,
  runNode,
  waitUntil,
  writeMockStdioServer,
  writeOnboardingState,
} from "./helpers.mjs";

// Run fn with process.env patched (undefined deletes a key), then restore it.
function withProcessEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function rmTemp(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

// A global git config that would break an unisolated commit: it signs every
// commit with a gpg program that does not exist, and carries a leaky identity.
function writeHostileGitConfig(dir) {
  const configPath = path.join(dir, "hostile.gitconfig");
  const missingGpg = path.join(dir, "no-such-gpg").replaceAll("\\", "/");
  fs.writeFileSync(
    configPath,
    [
      "[user]",
      "\tname = Real Developer",
      "\temail = leak@real.invalid",
      "[commit]",
      "\tgpgsign = true",
      "[gpg]",
      `\tprogram = ${missingGpg}`,
      "",
    ].join("\n")
  );
  return configPath;
}

function git(env, cwd, args) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
}

const realPath = (p) => fs.realpathSync.native(p);

test("mkTemp creates a unique directory under os.tmpdir() with the given prefix", () => {
  const first = mkTemp();
  const second = mkTemp("ignis-custom-");
  try {
    assert.ok(fs.statSync(first).isDirectory());
    assert.ok(fs.statSync(second).isDirectory());
    assert.ok(path.basename(first).startsWith("ignis-test-"));
    assert.ok(path.basename(second).startsWith("ignis-custom-"));
    assert.equal(path.dirname(first), path.join(os.tmpdir()));
    assert.notEqual(first, second);
  } finally {
    rmTemp(first, second);
  }
});

test("isolatedEnv strips IGNIS_* variables and isolates the git config and home", () => {
  const scratch = mkTemp();
  try {
    const hostileConfig = writeHostileGitConfig(scratch);
    const patch = {
      IGNIS_FOO: "leaked",
      IGNIS_BROKER_HOME: path.join(scratch, "real-broker-home"),
      CODEX_HOME: path.join(scratch, "real-codex"),
      GIT_CONFIG_GLOBAL: hostileConfig,
    };
    withProcessEnv(patch, () => {
      const iso = isolatedEnv();
      try {
        assert.equal(iso.env.IGNIS_FOO, undefined);
        assert.deepEqual(
          Object.keys(iso.env)
            .filter((key) => key.toUpperCase().startsWith("IGNIS_"))
            .sort(),
          ["IGNIS_BROKER_DATA", "IGNIS_BROKER_HOME"]
        );
        assert.equal(iso.env.IGNIS_BROKER_HOME, iso.dirs.brokerHome);
        assert.equal(iso.env.IGNIS_BROKER_DATA, iso.dirs.brokerData);
        assert.notEqual(iso.env.IGNIS_BROKER_HOME, patch.IGNIS_BROKER_HOME);
        assert.equal(iso.env.CODEX_HOME, iso.dirs.codexHome);
        assert.notEqual(iso.env.CODEX_HOME, patch.CODEX_HOME);
        assert.equal(iso.env.HOME, iso.dirs.home);
        assert.equal(iso.env.USERPROFILE, iso.dirs.home);
        assert.equal(iso.env.GIT_CONFIG_NOSYSTEM, "1");
        assert.notEqual(iso.env.GIT_CONFIG_GLOBAL, hostileConfig);

        // The parent environment is copied, not mutated.
        assert.equal(process.env.IGNIS_FOO, "leaked");
        assert.equal(process.env.GIT_CONFIG_GLOBAL, hostileConfig);

        // Git sees the temp config, not the hostile one.
        const read = (key) => git(iso.env, scratch, ["config", "--global", "--get", key]).stdout.trim();
        assert.equal(read("user.email"), "ignis-test@example.invalid");
        assert.equal(read("commit.gpgsign"), "false");
        assert.equal(read("init.defaultBranch"), "main");
        assert.equal(read("core.autocrlf"), "false");

        // Code under test resolves its home directory to the temp home.
        const home = spawnSync(process.execPath, ["-p", "require('node:os').homedir()"], {
          env: iso.env,
          encoding: "utf8",
          windowsHide: true,
        });
        assert.equal(home.stdout.trim(), iso.dirs.home);
      } finally {
        iso.cleanup();
      }
    });
  } finally {
    rmTemp(scratch);
  }
});

test("isolatedEnv strips git config injected through the environment, as a parent git -c or hook would", () => {
  const injected = {
    GIT_CONFIG_PARAMETERS: "'commit.gpgsign=true'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "true",
  };
  withProcessEnv(injected, () => {
    const iso = isolatedEnv();
    try {
      for (const key of Object.keys(injected)) assert.equal(iso.env[key], undefined, `${key} is stripped`);
      // Git itself, which reads these variables ahead of any file, sees the temp config.
      const res = git(iso.env, iso.dirs.root, ["config", "--get", "commit.gpgsign"]);
      assert.equal(res.stdout.trim(), "false");
    } finally {
      iso.cleanup();
    }
  });
});

test("isolatedEnv applies overrides last", () => {
  const iso = isolatedEnv({ CODEX_HOME: "/override/codex", EXTRA_VAR: "extra", IGNIS_BROKER_DATA: "/override/data" });
  try {
    assert.equal(iso.env.CODEX_HOME, "/override/codex");
    assert.equal(iso.env.EXTRA_VAR, "extra");
    assert.equal(iso.env.IGNIS_BROKER_DATA, "/override/data");
    assert.equal(iso.env.IGNIS_BROKER_HOME, iso.dirs.brokerHome);
  } finally {
    iso.cleanup();
  }
});

test("isolatedEnv cleanup removes every temp dir it created and is idempotent", () => {
  const iso = isolatedEnv();
  const dirs = Object.values(iso.dirs);
  assert.ok(dirs.length >= 5, "root, home, brokerHome, brokerData and codexHome are reported");
  for (const dir of dirs) assert.ok(fs.existsSync(dir), `${dir} exists before cleanup`);
  assert.ok(fs.existsSync(iso.env.GIT_CONFIG_GLOBAL));
  fs.writeFileSync(path.join(iso.dirs.brokerData, "state.json"), "{}");

  iso.cleanup();

  for (const dir of dirs) assert.ok(!fs.existsSync(dir), `${dir} is removed by cleanup`);
  assert.ok(!fs.existsSync(iso.env.GIT_CONFIG_GLOBAL));
  iso.cleanup();
});

test("isolatedEnv cleanup leaves alone a daemon recorded in its folder that runs another checkout's broker", async () => {
  const iso = isolatedEnv();
  const elsewhere = mkTemp("ignis-other-checkout-");
  const fakeEntry = path.join(elsewhere, "scripts", "ignis-broker.mjs");
  fs.mkdirSync(path.dirname(fakeEntry), { recursive: true });
  fs.writeFileSync(fakeEntry, "setInterval(() => {}, 1000);\n");
  const other = spawn(process.execPath, [fakeEntry, "daemon"], { cwd: os.tmpdir(), stdio: "ignore", windowsHide: true });
  const exited = new Promise((resolve) => other.once("exit", resolve));
  try {
    await waitUntil("the other daemon to start", () => isPidAlive(other.pid), 10_000);
    fs.writeFileSync(path.join(iso.dirs.brokerData, "daemon.json"), JSON.stringify({ pid: other.pid }));

    iso.cleanup();

    assert.equal(isPidAlive(other.pid), true, "a daemon from another checkout must survive cleanup");
    assert.equal(fs.existsSync(iso.dirs.root), false, "the iso folder is still removed");
  } finally {
    other.kill("SIGKILL");
    await exited;
    fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("initGitRepo commits even when the real global config signs commits with a broken gpg", () => {
  const scratch = mkTemp();
  try {
    const hostileConfig = writeHostileGitConfig(scratch);
    withProcessEnv({ GIT_CONFIG_GLOBAL: hostileConfig }, () => {
      // Control: the simulated global config really does break an unisolated commit.
      const control = path.join(scratch, "control");
      fs.mkdirSync(control);
      assert.equal(git(process.env, control, ["init"]).status, 0);
      const broken = git(process.env, control, ["commit", "--allow-empty", "-m", "control"]);
      assert.notEqual(broken.status, 0, "hostile config must break a plain commit");
      assert.match(broken.stderr, /gpg|sign/i, "the commit must fail because of the signing config, not for another reason");

      const iso = isolatedEnv();
      try {
        const repo = path.join(iso.dirs.root, "repo");
        initGitRepo(repo, { env: iso.env, files: { "a.txt": "hello\n" } });

        assert.equal(runGit(repo, ["rev-list", "--count", "HEAD"], { env: iso.env }), "1");
        assert.equal(runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { env: iso.env }), "main");
        assert.equal(runGit(repo, ["ls-files"], { env: iso.env }), "a.txt");
        assert.equal(runGit(repo, ["log", "-1", "--format=%ae"], { env: iso.env }), "ignis-test@example.invalid");
      } finally {
        iso.cleanup();
      }
    });
  } finally {
    rmTemp(scratch);
  }
});

test("initGitRepo does not write into the repository a leaked GIT_DIR points at", () => {
  const scratch = mkTemp();
  try {
    const outer = path.join(scratch, "outer");
    initGitRepo(outer, { commit: false });
    const outerGitDir = path.join(outer, ".git");
    const outerConfigBefore = fs.readFileSync(path.join(outerGitDir, "config"), "utf8");

    withProcessEnv({ GIT_DIR: outerGitDir }, () => {
      const inner = path.join(scratch, "inner");
      initGitRepo(inner, { files: { "c.txt": "x\n" } });
      assert.ok(fs.existsSync(path.join(inner, ".git")), "the repo is created in its own directory");
      assert.equal(runGit(inner, ["rev-list", "--count", "HEAD"]), "1");
    });

    assert.equal(fs.readFileSync(path.join(outerGitDir, "config"), "utf8"), outerConfigBefore, "outer repo config untouched");
    assert.equal(runGit(outer, ["rev-list", "--all", "--count"]), "0", "outer repo gained no commit");
  } finally {
    rmTemp(scratch);
  }
});

test("initGitRepo stays self-sufficient when the caller passes no isolated env", () => {
  const scratch = mkTemp();
  const hostileConfig = writeHostileGitConfig(scratch);
  try {
    withProcessEnv({ GIT_CONFIG_GLOBAL: hostileConfig }, () => {
      const repo = path.join(scratch, "repo");
      initGitRepo(repo, { files: { "b.txt": "x\n" } });
      assert.equal(runGit(repo, ["rev-list", "--count", "HEAD"]), "1");
      assert.equal(runGit(repo, ["log", "-1", "--format=%ae"]), "ignis-test@example.invalid");
    });
  } finally {
    rmTemp(scratch);
  }
});

test("initGitRepo writes nested files and leaves the repo unborn with commit: false", () => {
  const iso = isolatedEnv();
  try {
    const repo = path.join(iso.dirs.root, "unborn");
    initGitRepo(repo, { env: iso.env, commit: false, files: { "src/deep/a.txt": "nested\n" } });

    assert.equal(fs.readFileSync(path.join(repo, "src", "deep", "a.txt"), "utf8"), "nested\n");
    assert.equal(runGit(repo, ["rev-list", "--all", "--count"], { env: iso.env }), "0");
    assert.throws(() => runGit(repo, ["rev-parse", "--verify", "HEAD"], { env: iso.env }), /HEAD/);
  } finally {
    iso.cleanup();
  }
});

test("runGit throws with the command and its stderr when git fails", () => {
  const dir = mkTemp();
  try {
    assert.throws(
      () => runGit(dir, ["not-a-subcommand"]),
      (err) => /git not-a-subcommand failed/.test(err.message) && /not-a-subcommand/.test(err.message)
    );
  } finally {
    rmTemp(dir);
  }
});

test("writeMockStdioServer answers initialize, tools/list and an echo call over stdio", () => {
  const dir = mkTemp();
  const cwd = mkTemp();
  try {
    const script = writeMockStdioServer(dir, { label: "demo" });
    assert.ok(path.isAbsolute(script) && script.endsWith(".mjs") && fs.existsSync(script));

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { msg: "hi" } } },
      { jsonrpc: "2.0", id: 4, method: "no/such/method" },
    ];
    const res = runNode(script, [], { input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n", cwd });
    assert.equal(res.status, 0, res.stderr);

    const lines = res.stdout.split(/\r?\n/).filter(Boolean);
    assert.throws(() => JSON.parse(lines[0]), "banner line is not JSON");
    const msgs = lines.slice(1).map((line) => JSON.parse(line));
    assert.deepEqual(
      msgs.map((m) => m.id),
      [1, 2, 3, 4]
    );

    assert.equal(typeof msgs[0].result.protocolVersion, "string");
    assert.ok(msgs[0].result.capabilities.tools);

    assert.equal(msgs[1].result.tools.length, 1);
    assert.equal(msgs[1].result.tools[0].name, "echo");
    // Two sentences on purpose: the supervisor's compactSummary keeps only the first,
    // and the migrated supervisor test needs a description that proves it.
    assert.equal(msgs[1].result.tools[0].description, "Echo the label and cwd. Extra detail.");

    const [label, echoedCwd] = [
      msgs[2].result.content[0].text.slice(0, "demo:".length),
      msgs[2].result.content[0].text.slice("demo:".length),
    ];
    assert.equal(label, "demo:");
    assert.equal(realPath(echoedCwd), realPath(cwd));
    assert.deepEqual(JSON.parse(msgs[2].result.content[1].text), { msg: "hi" });
    assert.equal(msgs[2].result.isError, false);

    assert.equal(msgs[3].error.code, -32601);
  } finally {
    rmTemp(dir, cwd);
  }
});

test("writeMockStdioServer honours banner: false, crashOnFirstCallMarker and logPidFile", () => {
  const dir = mkTemp();
  try {
    const marker = path.join(dir, "flaky.crashed");
    const pidFile = path.join(dir, "pids.log");
    const script = writeMockStdioServer(dir, {
      label: "flaky",
      banner: false,
      crashOnFirstCallMarker: marker,
      logPidFile: pidFile,
    });
    const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } });

    const first = runNode(script, [], { input: `${call}\n` });
    assert.equal(first.status, 1, "first tools/call crashes the server");
    assert.equal(first.stdout, "", "no banner and no response before the crash");
    assert.ok(fs.existsSync(marker), "crash marker is written");

    const second = runNode(script, [], { input: `${call}\n` });
    assert.equal(second.status, 0, second.stderr);
    const lines = second.stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1);
    assert.ok(JSON.parse(lines[0]).result.content[0].text.startsWith("flaky:"));

    const pids = fs.readFileSync(pidFile, "utf8").trim().split(/\r?\n/);
    assert.equal(pids.length, 2, "one pid line per process start");
    assert.ok(pids.every((pid) => /^\d+$/.test(pid)));
    assert.notEqual(pids[0], pids[1]);
  } finally {
    rmTemp(dir);
  }
});

test("writeMockStdioServer gives two servers with the same label distinct scripts", () => {
  const dir = mkTemp();
  try {
    const a = writeMockStdioServer(dir, { label: "same" });
    const b = writeMockStdioServer(dir, { label: "same" });
    assert.notEqual(a, b);
  } finally {
    rmTemp(dir);
  }
});

test("runNode returns status, stdout and stderr and passes input, env and cwd to the child", () => {
  const dir = mkTemp();
  try {
    const script = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8"), probe: process.env.RUNNODE_PROBE, cwd: process.cwd() }));',
        'process.stderr.write("probe-stderr");',
        "process.exit(3);",
      ].join("\n")
    );

    const res = runNode(script, ["--flag", "value"], {
      input: "payload",
      env: { ...process.env, RUNNODE_PROBE: "yes" },
      cwd: dir,
    });

    assert.equal(res.status, 3);
    assert.equal(res.stderr, "probe-stderr");
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.argv, ["--flag", "value"]);
    assert.equal(out.stdin, "payload");
    assert.equal(out.probe, "yes");
    assert.equal(realPath(out.cwd), realPath(dir));
    assert.equal(res.timedOut, false);
  } finally {
    rmTemp(dir);
  }
});

test("runNode times out a hung child instead of waiting for it", () => {
  const dir = mkTemp();
  try {
    const script = path.join(dir, "hang.mjs");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");

    const started = Date.now();
    const res = runNode(script, [], { timeoutMs: 300 });

    assert.equal(res.timedOut, true);
    assert.equal(res.status, null);
    assert.ok(Date.now() - started < 10_000, "returns well before the default timeout");
  } finally {
    rmTemp(dir);
  }
});

test("writeOnboardingState merges defaults, lets the state override them and round-trips through the loader", () => {
  const dir = mkTemp();
  try {
    const dataDir = path.join(dir, "nested", "data");
    const defaultsFile = writeOnboardingState(dataDir);
    assert.equal(defaultsFile, path.join(dataDir, "onboarding.json"));
    const defaults = JSON.parse(fs.readFileSync(defaultsFile, "utf8"));
    assert.equal(defaults.version, 1);
    assert.equal(defaults.completed, true);
    assert.equal(defaults.skipped, false);
    assert.equal(defaults.memtrace.enabled, false);
    assert.equal(loadOnboardingState(dataDir).completed, true);

    const routing = { strategy: "headless_always", headlessBackend: "codex", headlessModel: null, effort: "low" };
    writeOnboardingState(dataDir, { completed: false, reviewRouting: routing });
    const merged = JSON.parse(fs.readFileSync(defaultsFile, "utf8"));
    assert.equal(merged.completed, false);
    assert.deepEqual(merged.reviewRouting, routing);
    assert.equal(merged.version, 1);
    assert.deepEqual(merged.compaction, { transcriptThresholdKb: 550 });
    assert.deepEqual(loadOnboardingState(dataDir).reviewRouting, routing);
  } finally {
    rmTemp(dir);
  }
});

test("isolatedEnv cleanup on POSIX kills the daemon's whole process group, so its children are not orphaned", { skip: process.platform === "win32" }, async () => {
  const iso = isolatedEnv();
  const childPidFile = path.join(iso.dirs.root, "child.pid");
  const daemonScript = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'require("node:fs").writeFileSync(process.argv[1], String(child.pid));',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const launcherScript = [
    'const { spawn } = require("node:child_process");',
    "const d = spawn(process.execPath, [\"-e\", process.argv[1], process.argv[2], process.argv[3], \"daemon\"], { detached: true, stdio: \"ignore\" });",
    "d.unref();",
    "process.stdout.write(String(d.pid));",
  ].join("\n");
  const launched = spawnSync(process.execPath, ["-e", launcherScript, daemonScript, childPidFile, BROKER_ENTRY], { encoding: "utf8" });
  assert.equal(launched.status, 0, launched.stderr);
  const daemonPid = Number(launched.stdout);
  let childPid = 0;
  let cleaned = false;
  try {
    await waitUntil("the fake daemon to start its child", () => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, "utf8") !== "", 10_000);
    childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    assert.ok(isPidAlive(daemonPid) && isPidAlive(childPid));
    fs.writeFileSync(path.join(iso.dirs.brokerData, "daemon.json"), JSON.stringify({ pid: daemonPid }));

    iso.cleanup();
    cleaned = true;

    await waitUntil("the daemon and its child to be gone", () => !isPidAlive(daemonPid) && !isPidAlive(childPid), 10_000);
  } finally {
    for (const pid of [daemonPid, childPid]) {
      if (pid > 0 && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    if (!cleaned) iso.cleanup();
  }
});
