import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, "..", "scripts", "run-blind-review.mjs");

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTempGitRepo() {
  const repoDir = createTempDir("ignis-blind-repo-");
  const git = (args) => {
    const res = spawnSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  };

  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);

  fs.writeFileSync(path.join(repoDir, "app.js"), "export const value = 1;\n", "utf8");
  git(["add", "app.js"]);
  git(["commit", "-m", "base commit"]);
  git(["tag", "base-ref"]);

  fs.writeFileSync(path.join(repoDir, "app.js"), "export const value = 2;\n", "utf8");
  git(["add", "app.js"]);
  git(["commit", "-m", "feature change"]);

  return repoDir;
}

function writeOnboarding(dataDir, reviewRouting) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "onboarding.json"),
    JSON.stringify({ version: 1, completed: true, reviewRouting }, null, 2),
    "utf8"
  );
}

function createEchoShim(dir, name, mode = "echo") {
  const shimPath = path.join(dir, `${name}.mjs`);
  const code =
    mode === "smoke"
      ? `
import fs from "node:fs";
const stdin = fs.readFileSync(0, "utf8");
process.stdout.write("OK\\n");
`
      : `
import fs from "node:fs";
const stdin = fs.readFileSync(0, "utf8");
const payload = { argv: process.argv.slice(2), stdin };
process.stdout.write(JSON.stringify(payload));
`;
  fs.writeFileSync(shimPath, code.trimStart(), "utf8");
  return shimPath;
}

function runCli(args, envOverrides = {}) {
  return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
}

