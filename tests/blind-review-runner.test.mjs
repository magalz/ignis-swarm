import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readReviewState, reviewGateDecision, reviewStatePath } from "../scripts/broker/review-state.mjs";
import { buildClaudeArgs, buildCodexArgs } from "../scripts/run-blind-review.mjs";
import { initGitRepo, isolatedEnv, runGit, runNode } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");
const RUNNER_PATH = path.join(SCRIPTS_DIR, "run-blind-review.mjs");

const NO_VERDICT_EMPTY = "headless reviewer returned no verdict (empty output)";
const NO_VERDICT_PREFIX = "headless reviewer returned no verdict (no Status line): ";
const MISSING_BINARY = "ignis-nonexistent-binary-xyz-9999";
const ESC = String.fromCharCode(27);
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const WINDOWS_ONLY = process.platform === "win32" ? false : "Windows only";

function headlessRouting(overrides = {}) {
  return { strategy: "headless_always", headlessBackend: "claude", headlessModel: "opus", effort: "high", ...overrides };
}

function writeOnboarding(dataDir, reviewRouting) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "onboarding.json"),
    JSON.stringify({ version: 1, completed: true, reviewRouting }, null, 2),
    "utf8"
  );
}

function createFeatureRepo(dir, env, { file = "app.js", before = "export const value = 1;\n", after = "export const value = 2;\n" } = {}) {
  initGitRepo(dir, { env, files: { [file]: before } });
  runGit(dir, ["tag", "base-ref"], { env });
  fs.writeFileSync(path.join(dir, file), after, "utf8");
  runGit(dir, ["add", "-A"], { env });
  runGit(dir, ["commit", "-m", "feature change"], { env });
  return dir;
}

function writeShim(dir, name, source) {
  const shimPath = path.join(dir, name);
  fs.writeFileSync(shimPath, source, "utf8");
  return shimPath;
}

function createEchoShim(dir, name) {
  return writeShim(
    dir,
    `${name}.mjs`,
    `import fs from "node:fs";
const stdin = fs.readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const at = argv.indexOf("--mcp-config");
const configPath = at === -1 ? null : argv[at + 1];
const mcpConfig =
  configPath === null
    ? null
    : { path: configPath, exists: fs.existsSync(configPath), content: fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null };
process.stdout.write(JSON.stringify({ argv, stdin, mcpConfig }) + "\\nStatus: PASS\\n");
`
  );
}

function createSmokeShim(dir, name) {
  return writeShim(dir, `${name}.mjs`, `import fs from "node:fs";\nfs.readFileSync(0, "utf8");\nprocess.stdout.write("OK\\n");\n`);
}

function createFailingShim(dir, name, code) {
  return writeShim(dir, `${name}.mjs`, `process.exit(${code});\n`);
}

let outputShimCount = 0;
function createOutputShim(dir, text) {
  outputShimCount += 1;
  return writeShim(
    dir,
    `output-${outputShimCount}.mjs`,
    `import fs from "node:fs";\nfs.readFileSync(0, "utf8");\nprocess.stdout.write(${JSON.stringify(text)});\n`
  );
}

function captured(output) {
  return JSON.parse(output.split("\n")[0]);
}

