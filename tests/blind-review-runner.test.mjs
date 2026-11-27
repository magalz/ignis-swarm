import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readReviewState, reviewGateDecision, reviewStatePath } from "../scripts/broker/review-state.mjs";
import { initGitRepo, runGit } from "./helpers.mjs";

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
const argv = process.argv.slice(2);
const at = argv.indexOf("--mcp-config");
const configPath = at === -1 ? null : argv[at + 1];
const mcpConfig =
  configPath === null
    ? null
    : { path: configPath, exists: fs.existsSync(configPath), content: fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null };
const payload = { argv, stdin, mcpConfig };
process.stdout.write(JSON.stringify(payload) + "\\nStatus: PASS\\n");
`;
  fs.writeFileSync(shimPath, code.trimStart(), "utf8");
  return shimPath;
}

function captured(output) {
  return JSON.parse(output.split("\n")[0]);
}

function createOutputShim(dir, name, text) {
  const shimPath = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(
    shimPath,
    `import fs from "node:fs";\nfs.readFileSync(0, "utf8");\nprocess.stdout.write(${JSON.stringify(text)});\n`,
    "utf8"
  );
  return shimPath;
}

function runCli(args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH, ...args], {
      windowsHide: true,
      env: { ...process.env, ...envOverrides },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("blind-review runner", { concurrency: 8 }, () => {
it("antigravity_gemini_only returns useNative=true and fallbackBackend=null", async () => {
  const dataDir = createTempDir("ignis-blind-data-");
  try {
    writeOnboarding(dataDir, {
      strategy: "antigravity_gemini_only",
      headlessBackend: null,
      headlessModel: null,
      effort: "high",
    });

    const res = await runCli(["--base", "base-ref", "--backend", "auto", "--json"], {
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

it("antigravity_first returns native without --fallback and invokes claude shim with --fallback", async () => {
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

    const first = await runCli(
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
    const second = await runCli(
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

    const seen = captured(secondJson.output);
    assert.equal(seen.argv[0], "-p");
    assert.ok(seen.argv[1].length > 0);
    const configAt = seen.argv.indexOf("--mcp-config");
    assert.deepEqual(seen.argv.slice(2, configAt), [
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--strict-mcp-config",
    ]);
    assert.equal(path.basename(seen.argv[configAt + 1]), "mcp-config.json");
    assert.deepEqual(seen.argv.slice(configAt + 2), ["--no-session-persistence"]);
    assert.equal(seen.mcpConfig.exists, true);
    assert.equal(seen.mcpConfig.content, '{"mcpServers":{}}');
    assert.match(seen.stdin, /export const value = 2;/);
    assert.match(seen.stdin, /diff --git a\/app\.js b\/app\.js/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

it("headless_always with codex passes -m when model is set and omits -m when headlessModel is null", async () => {
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

    const withModel = await runCli(
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

    const capturedWithModel = captured(withModelJson.output);
    assert.deepEqual(capturedWithModel.argv, [
      "exec",
      "-m",
      "gpt-6.2-sol",
      "--sandbox",
      "read-only",
      "-c",
      "approval_policy=never",
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

    const withoutModel = await runCli(
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

    const capturedWithoutModel = captured(withoutModelJson.output);
    assert.deepEqual(capturedWithoutModel.argv, [
      "exec",
      "--sandbox",
      "read-only",
      "-c",
      "approval_policy=never",
      "-",
    ]);
    assert.ok(!capturedWithoutModel.argv.includes("-m"));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

it("--smoke-test succeeds for both claude and codex shims", async () => {
  const shimDir = createTempDir("ignis-blind-smoke-");
  try {
    const claudeShim = createEchoShim(shimDir, "claude-smoke", "smoke");
    const codexShim = createEchoShim(shimDir, "codex-smoke", "smoke");

    const claudeRes = await runCli(["--smoke-test", "--backend", "claude", "--json"], {
      IGNIS_CLAUDE_CMD: claudeShim,
    });
    assert.equal(claudeRes.status, 0, claudeRes.stderr);
    const claudeOut = JSON.parse(claudeRes.stdout);
    assert.equal(claudeOut.ok, true);
    assert.equal(claudeOut.backend, "claude");
    assert.equal(claudeOut.model, "opus");
    assert.equal(claudeOut.output, "OK");

    const codexRes = await runCli(
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

it("missing binary returns useNative=true and fallbackToNative=true with exit 0", async () => {
  const dataDir = createTempDir("ignis-blind-data-");
  const repoDir = createTempGitRepo();
  try {
    writeOnboarding(dataDir, {
      strategy: "headless_always",
      headlessBackend: "claude",
      headlessModel: "opus",
      effort: "high",
    });

    const res = await runCli(
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

it("Windows .cmd claude shim receives -p prompt, --strict-mcp-config, and trailing flags intact", { skip: process.platform !== "win32" }, async () => {
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

    const batchCallCmdPath = path.join(shimDir, "claude-call.cmd");
    fs.writeFileSync(
      batchCallCmdPath,
      `@ECHO off\r\nCALL "${process.execPath}" "%~dp0claude-cmd-target.mjs" %*\r\n`,
      "utf8"
    );

    for (const shim of [cmdPath, npmStyleCmdPath, batchCallCmdPath]) {
      const res = await runCli(
        ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
        {
          IGNIS_BROKER_DATA: dataDir,
          IGNIS_CLAUDE_CMD: shim,
        }
      );
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.useNative, false, `${shim}: ${out.reason}`);
      const seen = captured(out.output);
      assert.equal(seen.argv[0], "-p");
      assert.ok(!seen.argv[1].includes("\n"));
      assert.ok(seen.argv.includes("--strict-mcp-config"));
      assert.ok(seen.argv.includes("--no-session-persistence"));
      assert.equal(seen.argv[seen.argv.indexOf("--tools") + 1], "", shim);
      assert.equal(seen.argv[seen.argv.indexOf("--setting-sources") + 1], "", shim);
      assert.ok(seen.argv.includes("--disable-slash-commands"), shim);
      assert.equal(seen.mcpConfig.exists, true);
      assert.equal(seen.mcpConfig.content, '{"mcpServers":{}}');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

it("empty diff short-circuits, corrupt onboarding falls back, and trailing value flag throws", async () => {
  const dataDir = createTempDir("ignis-blind-edge-data-");
  const repoDir = createTempGitRepo();
  try {
    writeOnboarding(dataDir, {
      strategy: "headless_always",
      headlessBackend: "claude",
      headlessModel: "opus",
      effort: "high",
    });

    const emptyRes = await runCli(
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
    const corruptRes = await runCli(
      ["--base", "base-ref", "--cwd", repoDir, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir }
    );
    assert.equal(corruptRes.status, 0, corruptRes.stderr);
    const corruptOut = JSON.parse(corruptRes.stdout);
    assert.equal(corruptOut.useNative, true);
    assert.equal(corruptOut.reason, "strategy=antigravity_gemini_only");

    const trailingFlag = await runCli(["--base"]);
    assert.notEqual(trailingFlag.status, 0);
    assert.match(trailingFlag.stderr, /missing value for --base/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});


function stateDir(dataDir) {
  return path.join(dataDir, "blind-review");
}

function blockStateDir(dataDir) {
  fs.writeFileSync(stateDir(dataDir), "not a directory", "utf8");
}

function headOf(repo) {
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function assertState(dataDir, repo, status) {
  const record = readReviewState(dataDir, repo);
  assert.ok(record, `expected a ${status} review state for ${repo}`);
  assert.equal(record.status, status);
  assert.equal(record.headSha, headOf(repo));
  return record;
}

function gateAllows(dataDir, dirs) {
  return reviewGateDecision(dataDir, dirs).allow;
}

function headlessRouting() {
  return { strategy: "headless_always", headlessBackend: "claude", headlessModel: null, effort: "high" };
}

async function withFixture(fn, makeRepo = createTempGitRepo) {
  const dataDir = createTempDir("ignis-blind-state-data-");
  const shimDir = createTempDir("ignis-blind-state-shim-");
  const repo = makeRepo();
  try {
    return await fn({ dataDir, shimDir, repo });
  } finally {
    for (const d of [dataDir, shimDir, repo]) fs.rmSync(d, { recursive: true, force: true });
  }
}

const runArgs = (repo) => ["--base", "base-ref", "--cwd", repo, "--backend", "auto", "--json"];

it("failing headless run records a fallback state and a successful run records reviewed", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const failing = path.join(shimDir, "fail.mjs");
    fs.writeFileSync(failing, "process.exit(3);\n", "utf8");
    let res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: failing });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.useNative, true);
    assert.equal(parsed.fallbackToNative, true);
    const fallback = assertState(dataDir, repo, "fallback");
    assert.equal(fallback.reason, parsed.reason);
    assert.equal(gateAllows(dataDir, [repo]), true);

    const ok = createEchoShim(shimDir, "ok");
    res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok });
    assert.equal(JSON.parse(res.stdout).fallbackToNative, false);
    const reviewed = assertState(dataDir, repo, "reviewed");
    assert.equal(reviewed.reason, null);
    assert.equal(gateAllows(dataDir, [repo]), false);
  });
});

it("empty diff replaces an existing fallback state with empty", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const failing = path.join(shimDir, "fail.mjs");
    fs.writeFileSync(failing, "process.exit(3);\n", "utf8");
    const failed = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: failing });
    assert.equal(failed.status, 0, failed.stderr);
    assertState(dataDir, repo, "fallback");
    assert.equal(gateAllows(dataDir, [repo]), true);

    const res = await runCli(
      ["--base", "HEAD", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }
    );
    assert.equal(res.status, 0, res.stderr);
    const emptyState = assertState(dataDir, repo, "empty");
    assert.equal(emptyState.reason, null);
    assert.equal(gateAllows(dataDir, [repo]), false);
  });
});

it("unconfigured headless backend records a fallback state", async () => {
  await withFixture(async ({ dataDir, repo }) => {
    writeOnboarding(dataDir, { strategy: "headless_always", headlessBackend: null, headlessModel: null, effort: "high" });
    const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir });
    assert.equal(JSON.parse(res.stdout).fallbackToNative, true);
    assert.match(assertState(dataDir, repo, "fallback").reason, /invalid or unconfigured headless backend/);
    assert.equal(gateAllows(dataDir, [repo]), true);
  });
});

it("smoke-test and non-attempt strategies never write state", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const env = { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "smoke", "smoke") };
    const res = await runCli(["--smoke-test", "--backend", "claude", "--cwd", repo], env);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(stateDir(dataDir)), false);

    for (const strategy of ["antigravity_gemini_only", "antigravity_first"]) {
      writeOnboarding(dataDir, { strategy, headlessBackend: "claude", headlessModel: null, effort: "high" });
      const stratRes = await runCli(runArgs(repo), env);
      assert.equal(stratRes.status, 0, stratRes.stderr);
      assert.equal(JSON.parse(stratRes.stdout).useNative, true);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
    }
  });
});

it("unwritable state location does not crash review output and is reported as stateError and on stderr", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    blockStateDir(dataDir);
    const res = await runCli(runArgs(repo), {
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"),
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.fallbackToNative, false);
    assert.equal(out.useNative, false);
    assert.equal(typeof out.stateError, "string");
    assert.ok(out.stateError.length > 0);
    assert.ok(
      res.stderr.includes(`review state could not be recorded at ${reviewStatePath(dataDir, repo)}: ${out.stateError}`),
      `stderr was: ${res.stderr}`
    );
  });
});

it("a failing headless run whose state cannot be written reports stateError in JSON and on stderr", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    blockStateDir(dataDir);
    const failing = path.join(shimDir, "fail.mjs");
    fs.writeFileSync(failing, "process.exit(3);\n", "utf8");
    const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: failing });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, true);
    assert.equal(typeof out.stateError, "string");
    assert.ok(out.stateError.length > 0);
    assert.ok(
      res.stderr.includes(`review state could not be recorded at ${reviewStatePath(dataDir, repo)}`),
      `stderr was: ${res.stderr}`
    );
  });
});

it("a state that cannot be written is reported on stderr in non-JSON mode after a successful review", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    blockStateDir(dataDir);
    const res = await runCli(["--base", "base-ref", "--cwd", repo, "--backend", "auto"], {
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(captured(res.stdout).stdin, /export const value = 2;/);
    assert.ok(
      res.stderr.includes(`review state could not be recorded at ${reviewStatePath(dataDir, repo)}`),
      `stderr was: ${res.stderr}`
    );
  });
});

it("buildClaudeArgs passes the MCP config as a file path and buildCodexArgs leaves approval_policy unquoted", async () => {
  const { buildClaudeArgs, buildCodexArgs } = await import("../scripts/run-blind-review.mjs");
  assert.deepEqual(buildClaudeArgs("review this", "opus", "high", "/tmp/ignis/mcp-config.json"), [
    "-p",
    "review this",
    "--model",
    "opus",
    "--effort",
    "high",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "/tmp/ignis/mcp-config.json",
    "--no-session-persistence",
  ]);
  const codexArgs = buildCodexArgs(null);
  assert.equal(codexArgs[codexArgs.indexOf("-c") + 1], "approval_policy=never");
  assert.ok(codexArgs.every((arg) => !arg.includes('"')));
});

it("the claude argv gives the reviewer no tools, no settings sources and no slash commands, and never uses --bare", async () => {
  const { buildClaudeArgs } = await import("../scripts/run-blind-review.mjs");
  const args = buildClaudeArgs("review this", "opus", "high", "/tmp/ignis/mcp-config.json");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--disable-slash-commands"));
  for (const forbidden of ["--allowedTools", "--allowed-tools", "--bare", "--add-dir", "--settings"]) {
    assert.ok(!args.includes(forbidden), `${forbidden} must not be passed`);
  }
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/ignis/mcp-config.json");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
});

it("the empty --tools and --setting-sources values reach a claude shim as empty argv elements", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-empty-args") });
    assert.equal(res.status, 0, res.stderr);
    const { argv } = captured(JSON.parse(res.stdout).output);
    assert.equal(argv[argv.indexOf("--tools") + 1], "");
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "");
    assert.ok(argv.includes("--disable-slash-commands"));
    assert.ok(!argv.includes("--allowedTools"));
  });
});

it("buildCodexArgs puts -m after exec and omits it without a model", async () => {
  const { buildCodexArgs } = await import("../scripts/run-blind-review.mjs");
  assert.deepEqual(buildCodexArgs("gpt-6.2-sol"), [
    "exec",
    "-m",
    "gpt-6.2-sol",
    "--sandbox",
    "read-only",
    "-c",
    "approval_policy=never",
    "-",
  ]);
  assert.deepEqual(buildCodexArgs(null), ["exec", "--sandbox", "read-only", "-c", "approval_policy=never", "-"]);
});

it("claude receives an existing MCP config file during the run and its temp directory is gone afterwards", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const echo = createEchoShim(shimDir, "echo-config");
    const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: echo });
    assert.equal(res.status, 0, res.stderr);
    const seen = captured(JSON.parse(res.stdout).output);
    assert.ok(seen.argv.includes("--strict-mcp-config"));
    assert.ok(path.isAbsolute(seen.mcpConfig.path));
    assert.equal(seen.mcpConfig.exists, true);
    assert.equal(seen.mcpConfig.content, '{"mcpServers":{}}');
    assert.equal(fs.existsSync(path.dirname(seen.mcpConfig.path)), false);

    const recorder = path.join(shimDir, "record-then-fail.mjs");
    const recorded = path.join(shimDir, "recorded-config-path.txt");
    fs.writeFileSync(
      recorder,
      `import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recorded)}, argv[argv.indexOf("--mcp-config") + 1]);
