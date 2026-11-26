import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expandEnvVars,
  importMcpConfig,
  redactServerConfig,
  resolveConfig,
} from "../scripts/broker/config.mjs";
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

  const resolved = resolveConfig(home, repo);
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