test("antigravity_gemini_only returns useNative=true and fallbackBackend=null", () => {
  const dataDir = createTempDir("ignis-blind-data-");
  try {
    writeOnboarding(dataDir, {
      strategy: "antigravity_gemini_only",
      headlessBackend: null,
      headlessModel: null,
      effort: "high",
    });

    const res = runCli(["--base", "base-ref", "--backend", "auto", "--json"], {
      IGNIS_BROKER_DATA: dataDir,
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, false);
    assert.equal(out.fallbackBackend, null);
    assert.equal(out.reason, "strategy=antigravity_gemini_only");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("antigravity_first returns native without --fallback and invokes claude shim with --fallback", () => {
  const dataDir = createTempDir("ignis-blind-data-");
  const shimDir = createTempDir("ignis-blind-shim-");
  const repoDir = createTempGitRepo();
  try {
    writeOnboarding(dataDir, {
      strategy: "antigravity_first",
      headlessBackend: "claude",
      headlessModel: "opus",
      effort: "high",
    });

    const first = runCli(
      ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir }
    );
    assert.equal(first.status, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout);
    assert.equal(firstJson.useNative, true);
    assert.equal(firstJson.fallbackToNative, false);
    assert.equal(firstJson.fallbackBackend, "claude");
    assert.equal(firstJson.reason, "strategy=antigravity_first");

    const claudeShim = createEchoShim(shimDir, "claude-shim");
    const second = runCli(
      ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--fallback", "--json"],
      {
        IGNIS_BROKER_DATA: dataDir,
        IGNIS_CLAUDE_CMD: claudeShim,
      }
    );
    assert.equal(second.status, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout);
    assert.equal(secondJson.useNative, false);
    assert.equal(secondJson.backend, "claude");
    assert.equal(secondJson.model, "opus");
    assert.ok(secondJson.diffBytes > 0);

    const captured = JSON.parse(secondJson.output);
    assert.equal(captured.argv[0], "-p");
    assert.ok(captured.argv[1].length > 0);
    assert.deepEqual(captured.argv.slice(2), [
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
    ]);
    assert.match(captured.stdin, /export const value = 2;/);
    assert.match(captured.stdin, /diff --git a\/app\.js b\/app\.js/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("headless_always with codex passes -m when model is set and omits -m when headlessModel is null", () => {
  const dataDir = createTempDir("ignis-blind-data-");
  const shimDir = createTempDir("ignis-blind-shim-");
  const repoDir = createTempGitRepo();
  try {
    const codexShim = createEchoShim(shimDir, "codex-shim");

    writeOnboarding(dataDir, {
      strategy: "headless_always",
      headlessBackend: "codex",
      headlessModel: "gpt-6.2-sol",
      effort: "high",
    });

    const withModel = runCli(
      ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
      {
        IGNIS_BROKER_DATA: dataDir,
        IGNIS_CODEX_CMD: codexShim,
      }
    );
    assert.equal(withModel.status, 0, withModel.stderr);
    const withModelJson = JSON.parse(withModel.stdout);
    assert.equal(withModelJson.useNative, false);
    assert.equal(withModelJson.backend, "codex");
    assert.equal(withModelJson.model, "gpt-6.2-sol");

    const capturedWithModel = JSON.parse(withModelJson.output);
    assert.deepEqual(capturedWithModel.argv, [
      "-m",
      "gpt-6.2-sol",
      "exec",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-",
    ]);
    assert.match(capturedWithModel.stdin, /diff --git a\/app\.js b\/app\.js/);
    assert.match(capturedWithModel.stdin, /export const value = 2;/);

    writeOnboarding(dataDir, {
      strategy: "headless_always",
      headlessBackend: "codex",
      headlessModel: null,
      effort: "high",
    });

    const withoutModel = runCli(
      ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
      {
        IGNIS_BROKER_DATA: dataDir,
        IGNIS_CODEX_CMD: codexShim,
      }
    );
    assert.equal(withoutModel.status, 0, withoutModel.stderr);
    const withoutModelJson = JSON.parse(withoutModel.stdout);
    assert.equal(withoutModelJson.useNative, false);
    assert.equal(withoutModelJson.backend, "codex");
    assert.equal(withoutModelJson.model, null);

    const capturedWithoutModel = JSON.parse(withoutModelJson.output);
    assert.deepEqual(capturedWithoutModel.argv, [
      "exec",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-",
    ]);
    assert.ok(!capturedWithoutModel.argv.includes("-m"));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("--smoke-test succeeds for both claude and codex shims", () => {
  const shimDir = createTempDir("ignis-blind-smoke-");
  try {
    const claudeShim = createEchoShim(shimDir, "claude-smoke", "smoke");
    const codexShim = createEchoShim(shimDir, "codex-smoke", "smoke");

    const claudeRes = runCli(["--smoke-test", "--backend", "claude", "--json"], {
      IGNIS_CLAUDE_CMD: claudeShim,
    });
    assert.equal(claudeRes.status, 0, claudeRes.stderr);
    const claudeOut = JSON.parse(claudeRes.stdout);
    assert.equal(claudeOut.ok, true);
    assert.equal(claudeOut.backend, "claude");
    assert.equal(claudeOut.model, "opus");
    assert.equal(claudeOut.output, "OK");

    const codexRes = runCli(
      ["--smoke-test", "--backend", "codex", "--model", "gpt-6.2-sol", "--json"],
      { IGNIS_CODEX_CMD: codexShim }
    );
    assert.equal(codexRes.status, 0, codexRes.stderr);
    const codexOut = JSON.parse(codexRes.stdout);
    assert.equal(codexOut.ok, true);
    assert.equal(codexOut.backend, "codex");
    assert.equal(codexOut.model, "gpt-6.2-sol");
    assert.equal(codexOut.output, "OK");
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test("missing binary returns useNative=true and fallbackToNative=true with exit 0", () => {
  const dataDir = createTempDir("ignis-blind-data-");
  const repoDir = createTempGitRepo();
  try {
    writeOnboarding(dataDir, {
      strategy: "headless_always",
      headlessBackend: "claude",
      headlessModel: "opus",
      effort: "high",
    });

    const res = runCli(
      ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
      {
        IGNIS_BROKER_DATA: dataDir,
        IGNIS_CLAUDE_CMD: "ignis-nonexistent-binary-xyz-9999",
      }
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, true);
    assert.equal(out.base, "base-ref");
    assert.ok(out.diffBytes > 0);
    assert.ok(typeof out.reason === "string" && out.reason.length > 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("Windows .cmd claude shim receives -p prompt, --strict-mcp-config, and trailing flags intact", { skip: process.platform !== "win32" }, () => {
  const dataDir = createTempDir("ignis-blind-cmd-data-");
  const shimDir = createTempDir("ignis-blind-cmd-shim-");
  const repoDir = createTempGitRepo();
  try {
    writeOnboarding(dataDir, {
      strategy: "headless_always",
      headlessBackend: "claude",
      headlessModel: "opus",
      effort: "high",
    });

    const jsPath = createEchoShim(shimDir, "claude-cmd-target");
    const cmdPath = path.join(shimDir, "claude.cmd");
    fs.writeFileSync(
      cmdPath,
      `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%" "%dp0%\\claude-cmd-target.mjs" %*\r\n`.replace('"%_prog%"', `"${process.execPath}"`),
      "utf8"
    );

    const npmStyleCmdPath = path.join(shimDir, "claude-npm.cmd");
    fs.writeFileSync(
      npmStyleCmdPath,
      `@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\claude-cmd-target.mjs" %*\r\n`,
      "utf8"
    );

    for (const shim of [cmdPath, npmStyleCmdPath]) {
      const res = runCli(
        ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
        {
          IGNIS_BROKER_DATA: dataDir,
          IGNIS_CLAUDE_CMD: shim,
        }
      );
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.useNative, false);
      const captured = JSON.parse(out.output);
      assert.equal(captured.argv[0], "-p");
      assert.ok(!captured.argv[1].includes("\n"));
      assert.ok(captured.argv.includes("--strict-mcp-config"));
      assert.ok(captured.argv.includes("--no-session-persistence"));
      assert.equal(captured.argv[captured.argv.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("empty diff short-circuits, corrupt onboarding falls back, and trailing value flag throws", () => {
  const dataDir = createTempDir("ignis-blind-edge-data-");
  const repoDir = createTempGitRepo();
  try {
    writeOnboarding(dataDir, {
      strategy: "headless_always",
      headlessBackend: "claude",
      headlessModel: "opus",
      effort: "high",
    });

    const emptyRes = runCli(
      ["--base", "HEAD", "--cwd", repoDir, "--backend", "auto", "--json"],
      {
        IGNIS_BROKER_DATA: dataDir,
        IGNIS_CLAUDE_CMD: "ignis-nonexistent-binary-xyz-9999",
      }
    );
    assert.equal(emptyRes.status, 0, emptyRes.stderr);
    const emptyOut = JSON.parse(emptyRes.stdout);
    assert.equal(emptyOut.useNative, false);
    assert.equal(emptyOut.diffBytes, 0);

    fs.writeFileSync(path.join(dataDir, "onboarding.json"), "{corrupt-json", "utf8");
    const corruptRes = runCli(
      ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir }
    );
    assert.equal(corruptRes.status, 0, corruptRes.stderr);
    const corruptOut = JSON.parse(corruptRes.stdout);
    assert.equal(corruptOut.useNative, true);
    assert.equal(corruptOut.reason, "strategy=antigravity_gemini_only");

    const trailingFlag = runCli(["--base"]);
    assert.notEqual(trailingFlag.status, 0);
    assert.match(trailingFlag.stderr, /missing value for --base/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});


function stateFile(dataDir) {
  return path.join(dataDir, "blind-review-state.json");
}

function headlessRouting() {
  return { strategy: "headless_always", headlessBackend: "claude", headlessModel: null, effort: "high" };
}

function withFixture(fn) {
  const dataDir = createTempDir("ignis-blind-state-data-");
  const shimDir = createTempDir("ignis-blind-state-shim-");
  const repo = createTempGitRepo();
  try {
    return fn({ dataDir, shimDir, repo });
  } finally {
    for (const d of [dataDir, shimDir, repo]) fs.rmSync(d, { recursive: true, force: true });
  }
}

const runArgs = (repo) => ["--base", "base-ref", "--cwd", repo, "--backend", "auto", "--json"];

test("failing headless run records fresh fallback marker and success clears it", async () => {
  const { hasFreshNativeFallback } = await import("../scripts/broker/onboarding.mjs");
  withFixture(({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const failing = path.join(shimDir, "fail.mjs");
    fs.writeFileSync(failing, "process.exit(3);\n", "utf8");
    let res = runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: failing });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.useNative, true);
    assert.equal(parsed.fallbackToNative, true);
    assert.equal(hasFreshNativeFallback(dataDir, [repo]), true);

    const ok = createEchoShim(shimDir, "ok");
    res = runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok });
    assert.equal(JSON.parse(res.stdout).fallbackToNative, false);
    assert.equal(hasFreshNativeFallback(dataDir, [repo]), false);
  });
});

test("empty diff clears an existing fallback marker", async () => {
  const { hasFreshNativeFallback, recordBlindReviewState } = await import("../scripts/broker/onboarding.mjs");
  withFixture(({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    recordBlindReviewState(dataDir, repo, { fallbackToNative: true, reason: "x" });
    assert.equal(hasFreshNativeFallback(dataDir, [repo]), true);
    const res = runCli(
      ["--base", "HEAD", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(hasFreshNativeFallback(dataDir, [repo]), false);
  });
});

test("unconfigured headless backend records fallback marker", async () => {
  const { hasFreshNativeFallback } = await import("../scripts/broker/onboarding.mjs");
  withFixture(({ dataDir, repo }) => {
    writeOnboarding(dataDir, { strategy: "headless_always", headlessBackend: null, headlessModel: null, effort: "high" });
    const res = runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir });
    assert.equal(JSON.parse(res.stdout).fallbackToNative, true);
    assert.equal(hasFreshNativeFallback(dataDir, [repo]), true);
  });
});

test("smoke-test and non-attempt strategies never write state", () => {
  withFixture(({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const env = { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "smoke", "smoke") };
    const res = runCli(["--smoke-test", "--backend", "claude", "--cwd", repo], env);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(stateFile(dataDir)), false);

    for (const strategy of ["antigravity_gemini_only", "antigravity_first"]) {
      writeOnboarding(dataDir, { strategy, headlessBackend: "claude", headlessModel: null, effort: "high" });
      const stratRes = runCli(runArgs(repo), env);
      assert.equal(stratRes.status, 0, stratRes.stderr);
      assert.equal(JSON.parse(stratRes.stdout).useNative, true);
      assert.equal(fs.existsSync(stateFile(dataDir)), false);
    }
  });
});

test("unwritable state location does not crash review output", () => {
  withFixture(({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    fs.mkdirSync(stateFile(dataDir));
    const res = runCli(runArgs(repo), {
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).fallbackToNative, false);
  });
});

test("uncommitted working-tree edits are included when --base HEAD is passed", () => {
  withFixture(({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n", "utf8");

    const ok = createEchoShim(shimDir, "ok");
    const res = runCli(
      ["--base", "HEAD", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok }
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, false);
    assert.equal(out.fallbackToNative, false);
    assert.ok(out.diffBytes > 0, `expected non-empty diff, got diffBytes=${out.diffBytes}`);
    const captured = JSON.parse(out.output);
    assert.match(captured.stdin, /export const value = 3;/);
  });
});

test("non-zero exit with stdout-only error preserves stdout in reason and records fallback marker", async () => {
  const { hasFreshNativeFallback } = await import("../scripts/broker/onboarding.mjs");
  withFixture(({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const stdoutErrShim = path.join(shimDir, "stdout-fail.mjs");
    fs.writeFileSync(
      stdoutErrShim,
      'process.stdout.write("You\'ve hit your weekly limit · resets 11pm\\n");\nprocess.exit(1);\n',
      "utf8"
    );

    const res = runCli(runArgs(repo), {
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_CLAUDE_CMD: stdoutErrShim,
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, true);
    assert.match(out.reason, /claude exited with status 1:.*You've hit your weekly limit/);
    assert.equal(hasFreshNativeFallback(dataDir, [repo]), true);

    const rawState = fs.readFileSync(stateFile(dataDir), "utf8");
    assert.match(rawState, /You've hit your weekly limit/);
  });
});

test("invalid --backend throws without writing fallback state", () => {
  withFixture(({ dataDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    for (const badBackend of ["bogus", ""]) {
      const res = runCli(
        ["--base", "base-ref", "--cwd", repo, "--backend", badBackend, "--json"],
        { IGNIS_BROKER_DATA: dataDir }
      );
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /unsupported backend/i);
      assert.equal(fs.existsSync(stateFile(dataDir)), false);
    }
  });
});

test("mismatched explicit --backend override does not persist fallback marker", async () => {
  const { hasFreshNativeFallback } = await import("../scripts/broker/onboarding.mjs");
  withFixture(({ dataDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const res = runCli(
      ["--base", "base-ref", "--cwd", repo, "--backend", "codex", "--json"],
      {
        IGNIS_BROKER_DATA: dataDir,
        IGNIS_CODEX_CMD: "ignis-nonexistent-codex-xyz-9999",
      }
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, true);
    assert.equal(fs.existsSync(stateFile(dataDir)), false);
    assert.equal(hasFreshNativeFallback(dataDir, [repo]), false);
  });
});

test("--base rejects flag injection and invalid git refs loudly without writing files or state", () => {
  withFixture(({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const ok = createEchoShim(shimDir, "ok");

    const evilPath = path.join(repo, "evil.txt");
    const injRes = runCli(
      ["--base", "--output=evil.txt", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok }
    );
    assert.notEqual(injRes.status, 0);
    assert.match(injRes.stderr, /--base must not start with '-'/);
    assert.equal(fs.existsSync(evilPath), false);
    assert.equal(fs.existsSync(stateFile(dataDir)), false);

    const badRefRes = runCli(
      ["--base", "nonexistent-ref", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok }
    );
    assert.notEqual(badRefRes.status, 0);
    assert.match(badRefRes.stderr, /merge-base/i);
    assert.equal(fs.existsSync(stateFile(dataDir)), false);
  });
});

