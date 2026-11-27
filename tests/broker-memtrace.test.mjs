import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { BrokerError, tryCliFallback } from "../scripts/broker/adapters.mjs";
import { isolatedEnv } from "./helpers.mjs";

const STUB_SOURCE = `import fs from "node:fs";
fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.STUB_STDOUT) process.stdout.write(process.env.STUB_STDOUT);
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);
process.exit(Number(process.env.STUB_EXIT || 0));
`;

const SAVED = ["IGNIS_MEMTRACE_CMD", "IGNIS_BROKER_HOME", "IGNIS_BROKER_DATA", "STUB_ARGV_FILE", "STUB_EXIT", "STUB_STDOUT", "STUB_STDERR"];

const KEYS = {
  find: ["query", "symbol", "name", "pattern"],
  callers: ["symbol", "name", "target", "query"],
  callees: ["symbol", "name", "target", "query"],
  impact: ["target", "symbol", "name", "query"],
};

const ALIASES = [
  ["find_symbol", "find"],
  ["find_code", "find"],
  ["find", "find"],
  ["callers", "callers"],
  ["get_callers", "callers"],
  ["callees", "callees"],
  ["get_callees", "callees"],
  ["get_impact", "impact"],
  ["impact", "impact"],
];

let iso;
let argvFile;
const saved = {};

function readArgv() {
  return JSON.parse(fs.readFileSync(argvFile, "utf8"));
}

before(() => {
  for (const key of SAVED) saved[key] = process.env[key];
  iso = isolatedEnv();
  const stubPath = path.join(iso.dirs.root, "memtrace-stub.mjs");
  fs.writeFileSync(stubPath, STUB_SOURCE);
  let cmd;
  if (process.platform === "win32") {
    cmd = path.join(iso.dirs.root, "memtrace-stub.cmd");
    fs.writeFileSync(cmd, `@echo off\r\nnode "${stubPath}" %*\r\n`);
  } else {
    cmd = path.join(iso.dirs.root, "memtrace-stub");
    fs.writeFileSync(cmd, `#!${process.execPath}\n${STUB_SOURCE}`, { mode: 0o755 });
  }
  process.env.IGNIS_MEMTRACE_CMD = cmd;
  process.env.IGNIS_BROKER_HOME = iso.dirs.brokerHome;
  process.env.IGNIS_BROKER_DATA = iso.dirs.brokerData;
  argvFile = path.join(iso.dirs.root, "argv.json");
  process.env.STUB_ARGV_FILE = argvFile;
});

after(() => {
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  iso.cleanup();
});

beforeEach(() => {
  process.env.STUB_EXIT = "0";
  delete process.env.STUB_STDOUT;
  delete process.env.STUB_STDERR;
  fs.rmSync(argvFile, { force: true });
});

const run = (tool, args) => tryCliFallback("memtrace", tool, args, iso.dirs.root, 20_000);

describe("memtrace CLI fallback", () => {
  test("a query that looks like a flag arrives last, after --, with options before it", async () => {
    await run("find_symbol", { query: "--help", limit: 5 });
    assert.deepEqual(readArgv(), ["find", "--limit", "5", "--", "--help"]);
  });

  test("without a limit the argv is subcommand, --, value", async () => {
    await run("callers", { symbol: "--repo=/x" });
    assert.deepEqual(readArgv(), ["callers", "--", "--repo=/x"]);
  });

  for (const [alias, sub] of ALIASES) {
    test(`alias ${alias} maps to ${sub} and honors the key order`, async () => {
      const keys = KEYS[sub];
      for (let i = 0; i < keys.length; i++) {
        const args = {};
        for (let j = i; j < keys.length; j++) args[keys[j]] = `v-${keys[j]}`;
        fs.rmSync(argvFile, { force: true });
        await run(alias, args);
        const argv = readArgv();
        assert.equal(argv[0], sub);
        assert.equal(argv[argv.length - 2], "--");
        assert.equal(argv[argv.length - 1], `v-${keys[i]}`);
      }
    });
  }

  test("an unknown tool returns null and does not spawn", async () => {
    assert.equal(await run("get_widget", { query: "x" }), null);
    assert.equal(fs.existsSync(argvFile), false);
  });

  test("a blank value returns null", async () => {
    assert.equal(await run("find", { query: "   " }), null);
  });

  test("a non-memtrace kind returns null", async () => {
    assert.equal(await tryCliFallback("other", "find", { query: "x" }, iso.dirs.root, 5000), null);
  });

  test("exit 0 resolves with stdout", async () => {
    process.env.STUB_STDOUT = "a.js:1";
    const res = await run("find", { query: "x" });
    assert.equal(res.isError, false);
    assert.equal(res.content[0].text, "a.js:1");
  });

  test("exit 1 with empty stderr resolves with No results found.", async () => {
    process.env.STUB_EXIT = "1";
    const res = await run("find", { query: "x" });
    assert.equal(res.isError, false);
    assert.equal(res.content[0].text, "No results found.");
  });

  test("exit 1 with stderr rejects with that stderr", async () => {
    process.env.STUB_EXIT = "1";
    process.env.STUB_STDERR = "boom\n";
    await assert.rejects(
      () => run("find", { query: "secret-query" }),
      (err) => {
        assert.ok(err instanceof BrokerError);
        assert.match(err.message, /boom/);
        assert.doesNotMatch(err.message, /secret-query/);
        return true;
      }
    );
  });

  test("exit 2 rejects with stderr", async () => {
    process.env.STUB_EXIT = "2";
    process.env.STUB_STDERR = "no running memtrace";
    await assert.rejects(
      () => run("find", { query: "x" }),
      (err) => err instanceof BrokerError && /code 2: no running memtrace/.test(err.message)
    );
  });
});
