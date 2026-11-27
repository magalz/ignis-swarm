import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Supervisor } from "../scripts/broker/supervisor.mjs";
import { mkTemp } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeMock(dir, name, slowMs = 1500) {
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(
    script,
    `
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", inputSchema: { type: "object" } }, { name: "fast", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") {
    const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: msg.params.name + ":" + process.pid }], isError: false } });
    if (msg.params.name === "slow") setTimeout(reply, ${slowMs});
    else reply();
  }
});
`
  );
  return script;
}

function setup(t, { servers, defaults = {} }) {
  const home = mkTemp("ignis-pool-home-");
  const data = mkTemp("ignis-pool-data-");
  const repos = [];
  const saved = { h: process.env.IGNIS_BROKER_HOME, d: process.env.IGNIS_BROKER_DATA };
  process.env.IGNIS_BROKER_HOME = home;
  process.env.IGNIS_BROKER_DATA = data;
  const sup = new Supervisor(home, data, 0);
  t.after(async () => {
    await sup.shutdown();
    if (saved.h === undefined) delete process.env.IGNIS_BROKER_HOME;
    else process.env.IGNIS_BROKER_HOME = saved.h;
    if (saved.d === undefined) delete process.env.IGNIS_BROKER_DATA;
    else process.env.IGNIS_BROKER_DATA = saved.d;
    for (const dir of [home, data, ...repos]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const script = writeMock(home, "mock");
  const entries = {};
  for (const [name, extra] of Object.entries(servers)) {
    entries[name] = {
      transport: "stdio",
      command: process.execPath,
      args: [script],
      perWorkspace: true,
      requestTimeoutMs: 10_000,
      ...extra,
    };
  }
  fs.writeFileSync(path.join(home, "servers.json"), JSON.stringify({ version: 1, defaults, servers: entries }));
  const repo = () => {
    const dir = fs.realpathSync.native(mkTemp("ignis-pool-repo-"));
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    repos.push(dir);
    return dir;
  };
  const call = (server, cwd, tool = "fast") => sup.call({ server, tool, arguments: {}, cwd });
  return { sup, repo, call, home };
}

test("case variants of one workspace path share one pool entry", { skip: process.platform !== "win32" }, async (t) => {
  const { sup, repo, call } = setup(t, { servers: { demo: {} } });
  const dir = repo();
  const swapped = dir.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  assert.notEqual(swapped, dir);
  await call("demo", dir);
  await call("demo", swapped);
  assert.equal(sup.pool.size, 1);
});

test("maxWorkspaceInstances is per server: B does not evict A", async (t) => {
  const { sup, repo, call } = setup(t, {
    servers: { a: {}, b: {} },
    defaults: { maxWorkspaceInstances: 1 },
  });
  const dir = repo();
  await call("a", dir);
  await call("b", dir);
  const servers = [...sup.pool.values()].map((e) => e.server).sort();
  assert.deepEqual(servers, ["a", "b"]);
  for (const e of sup.pool.values()) assert.equal(await e.adapter.isAlive(), true);
});

test("an entry with a call in flight is not evicted by the LRU limit", async (t) => {
  const { sup, repo, call } = setup(t, {
    servers: { a: {} },
    defaults: { maxWorkspaceInstances: 1 },
  });
  const w1 = repo();
  const w2 = repo();
  const slow = call("a", w1, "slow").then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  while (sup.pool.size === 0) await sleep(20);
  await sleep(300);
  await call("a", w2);
  const scopes = [...sup.pool.values()].map((e) => e.scope);
  assert.ok(scopes.includes(w1), `w1 entry evicted while busy: ${scopes.join(",")}`);
  const outcome = await slow;
  assert.equal(outcome.error, undefined);
  assert.match(outcome.value.content[0].text, /^slow:/);
});

test("a failing shutdown does not stop the sweep and is reported redacted", async (t) => {
  const token = `${"sweep"}-${"sec"}ret-${Date.now() % 100000}`;
  const secret = `Bearer ${token}`;
  const { sup, repo, call } = setup(t, {
    servers: { a: { headers: { Authorization: secret } }, b: {} },
    defaults: { idleTimeoutSecs: 1 },
  });
  const dir = repo();
  await call("a", dir);
  await call("b", dir);
  const [first, second] = [...sup.pool.values()];
  const realShutdown = first.adapter.shutdown.bind(first.adapter);
  first.adapter.shutdown = async () => {
    throw new Error(`shutdown failed with ${secret} and ${token}`);
  };
  try {
    for (const e of sup.pool.values()) e.lastUsed = Date.now() - 60_000;
    await sup.maintenanceSweep();
    assert.equal(sup.pool.has(second.key), false);
    const status = await sup.status({});
    assert.ok(Array.isArray(status.sweepErrors));
    assert.equal(status.sweepErrors.length, 1);
    const message = status.sweepErrors[0].message;
    assert.match(message, /shutdown failed/);
    assert.equal(message.includes(token), false);
  } finally {
    await realShutdown();
  }
});
