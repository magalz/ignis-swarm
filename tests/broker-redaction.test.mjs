import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Supervisor } from "../scripts/broker/supervisor.mjs";
import { trustLocalConfig } from "../scripts/broker/trust.mjs";
import { mkTemp, writeMockStdioServer } from "./helpers.mjs";

const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
const mkSecret = (label) => "sec" + "ret-" + label + "-" + rand();

function setup(t) {
  const home = mkTemp("ignis-red-home-");
  const repo = mkTemp("ignis-red-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  const saved = { h: process.env.IGNIS_BROKER_HOME, d: process.env.IGNIS_BROKER_DATA };
  process.env.IGNIS_BROKER_HOME = home;
  process.env.IGNIS_BROKER_DATA = home;
  const sup = new Supervisor(home, home, 0);
  const servers = [];
  t.after(async () => {
    await sup.shutdown();
    for (const s of servers) {
      s.closeAllConnections?.();
      s.close();
    }
    if (saved.h === undefined) delete process.env.IGNIS_BROKER_HOME;
    else process.env.IGNIS_BROKER_HOME = saved.h;
    if (saved.d === undefined) delete process.env.IGNIS_BROKER_DATA;
    else process.env.IGNIS_BROKER_DATA = saved.d;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const fake500 = async (body = "boom") => {
    const srv = http.createServer((req, res) => {
      req.resume();
      res.statusCode = 500;
      res.end(body);
    });
    servers.push(srv);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return srv.address().port;
  };
  const writeServers = (obj) =>
    fs.writeFileSync(path.join(home, "servers.json"), JSON.stringify({ version: 1, servers: obj }));
  const writeEnv = (obj) =>
    fs.writeFileSync(
      path.join(home, ".env"),
      Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
    );
  return { home, repo, sup, fake500, writeServers, writeEnv };
}

async function failingCall(sup, repo, server = "demo") {
  try {
    await sup.call({ server, tool: "echo", arguments: {}, cwd: repo });
  } catch (e) {
    return e;
  }
  return assert.fail("call should have failed");
}

async function everything(sup, repo, err) {
  const status = await sup.status({ cwd: repo });
  return JSON.stringify({ message: err.message, status, fallbacks: sup.recentFallbacks });
}

test("a secret in a global HTTP url query is not in the error or status, host and name stay", async (t) => {
  const { sup, repo, fake500, writeServers, writeEnv } = setup(t);
  const port = await fake500();
  const TOKEN = mkSecret("q");
  writeEnv({ TOKEN });
  writeServers({ demo: { transport: "http", url: `http://127.0.0.1:${port}/mcp?k=\${TOKEN}` } });
  const err = await failingCall(sup, repo);
  const all = await everything(sup, repo, err);
  assert.ok(!all.includes(TOKEN), all);
  assert.ok(err.message.includes("127.0.0.1"), err.message);
  assert.ok(err.message.includes(String(port)), err.message);
});

test("a secret echoed in the response body is not in the error", async (t) => {
  const { sup, repo, fake500, writeServers, writeEnv } = setup(t);
  const TOKEN = mkSecret("b");
  const port = await fake500(`denied for ${TOKEN}`);
  writeEnv({ TOKEN });
  writeServers({ demo: { transport: "http", url: `http://127.0.0.1:${port}/mcp?k=\${TOKEN}` } });
  const err = await failingCall(sup, repo);
  assert.ok(!(await everything(sup, repo, err)).includes(TOKEN));
});

test("an expanded Authorization bearer header is not in the error or status", async (t) => {
  const { sup, repo, fake500, writeServers, writeEnv } = setup(t);
  const TOKEN = mkSecret("h");
  const port = await fake500(`bad credentials: Bearer ${TOKEN}`);
  writeEnv({ TOKEN });
  writeServers({
    demo: {
      transport: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: "Bearer ${TOKEN}" },
    },
  });
  const err = await failingCall(sup, repo);
  const all = await everything(sup, repo, err);
  assert.ok(!all.includes(TOKEN), all);
  assert.ok(err.message.includes("127.0.0.1"), err.message);
});

test("a literal header secret in servers.json is not in the error or status", async (t) => {
  const { sup, repo, fake500, writeServers } = setup(t);
  const LIT = mkSecret("lit");
  const port = await fake500(`rejected ${LIT}`);
  writeServers({
    demo: {
      transport: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { "X-Api-Key": LIT },
    },
  });
  const err = await failingCall(sup, repo);
  const all = await everything(sup, repo, err);
  assert.ok(!all.includes(LIT), all);
  assert.ok(err.message.includes("127.0.0.1"), err.message);
});

test("a local literal url secret is not in _meta.localError after failing over to global", async (t) => {
  const { home, sup, repo, fake500, writeServers } = setup(t);
  const LIT = mkSecret("loc");
  const port = await fake500();
  const mock = writeMockStdioServer(home, { label: "glob" });
  writeServers({ demo: { transport: "stdio", command: process.execPath, args: [mock] } });
  const localPath = path.join(repo, ".agents", "ignis-broker.json");
  fs.writeFileSync(
    localPath,
    JSON.stringify({
      version: 1,
      servers: { demo: { transport: "http", url: `http://u:${LIT}@127.0.0.1:${port}/mcp?k=${LIT}` } },
    })
  );
  trustLocalConfig(home, localPath);
  const res = await sup.call({ server: "demo", tool: "echo", arguments: {}, cwd: repo });
  const dump = JSON.stringify({ meta: res.meta, fb: sup.recentFallbacks, st: await sup.status({ cwd: repo }) });
  assert.ok(res.meta.localError, dump);
  assert.ok(!dump.includes(LIT), dump);
  assert.ok(dump.includes("127.0.0.1"), dump);
});

test("a stdio server that prints its env token to stderr and exits leaks nothing", async (t) => {
  const { home, sup, repo, writeServers, writeEnv } = setup(t);
  const TOKEN = mkSecret("e");
  writeEnv({ TOKEN });
  const script = path.join(home, "leaky.mjs");
  fs.writeFileSync(
    script,
    `process.stderr.write("fatal: bad key " + process.env.MY_KEY + "\\n");\nprocess.exit(1);\n`
  );
  writeServers({
    demo: {
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: { MY_KEY: "${TOKEN}" },
      startupTimeoutMs: 5000,
    },
  });
  const err = await failingCall(sup, repo);
  const all = await everything(sup, repo, err);
  assert.ok(!all.includes(TOKEN), all);
});

test("a stdio server error that echoes its env token leaks nothing", async (t) => {
  const { home, sup, repo, writeServers, writeEnv } = setup(t);
  const TOKEN = mkSecret("j");
  writeEnv({ TOKEN });
  const script = path.join(home, "echo-err.mjs");
  fs.writeFileSync(
    script,
    `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "rejected key " + process.env.MY_KEY } }) + "\\n");
  }
});
`
  );
  writeServers({
    demo: {
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: { MY_KEY: "${TOKEN}" },
      startupTimeoutMs: 5000,
    },
  });
  const err = await failingCall(sup, repo);
  const all = await everything(sup, repo, err);
  assert.ok(!all.includes(TOKEN), all);
  assert.ok(err.message.includes("rejected key"), err.message);
});

test("the whole status payload contains none of the secrets", async (t) => {
  const { sup, repo, fake500, writeServers, writeEnv } = setup(t);
  const TOKEN = mkSecret("s1");
  const LIT = mkSecret("s2");
  const port = await fake500();
  writeEnv({ TOKEN });
  writeServers({
    a: { transport: "http", url: `http://127.0.0.1:${port}/mcp?k=\${TOKEN}`, headers: { "X-K": LIT } },
  });
  await failingCall(sup, repo, "a");
  const json = JSON.stringify(await sup.status({ cwd: repo }));
  assert.ok(!json.includes(TOKEN) && !json.includes(LIT), json);
  assert.ok(json.includes('"a"'));
});

test("a value shorter than 4 characters is left as is and the message is not mangled", async (t) => {
  const { sup, repo, fake500, writeServers, writeEnv } = setup(t);
  const port = await fake500("service unavailable");
  writeEnv({ TOKEN: "abc" });
  writeServers({
    demo: { transport: "http", url: `http://127.0.0.1:${port}/mcp?k=\${TOKEN}` },
  });
  const err = await failingCall(sup, repo);
  assert.ok(!err.message.includes("***"), err.message);
  assert.ok(err.message.includes("HTTP 500"), err.message);
  assert.ok(err.message.includes("service unavailable"), err.message);
});
