import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverLocalConfig,
  expandEnvVars,
  importMcpConfig,
  redactServerConfig,
  resolveConfig,
} from "../scripts/broker/config.mjs";
import { trustLocalConfig } from "../scripts/broker/trust.mjs";
import { cleanupExpiredSpills, truncateContentBlocks } from "../scripts/broker/spill.mjs";

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolves local-first with global fallback chain and respects local opt-out", () => {
  const home = mkTemp("ignis-cfg-home-");
  const repo = mkTemp("ignis-cfg-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });

  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        search: { transport: "stdio", command: "global-search", args: ["mcp"] },
        disabled_here: { transport: "stdio", command: "global-tool" },
      },
    })
  );

  fs.writeFileSync(
    path.join(repo, ".agents", "ignis-broker.json"),
    JSON.stringify({
      version: 1,
      servers: {
        search: { transport: "stdio", command: "local-search", args: ["mcp"] },
        disabled_here: { transport: "stdio", command: "local-tool", enabled: false },
      },
    })
  );

  trustLocalConfig(home, path.join(repo, ".agents", "ignis-broker.json"));
  const resolved = resolveConfig(home, repo, home);
  assert.equal(resolved.localConfigError, null);
  const chain = resolved.candidates.get("search");
  assert.equal(chain.length, 2);
  assert.equal(chain[0].source, "local");
  assert.equal(chain[0].config.command, "local-search");
  assert.equal(chain[1].source, "global");
  assert.equal(chain[1].config.command, "global-search");
  assert.equal(resolved.candidates.has("disabled_here"), false);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("malformed local config falls back to global with warning and expands dotenv secrets", () => {
  const home = mkTemp("ignis-cfg-bad-home-");
  const repo = mkTemp("ignis-cfg-bad-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });

  fs.writeFileSync(path.join(home, ".env"), 'API_KEY="tok-999"\n');
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        remote: {
          transport: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer ${API_KEY}" },
        },
      },
    })
  );
  fs.writeFileSync(path.join(repo, ".agents", "ignis-broker.json"), "{ invalid");

  const resolved = resolveConfig(home, repo);
  assert.ok(resolved.localConfigError);
  const cfg = resolved.candidates.get("remote")[0].config;
  assert.equal(cfg.headers.Authorization, "Bearer tok-999");
  assert.equal(redactServerConfig(cfg).headers.Authorization, "***REDACTED***");
  assert.equal(expandEnvVars("a-${X}-b", new Map([["X", "1"]])), "a-1-b");

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("imports generic MCP config excluding broker itself", () => {
  const dir = mkTemp("ignis-import-");
  const src = path.join(dir, "mcp_config.json");
  fs.writeFileSync(
    src,
    JSON.stringify({
      mcpServers: {
        github: { serverUrl: "https://api.github.com/mcp", headers: { Authorization: "Bearer x" } },
        sqlite: { command: "node", args: ["server.mjs"] },
        broker: { command: "node", args: ["ignis-broker.mjs", "mcp-bridge"] },
      },
    })
  );

  const imported = importMcpConfig(src);
  assert.equal(Object.hasOwn(imported.servers, "broker"), false);
  assert.equal(imported.servers.github.transport, "http");
  assert.equal(imported.servers.sqlite.transport, "stdio");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("truncates large UTF-8 output to spill file and cleans expired spills", () => {
  const dir = mkTemp("ignis-spill-");
  const text = "ação-日本語-🚀\n".repeat(120);
  const res = truncateContentBlocks([{ type: "text", text }], 120, 10, dir, false);

  assert.equal(res.truncated, true);
  assert.ok(res.spillPath);
  assert.equal(fs.readFileSync(res.spillPath, "utf8"), text);
  assert.match(res.content[0].text, /ignis-broker truncated:/);

  const bypass = truncateContentBlocks([{ type: "text", text }], 64, 5, dir, true);
  assert.equal(bypass.truncated, false);
  assert.equal(bypass.content[0].text, text);

  const removed = cleanupExpiredSpills(dir, 0);
  assert.equal(removed, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("local entries keep ${VAR} literal while global entries expand it", () => {
  const home = mkTemp("ignis-cfg-lit-home-");
  const repo = mkTemp("ignis-cfg-lit-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".env"), "SECRET_X=s3cret\n");
  const entry = {
    transport: "http",
    url: "https://example.com/mcp?k=${SECRET_X}",
    headers: { Authorization: "Bearer ${SECRET_X}" },
    env: { TOKEN: "${SECRET_X}" },
  };
  fs.writeFileSync(path.join(home, "servers.json"), JSON.stringify({ version: 1, servers: { remote: entry } }));
  fs.writeFileSync(path.join(repo, ".agents", "ignis-broker.json"), JSON.stringify({ version: 1, servers: { remote: entry } }));
  trustLocalConfig(home, path.join(repo, ".agents", "ignis-broker.json"));

  const chain = resolveConfig(home, repo, home).candidates.get("remote");
  assert.equal(chain[0].source, "local");
  assert.equal(chain[0].config.url, "https://example.com/mcp?k=${SECRET_X}");
  assert.equal(chain[0].config.headers.Authorization, "Bearer ${SECRET_X}");
  assert.equal(chain[0].config.env.TOKEN, "${SECRET_X}");
  assert.equal(chain[1].source, "global");
  assert.equal(chain[1].config.url, "https://example.com/mcp?k=s3cret");
  assert.equal(chain[1].config.headers.Authorization, "Bearer s3cret");
  assert.equal(chain[1].config.env.TOKEN, "s3cret");

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function writeLocal(dir) {
  fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
  const file = path.join(dir, ".agents", "ignis-broker.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, servers: {} }));
  return file;
}

test("discoverLocalConfig ignores a config when no git repository exists", () => {
  const tmp = mkTemp("ignis-disc-norepo-");
  writeLocal(tmp);
  fs.mkdirSync(path.join(tmp, "sub"));
  assert.equal(discoverLocalConfig(path.join(tmp, "sub")), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("discoverLocalConfig finds a config at the repository root from a nested cwd", () => {
  const root = mkTemp("ignis-disc-repo-");
  fs.mkdirSync(path.join(root, ".git"));
  const file = writeLocal(root);
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  assert.equal(discoverLocalConfig(path.join(root, "a", "b")), file);
  fs.rmSync(root, { recursive: true, force: true });
});

test("discoverLocalConfig never searches above the repository root", () => {
  const parent = mkTemp("ignis-disc-above-");
  writeLocal(parent);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"));
  assert.equal(discoverLocalConfig(path.join(repo, "src")), null);
  fs.rmSync(parent, { recursive: true, force: true });
});

test("discoverLocalConfig treats a worktree-style .git file as a repository root", () => {
  const root = mkTemp("ignis-disc-wt-");
  fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  const file = writeLocal(root);
  fs.mkdirSync(path.join(root, "pkg"));
  assert.equal(discoverLocalConfig(path.join(root, "pkg")), file);
  fs.rmSync(root, { recursive: true, force: true });
});

const syntaxErrorForms = {
  "unexpected token": (secret) => `{"a":1,\n  "b": x${secret}}`,
  "expected property name": (secret) => `{"a":1,\n  "b": "${secret}",\n}`,
};
const syntaxErrorWhere = { "unexpected token": "line 2, column 8", "expected property name": "line 3, column 1" };

for (const [form, build] of Object.entries(syntaxErrorForms)) {
  test(`a global config syntax error (${form}) reports line and column and never quotes the file`, () => {
    const home = mkTemp("ignis-cfg-perr-home-");
    const secret = "sec" + "ret-" + Math.floor(Math.random() * 1e9);
    fs.writeFileSync(path.join(home, "servers.json"), build(secret));
    let message = "";
    try {
      resolveConfig(home, null);
    } catch (err) {
      message = err.message;
    }
    assert.equal(message.includes(secret), false, "the message quoted file content");
    assert.equal(message.includes("Unexpected"), false);
    assert.equal(message.includes("Expected"), false);
    assert.ok(message.startsWith(`invalid global config ${path.join(home, "servers.json")}: `), message);
    assert.ok(message.endsWith(`invalid JSON at ${syntaxErrorWhere[form]}`), message);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test(`a local config syntax error (${form}) reports line and column and never quotes the file`, () => {
    const home = mkTemp("ignis-cfg-perr-lhome-");
    const repo = mkTemp("ignis-cfg-perr-repo-");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    const secret = "sec" + "ret-" + Math.floor(Math.random() * 1e9);
    fs.writeFileSync(path.join(repo, ".agents", "ignis-broker.json"), build(secret));
    const resolved = resolveConfig(home, repo);
    const message = resolved.localConfigError;
    assert.ok(message, "no localConfigError");
    assert.equal(message.includes(secret), false, "localConfigError quoted file content");
    assert.match(message, /^invalid local config /);
    assert.ok(message.endsWith(`invalid JSON at ${syntaxErrorWhere[form]}`), message);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
}

test("trust refuses a syntax error with line and column and never quotes the file", () => {
  const home = mkTemp("ignis-cfg-perr-thome-");
  const repo = mkTemp("ignis-cfg-perr-trepo-");
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  const file = path.join(repo, ".agents", "ignis-broker.json");
  const secret = "sec" + "ret-" + Math.floor(Math.random() * 1e9);
  fs.writeFileSync(file, syntaxErrorForms["unexpected token"](secret));
  assert.throws(
    () => trustLocalConfig(home, file),
    (err) => !err.message.includes(secret) && err.message.endsWith("invalid JSON at line 2, column 8")
  );
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("an mcp_config.json syntax error never quotes the file", () => {
  const dir = mkTemp("ignis-cfg-perr-mcp-");
  const file = path.join(dir, "mcp_config.json");
  const secret = "sec" + "ret-" + Math.floor(Math.random() * 1e9);
  fs.writeFileSync(file, syntaxErrorForms["unexpected token"](secret));
  assert.throws(
    () => importMcpConfig(file),
    (err) => !err.message.includes(secret) && err.message.endsWith("invalid JSON at line 2, column 8")
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a number error reports the column V8 gives, not the scanner's", () => {
  const dir = mkTemp("ignis-cfg-perr-num-");
  const file = path.join(dir, "mcp_config.json");
  fs.writeFileSync(file, '{"a": 1e}');
  assert.throws(
    () => importMcpConfig(file),
    (err) => err.message.endsWith("invalid JSON at line 1, column 9")
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