function parseOut(res) {
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function stateDir(dataDir) {
  return path.join(dataDir, "blind-review");
}

function blockStateDir(dataDir) {
  fs.writeFileSync(stateDir(dataDir), "not a directory", "utf8");
}

function jsonArgs(repo, { base = "base-ref", backend = "auto", extra = [] } = {}) {
  return ["--base", base, "--cwd", repo, "--backend", backend, "--json", ...extra];
}

function assertClaudeArgv(argv, model) {
  const configAt = argv.indexOf("--mcp-config");
  assert.equal(argv[0], "-p");
  assert.match(argv[1], /^[^\r\n]+$/);
  assert.deepEqual(argv.slice(2, configAt), [
    "--model",
    model,
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
  assert.equal(path.basename(argv[configAt + 1]), "mcp-config.json");
  assert.deepEqual(argv.slice(configAt + 2), ["--no-session-persistence"]);
}

function withIso(fn) {
  const iso = isolatedEnv();
  const run = (args, extra = {}, { noPath, ...options } = {}) => {
    const env = { ...iso.env, ...extra };
    if (noPath) {
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
      env.PATH = noPath;
    }
    return runNode(RUNNER_PATH, args, { env, timeoutMs: 60_000, ...options });
  };
  return Promise.resolve(fn({ iso, dataDir: iso.dirs.brokerData, run })).finally(() => iso.cleanup());
}

function withFixture(fn, { routing = headlessRouting(), makeRepo = createFeatureRepo } = {}) {
  return withIso((base) => {
    const { iso, dataDir } = base;
    const shimDir = path.join(iso.dirs.root, "shims");
    fs.mkdirSync(shimDir, { recursive: true });
    const repo = makeRepo(path.join(iso.dirs.root, "repo"), iso.env);
    if (routing) writeOnboarding(dataDir, routing);
    const head = (dir = repo) => runGit(dir, ["rev-parse", "HEAD"], { env: iso.env });
    const assertState = (status, dir = repo) => {
      const record = readReviewState(dataDir, dir);
      assert.notEqual(record, null, `expected a ${status} review state for ${dir}`);
      assert.equal(record.status, status);
      assert.equal(record.headSha, head(dir));
      return record;
    };
    const gateAllows = (...dirs) => reviewGateDecision(dataDir, dirs, { env: iso.env }).allow;
    const git = (args, dir = repo) => runGit(dir, args, { env: iso.env });
    return fn({ ...base, shimDir, repo, head, assertState, gateAllows, git });
  });
}

describe("blind-review runner: strategy routing", () => {
  it("antigravity_gemini_only returns native with no fallback backend", async () => {
    await withIso(async ({ dataDir, run }) => {
      writeOnboarding(dataDir, headlessRouting({ strategy: "antigravity_gemini_only", headlessBackend: null, headlessModel: null }));
      const out = parseOut(run(["--base", "base-ref", "--backend", "auto", "--json"]));
      assert.deepEqual(
        { useNative: out.useNative, fallbackToNative: out.fallbackToNative, fallbackBackend: out.fallbackBackend, reason: out.reason },
        { useNative: true, fallbackToNative: false, fallbackBackend: null, reason: "strategy=antigravity_gemini_only" }
      );
    });
  });

  it("antigravity_first without --fallback returns native and names the fallback backend", async () => {
    await withFixture(
      async ({ repo, run }) => {
        const out = parseOut(run(jsonArgs(repo)));
        assert.deepEqual(
          { useNative: out.useNative, fallbackToNative: out.fallbackToNative, fallbackBackend: out.fallbackBackend, reason: out.reason },
          { useNative: true, fallbackToNative: false, fallbackBackend: "claude", reason: "strategy=antigravity_first" }
        );
      },
      { routing: headlessRouting({ strategy: "antigravity_first" }) }
    );
  });

  it("antigravity_first with --fallback runs the claude backend with the configured model", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo, { extra: ["--fallback"] }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-shim") }));
        assert.deepEqual(
          { useNative: out.useNative, backend: out.backend, model: out.model },
          { useNative: false, backend: "claude", model: "opus" }
        );
      },
      { routing: headlessRouting({ strategy: "antigravity_first" }) }
    );
  });

  it("antigravity_first with --fallback passes claude the full review argv", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo, { extra: ["--fallback"] }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-shim") }));
        assertClaudeArgv(captured(out.output).argv, "opus");
      },
      { routing: headlessRouting({ strategy: "antigravity_first" }) }
    );
  });

  it("antigravity_first with --fallback sends the diff on stdin", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo, { extra: ["--fallback"] }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-shim") }));
        const { stdin } = captured(out.output);
        assert.match(stdin, /diff --git a\/app\.js b\/app\.js/);
        assert.match(stdin, /^-export const value = 1;$/m);
        assert.match(stdin, /^\+export const value = 2;$/m);
      },
      { routing: headlessRouting({ strategy: "antigravity_first" }) }
    );
  });
});

describe("blind-review runner: codex backend", () => {
  const CODEX_ROUTING = { headlessBackend: "codex" };

  it("passes -m after exec when the model is set", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo), { IGNIS_CODEX_CMD: createEchoShim(shimDir, "codex-shim") }));
        assert.deepEqual(
          { useNative: out.useNative, backend: out.backend, model: out.model },
          { useNative: false, backend: "codex", model: "gpt-6.2-sol" }
        );
        assert.deepEqual(captured(out.output).argv, [
          "exec",
          "-m",
          "gpt-6.2-sol",
          "--sandbox",
          "read-only",
          "-c",
          "approval_policy=never",
          "-",
        ]);
      },
      { routing: headlessRouting({ ...CODEX_ROUTING, headlessModel: "gpt-6.2-sol" }) }
    );
  });

  it("omits -m when headlessModel is null", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo), { IGNIS_CODEX_CMD: createEchoShim(shimDir, "codex-shim") }));
        assert.deepEqual(
          { useNative: out.useNative, backend: out.backend, model: out.model },
          { useNative: false, backend: "codex", model: null }
        );
        assert.deepEqual(captured(out.output).argv, ["exec", "--sandbox", "read-only", "-c", "approval_policy=never", "-"]);
      },
      { routing: headlessRouting({ ...CODEX_ROUTING, headlessModel: null }) }
    );
  });

  it("sends the diff on stdin", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo), { IGNIS_CODEX_CMD: createEchoShim(shimDir, "codex-shim") }));
        const { stdin } = captured(out.output);
        assert.match(stdin, /diff --git a\/app\.js b\/app\.js/);
        assert.match(stdin, /^\+export const value = 2;$/m);
      },
      { routing: headlessRouting({ ...CODEX_ROUTING, headlessModel: null }) }
    );
  });
});

describe("blind-review runner: --smoke-test", () => {
  it("succeeds for a claude shim", async () => {
    await withIso(async ({ dataDir, run }) => {
      const shim = createSmokeShim(dataDir, "claude-smoke");
      const out = parseOut(run(["--smoke-test", "--backend", "claude", "--json"], { IGNIS_CLAUDE_CMD: shim }));
      assert.deepEqual(
        { ok: out.ok, backend: out.backend, model: out.model, output: out.output },
        { ok: true, backend: "claude", model: "opus", output: "OK" }
      );
    });
  });

  it("succeeds for a codex shim with an explicit model", async () => {
    await withIso(async ({ dataDir, run }) => {
      const shim = createSmokeShim(dataDir, "codex-smoke");
      const out = parseOut(run(["--smoke-test", "--backend", "codex", "--model", "gpt-6.2-sol", "--json"], { IGNIS_CODEX_CMD: shim }));
      assert.deepEqual(
        { ok: out.ok, backend: out.backend, model: out.model, output: out.output },
        { ok: true, backend: "codex", model: "gpt-6.2-sol", output: "OK" }
      );
    });
  });

  it("passes claude an MCP config file that exists", async () => {
    await withIso(async ({ dataDir, run }) => {
      const shim = writeShim(
        dataDir,
        "claude-smoke-config.mjs",
        `import fs from "node:fs";
const argv = process.argv.slice(2);
const configPath = argv[argv.indexOf("--mcp-config") + 1];
process.stdout.write(fs.existsSync(configPath) ? "OK\\n" : "MISSING\\n");
`
      );
      const out = parseOut(run(["--smoke-test", "--backend", "claude", "--json"], { IGNIS_CLAUDE_CMD: shim }));
      assert.equal(out.output, "OK");
    });
  });

  it("writes no review state", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      const res = run(["--smoke-test", "--backend", "claude", "--cwd", repo], { IGNIS_CLAUDE_CMD: createSmokeShim(shimDir, "smoke") });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
    });
  });
});

