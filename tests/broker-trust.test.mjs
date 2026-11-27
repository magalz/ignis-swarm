import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../scripts/broker/config.mjs";
import { Supervisor } from "../scripts/broker/supervisor.mjs";
import {
  listTrustedLocalConfigs,
  normalizeTrustPath,
  readTrustedLocalConfig,
  revokeLocalConfig,
  trustLocalConfig,
  trustStorePath,
} from "../scripts/broker/trust.mjs";
import { mkTemp, writeMockStdioServer } from "./helpers.mjs";

function fixture(t, servers = { x: { transport: "stdio", command: "local-x" } }, extra = {}) {
  const home = mkTemp("ignis-trust-home-");
  const repo = mkTemp("ignis-trust-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  const file = path.join(repo, ".agents", "ignis-broker.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, servers, ...extra }));
  fs.writeFileSync(
    path.join(home, "servers.json"),
    JSON.stringify({ version: 1, servers: { x: { transport: "stdio", command: "global-x" } } })
  );
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  return { home, repo, file };
}

test("an untrusted local config is ignored entirely", (t) => {
  const { home, repo, file } = fixture(t, undefined, { defaults: { requestTimeoutMs: 1 } });
  const resolved = resolveConfig(home, repo, home);
  const chain = resolved.candidates.get("x");
  assert.equal(chain.length, 1);
  assert.equal(chain[0].source, "global");
  assert.notEqual(resolved.defaults.requestTimeoutMs, 1);
  assert.match(resolved.localConfigError, /^untrusted local config /);
  assert.ok(resolved.localConfigError.includes(file));
  assert.ok(resolved.localConfigError.includes("ignis-broker trust --cwd"));
  assert.ok(resolved.localConfigError.includes(repo));
  assert.equal(resolved.localTrusted, false);
});

test("a trusted local config comes first", (t) => {
  const { home, repo, file } = fixture(t);
  const res = trustLocalConfig(home, file);
  assert.equal(res.sha256.length, 64);
  const resolved = resolveConfig(home, repo, home);
  const chain = resolved.candidates.get("x");
  assert.deepEqual(chain.map((c) => c.source), ["local", "global"]);
  assert.equal(resolved.localConfigError, null);
  assert.equal(resolved.localTrusted, true);
});

test("editing the file after trust voids the trust", (t) => {
  const { home, repo, file } = fixture(t);
  trustLocalConfig(home, file);
  fs.appendFileSync(file, " ");
  assert.equal(readTrustedLocalConfig(home, file).status, "changed");
  const resolved = resolveConfig(home, repo, home);
  assert.match(resolved.localConfigError, /changed since it was trusted/);
  assert.ok(resolved.localConfigError.includes("ignis-broker trust --cwd"));
  assert.deepEqual(resolved.candidates.get("x").map((c) => c.source), ["global"]);
  assert.equal(resolved.localTrusted, false);
});

test("revoke and list", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  const home = a.home;
  trustLocalConfig(home, b.file);
  trustLocalConfig(home, a.file);
  const listed = listTrustedLocalConfigs(home);
  assert.equal(listed.length, 2);
  const paths = listed.map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort());
  for (const e of listed) {
    assert.equal(e.sha256.length, 64);
    assert.ok(!Number.isNaN(Date.parse(e.trustedAt)));
  }
  assert.equal(revokeLocalConfig(home, a.file), true);
  assert.equal(readTrustedLocalConfig(home, a.file).status, "untrusted");
  assert.equal(revokeLocalConfig(home, a.file), false);
  assert.equal(listTrustedLocalConfigs(home).length, 1);
});

test("the store is mode 0600 on POSIX", { skip: process.platform === "win32" }, (t) => {
  const { home, file } = fixture(t);
  trustLocalConfig(home, file);
  assert.equal(fs.statSync(trustStorePath(home)).mode & 0o777, 0o600);
});

test("trustStorePath names the store inside the data dir", () => {
  assert.equal(trustStorePath("/d"), path.join("/d", "trusted-local-configs.json"));
});

test("paths are normalized case-insensitively on win32", { skip: process.platform !== "win32" }, (t) => {
  const { home, file } = fixture(t);
  trustLocalConfig(home, file.toUpperCase());
  assert.equal(readTrustedLocalConfig(home, file.toLowerCase()).status, "trusted");
});

test("a symlinked or junction dir resolves to the real path", (t) => {
  const { home, repo, file } = fixture(t);
  const holder = mkTemp("ignis-trust-link-");
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));
  const link = path.join(holder, "link");
  fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
  const viaLink = path.join(link, ".agents", "ignis-broker.json");
  trustLocalConfig(home, viaLink);
  assert.equal(readTrustedLocalConfig(home, file).status, "trusted");
  assert.equal(normalizeTrustPath(viaLink), normalizeTrustPath(file));
});

test("a corrupt store trusts nothing and refuses writes", (t) => {
  const { home, repo, file } = fixture(t);
  fs.writeFileSync(trustStorePath(home), "{ not json");
  assert.equal(readTrustedLocalConfig(home, file).status, "untrusted");
  assert.equal(resolveConfig(home, repo, home).localTrusted, false);
  assert.throws(() => trustLocalConfig(home, file), (e) => e.message.includes(trustStorePath(home)));
  assert.throws(() => revokeLocalConfig(home, file), (e) => e.message.includes(trustStorePath(home)));
  assert.equal(fs.readFileSync(trustStorePath(home), "utf8"), "{ not json");
});

