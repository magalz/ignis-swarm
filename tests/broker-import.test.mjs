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

const rnd = (tag) => "sec" + "ret-" + tag + "-" + Math.floor(Math.random() * 1e9);

function secretSetup(t) {
  const ctx = setup(t);
  const envPath = path.join(ctx.iso.dirs.brokerHome, ".env");
  const resolved = (name) => {
    const cfg = resolveConfig(ctx.iso.dirs.brokerHome, null, ctx.iso.dirs.brokerData);
    return cfg.candidates.get(name)[0].config;
  };
  const readEnv = () => fs.readFileSync(envPath, "utf8");
  return { ...ctx, envPath, resolved, readEnv };
}

for (const cmd of ["register-mcp", "import-mcp"]) {
  test(`${cmd} moves literal env and header values into .env`, (t) => {
    const { source, serversPath, envPath, broker, writeSource, resolved, readEnv } = secretSetup(t);
    const envSecret = rnd("env");
    const headerSecret = "Bearer " + rnd("hdr");
    writeSource({
      local: { ...stdioEntry, env: { API_KEY: envSecret } },
      "my-api": { serverUrl: "https://example.com/mcp", headers: { "X-Api-Key": headerSecret } },
    });
    const args = cmd === "register-mcp" ? ["register-mcp", "--all", "--from", source] : ["import-mcp", "--from", source];
    const res = broker(args);
    assert.equal(res.status, 0, res.stderr);
    const servers = fs.readFileSync(serversPath, "utf8");
    assert.equal(servers.includes(envSecret), false);
    assert.equal(servers.includes(headerSecret), false);
    assert.match(servers, /\$\{IGNIS_LOCAL_API_KEY\}/);
    assert.match(servers, /\$\{IGNIS_MY_API_X_API_KEY\}/);
    const env = readEnv();
    assert.ok(env.includes(envSecret));
    assert.ok(env.includes(headerSecret));
    assert.deepEqual(resolved("local").env, { API_KEY: envSecret });
    assert.deepEqual(resolved("my-api").headers, { "X-Api-Key": headerSecret });
    const out = res.stdout + res.stderr;
    assert.equal(out.includes(envSecret) || out.includes(headerSecret), false, "output leaked a secret");
    assert.match(out, /IGNIS_LOCAL_API_KEY/);
    assert.ok(fs.existsSync(envPath));
  });
}

test("a value that is already a reference stays and writes no .env line", (t) => {
  const { source, envPath, broker, writeSource, readServers } = secretSetup(t);
  writeSource({
    s: { ...stdioEntry, env: { A: "${MY_TOKEN}", B: "pre-${MY_TOKEN}-post" } },
  });
  const res = broker(["register-mcp", "--all", "--from", source]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readServers().servers.s.env, { A: "${MY_TOKEN}", B: "pre-${MY_TOKEN}-post" });
  assert.equal(fs.existsSync(envPath), false);
});

test("an existing .env keeps its comments and unrelated lines", (t) => {
  const { iso, source, envPath, broker, writeSource, readEnv } = secretSetup(t);
  fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
  fs.writeFileSync(envPath, "# keep me\nOTHER=1\n");
  const secret = rnd("k");
  writeSource({ s: { ...stdioEntry, env: { K: secret } } });
  const res = broker(["register-mcp", "--all", "--from", source]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readEnv().split("\n").filter(Boolean);
  assert.deepEqual(lines.slice(0, 2), ["# keep me", "OTHER=1"]);
  assert.equal(lines.length, 3);
  assert.ok(lines[2].startsWith("IGNIS_S_K="));
});

test("re-registering with a new secret replaces the .env line in place", (t) => {
  const { iso, source, envPath, broker, writeSource, resolved, readEnv } = secretSetup(t);
  fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
  fs.writeFileSync(envPath, "A=1\nIGNIS_S_K=old\nZ=2\n");
  const first = rnd("one");
  const second = rnd("two");
  writeSource({ s: { ...stdioEntry, env: { K: first } } });
  assert.equal(broker(["register-mcp", "--all", "--from", source]).status, 0);
  writeSource({ s: { ...stdioEntry, env: { K: second } } });
  assert.equal(broker(["register-mcp", "--all", "--from", source]).status, 0);
  const env = readEnv();
  assert.equal(env.includes(first), false);
  assert.equal(env.split("\n").filter((l) => l.startsWith("IGNIS_S_K=")).length, 1);
  assert.deepEqual(env.split("\n").filter(Boolean).map((l) => l.split("=")[0]), ["A", "IGNIS_S_K", "Z"]);
  assert.equal(resolved("s").env.K, second);
});

test("the .env file is mode 0600 on POSIX", { skip: process.platform === "win32" }, (t) => {
  const { source, envPath, broker, writeSource } = secretSetup(t);
  writeSource({ s: { ...stdioEntry, env: { K: rnd("m") } } });
  assert.equal(broker(["register-mcp", "--all", "--from", source]).status, 0);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test("a value with spaces, hash, equals, quote and backslash round-trips exactly", (t) => {
  const { source, broker, writeSource, resolved } = secretSetup(t);
  const tricky = ` a b # c = d "e" 'f' \g\\h ${rnd("x")} `;
  const quoted = `"quoted"`;
  writeSource({ s: { ...stdioEntry, env: { TRICKY: tricky, QUOTED: quoted, EMPTY: "" } } });
  const res = broker(["register-mcp", "--all", "--from", source]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(resolved("s").env, { TRICKY: tricky, QUOTED: quoted, EMPTY: "" });
});

test("a value with a newline fails and writes nothing", (t) => {
  const { source, serversPath, envPath, broker, writeSource } = secretSetup(t);
  writeSource({ s: { ...stdioEntry, env: { K: "line1\nline2" } } });
  const res = broker(["register-mcp", "--all", "--from", source]);
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(serversPath), false);
  assert.equal(fs.existsSync(envPath), false);
});

test("two literals that normalize to the same name fail and write nothing", (t) => {
  const { iso, source, serversPath, envPath, broker, writeSource } = secretSetup(t);
  fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
  fs.writeFileSync(envPath, "OTHER=1\n");
  const beforeEnv = fs.readFileSync(envPath, "utf8");
  writeSource({ s: { ...stdioEntry, env: { "A-B": rnd("one"), "a.b": rnd("two") } } });
  for (const args of [["register-mcp", "--all", "--from", source], ["import-mcp", "--from", source]]) {
    const res = broker(args);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /IGNIS_S_A_B/);
    assert.equal(fs.existsSync(serversPath), false);
    assert.equal(fs.readFileSync(envPath, "utf8"), beforeEnv);
  }
});

test("import-mcp --dry-run writes neither file", (t) => {
  const { source, serversPath, envPath, broker, writeSource } = secretSetup(t);
  writeSource({ s: { ...stdioEntry, env: { K: rnd("d") } } });
  assert.equal(broker(["import-mcp", "--dry-run", "--from", source]).status, 0);
  assert.equal(fs.existsSync(serversPath), false);
  assert.equal(fs.existsSync(envPath), false);
});

test("add-http-mcp stores a reference, not a literal", (t) => {
  const { broker, readServers, envPath } = secretSetup(t);
  const res = broker(["add-http-mcp", "web", "https://example.com/mcp", "--auth-env", "WEB_TOKEN"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readServers().servers.web.headers, { Authorization: "Bearer ${WEB_TOKEN}" });
  assert.equal(fs.existsSync(envPath), false);
});