describe("blind-review runner: fallback to native", () => {
  it("a missing binary falls back to native with exit 0 and the spawn failure as the reason", async () => {
    await withFixture(async ({ repo, run }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: MISSING_BINARY }));
      assert.deepEqual(
        { useNative: out.useNative, fallbackToNative: out.fallbackToNative, base: out.base },
        { useNative: true, fallbackToNative: true, base: "base-ref" }
      );
      assert.match(out.reason, new RegExp(`${MISSING_BINARY}|ENOENT`));
    });
  });

  it("a missing binary still reports the exact byte size of the diff it extracted", async () => {
    await withFixture(async ({ repo, git, run }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: MISSING_BINARY }));
      const expected = `${git(["diff", "base-ref", "HEAD"])}
`;
      assert.equal(out.diffBytes, Buffer.byteLength(expected));
      assert.equal(out.diffBytes > 0, true);
    });
  });

  it("an unconfigured headless backend records a fallback state", async () => {
    await withFixture(
      async ({ repo, run, assertState, gateAllows }) => {
        const out = parseOut(run(jsonArgs(repo)));
        assert.equal(out.fallbackToNative, true);
        assert.match(assertState("fallback").reason, /invalid or unconfigured headless backend/);
        assert.equal(gateAllows(repo), true);
      },
      { routing: headlessRouting({ headlessBackend: null, headlessModel: null }) }
    );
  });

  it("a failing run exits 0 with native fallback and a fallback state carrying the same reason", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, gateAllows }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createFailingShim(shimDir, "fail", 3) }));
      assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: true, fallbackToNative: true });
      assert.match(out.reason, /claude exited with status 3/);
      assert.equal(assertState("fallback").reason, out.reason);
      assert.equal(gateAllows(repo), true);
    });
  });

  it("a non-zero exit with stdout-only output keeps that stdout in the reason", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, gateAllows }) => {
      const shim = writeShim(
        shimDir,
        "stdout-fail.mjs",
        'process.stdout.write("You\'ve hit your weekly limit · resets 11pm\\n");\nprocess.exit(1);\n'
      );
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: shim }));
      assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: true, fallbackToNative: true });
      assert.match(out.reason, /claude exited with status 1:.*You've hit your weekly limit/);
      assert.equal(assertState("fallback").reason, out.reason);
      assert.equal(gateAllows(repo), true);
    });
  });

  it("a mismatched explicit --backend override does not persist a fallback state", async () => {
    await withFixture(async ({ repo, dataDir, run, gateAllows }) => {
      const out = parseOut(run(jsonArgs(repo, { backend: "codex" }), { IGNIS_CODEX_CMD: "ignis-nonexistent-codex-xyz-9999" }));
      assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: true, fallbackToNative: true });
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
      assert.equal(gateAllows(repo), false);
    });
  });
});

describe("blind-review runner: review state", () => {
  it("a successful run records reviewed with no reason and closes the gate", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, gateAllows }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assert.equal(out.fallbackToNative, false);
      assert.equal(assertState("reviewed").reason, null);
      assert.equal(gateAllows(repo), false);
    });
  });

  it("a successful run replaces an earlier fallback state with reviewed", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, gateAllows }) => {
      run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createFailingShim(shimDir, "fail", 3) });
      assertState("fallback");
      assert.equal(gateAllows(repo), true);
      run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") });
      assert.equal(assertState("reviewed").reason, null);
      assert.equal(gateAllows(repo), false);
    });
  });

  it("an empty diff replaces an earlier fallback state with empty and closes the gate", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, gateAllows }) => {
      run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createFailingShim(shimDir, "fail", 3) });
      assertState("fallback");
      assert.equal(gateAllows(repo), true);
      const res = run(jsonArgs(repo, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(assertState("empty").reason, null);
      assert.equal(gateAllows(repo), false);
    });
  });

  for (const strategy of ["antigravity_gemini_only", "antigravity_first"]) {
    it(`the ${strategy} strategy writes no state`, async () => {
      await withFixture(
        async ({ repo, dataDir, shimDir, run }) => {
          const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
          assert.equal(out.useNative, true);
          assert.equal(fs.existsSync(stateDir(dataDir)), false);
        },
        { routing: headlessRouting({ strategy }) }
      );
    });
  }

  it("a monorepo subdirectory keys its state on the git root", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, gateAllows, dataDir }) => {
      const subDir = path.join(repo, "packages", "app");
      fs.mkdirSync(subDir, { recursive: true });
      const out = parseOut(run(jsonArgs(subDir), { IGNIS_CLAUDE_CMD: createFailingShim(shimDir, "fail", 2) }));
      assert.equal(out.fallbackToNative, true);
      assertState("fallback");
      assert.equal(readReviewState(dataDir, subDir), null);
      assert.deepEqual([gateAllows(repo), gateAllows(subDir)], [true, true]);
    });
  });

  it("a review run from the git root closes the gate for its subdirectories", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, gateAllows }) => {
      const subDir = path.join(repo, "packages", "app");
      fs.mkdirSync(subDir, { recursive: true });
      parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assertState("reviewed");
      assert.deepEqual([gateAllows(repo), gateAllows(subDir)], [false, false]);
    });
  });

  it("a nested git repository keeps its own record and leaves its parent's alone", async () => {
    await withFixture(async ({ repo, iso, shimDir, run, assertState, gateAllows }) => {
      const nestedRepo = createFeatureRepo(path.join(repo, "nested-repo"), iso.env, {
        file: "n.js",
        before: "export const n = 1;\n",
        after: "export const n = 2;\n",
      });
      parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      const out = parseOut(run(jsonArgs(nestedRepo), { IGNIS_CLAUDE_CMD: createFailingShim(shimDir, "fail", 2) }));
      assert.equal(out.fallbackToNative, true);
      assertState("fallback", nestedRepo);
      assert.equal(gateAllows(nestedRepo), true);
      assertState("reviewed");
      assert.equal(gateAllows(repo), false);
    });
  });
});

