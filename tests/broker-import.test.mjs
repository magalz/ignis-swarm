import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, mkTemp, runNode } from "./helpers.mjs";
import { resolveConfig, mergeServersConfig, importMcpConfig, writeDotenvSecrets } from "../scripts/broker/config.mjs";

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

for (const cmd of ["register-mcp", "import-mcp"]) {
  const argsFor = (source) =>
    cmd === "register-mcp" ? ["register-mcp", "--all", "--from", source] : ["import-mcp", "--from", source];

  test(`${cmd} with an invalid servers.json fails and writes nothing`, (t) => {
    const { iso, source, serversPath, envPath, broker, writeSource } = secretSetup(t);
    fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
    const existing = rnd("existing");
    const broken = `{"servers": {"keep": {"headers": {"X": "${existing}"}}},\n  oops}`;
    fs.writeFileSync(serversPath, broken);
    const literal = rnd("new");
    writeSource({ s: { ...stdioEntry, env: { K: literal } } });
    const res = broker(argsFor(source));
    assert.notEqual(res.status, 0);
    assert.equal(fs.existsSync(envPath), false, ".env was written before servers.json was validated");
    assert.equal(fs.readFileSync(serversPath, "utf8"), broken);
    const out = res.stdout + res.stderr;
    assert.equal(out.includes(existing) || out.includes(literal), false, "output leaked a secret");
    assert.match(out, /invalid JSON at line 2, column 3/);
  });

  test(`${cmd} fails when a different server already uses the same IGNIS_ variable`, (t) => {
    const { iso, source, serversPath, envPath, broker, writeSource } = secretSetup(t);
    fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
    writeSource({ "a-b": { ...stdioEntry, env: { K: rnd("first") } } });
    assert.equal(broker(argsFor(source)).status, 0);
    const serversBefore = fs.readFileSync(serversPath, "utf8");
    const envBefore = fs.readFileSync(envPath, "utf8");
    const other = rnd("second");
    writeSource({ "a.b": { ...stdioEntry, env: { K: other } } });
    const res = broker(argsFor(source));
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /IGNIS_A_B_K/);
    assert.match(res.stderr, /a-b/);
    assert.match(res.stderr, /a\.b/);
    assert.equal(res.stdout.includes(other) || res.stderr.includes(other), false);
    assert.equal(fs.readFileSync(serversPath, "utf8"), serversBefore);
    assert.equal(fs.readFileSync(envPath, "utf8"), envBefore);
  });
}

test("a collision is found in headers and url references too", (t) => {
  const { iso, source, serversPath, envPath, broker, writeSource } = secretSetup(t);
  fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
  const existing = JSON.stringify({
    servers: {
      viaHeader: { transport: "http", url: "https://example.com/h", headers: { A: "Bearer ${IGNIS_S_K}" } },
      viaUrl: { transport: "http", url: "https://example.com/u?t=${IGNIS_S_K2}" },
    },
  });
  fs.writeFileSync(serversPath, existing);
  for (const key of ["K", "K2"]) {
    writeSource({ s: { ...stdioEntry, env: { [key]: rnd(key) } } });
    const res = broker(["register-mcp", "--all", "--from", source]);
    assert.notEqual(res.status, 0, key);
    assert.match(res.stderr, new RegExp(key === "K" ? "viaHeader" : "viaUrl"));
  }
  assert.equal(fs.readFileSync(serversPath, "utf8"), existing);
  assert.equal(fs.existsSync(envPath), false);
});

test("re-registering the same server replaces its own entry and .env value", (t) => {
  const { source, broker, writeSource, resolved, readServers } = secretSetup(t);
  const second = rnd("two");
  writeSource({ s: { ...stdioEntry, env: { K: rnd("one") } } });
  assert.equal(broker(["register-mcp", "--all", "--from", source]).status, 0);
  writeSource({ s: { ...stdioEntry, env: { K: second } } });
  const res = broker(["register-mcp", "--all", "--from", source]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(Object.keys(readServers().servers), ["s"]);
  assert.equal(resolved("s").env.K, second);
});

test("writeDotenvSecrets never reuses a leftover temp file or its mode", { skip: process.platform === "win32" }, (t) => {
  const home = mkTemp("ignis-dotenv-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const leftover = path.join(home, `.env.${process.pid}.tmp`);
  fs.writeFileSync(leftover, "STALE=1\n");
  fs.chmodSync(leftover, 0o666);
  const value = rnd("v");
  writeDotenvSecrets(home, new Map([["IGNIS_S_K", value]]));
  const envPath = path.join(home, ".env");
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(envPath, "utf8"), `IGNIS_S_K="${value}"\n`);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".tmp") && f !== path.basename(leftover)), []);
});

const WRONG_SHAPES = {
  "a top-level array": (marker) => JSON.stringify([marker]),
  "a top-level string": (marker) => JSON.stringify(marker),
  "a top-level null": () => "null",
  "servers as an array": (marker) => JSON.stringify({ servers: [marker] }),
  "servers as a string": (marker) => JSON.stringify({ servers: marker }),
  "servers as null": () => JSON.stringify({ servers: null }),
  "defaults as an array": (marker) => JSON.stringify({ defaults: [marker], servers: {} }),
  "defaults as a string": (marker) => JSON.stringify({ defaults: marker, servers: {} }),
};

for (const cmd of ["register-mcp", "import-mcp"]) {
  const argsFor = (source) =>
    cmd === "register-mcp" ? ["register-mcp", "--all", "--from", source] : ["import-mcp", "--from", source];

  for (const [label, build] of Object.entries(WRONG_SHAPES)) {
    test(`${cmd} rejects a servers.json with ${label} and writes nothing`, (t) => {
      const { iso, source, serversPath, envPath, broker, writeSource } = secretSetup(t);
      fs.mkdirSync(iso.dirs.brokerHome, { recursive: true });
      const marker = rnd("filecontent");
      const existing = build(marker);
      fs.writeFileSync(serversPath, existing);
      const literal = rnd("new");
      writeSource({ s: { ...stdioEntry, env: { K: literal } } });
      const res = broker(argsFor(source));
      assert.notEqual(res.status, 0);
      assert.ok(res.stderr.includes(`invalid servers config ${serversPath}: `), res.stderr);
      for (const text of [marker, literal]) {
        assert.equal(res.stdout.includes(text) || res.stderr.includes(text), false);
      }
      assert.equal(fs.readFileSync(serversPath, "utf8"), existing);
      assert.equal(fs.existsSync(envPath), false);
    });
  }

  for (const [label, value] of [["CR", "a\rb"], ["LF", "a\nb"], ["CRLF", "a\r\nb"]]) {
    for (const field of ["env", "headers"]) {
      test(`${cmd} rejects a literal ${field} value with ${label} and writes nothing`, (t) => {
        const { source, serversPath, envPath, broker, writeSource } = secretSetup(t);
        const prefix = rnd("lit");
        const entry =
          field === "env"
            ? { ...stdioEntry, env: { K: prefix + value } }
            : { url: "https://example.com/mcp", headers: { Authorization: prefix + value } };
        writeSource({ s: entry });
        const res = broker(argsFor(source));
        assert.notEqual(res.status, 0);
        assert.match(res.stderr, /line break/);
        assert.equal(res.stdout.includes(prefix) || res.stderr.includes(prefix), false);
        assert.equal(fs.existsSync(serversPath), false);
        assert.equal(fs.existsSync(envPath), false);
      });
    }
  }
}