test("trust refuses a file that is not a JSON object", (t) => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, "{ nope");
  assert.throws(() => trustLocalConfig(home, file), /JSON/i);
  fs.writeFileSync(file, "[1]");
  assert.throws(() => trustLocalConfig(home, file), /object/i);
  assert.equal(listTrustedLocalConfigs(home).length, 0);
});

test("an unreadable or invalid file reports an error", (t) => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, "{ nope");
  assert.ok(readTrustedLocalConfig(home, file).error);
  assert.ok(readTrustedLocalConfig(home, path.join(home, "missing.json")).error);
});

test("an untrusted local command does not run on list; after trust it does", async (t) => {
  const home = mkTemp("ignis-trust-sup-home-");
  const repo = mkTemp("ignis-trust-sup-repo-");
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
  const marker = path.join(home, "spawned.marker");
  const script = writeMockStdioServer(home, { label: "loc", logPidFile: marker });
  const file = path.join(repo, ".agents", "ignis-broker.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, servers: { evil: { transport: "stdio", command: process.execPath, args: [script] } } })
  );
  await sup.list({ cwd: repo, server: "evil" }).catch(() => null);
  assert.equal(fs.existsSync(marker), false);
  trustLocalConfig(home, file);
  const after = await sup.list({ cwd: repo, server: "evil" });
  assert.equal(fs.existsSync(marker), true);
  assert.ok(JSON.stringify(after).includes("echo"));
});

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const REFUSAL = /a local broker config must be a regular file in its own \.agents folder, not a link/;

test("a linked .agents dir cannot borrow the trust of the config it points at", (t) => {
  const victim = fixture(t);
  const clone = fixture(t);
  fs.rmSync(path.join(clone.repo, ".agents"), { recursive: true, force: true });
  fs.symlinkSync(path.join(victim.repo, ".agents"), path.join(clone.repo, ".agents"), LINK_TYPE);
  const linked = path.join(clone.repo, ".agents", "ignis-broker.json");
  trustLocalConfig(victim.home, victim.file);
  assert.throws(
    () => trustLocalConfig(victim.home, linked),
    (e) => REFUSAL.test(e.message) && e.message.includes("refusing to trust")
  );
  const read = readTrustedLocalConfig(victim.home, linked);
  assert.ok(read.error);
  assert.match(read.error.message, REFUSAL);
  assert.equal(read.status, undefined);
  const resolved = resolveConfig(victim.home, clone.repo, victim.home);
  assert.equal(resolved.localTrusted, false);
  assert.match(resolved.localConfigError, /^invalid local config /);
});

test("a symlinked config file is refused", { skip: process.platform === "win32" }, (t) => {
  const victim = fixture(t);
  const clone = fixture(t);
  fs.rmSync(clone.file);
  fs.symlinkSync(victim.file, clone.file);
  trustLocalConfig(victim.home, victim.file);
  assert.throws(() => trustLocalConfig(victim.home, clone.file), REFUSAL);
  assert.match(readTrustedLocalConfig(victim.home, clone.file).error.message, REFUSAL);
});

test("a repo under a linked parent folder can be trusted and read", (t) => {
  const { home, repo } = fixture(t);
  const holder = mkTemp("ignis-trust-parent-");
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));
  const link = path.join(holder, "link");
  fs.symlinkSync(repo, link, LINK_TYPE);
  const viaLink = path.join(link, ".agents", "ignis-broker.json");
  assert.doesNotThrow(() => trustLocalConfig(home, viaLink));
  const read = readTrustedLocalConfig(home, viaLink);
  assert.equal(read.error, undefined);
  assert.equal(read.status, "trusted");
});

test("a deleted config trusted through a linked parent folder is revoked through the same path", (t) => {
  const { home, repo } = fixture(t);
  const holder = mkTemp("ignis-trust-parent-");
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));
  const link = path.join(holder, "link");
  fs.symlinkSync(repo, link, LINK_TYPE);
  const viaLink = path.join(link, ".agents", "ignis-broker.json");
  trustLocalConfig(home, viaLink);
  fs.rmSync(viaLink);
  const realFile = path.join(fs.realpathSync.native(repo), ".agents", "ignis-broker.json");
  assert.equal(normalizeTrustPath(viaLink), normalizeTrustPath(realFile));
  assert.equal(revokeLocalConfig(home, viaLink), true);
  assert.deepEqual(listTrustedLocalConfigs(home), []);
});

test("an invalid local config error carries line and column but never the file content", (t) => {
  const { home, file } = fixture(t);
  const secret = "sec" + "ret-" + Math.floor(Math.random() * 1e9);
  fs.writeFileSync(file, `{"a":"${secret}",\n  "b": x}`);
  const read = readTrustedLocalConfig(home, file);
  assert.equal(read.error.message.includes(secret), false);
  assert.equal(read.error.message, "invalid JSON at line 2, column 8");
});

test("a corrupt trust store names no file content", (t) => {
  const { home, file } = fixture(t);
  const secret = "sec" + "ret-" + Math.floor(Math.random() * 1e9);
  fs.writeFileSync(trustStorePath(home), `{"a":"${secret}",\n  "b": x}`);
  assert.throws(
    () => trustLocalConfig(home, file),
    (err) => /corrupt trust store/.test(err.message) && !err.message.includes(secret)
  );
});