process.exit(4);
`,
      "utf8"
    );
    const failed = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: recorder });
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).fallbackToNative, true);
    const configPath = fs.readFileSync(recorded, "utf8");
    assert.equal(fs.existsSync(path.dirname(configPath)), false);
  });
});

it("--smoke-test passes claude an existing MCP config file", async () => {
  await withFixture(async ({ shimDir }) => {
    const shim = path.join(shimDir, "claude-smoke-config.mjs");
    fs.writeFileSync(
      shim,
      `import fs from "node:fs";
const argv = process.argv.slice(2);
const configPath = argv[argv.indexOf("--mcp-config") + 1];
process.stdout.write(fs.existsSync(configPath) ? "OK\\n" : "MISSING\\n");
`,
      "utf8"
    );
    const res = await runCli(["--smoke-test", "--backend", "claude", "--json"], { IGNIS_CLAUDE_CMD: shim });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true, JSON.stringify(out));
  });
});

it("a diff above the size limit records a fallback state and still prints JSON", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(8192), "utf8");
    spawnSync("git", ["add", "big.txt"], { cwd: repo, windowsHide: true });
    spawnSync("git", ["commit", "-q", "-m", "big file"], { cwd: repo, windowsHide: true });

    const env = {
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"),
      IGNIS_REVIEW_MAX_DIFF_BYTES: "1024",
    };
    const res = await runCli(["--base", "base-ref", "--cwd", repo, "--backend", "auto"], env);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, true);
    assert.match(out.reason, /diff extraction failed/);
    assert.match(out.reason, /too_large/);
    assert.match(out.reason, /1024/);
    assert.equal(out.base, "base-ref");
    assertState(dataDir, repo, "fallback");
    assert.equal(gateAllows(dataDir, [repo]), true);

    const nonNumeric = await runCli(runArgs(repo), { ...env, IGNIS_REVIEW_MAX_DIFF_BYTES: "not-a-number" });
    assert.equal(nonNumeric.status, 0, nonNumeric.stderr);
    assert.equal(JSON.parse(nonNumeric.stdout).useNative, false);
    assertState(dataDir, repo, "reviewed");
    assert.equal(gateAllows(dataDir, [repo]), false);
  });
});

it("a diff extraction failure from git itself falls back and reports that no state could be recorded", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    Object.assign(env, {
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"),
      PATH: path.join(shimDir, "no-git-here"),
    });
    const res = spawnSync(process.execPath, [RUNNER_PATH, ...runArgs(repo)], {
      encoding: "utf8",
      windowsHide: true,
      env,
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, true);
    assert.match(out.reason, /diff extraction failed/);
    assert.equal(typeof out.stateError, "string");
    assert.ok(out.stateError.length > 0);
    assert.ok(
      res.stderr.includes(`review state could not be recorded at ${stateDir(dataDir)}: ${out.stateError}`),
      `stderr was: ${res.stderr}`
    );
    assert.equal(fs.existsSync(stateDir(dataDir)), false);
  });
});

it(
  "Windows plain .cmd claude shim runs now that no argument carries a double quote",
  { skip: process.platform !== "win32" ? "needs cmd.exe batch handling, Windows only" : false },
  async () => {
    await withFixture(async ({ dataDir, shimDir, repo }) => {
      writeOnboarding(dataDir, headlessRouting());
      const cmdPath = path.join(shimDir, "claude-plain.cmd");
      fs.writeFileSync(cmdPath, "@echo off\r\necho review\r\necho Status: PASS\r\n", "utf8");
      const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: cmdPath });
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.useNative, false);
      assert.equal(out.fallbackToNative, false);
      assert.equal(out.verdict, "PASS");
      assert.match(out.output, /^review\r?\nStatus: PASS\r?\n?$/);
    });
  }
);

it(
  "Windows plain .cmd shim with a double quote in an argument records a fallback state instead of exiting 1",
  { skip: process.platform !== "win32" ? "resolvePlatformCommand only rejects batch arguments on Windows" : false },
  async () => {
    await withFixture(async ({ dataDir, shimDir, repo }) => {
      writeOnboarding(dataDir, { ...headlessRouting(), headlessModel: 'op"us' });
      const cmdPath = path.join(shimDir, "claude-plain.cmd");
      fs.writeFileSync(cmdPath, "@echo off\r\necho review\r\n", "utf8");
      const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: cmdPath });
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.useNative, true);
      assert.equal(out.fallbackToNative, true);
      assert.match(out.reason, /double quotes/);
      assertState(dataDir, repo, "fallback");
      assert.equal(gateAllows(dataDir, [repo]), true);
    });
  }
);

it(
  "Windows plain .cmd codex shim with a double quote in the model records a fallback state instead of exiting 1",
  { skip: process.platform !== "win32" ? "resolvePlatformCommand only rejects batch arguments on Windows" : false },
  async () => {
    await withFixture(async ({ dataDir, shimDir, repo }) => {
      writeOnboarding(dataDir, { ...headlessRouting(), headlessBackend: "codex", headlessModel: 'o"3' });
      const cmdPath = path.join(shimDir, "codex-plain.cmd");
      fs.writeFileSync(cmdPath, "@echo off\r\necho review\r\n", "utf8");
      const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CODEX_CMD: cmdPath });
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.useNative, true);
      assert.equal(out.fallbackToNative, true);
      assert.match(out.reason, /double quotes/);
      assertState(dataDir, repo, "fallback");
      assert.equal(gateAllows(dataDir, [repo]), true);
    });
  }
);

it("uncommitted working-tree edits are included when --base HEAD is passed", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n", "utf8");

    const ok = createEchoShim(shimDir, "ok");
    const res = await runCli(
      ["--base", "HEAD", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok }
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, false);
    assert.equal(out.fallbackToNative, false);
    assert.ok(out.diffBytes > 0, `expected non-empty diff, got diffBytes=${out.diffBytes}`);
    assert.match(captured(out.output).stdin, /export const value = 3;/);
  });
});

it("non-zero exit with stdout-only error preserves stdout in reason and records a fallback state", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const stdoutErrShim = path.join(shimDir, "stdout-fail.mjs");
    fs.writeFileSync(
      stdoutErrShim,
      'process.stdout.write("You\'ve hit your weekly limit · resets 11pm\\n");\nprocess.exit(1);\n',
      "utf8"
    );

    const res = await runCli(runArgs(repo), {
      IGNIS_BROKER_DATA: dataDir,
      IGNIS_CLAUDE_CMD: stdoutErrShim,
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, true);
    assert.equal(out.fallbackToNative, true);
    assert.match(out.reason, /claude exited with status 1:.*You've hit your weekly limit/);
    assert.match(assertState(dataDir, repo, "fallback").reason, /You've hit your weekly limit/);
    assert.equal(gateAllows(dataDir, [repo]), true);
  });
});

it("invalid --backend throws without writing fallback state", async () => {
  await withFixture(async ({ dataDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    for (const badBackend of ["bogus", ""]) {
      const res = await runCli(
        ["--base", "base-ref", "--cwd", repo, "--backend", badBackend, "--json"],
        { IGNIS_BROKER_DATA: dataDir }
      );
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /unsupported backend/i);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
    }
  });
});

it("mismatched explicit --backend override does not persist a fallback state", async () => {
  await withFixture(async ({ dataDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const res = await runCli(
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
    assert.equal(fs.existsSync(stateDir(dataDir)), false);
    assert.equal(gateAllows(dataDir, [repo]), false);
  });
});

it("--base rejects flag injection and invalid git refs loudly without writing files or state", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const ok = createEchoShim(shimDir, "ok");

    const evilPath = path.join(repo, "evil.txt");
    const injRes = await runCli(
      ["--base", "--output=evil.txt", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok }
    );
    assert.notEqual(injRes.status, 0);
    assert.match(injRes.stderr, /--base must not start with '-'/);
    assert.equal(fs.existsSync(evilPath), false);
    assert.equal(fs.existsSync(stateDir(dataDir)), false);

    const badRefRes = await runCli(
      ["--base", "nonexistent-ref", "--cwd", repo, "--backend", "auto", "--json"],
      { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok }
    );
    assert.notEqual(badRefRes.status, 0);
    assert.match(badRefRes.stderr, /merge-base/i);
    assert.equal(fs.existsSync(stateDir(dataDir)), false);
  });
});

it("the runner started through a junction or symlink still runs: bad input is exit 1, not a silent exit 0", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    const root = createTempDir("ignis-blind-link-");
    try {
      const realScripts = path.join(root, "real-scripts");
      fs.cpSync(path.resolve(__dirname, "..", "scripts"), realScripts, { recursive: true });
      const linkedScripts = path.join(root, "linked-scripts");
      fs.symlinkSync(realScripts, linkedScripts, process.platform === "win32" ? "junction" : "dir");
      assert.notEqual(fs.realpathSync.native(linkedScripts), path.resolve(linkedScripts));
      const linkedRunner = path.join(linkedScripts, "run-blind-review.mjs");
      const runLinked = (args, env) =>
        spawnSync(process.execPath, [linkedRunner, ...args], {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, ...env },
        });

      writeOnboarding(dataDir, headlessRouting());
      const ok = createEchoShim(shimDir, "ok-link");
      const env = { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok };

      const unknownFlag = runLinked(["--definitely-unknown-flag"], env);
      assert.equal(unknownFlag.status, 1, unknownFlag.stderr);
      assert.match(unknownFlag.stderr, /unknown argument: --definitely-unknown-flag/);
      assert.equal(unknownFlag.stdout, "");

      const injected = runLinked(["--base", "--output=evil.txt", "--cwd", repo, "--backend", "auto", "--json"], env);
      assert.equal(injected.status, 1, injected.stderr);
      assert.match(injected.stderr, /--base must not start with '-'/);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);

      const good = runLinked(runArgs(repo), env);
      assert.equal(good.status, 0, good.stderr);
      const out = JSON.parse(good.stdout);
      assert.equal(out.fallbackToNative, false);
      assert.equal(out.verdict, "PASS");
      assertState(dataDir, repo, "reviewed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

it("monorepo subdir keys state on the git root while a nested git repo keeps its own record", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const subDir = path.join(repo, "packages", "app");
    fs.mkdirSync(subDir, { recursive: true });

    const failing = path.join(shimDir, "fail-sub.mjs");
    fs.writeFileSync(failing, "process.exit(2);\n", "utf8");
    const ok = createEchoShim(shimDir, "ok-sub");

    const failRes = await runCli(runArgs(subDir), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: failing });
    assert.equal(failRes.status, 0, failRes.stderr);
    assert.equal(JSON.parse(failRes.stdout).fallbackToNative, true);
    assertState(dataDir, repo, "fallback");
    assert.equal(readReviewState(dataDir, subDir), null);
    assert.equal(gateAllows(dataDir, [repo]), true);
    assert.equal(gateAllows(dataDir, [subDir]), true);

    const okRes = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: ok });
    assert.equal(okRes.status, 0, okRes.stderr);
    assertState(dataDir, repo, "reviewed");
    assert.equal(gateAllows(dataDir, [repo]), false);
    assert.equal(gateAllows(dataDir, [subDir]), false);

    const nestedRepo = path.join(repo, "nested-repo");
    fs.mkdirSync(nestedRepo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: nestedRepo, windowsHide: true });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: nestedRepo, windowsHide: true });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: nestedRepo, windowsHide: true });
    fs.writeFileSync(path.join(nestedRepo, "n.js"), "export const n = 1;\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: nestedRepo, windowsHide: true });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: nestedRepo, windowsHide: true });
    spawnSync("git", ["branch", "base-ref"], { cwd: nestedRepo, windowsHide: true });
    fs.writeFileSync(path.join(nestedRepo, "n.js"), "export const n = 2;\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: nestedRepo, windowsHide: true });
    spawnSync("git", ["commit", "-q", "-m", "change"], { cwd: nestedRepo, windowsHide: true });

    const nestedFail = await runCli(runArgs(nestedRepo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: failing });
    assert.equal(nestedFail.status, 0, nestedFail.stderr);
    assert.equal(JSON.parse(nestedFail.stdout).fallbackToNative, true);
    assertState(dataDir, nestedRepo, "fallback");
    assert.equal(gateAllows(dataDir, [nestedRepo]), true);
    assert.equal(gateAllows(dataDir, [repo]), false);
    assertState(dataDir, repo, "reviewed");
  });
});


const NO_VERDICT_EMPTY = "headless reviewer returned no verdict (empty output)";
const NO_VERDICT_PREFIX = "headless reviewer returned no verdict (no Status line): ";

async function runReviewer(fixture, text, extraArgs = []) {
  const { dataDir, shimDir, repo } = fixture;
  writeOnboarding(dataDir, headlessRouting());
  const shim = createOutputShim(shimDir, `out-${fs.readdirSync(shimDir).length}`, text);
  const res = await runCli([...runArgs(repo), ...extraArgs], { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: shim });
  assert.equal(res.status, 0, res.stderr);
  return res;
}

function assertNoVerdictFallback(fixture, res, reason) {
  const out = JSON.parse(res.stdout);
  assert.equal(out.useNative, true);
  assert.equal(out.fallbackToNative, true);
  assert.equal(out.reason, reason);
  assert.ok(!("verdict" in out));
  assert.equal(assertState(fixture.dataDir, fixture.repo, "fallback").reason, reason);
  assert.equal(gateAllows(fixture.dataDir, [fixture.repo]), true);
}

it("a headless run that exits 0 with empty output records a fallback state", async () => {
  await withFixture(async (fixture) => {
    assertNoVerdictFallback(fixture, await runReviewer(fixture, ""), NO_VERDICT_EMPTY);
  });
});

it("a headless run whose output has no Status line records a fallback state carrying the detail", async () => {
  await withFixture(async (fixture) => {
    const text = "The reviewer wrote Status: ISSUES in the middle of a sentence.\n";
    assertNoVerdictFallback(fixture, await runReviewer(fixture, text), `${NO_VERDICT_PREFIX}${text.trim()}`);
  });
});

it("Status: PASS is a success with verdict PASS, the reviewed state and the reviewer output printed", async () => {
  await withFixture(async (fixture) => {
    const text = "No HIGH or MEDIUM issues found.\nStatus: PASS\n";
    const res = await runReviewer(fixture, text);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, false);
    assert.equal(out.fallbackToNative, false);
    assert.equal(out.verdict, "PASS");
    assert.ok(!("stateError" in out));
    assert.equal(out.output, text);
    assert.equal(assertState(fixture.dataDir, fixture.repo, "reviewed").reason, null);
    assert.equal(gateAllows(fixture.dataDir, [fixture.repo]), false);

    const plain = await runCli(
      ["--base", "base-ref", "--cwd", fixture.repo, "--backend", "auto"],
      {
        IGNIS_BROKER_DATA: fixture.dataDir,
        IGNIS_CLAUDE_CMD: path.join(fixture.shimDir, `out-${fs.readdirSync(fixture.shimDir).length - 1}.mjs`),
      }
    );
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, text);
  });
});

it("Status: ISSUES is reported as such with the reviewed state and keeps the gate closed", async () => {
  await withFixture(async (fixture) => {
    const out = JSON.parse((await runReviewer(fixture, "Found a race condition in app.js.\n\n**Status: issues**\n")).stdout);
    assert.equal(out.useNative, false);
    assert.equal(out.fallbackToNative, false);
    assert.equal(out.verdict, "ISSUES");
    assertState(fixture.dataDir, fixture.repo, "reviewed");
    assert.equal(gateAllows(fixture.dataDir, [fixture.repo]), false);
  });
});

it("the review prompt passed to claude and to codex carries the Status instruction", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const claude = JSON.parse(
      (await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-echo") })).stdout
    );
    assert.equal(claude.verdict, "PASS");
    const prompt = captured(claude.output).argv[1];
    assert.match(prompt, /Status: PASS/);
    assert.match(prompt, /Status: ISSUES/);
    assert.match(prompt, /final line/);
    assert.match(prompt, /HIGH or MEDIUM/);
    assert.ok(!prompt.includes("\n"));
    assert.ok(!prompt.includes('"'));

    writeOnboarding(dataDir, { ...headlessRouting(), headlessBackend: "codex" });
    const codex = JSON.parse(
      (await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CODEX_CMD: createEchoShim(shimDir, "codex-echo") })).stdout
    );
    assert.equal(codex.verdict, "PASS");
    assert.match(captured(codex.output).stdin, /Status: PASS[\s\S]*Status: ISSUES/);
  });
});

const ESC = String.fromCharCode(27);

function reviewerEnv(dataDir, shimDir, extra = {}) {
  return { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"), ...extra };
}

it("a new untracked file that is the only change reaches the reviewer and records reviewed", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    fs.writeFileSync(path.join(repo, "fresh.js"), "export const fresh = 42;\n", "utf8");
    const res = await runCli(["--base", "HEAD", "--cwd", repo, "--backend", "auto", "--json"], reviewerEnv(dataDir, shimDir));
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, false);
    assert.equal(out.fallbackToNative, false);
    assert.ok(out.diffBytes > 0, `expected the new file in the diff, got diffBytes=${out.diffBytes}`);
    const seen = captured(out.output);
    assert.match(seen.stdin, /diff --git a\/fresh\.js b\/fresh\.js/);
    assert.match(seen.stdin, /new file mode/);
    assert.match(seen.stdin, /export const fresh = 42;/);
    assertState(dataDir, repo, "reviewed");
    assert.equal(runGit(repo, ["status", "--porcelain"]), "?? fresh.js");
  });
});

it("a repository with no commits and a new file is reviewed and records headSha unborn", async () => {
  const makeRepo = () =>
    initGitRepo(createTempDir("ignis-blind-unborn-"), { commit: false, files: { "created.js": "export const created = 1;\n" } });
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const res = await runCli(["--base", "HEAD", "--cwd", repo, "--backend", "auto", "--json"], reviewerEnv(dataDir, shimDir));
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.useNative, false);
    assert.equal(out.fallbackToNative, false);
    assert.equal(out.verdict, "PASS");
    const seen = captured(out.output);
    assert.match(seen.stdin, /diff --git a\/created\.js b\/created\.js/);
    assert.match(seen.stdin, /export const created = 1;/);
    const record = readReviewState(dataDir, repo);
    assert.ok(record, "expected a review state for the repository with no commits");
    assert.equal(record.status, "reviewed");
    assert.equal(record.headSha, "unborn");
    assert.equal(gateAllows(dataDir, [repo]), false);
  }, makeRepo);
});

it("a HEAD that moves while the reviewer runs does not change the recorded headSha", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const before = headOf(repo);
    const mover = path.join(shimDir, "move-head.mjs");
    fs.writeFileSync(
      mover,
      `import fs from "node:fs";