describe("blind-review runner: unwritable state", () => {
  const STATE_ERROR = /^(ENOTDIR|EEXIST|EPERM|EACCES|ENOENT)\b/;

  it("a successful review reports stateError in the JSON", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      blockStateDir(dataDir);
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assert.deepEqual({ fallbackToNative: out.fallbackToNative, useNative: out.useNative }, { fallbackToNative: false, useNative: false });
      assert.match(out.stateError, STATE_ERROR);
    });
  });

  it("a successful review reports the same stateError on stderr with the state path", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      blockStateDir(dataDir);
      const res = run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") });
      const out = parseOut(res);
      assert.ok(
        res.stderr.includes(`review state could not be recorded at ${reviewStatePath(dataDir, repo)}: ${out.stateError}`),
        `stderr was: ${res.stderr}`
      );
    });
  });

  it("a failing headless run still falls back and reports stateError in the JSON", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      blockStateDir(dataDir);
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createFailingShim(shimDir, "fail", 3) }));
      assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: true, fallbackToNative: true });
      assert.match(out.stateError, STATE_ERROR);
    });
  });

  it("a failing headless run reports the unwritable state on stderr", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      blockStateDir(dataDir);
      const res = run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createFailingShim(shimDir, "fail", 3) });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(res.stderr.includes(`review state could not be recorded at ${reviewStatePath(dataDir, repo)}`), `stderr was: ${res.stderr}`);
    });
  });

  it("non-JSON mode prints the reviewer stdout and reports the unwritable state on stderr", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      blockStateDir(dataDir);
      const res = run(["--base", "base-ref", "--cwd", repo, "--backend", "auto"], { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") });
      assert.equal(res.status, 0, res.stderr);
      assert.match(captured(res.stdout).stdin, /^\+export const value = 2;$/m);
      assert.ok(res.stderr.includes(`review state could not be recorded at ${reviewStatePath(dataDir, repo)}`), `stderr was: ${res.stderr}`);
    });
  });
});

describe("blind-review runner: claude and codex argv builders", () => {
  it("buildClaudeArgs passes the MCP config as a file path", () => {
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
  });

  it("buildClaudeArgs never passes a tool allowlist, --bare, --add-dir or --settings", () => {
    const args = buildClaudeArgs("review this", "opus", "high", "/tmp/ignis/mcp-config.json");
    const forbidden = ["--allowedTools", "--allowed-tools", "--bare", "--add-dir", "--settings"];
    assert.deepEqual(
      args.filter((arg) => forbidden.includes(arg)),
      []
    );
  });

  it("buildCodexArgs puts -m after exec", () => {
    assert.deepEqual(buildCodexArgs("gpt-6.2-sol"), ["exec", "-m", "gpt-6.2-sol", "--sandbox", "read-only", "-c", "approval_policy=never", "-"]);
  });

  it("buildCodexArgs omits -m without a model", () => {
    assert.deepEqual(buildCodexArgs(null), ["exec", "--sandbox", "read-only", "-c", "approval_policy=never", "-"]);
  });

  it("buildCodexArgs leaves approval_policy unquoted and carries no double quote", () => {
    const args = buildCodexArgs(null);
    assert.equal(args[args.indexOf("-c") + 1], "approval_policy=never");
    assert.deepEqual(
      args.filter((arg) => arg.includes('"')),
      []
    );
  });
});

