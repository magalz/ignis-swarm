import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Supervisor } from "../scripts/broker/supervisor.mjs";
import { mkTemp } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeMock(dir, name, { slowMs = 2000, crashFirst = false } = {}) {
  const script = path.join(dir, `${name}.mjs`);
  const files = {
    counter: path.join(dir, `${name}.counter`),
    methods: path.join(dir, `${name}.methods`),
    spawns: path.join(dir, `${name}.spawns`),
    cancelled: path.join(dir, `${name}.cancelled`),
    crashed: path.join(dir, `${name}.crashed`),
  };
  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
import readline from "node:readline";
const f = ${JSON.stringify(files)};
fs.appendFileSync(f.spawns, String(process.pid) + "\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(f.methods, msg.method + "\\n");
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", inputSchema: { type: "object" } }, { name: "fast", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "notifications/cancelled") {
    fs.appendFileSync(f.cancelled, JSON.stringify(msg.params) + "\\n");
  } else if (msg.method === "tools/call") {
    if (${crashFirst ? "true" : "false"} && !fs.existsSync(f.crashed)) {
      fs.writeFileSync(f.crashed, "1");
      process.exit(1);
    }
    const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: msg.params.name + ":" + process.pid }], isError: false } });
    if (msg.params.name === "slow") {
      fs.appendFileSync(f.counter, "x\\n");
      setTimeout(reply, ${slowMs});
    } else {
      reply();
    }
  }
});
`
  );
  return { script, files };
}

function lines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function setup(t, { requestTimeoutMs = 500 } = {}) {
  const home = mkTemp("ignis-to-home-");
  const repo = mkTemp("ignis-to-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  const saved = { h: process.env.IGNIS_BROKER_HOME, d: process.env.IGNIS_BROKER_DATA };
  process.env.IGNIS_BROKER_HOME = home;
  process.env.IGNIS_BROKER_DATA = home;
  const sup = new Supervisor(home, home, 0);
  t.after(async () => {
    await sup.shutdown();
    if (saved.h === undefined) delete process.env.IGNIS_BROKER_HOME;
    else process.env.IGNIS_BROKER_HOME = saved.h;
    if (saved.d === undefined) delete process.env.IGNIS_BROKER_DATA;
    else process.env.IGNIS_BROKER_DATA = saved.d;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const entry = (script) => ({
    transport: "stdio",
    command: process.execPath,
    args: [script],
    requestTimeoutMs,
  });
  return { home, repo, sup, entry };
}

test("a timed-out tools/call runs exactly once", async (t) => {
  const { home, repo, sup, entry } = setup(t);
  const m = writeMock(home, "srv");
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({ version: 1, servers: { demo: entry(m.script) } })
  );
  await assert.rejects(
    sup.call({ server: "demo", tool: "slow", arguments: {}, cwd: repo }),
    (e) => e.kind === "timeout"
  );
  await sleep(2500);
  assert.equal(lines(m.files.counter).length, 1);
});

test("a timeout does not fail over from local to global", async (t) => {
  const { home, repo, sup, entry } = setup(t);
  const local = writeMock(home, "loc");
  const glob = writeMock(home, "glob");
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({ version: 1, servers: { demo: entry(glob.script) } })
  );
  fs.writeFileSync(
    path.join(repo, ".agents", "ignis-broker.json"),
    JSON.stringify({ version: 1, servers: { demo: entry(local.script) } })
  );
  await assert.rejects(
    sup.call({ server: "demo", tool: "slow", arguments: {}, cwd: repo }),
    (e) => e.kind === "timeout"
  );
  await sleep(2500);
  assert.equal(lines(local.files.counter).length, 1);
  assert.equal(lines(glob.files.counter).length, 0);
  assert.equal(lines(glob.files.spawns).length, 0);
});

test("a timeout leaves the shared process serving other calls", async (t) => {
  const { home, repo, sup, entry } = setup(t);
  const m = writeMock(home, "srv");
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({ version: 1, servers: { demo: entry(m.script) } })
  );
  const slow = sup.call({ server: "demo", tool: "slow", arguments: {}, cwd: repo });
  const slowOutcome = slow.then(
    () => null,
    (e) => e
  );
  await sleep(100);
  const fast = await sup.call({ server: "demo", tool: "fast", arguments: {}, cwd: repo });
  assert.match(fast.content[0].text, /^fast:/);
  const err = await slowOutcome;
  assert.equal(err?.kind, "timeout");
  const after = await sup.call({ server: "demo", tool: "fast", arguments: {}, cwd: repo });
  assert.equal(after.content[0].text, fast.content[0].text);
  assert.equal(lines(m.files.spawns).length, 1);
});

test("the server receives notifications/cancelled for the timed-out request", async (t) => {
  const { home, repo, sup, entry } = setup(t);
  const m = writeMock(home, "srv");
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({ version: 1, servers: { demo: entry(m.script) } })
  );
  await assert.rejects(sup.call({ server: "demo", tool: "slow", arguments: {}, cwd: repo }));
  await sleep(300);
  const got = lines(m.files.cancelled).map((l) => JSON.parse(l));
  assert.equal(got.length, 1);
  assert.equal(typeof got[0].requestId, "number");
  assert.equal(got[0].reason, "timeout");
  assert.ok(lines(m.files.methods).includes("notifications/cancelled"));
});

test("a transport crash still retries the call once", async (t) => {
  const { home, repo, sup, entry } = setup(t, { requestTimeoutMs: 5000 });
  const m = writeMock(home, "srv", { crashFirst: true, slowMs: 10 });
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({ version: 1, servers: { demo: entry(m.script) } })
  );
  const res = await sup.call({ server: "demo", tool: "slow", arguments: {}, cwd: repo });
  assert.equal(res.meta.retried, true);
  assert.match(res.content[0].text, /^slow:/);
  assert.equal(lines(m.files.spawns).length, 2);
});