import { spawnSync } from "node:child_process";
fs.readFileSync(0, "utf8");
const res = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "moved during review"], {
  cwd: ${JSON.stringify(repo)},
  encoding: "utf8",
});
if (res.status !== 0) {
  process.stderr.write(String(res.stderr));
  process.exit(9);
}
process.stdout.write("Status: PASS\\n");
`,
      "utf8"
    );
    const res = await runCli(runArgs(repo), { IGNIS_BROKER_DATA: dataDir, IGNIS_CLAUDE_CMD: mover });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).fallbackToNative, false);
    assert.notEqual(headOf(repo), before, "the shim must have moved HEAD");
    const record = readReviewState(dataDir, repo);
    assert.equal(record.status, "reviewed");
    assert.equal(record.headSha, before);
  });
});

it("a --cwd that does not exist or is outside git is an input error: exit 1 and no state", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    const outside = createTempDir("ignis-blind-nogit-");
    try {
      const cases = [
        [path.join(shimDir, "no-such-dir"), /--cwd/],
        [outside, /not inside a git repository/],
      ];
      for (const [cwd, message] of cases) {
        const res = await runCli(
          ["--base", "HEAD", "--cwd", cwd, "--backend", "auto", "--json"],
          reviewerEnv(dataDir, shimDir, { GIT_CEILING_DIRECTORIES: os.tmpdir() })
        );
        assert.equal(res.status, 1, `${cwd}: ${res.stdout}`);
        assert.match(res.stderr, message);
        assert.equal(res.stdout, "");
        assert.equal(fs.existsSync(stateDir(dataDir)), false);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    assert.equal(readReviewState(dataDir, repo), null);
  });
});

it("git color.ui=always leaves no escape characters in the diff the reviewer receives", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    runGit(repo, ["config", "color.ui", "always"]);
    const res = await runCli(runArgs(repo), reviewerEnv(dataDir, shimDir));
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.fallbackToNative, false, out.reason);
    const { stdin } = captured(out.output);
    assert.ok(!stdin.includes(ESC), "the reviewer stdin must carry no ANSI escape characters");
    assert.match(stdin, /^-export const value = 1;$/m);
    assert.match(stdin, /^\+export const value = 2;$/m);
    assertState(dataDir, repo, "reviewed");
  });
});

it("diff.noprefix and diff.external in the user git config do not change the diff the reviewer receives", async () => {
  await withFixture(async ({ dataDir, shimDir, repo }) => {
    writeOnboarding(dataDir, headlessRouting());
    runGit(repo, ["config", "diff.noprefix", "true"]);
    runGit(repo, ["config", "diff.external", "ignis-nonexistent-diff-tool-xyz-9999"]);
    const res = await runCli(runArgs(repo), reviewerEnv(dataDir, shimDir));
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.fallbackToNative, false, out.reason);
    const { stdin } = captured(out.output);
    assert.match(stdin, /diff --git a\/app\.js b\/app\.js/);
    assert.match(stdin, /^\+export const value = 2;$/m);
    assertState(dataDir, repo, "reviewed");
  });
});
});