describe("blind-review runner: claude invocation", () => {
  it("the empty --tools and --setting-sources values reach a claude shim as empty argv elements", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-empty-args") }));
      const { argv } = captured(out.output);
      assert.deepEqual([argv[argv.indexOf("--tools") + 1], argv[argv.indexOf("--setting-sources") + 1]], ["", ""]);
    });
  });

  it("the prompt is a single line without a double quote", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-echo") }));
      assert.match(captured(out.output).argv[1], /^[^\r\n"]+$/);
    });
  });

  it("the prompt carries the Status instruction", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "claude-echo") }));
      assert.equal(out.verdict, "PASS");
      const prompt = captured(out.output).argv[1];
      assert.match(prompt, /Status: PASS/);
      assert.match(prompt, /Status: ISSUES/);
      assert.match(prompt, /final line/);
      assert.match(prompt, /HIGH or MEDIUM/);
    });
  });

  it("the codex stdin carries the Status instruction", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo), { IGNIS_CODEX_CMD: createEchoShim(shimDir, "codex-echo") }));
        assert.equal(out.verdict, "PASS");
        assert.match(captured(out.output).stdin, /Status: PASS[\s\S]*Status: ISSUES/);
      },
      { routing: headlessRouting({ headlessBackend: "codex" }) }
    );
  });

  it("claude receives an MCP config file that exists with the empty server list", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "echo-config") }));
      const { mcpConfig } = captured(out.output);
      assert.equal(path.isAbsolute(mcpConfig.path), true);
      assert.deepEqual({ exists: mcpConfig.exists, content: mcpConfig.content }, { exists: true, content: EMPTY_MCP_CONFIG });
    });
  });

  it("the MCP config temp directory is gone after a successful run", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "echo-config") }));
      assert.equal(fs.existsSync(path.dirname(captured(out.output).mcpConfig.path)), false);
    });
  });

  it("the MCP config temp directory is gone after a failing run", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const recorded = path.join(shimDir, "recorded-config-path.txt");
      const recorder = writeShim(
        shimDir,
        "record-then-fail.mjs",
        `import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recorded)}, argv[argv.indexOf("--mcp-config") + 1]);
process.exit(4);
`
      );
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: recorder }));
      assert.equal(out.fallbackToNative, true);
      assert.equal(fs.existsSync(path.dirname(fs.readFileSync(recorded, "utf8"))), false);
    });
  });
});

describe("blind-review runner: Windows batch shims", () => {
  const BATCH_SHIMS = [
    ["a cmd file that runs the node binary by absolute path", (dir) => `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"${process.execPath}" "%dp0%\\claude-cmd-target.mjs" %*\r\n`],
    ["an npm-style cmd file that resolves node through a variable", () => `@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\claude-cmd-target.mjs" %*\r\n`],
    ["a cmd file that uses CALL", () => `@ECHO off\r\nCALL "${process.execPath}" "%~dp0claude-cmd-target.mjs" %*\r\n`],
  ];

  for (const [label, source] of BATCH_SHIMS) {
    it(`${label} receives the full review argv and a readable MCP config`, { skip: WINDOWS_ONLY }, async () => {
      await withFixture(async ({ repo, shimDir, run }) => {
        createEchoShim(shimDir, "claude-cmd-target");
        const cmdPath = writeShim(shimDir, "claude-batch.cmd", source(shimDir));
        const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: cmdPath }));
        assert.equal(out.useNative, false, out.reason);
        const seen = captured(out.output);
        assertClaudeArgv(seen.argv, "opus");
        assert.deepEqual({ exists: seen.mcpConfig.exists, content: seen.mcpConfig.content }, { exists: true, content: EMPTY_MCP_CONFIG });
      });
    });
  }

  it("a plain cmd claude shim runs now that no argument carries a double quote", { skip: WINDOWS_ONLY }, async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const cmdPath = writeShim(shimDir, "claude-plain.cmd", "@echo off\r\necho review\r\necho Status: PASS\r\n");
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: cmdPath }));
      assert.deepEqual(
        { useNative: out.useNative, fallbackToNative: out.fallbackToNative, verdict: out.verdict },
        { useNative: false, fallbackToNative: false, verdict: "PASS" }
      );
      assert.match(out.output, /^review\r?\nStatus: PASS\r?\n?$/);
    });
  });

  it(
    "a plain cmd claude shim with a double quote in the model records a fallback state instead of exiting 1",
    { skip: WINDOWS_ONLY },
    async () => {
      await withFixture(
        async ({ repo, shimDir, run, assertState, gateAllows }) => {
          const cmdPath = writeShim(shimDir, "claude-plain.cmd", "@echo off\r\necho review\r\n");
          const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: cmdPath }));
          assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: true, fallbackToNative: true });
          assert.match(out.reason, /double quotes/);
          assertState("fallback");
          assert.equal(gateAllows(repo), true);
        },
        { routing: headlessRouting({ headlessModel: 'op"us' }) }
      );
    }
  );

  it(
    "a plain cmd codex shim with a double quote in the model records a fallback state instead of exiting 1",
    { skip: WINDOWS_ONLY },
    async () => {
      await withFixture(
        async ({ repo, shimDir, run, assertState, gateAllows }) => {
          const cmdPath = writeShim(shimDir, "codex-plain.cmd", "@echo off\r\necho review\r\n");
          const out = parseOut(run(jsonArgs(repo), { IGNIS_CODEX_CMD: cmdPath }));
          assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: true, fallbackToNative: true });
          assert.match(out.reason, /double quotes/);
          assertState("fallback");
          assert.equal(gateAllows(repo), true);
        },
        { routing: headlessRouting({ headlessBackend: "codex", headlessModel: 'o"3' }) }
      );
    }
  );
});

