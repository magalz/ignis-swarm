import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, runNode } from "./helpers.mjs";
import { resolveConfig, mergeServersConfig, importMcpConfig } from "../scripts/broker/config.mjs";

const BROKER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ignis-broker.mjs");

function setup(t) {
  const iso = isolatedEnv();
  t.after(() => iso.cleanup());
  const source = path.join(iso.dirs.root, "mcp_config.json");
  const serversPath = path.join(iso.dirs.brokerHome, "servers.json");
  const broker = (args) => runNode(BROKER_ENTRY, args, { env: iso.env, timeoutMs: 20_000 });
  const writeSource = (mcpServers) => fs.writeFileSync(source, JSON.stringify({ mcpServers }));
  const readServers = () => JSON.parse(fs.readFileSync(serversPath, "utf8"));
  return { iso, source, serversPath, broker, writeSource, readServers };
}

const stdioEntry = { command: process.execPath, args: ["-e", "0"] };

test("import-mcp keeps servers registered earlier", (t) => {
  const { source, broker, writeSource, readServers } = setup(t);
  writeSource({ X: stdioEntry });
  const reg = broker(["register-mcp", "--servers", "X", "--from", source]);
  assert.equal(reg.status, 0, reg.stderr);
  writeSource({ Y: stdioEntry });
  const imp = broker(["import-mcp", "--from", source]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.deepEqual(Object.keys(readServers().servers).sort(), ["X", "Y"]);
});

test("import-mcp --dry-run prints no secret and writes nothing", (t) => {
  const { source, serversPath, broker, writeSource, readServers } = setup(t);
  const envSecret = "sec" + "ret-env-" + Math.floor(Math.random() * 1e9);
  const headerSecret = "sec" + "ret-hdr-" + Math.floor(Math.random() * 1e9);
  const userInfo = "sec" + "ret-usr-" + Math.floor(Math.random() * 1e9);
  const querySecret = "sec" + "ret-qry-" + Math.floor(Math.random() * 1e9);
  writeSource({
    local: { ...stdioEntry, env: { API_KEY: envSecret } },
    remote: {
      serverUrl: `https://user:${userInfo}@example.com/mcp?token=${querySecret}`,
      headers: { Authorization: `Bearer ${headerSecret}` },
    },
  });
  const dry = broker(["import-mcp", "--dry-run", "--from", source]);
  assert.equal(dry.status, 0, dry.stderr);
  const out = dry.stdout + dry.stderr;
  for (const secret of [envSecret, headerSecret, userInfo, querySecret]) {
    assert.equal(out.includes(secret), false, "dry-run leaked a secret");
  }
  assert.match(out, /local/);
  assert.match(out, /remote/);
  assert.equal(fs.existsSync(serversPath), false);

  fs.mkdirSync(path.dirname(serversPath), { recursive: true });
  const before = JSON.stringify({ version: 1, servers: { keep: { transport: "http", url: "https://example.com/k" } } });
  fs.writeFileSync(serversPath, before);
  const again = broker(["import-mcp", "--dry-run", "--from", source]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(serversPath, "utf8"), before);
  assert.deepEqual(Object.keys(readServers().servers), ["keep"]);
});

test("a fresh import persists no defaults yet resolveConfig still applies them", (t) => {
  const { iso, source, broker, writeSource, readServers } = setup(t);
  writeSource({ Y: stdioEntry });
  const imp = broker(["import-mcp", "--from", source]);
  assert.equal(imp.status, 0, imp.stderr);
  const file = readServers();
  assert.equal(file.defaults?.requestTimeoutMs, undefined);
  assert.equal(Object.keys(file.defaults ?? {}).length, 0);
  const cfg = resolveConfig(iso.dirs.brokerHome, iso.dirs.root, iso.dirs.brokerData);
  assert.equal(cfg.defaults.requestTimeoutMs, 120000);
});

test("a user-written defaults block survives import and register", (t) => {
  const { iso, source, serversPath, broker, writeSource, readServers } = setup(t);
  fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
  fs.writeFileSync(serversPath, JSON.stringify({ version: 1, defaults: { requestTimeoutMs: 5000 }, servers: {} }));
  writeSource({ Y: stdioEntry, Z: stdioEntry });
  const imp = broker(["import-mcp", "--servers", "Y", "--from", source]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.deepEqual(readServers().defaults, { requestTimeoutMs: 5000 });
  const reg = broker(["register-mcp", "--servers", "Z", "--from", source]);
  assert.equal(reg.status, 0, reg.stderr);
  const file = readServers();
  assert.deepEqual(file.defaults, { requestTimeoutMs: 5000 });
  assert.deepEqual(Object.keys(file.servers).sort(), ["Y", "Z"]);
});

test("broker self-names are skipped by import and by merge", (t) => {
  const { iso, source, broker, writeSource, readServers } = setup(t);
  const selfNames = ["ignis-broker", "broker", "ignis-swarm_broker"];
  writeSource({ ...Object.fromEntries(selfNames.map((n) => [n, stdioEntry])), Y: stdioEntry });
  const imp = broker(["import-mcp", "--from", source]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.deepEqual(Object.keys(readServers().servers), ["Y"]);
  assert.deepEqual(Object.keys(importMcpConfig(source).servers), ["Y"]);

  const home = path.join(iso.dirs.root, "merge-home");
  const merged = mergeServersConfig(home, {
    ...Object.fromEntries(selfNames.map((n) => [n, { transport: "stdio", command: "x" }])),
    ok: { transport: "stdio", command: "x" },
  });
  assert.deepEqual(Object.keys(merged.servers), ["ok"]);
});
