import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../scripts/broker/config.mjs";
import { initGitRepo, isolatedEnv, mkTemp, runNode } from "./helpers.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ignis-broker.mjs");
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function token() {
  return `${"sec"}${"ret-"}${crypto.randomInt(10 ** 9, 10 ** 10)}`;
}

function setup(t) {
  const iso = isolatedEnv();
  const repo = initGitRepo(mkTemp("ignis-tcli-repo-"));
  const secrets = [token(), token(), token()];
  const [secret, bearer, query] = secrets;
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  fs.mkdirSync(path.join(repo, "sub", "dir"), { recursive: true });
  const file = path.join(repo, ".agents", "ignis-broker.json");
  const config = {
    version: 1,
    servers: {
      "local-stdio": { transport: "stdio", command: "node", args: ["srv.mjs", "--flag"], env: { TOKEN: secret } },
      "local-http": {
        transport: "http",
        url: `https://user:${secret}@example.test/mcp?k=${query}`,
        headers: { Authorization: `Bearer ${bearer}` },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config));
  t.after(() => {
    iso.cleanup();
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { iso, repo, file, secrets };
}

function cli(iso, args) {
  return runNode(BIN, args, { env: iso.env, timeoutMs: 20_000 });
}

function assertNoSecrets(res, secrets) {
  for (const s of secrets) {
    assert.ok(!res.stdout.includes(s), "stdout leaked a secret");
    assert.ok(!res.stderr.includes(s), "stderr leaked a secret");
  }
}

test("trust prints a redacted summary and trusts the config", (t) => {
  const { iso, repo, file, secrets } = setup(t);
  const res = cli(iso, ["trust", "--cwd", path.join(repo, "sub", "dir")]);
  assert.equal(res.timedOut, false);
  assert.equal(res.status, 0, res.stderr);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.ok(res.stdout.includes(file));
  assert.ok(res.stdout.includes(sha));
  assert.ok(res.stdout.includes("local-stdio"));
  assert.ok(res.stdout.includes("local-http"));
  assert.ok(res.stdout.includes("srv.mjs"));
  assert.ok(res.stdout.includes("example.test"));
  assert.ok(res.stdout.includes("***"));
  assert.match(res.stdout, /^trusted$/m);
  assertNoSecrets(res, secrets);
  const resolved = resolveConfig(iso.dirs.brokerHome, repo, iso.dirs.brokerData);
  assert.equal(resolved.localTrusted, true);
});

test("trust --json is one object without secrets", (t) => {
  const { iso, repo, file, secrets } = setup(t);
  const res = cli(iso, ["trust", "--cwd", repo, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.path, file);
  assert.equal(out.sha256.length, 64);
  assert.equal(out.trusted, true);
  assert.deepEqual(out.servers.map((s) => s.name).sort(), ["local-http", "local-stdio"]);
  assertNoSecrets(res, secrets);
});

test("trust --list shows ok, then changed after an edit, then missing", (t) => {
  const { iso, repo, file } = setup(t);
  assert.equal(cli(iso, ["trust", "--cwd", repo]).status, 0);
  const ok = cli(iso, ["trust", "--list"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /\bok\b/);
  const okJson = JSON.parse(cli(iso, ["trust", "--list", "--json"]).stdout);
  assert.equal(okJson.entries.length, 1);
  assert.equal(okJson.entries[0].state, "ok");
  fs.appendFileSync(file, " ");
  assert.match(cli(iso, ["trust", "--list"]).stdout, /\bchanged\b/);
  fs.rmSync(file);
  assert.match(cli(iso, ["trust", "--list"]).stdout, /\bmissing\b/);
});

test("trust --revoke removes the entry once, exit 0 both times", (t) => {
  const { iso, repo } = setup(t);
  assert.equal(cli(iso, ["trust", "--cwd", repo]).status, 0);
  const first = cli(iso, ["trust", "--revoke", "--cwd", repo, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).revoked, true);
  assert.equal(resolveConfig(iso.dirs.brokerHome, repo, iso.dirs.brokerData).localTrusted, false);
  const second = cli(iso, ["trust", "--revoke", "--cwd", repo, "--json"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).revoked, false);
});

test("trust --revoke works after the config file was deleted", (t) => {
  const { iso, repo, file } = setup(t);
  assert.equal(cli(iso, ["trust", "--cwd", repo]).status, 0);
  fs.rmSync(file);
  const res = cli(iso, ["trust", "--revoke", "--cwd", repo, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).revoked, true);
});

test("trust without a local config exits 1", (t) => {
  const { iso, repo, file } = setup(t);
  fs.rmSync(file);
  const res = cli(iso, ["trust", "--cwd", repo]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no local broker config found for .* \(it must be inside a git repository\)/);
});

test("trust refuses a linked .agents dir", (t) => {
  const victim = setup(t);
  const clone = initGitRepo(mkTemp("ignis-tcli-clone-"));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.symlinkSync(path.join(victim.repo, ".agents"), path.join(clone, ".agents"), LINK_TYPE);
  assert.equal(cli(victim.iso, ["trust", "--cwd", victim.repo]).status, 0);
  const res = cli(victim.iso, ["trust", "--cwd", clone]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not a link/);
  assert.doesNotMatch(res.stdout, /^trusted$/m);
  assert.equal(resolveConfig(victim.iso.dirs.brokerHome, clone, victim.iso.dirs.brokerData).localTrusted, false);
});