describe("blind-review runner: diff extraction", () => {
  it("an empty diff short-circuits to a review that needs no reviewer", async () => {
    await withFixture(async ({ repo, run }) => {
      const out = parseOut(run(jsonArgs(repo, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: MISSING_BINARY }));
      assert.deepEqual({ useNative: out.useNative, diffBytes: out.diffBytes }, { useNative: false, diffBytes: 0 });
    });
  });

  it("uncommitted working-tree edits are included when --base HEAD is passed", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n", "utf8");
      const out = parseOut(run(jsonArgs(repo, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: false, fallbackToNative: false });
      const { stdin } = captured(out.output);
      assert.match(stdin, /^-export const value = 2;$/m);
      assert.match(stdin, /^\+export const value = 3;$/m);
    });
  });

  it("a new untracked file that is the only change reaches the reviewer", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      fs.writeFileSync(path.join(repo, "fresh.js"), "export const fresh = 42;\n", "utf8");
      const out = parseOut(run(jsonArgs(repo, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: false, fallbackToNative: false });
      const { stdin } = captured(out.output);
      assert.match(stdin, /diff --git a\/fresh\.js b\/fresh\.js/);
      assert.match(stdin, /new file mode/);
      assert.match(stdin, /^\+export const fresh = 42;$/m);
    });
  });

  it("a new untracked file is reviewed without being staged", async () => {
    await withFixture(async ({ repo, shimDir, run, assertState, git }) => {
      fs.writeFileSync(path.join(repo, "fresh.js"), "export const fresh = 42;\n", "utf8");
      parseOut(run(jsonArgs(repo, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assertState("reviewed");
      assert.equal(git(["status", "--porcelain"]), "?? fresh.js");
    });
  });

  it("a repository with no commits and a new file is reviewed", async () => {
    await withFixture(
      async ({ repo, shimDir, run }) => {
        const out = parseOut(run(jsonArgs(repo, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
        assert.deepEqual(
          { useNative: out.useNative, fallbackToNative: out.fallbackToNative, verdict: out.verdict },
          { useNative: false, fallbackToNative: false, verdict: "PASS" }
        );
        const { stdin } = captured(out.output);
        assert.match(stdin, /diff --git a\/created\.js b\/created\.js/);
        assert.match(stdin, /^\+export const created = 1;$/m);
      },
      { makeRepo: (dir, env) => initGitRepo(dir, { env, commit: false, files: { "created.js": "export const created = 1;\n" } }) }
    );
  });

  it("a repository with no commits records headSha unborn and closes the gate", async () => {
    await withFixture(
      async ({ repo, dataDir, shimDir, run, gateAllows }) => {
        parseOut(run(jsonArgs(repo, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
        const record = readReviewState(dataDir, repo);
        assert.deepEqual({ status: record.status, headSha: record.headSha }, { status: "reviewed", headSha: "unborn" });
        assert.equal(gateAllows(repo), false);
      },
      { makeRepo: (dir, env) => initGitRepo(dir, { env, commit: false, files: { "created.js": "export const created = 1;\n" } }) }
    );
  });

  it("a diff above the size limit falls back to native and says why", async () => {
    await withFixture(async ({ repo, shimDir, git, run }) => {
      fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(8192), "utf8");
      git(["add", "big.txt"]);
      git(["commit", "-q", "-m", "big file"]);
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"), IGNIS_REVIEW_MAX_DIFF_BYTES: "1024" }));
      assert.deepEqual(
        { useNative: out.useNative, fallbackToNative: out.fallbackToNative, base: out.base },
        { useNative: true, fallbackToNative: true, base: "base-ref" }
      );
      assert.match(out.reason, /diff extraction failed.*too_large.*1024/);
    });
  });

  it("a fallback prints JSON even without --json", async () => {
    await withFixture(async ({ repo, shimDir, git, run }) => {
      fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(8192), "utf8");
      git(["add", "big.txt"]);
      git(["commit", "-q", "-m", "big file"]);
      const out = parseOut(run(["--base", "base-ref", "--cwd", repo, "--backend", "auto"], { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"), IGNIS_REVIEW_MAX_DIFF_BYTES: "1024" }));
      assert.equal(out.fallbackToNative, true);
    });
  });

  it("a diff above the size limit records a fallback state", async () => {
    await withFixture(async ({ repo, shimDir, git, run, assertState, gateAllows }) => {
      fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(8192), "utf8");
      git(["add", "big.txt"]);
      git(["commit", "-q", "-m", "big file"]);
      run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"), IGNIS_REVIEW_MAX_DIFF_BYTES: "1024" });
      assertState("fallback");
      assert.equal(gateAllows(repo), true);
    });
  });

  it("a non-numeric size limit is ignored and the review runs", async () => {
    await withFixture(async ({ repo, shimDir, git, run, assertState, gateAllows }) => {
      fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(8192), "utf8");
      git(["add", "big.txt"]);
      git(["commit", "-q", "-m", "big file"]);
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"), IGNIS_REVIEW_MAX_DIFF_BYTES: "not-a-number" }));
      assert.equal(out.useNative, false);
      assertState("reviewed");
      assert.equal(gateAllows(repo), false);
    });
  });

  it("a git failure falls back to native with the extraction failure as the reason", async () => {
    await withFixture(async ({ repo, shimDir, run }) => {
      const out = parseOut(run(jsonArgs(repo), {}, { noPath: shimDir }));
      assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative }, { useNative: true, fallbackToNative: true });
      assert.match(out.reason, /diff extraction failed/);
    });
  });

  it("a git failure reports that no state could be recorded and writes none", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      const res = run(jsonArgs(repo), {}, { noPath: shimDir });
      const out = parseOut(res);
      assert.ok(
        res.stderr.includes(`review state could not be recorded at ${stateDir(dataDir)}: ${out.stateError}`),
        `stderr was: ${res.stderr}`
      );
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
    });
  });

  it("git color.ui=always leaves no escape characters in the diff the reviewer receives", async () => {
    await withFixture(async ({ iso, repo, shimDir, run, git }) => {
      git(["config", "--file", iso.env.GIT_CONFIG_GLOBAL, "color.ui", "always"]);
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assert.equal(out.fallbackToNative, false, out.reason);
      const { stdin } = captured(out.output);
      assert.equal(stdin.includes(ESC), false);
      assert.match(stdin, /^-export const value = 1;$/m);
      assert.match(stdin, /^\+export const value = 2;$/m);
    });
  });

  it("diff.noprefix and diff.external in the user git config do not change the diff the reviewer receives", async () => {
    await withFixture(async ({ iso, repo, shimDir, run, git }) => {
      git(["config", "--file", iso.env.GIT_CONFIG_GLOBAL, "diff.noprefix", "true"]);
      git(["config", "--file", iso.env.GIT_CONFIG_GLOBAL, "diff.external", "ignis-nonexistent-diff-tool-xyz-9999"]);
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") }));
      assert.equal(out.fallbackToNative, false, out.reason);
      const { stdin } = captured(out.output);
      assert.match(stdin, /diff --git a\/app\.js b\/app\.js/);
      assert.match(stdin, /^\+export const value = 2;$/m);
    });
  });

  it("a HEAD that moves while the reviewer runs does not change the recorded headSha", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run, head }) => {
      const before = head();
      const mover = writeShim(
        shimDir,
        "move-head.mjs",
        `import fs from "node:fs";
import { spawnSync } from "node:child_process";
fs.readFileSync(0, "utf8");
const res = spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "moved during review"], {
  cwd: ${JSON.stringify(repo)},
  encoding: "utf8",
});
if (res.status !== 0) {
  process.stderr.write(String(res.stderr));
  process.exit(9);
}
process.stdout.write("Status: PASS\\n");
`
      );
      const out = parseOut(run(jsonArgs(repo), { IGNIS_CLAUDE_CMD: mover }));
      assert.equal(out.fallbackToNative, false);
      assert.notEqual(head(), before);
      const record = readReviewState(dataDir, repo);
      assert.deepEqual({ status: record.status, headSha: record.headSha }, { status: "reviewed", headSha: before });
    });
  });
});

