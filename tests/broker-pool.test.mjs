import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Supervisor } from "../scripts/broker/supervisor.mjs";
import { mkTemp, waitUntil } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeMock(dir, name, slowMs = 1500, listMs = 0) {
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
    const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", inputSchema: { type: "object" } }, { name: "fast", inputSchema: { type: "object" } }] } });
    if (${listMs} > 0) setTimeout(reply, ${listMs});
    else reply();
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

function setup(t, { servers, defaults = {}, listMs = 0 }) {
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
  const script = writeMock(home, "mock", 1500, listMs);
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
  const rewrite = (mutate) => {
    const file = path.join(home, "servers.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(cfg);
    fs.writeFileSync(file, JSON.stringify(cfg));
  };
  return { sup, repo, call, home, rewrite };
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
  let shutdownCalls = 0;
  let failing = true;
  first.adapter.shutdown = async () => {
    shutdownCalls += 1;
    if (failing) throw new Error(`shutdown failed with ${secret} and ${token}`);
    await realShutdown();
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
    assert.equal(sup.retiredEntries.has(first), true, "failed entry no longer tracked");
    failing = false;
    const before = shutdownCalls;
    await sup.shutdown();
    assert.equal(shutdownCalls, before + 1, "shutdown was not retried");
    assert.equal(await first.adapter.isAlive(), false);
  } finally {
    await realShutdown();
  }
});

test("a failed shutdown leaves the entry tracked and the next sweep retries it", async (t) => {
  const { sup, repo, call } = setup(t, { servers: { a: {} }, defaults: { idleTimeoutSecs: 1 } });
  await call("a", repo());
  const [entry] = [...sup.pool.values()];
  const realShutdown = entry.adapter.shutdown.bind(entry.adapter);
  let failing = true;
  entry.adapter.shutdown = async () => {
    if (failing) throw new Error("boom");
    await realShutdown();
  };
  entry.lastUsed = Date.now() - 60_000;
  await sup.maintenanceSweep();
  assert.equal(sup.retiredEntries.has(entry), true, "failed entry no longer tracked");
  failing = false;
  await sup.maintenanceSweep();
  assert.equal(await entry.adapter.isAlive(), false);
  assert.equal(sup.retiredEntries.has(entry), false);
});

test("a tools/list request counts as busy and is not evicted by the LRU limit", async (t) => {
  const { sup, repo, call } = setup(t, {
    servers: { a: {} },
    defaults: { maxWorkspaceInstances: 1 },
    listMs: 1500,
  });
  const w1 = repo();
  const w2 = repo();
  const listing = sup.list({ server: "a", cwd: w1 }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await waitUntil("w1 entry", () => sup.pool.size > 0);
  await sleep(300);
  const [first] = [...sup.pool.values()];
  await call("a", w2);
  assert.equal(sup.pool.get(first.key), first, "w1 entry evicted during tools/list");
  const outcome = await listing;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value.meta.retried, false);
  assert.deepEqual(outcome.value.tools.map((x) => x.name), ["slow", "fast"]);
});

test("an entry being handed out is busy before its request starts", async (t) => {
  const { sup, repo, call } = setup(t, {
    servers: { a: {} },
    defaults: { maxWorkspaceInstances: 1 },
  });
  const w1 = repo();
  const w2 = repo();
  await call("a", w1);
  const [entry] = [...sup.pool.values()];
  const realAlive = entry.adapter.isAlive.bind(entry.adapter);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  entry.adapter.isAlive = async () => {
    await gate;
    return realAlive();
  };
  const handedOut = call("a", w1);
  await sleep(100);
  await call("a", w2);
  assert.equal(sup.pool.get(entry.key), entry, "entry being handed out was evicted");
  assert.equal(await realAlive(), true);
  release();
  const res = await handedOut;
  assert.match(res.content[0].text, /^fast:/);
  assert.equal(entry.inFlight, 0);
});

test("concurrent callers sharing one connect each count once", async (t) => {
  const { sup, repo, call } = setup(t, { servers: { a: {} } });
  const w1 = repo();
  const calls = [call("a", w1, "slow"), call("a", w1, "slow"), call("a", w1, "slow")];
  await waitUntil("entry", () => sup.pool.size === 1);
  await sleep(300);
  const [entry] = [...sup.pool.values()];
  assert.equal(entry.inFlight, 3);
  await Promise.all(calls);
  assert.equal(entry.inFlight, 0);
  assert.equal(sup.pool.size, 1);
});

test("a config change does not kill an entry with a call in flight", async (t) => {
  const { sup, repo, call, rewrite } = setup(t, { servers: { a: {} } });
  const w1 = repo();
  const slow = call("a", w1, "slow").then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await waitUntil("entry", () => sup.pool.size === 1);
  await sleep(300);
  const [old] = [...sup.pool.values()];
  rewrite((cfg) => {
    cfg.servers.a.requestTimeoutMs = 10_001;
  });
  const fresh = await call("a", w1);
  const [current] = [...sup.pool.values()];
  assert.notEqual(current, old);
  assert.match(fresh.content[0].text, /^fast:/);
  assert.equal(await old.adapter.isAlive(), true, "old entry shut down while busy");
  const outcome = await slow;
  assert.equal(outcome.error, undefined);
  assert.match(outcome.value.content[0].text, /^slow:/);
  await waitUntil("old child to exit", () => !sup.retiredEntries.has(old));
  assert.equal(await old.adapter.isAlive(), false);
  assert.equal(await current.adapter.isAlive(), true);
});

test("Supervisor.shutdown also shuts down retired entries that are still draining", async (t) => {
  const { sup, repo, call, rewrite } = setup(t, { servers: { a: {} } });
  const w1 = repo();
  const slow = call("a", w1, "slow").then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await waitUntil("entry", () => sup.pool.size === 1);
  await sleep(300);
  const [old] = [...sup.pool.values()];
  rewrite((cfg) => {
    cfg.servers.a.requestTimeoutMs = 10_001;
  });
  await call("a", w1);
  assert.equal(await old.adapter.isAlive(), true);
  await sup.shutdown();
  assert.equal(await old.adapter.isAlive(), false, "retired entry survived Supervisor.shutdown");
  await slow;
});

test("an explicit restart stops a busy entry right away instead of waiting for its call", async (t) => {
  const { sup, repo, call } = setup(t, { servers: { a: {} } });
  const w1 = repo();
  const slow = call("a", w1, "slow").then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await waitUntil("a call in flight", () => [...sup.pool.values()].some((e) => e.inFlight > 0));
  const [busy] = [...sup.pool.values()];

  const res = await sup.restart({ server: "a" });

  assert.deepEqual(res, { evicted: 1 });
  assert.equal(await busy.adapter.isAlive(), false, "restart left the busy child running");
  assert.equal(sup.retiredEntries.has(busy), false);
  await slow;
});

test("sweepErrors never carry config file content", async (t) => {
  const { sup, home } = setup(t, { servers: { a: {} } });
  const secret = `${"sec"}${"ret"}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(
    path.join(home, "servers.json"),
    `{"version":1,"servers":{"a":{"headers":{"Authorization":"Bearer ${secret}"}}} oops`
  );
  await sup.maintenanceSweep();
  fs.writeFileSync(path.join(home, "servers.json"), JSON.stringify({ version: 1, servers: {} }));
  const { sweepErrors } = await sup.status({});
  assert.equal(sweepErrors.length >= 1, true);
  assert.match(sweepErrors[0].message, /line \d+, column \d+/);
  assert.equal(JSON.stringify(sweepErrors).includes(secret), false);
});