describe("blind-review runner: verdict handling", () => {
  function runReviewer(fixture, text, args = jsonArgs(fixture.repo)) {
    return fixture.run(args, { IGNIS_CLAUDE_CMD: createOutputShim(fixture.shimDir, text) });
  }

  function assertNoVerdictFallback(fixture, res, reason) {
    const out = parseOut(res);
    assert.deepEqual({ useNative: out.useNative, fallbackToNative: out.fallbackToNative, reason: out.reason }, { useNative: true, fallbackToNative: true, reason });
    assert.equal("verdict" in out, false);
    assert.equal(fixture.assertState("fallback").reason, reason);
    assert.equal(fixture.gateAllows(fixture.repo), true);
  }

  it("a headless run that exits 0 with empty output records a fallback state", async () => {
    await withFixture(async (fixture) => {
      assertNoVerdictFallback(fixture, runReviewer(fixture, ""), NO_VERDICT_EMPTY);
    });
  });

  it("a headless run whose output has no Status line records a fallback state carrying the detail", async () => {
    await withFixture(async (fixture) => {
      const text = "The reviewer wrote Status: ISSUES in the middle of a sentence.\n";
      assertNoVerdictFallback(fixture, runReviewer(fixture, text), `${NO_VERDICT_PREFIX}${text.trim()}`);
    });
  });

  it("Status: PASS is a success with verdict PASS and the reviewer output printed", async () => {
    await withFixture(async (fixture) => {
      const text = "No HIGH or MEDIUM issues found.\nStatus: PASS\n";
      const out = parseOut(runReviewer(fixture, text));
      assert.deepEqual(
        { useNative: out.useNative, fallbackToNative: out.fallbackToNative, verdict: out.verdict, output: out.output },
        { useNative: false, fallbackToNative: false, verdict: "PASS", output: text }
      );
      assert.equal("stateError" in out, false);
    });
  });

  it("Status: PASS records reviewed with no reason and closes the gate", async () => {
    await withFixture(async (fixture) => {
      parseOut(runReviewer(fixture, "No HIGH or MEDIUM issues found.\nStatus: PASS\n"));
      assert.equal(fixture.assertState("reviewed").reason, null);
      assert.equal(fixture.gateAllows(fixture.repo), false);
    });
  });

  it("non-JSON mode prints the reviewer output unchanged", async () => {
    await withFixture(async (fixture) => {
      const text = "No HIGH or MEDIUM issues found.\nStatus: PASS\n";
      const res = runReviewer(fixture, text, ["--base", "base-ref", "--cwd", fixture.repo, "--backend", "auto"]);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, text);
    });
  });

  it("Status: ISSUES is reported as such and is not a fallback", async () => {
    await withFixture(async (fixture) => {
      const out = parseOut(runReviewer(fixture, "Found a race condition in app.js.\n\n**Status: issues**\n"));
      assert.deepEqual(
        { useNative: out.useNative, fallbackToNative: out.fallbackToNative, verdict: out.verdict },
        { useNative: false, fallbackToNative: false, verdict: "ISSUES" }
      );
    });
  });

  it("Status: ISSUES records reviewed and keeps the gate closed", async () => {
    await withFixture(async (fixture) => {
      parseOut(runReviewer(fixture, "Found a race condition in app.js.\n\n**Status: issues**\n"));
      fixture.assertState("reviewed");
      assert.equal(fixture.gateAllows(fixture.repo), false);
    });
  });
});

describe("blind-review runner: input errors", () => {
  it("a trailing value flag exits non-zero naming the flag", async () => {
    await withIso(async ({ run }) => {
      const res = run(["--base"]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /missing value for --base/);
    });
  });

  it("corrupt onboarding falls back to the antigravity_gemini_only strategy", async () => {
    await withFixture(async ({ repo, dataDir, run }) => {
      fs.writeFileSync(path.join(dataDir, "onboarding.json"), "{corrupt-json", "utf8");
      const out = parseOut(run(jsonArgs(repo)));
      assert.deepEqual({ useNative: out.useNative, reason: out.reason }, { useNative: true, reason: "strategy=antigravity_gemini_only" });
    });
  });

  for (const badBackend of ["bogus", ""]) {
    it(`--backend ${JSON.stringify(badBackend)} throws and writes no state`, async () => {
      await withFixture(async ({ repo, dataDir, run }) => {
        const res = run(jsonArgs(repo, { backend: badBackend }));
        assert.equal(res.status, 1);
        assert.match(res.stderr, /unsupported backend/i);
        assert.equal(fs.existsSync(stateDir(dataDir)), false);
      });
    });
  }

  it("--base rejects flag injection without writing a file or state", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      const res = run(["--base", "--output=evil.txt", "--cwd", repo, "--backend", "auto", "--json"], { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--base must not start with '-'/);
      assert.equal(fs.existsSync(path.join(repo, "evil.txt")), false);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
    });
  });

  it("--base rejects an invalid git ref without writing state", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      const res = run(jsonArgs(repo, { base: "nonexistent-ref" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /merge-base/i);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
    });
  });

  it("a --cwd that does not exist is an input error with no output and no state", async () => {
    await withFixture(async ({ repo, dataDir, shimDir, run }) => {
      const res = run(jsonArgs(path.join(shimDir, "no-such-dir"), { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok") });
      assert.deepEqual({ status: res.status, stdout: res.stdout }, { status: 1, stdout: "" });
      assert.match(res.stderr, /--cwd/);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
      assert.equal(readReviewState(dataDir, repo), null);
    });
  });

  it("a --cwd outside git is an input error with no output and no state", async () => {
    await withFixture(async ({ iso, repo, dataDir, shimDir, run }) => {
      const outside = path.join(iso.dirs.root, "not-git");
      fs.mkdirSync(outside);
      const res = run(jsonArgs(outside, { base: "HEAD" }), { IGNIS_CLAUDE_CMD: createEchoShim(shimDir, "ok"), GIT_CEILING_DIRECTORIES: os.tmpdir() });
      assert.deepEqual({ status: res.status, stdout: res.stdout }, { status: 1, stdout: "" });
      assert.match(res.stderr, /not inside a git repository/);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
      assert.equal(readReviewState(dataDir, repo), null);
    });
  });
});

describe("blind-review runner: started through a link", () => {
  function withLinkedRunner(fn) {
    return withFixture(async (fixture) => {
      const realScripts = path.join(fixture.iso.dirs.root, "real-scripts");
      fs.cpSync(SCRIPTS_DIR, realScripts, { recursive: true });
      const linkedScripts = path.join(fixture.iso.dirs.root, "linked-scripts");
      fs.symlinkSync(realScripts, linkedScripts, process.platform === "win32" ? "junction" : "dir");
      assert.notEqual(fs.realpathSync.native(linkedScripts), path.resolve(linkedScripts));
      const linkedRunner = path.join(linkedScripts, "run-blind-review.mjs");
      const runLinked = (args) =>
        runNode(linkedRunner, args, { env: { ...fixture.iso.env, IGNIS_CLAUDE_CMD: createEchoShim(fixture.shimDir, "ok-link") }, timeoutMs: 60_000 });
      return fn({ ...fixture, runLinked });
    });
  }

  it("an unknown flag is exit 1 with the message on stderr, not a silent exit 0", async () => {
    await withLinkedRunner(async ({ runLinked }) => {
      const res = runLinked(["--definitely-unknown-flag"]);
      assert.deepEqual({ status: res.status, stdout: res.stdout }, { status: 1, stdout: "" });
      assert.match(res.stderr, /unknown argument: --definitely-unknown-flag/);
    });
  });

  it("a flag-injection --base is exit 1 and writes no state", async () => {
    await withLinkedRunner(async ({ repo, dataDir, runLinked }) => {
      const res = runLinked(["--base", "--output=evil.txt", "--cwd", repo, "--backend", "auto", "--json"]);
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, /--base must not start with '-'/);
      assert.equal(fs.existsSync(stateDir(dataDir)), false);
    });
  });

  it("a good review runs and reports PASS", async () => {
    await withLinkedRunner(async ({ repo, runLinked }) => {
      const out = parseOut(runLinked(jsonArgs(repo)));
      assert.deepEqual({ fallbackToNative: out.fallbackToNative, verdict: out.verdict }, { fallbackToNative: false, verdict: "PASS" });
    });
  });

  it("a good review records reviewed", async () => {
    await withLinkedRunner(async ({ repo, runLinked, assertState }) => {
      parseOut(runLinked(jsonArgs(repo)));
      assertState("reviewed");
    });
  });
});
