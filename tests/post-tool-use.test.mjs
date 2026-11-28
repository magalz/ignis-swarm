import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, runNode } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "post-tool-use.mjs");
const HOOK_TIMEOUT_MS = 60_000;
const ROTATE_THRESHOLD = 5 * 1024 * 1024;

const iso = isolatedEnv();
after(() => iso.cleanup());

function runHook(inputObj) {
  const res = runNode(HOOK, [], { input: JSON.stringify(inputObj), env: iso.env, cwd: PLUGIN_ROOT, timeoutMs: HOOK_TIMEOUT_MS });
  assert.equal(res.status, 0, `hook failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function auditPath(convId, suffix = ".jsonl") {
  return path.join(iso.dirs.brokerData, "audit", `${convId}${suffix}`);
}

function readEntries(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runCommand(convId, commandLine) {
  runHook({ conversationId: convId, stepIdx: 1, toolCall: { name: "run_command", args: { CommandLine: commandLine } } });
  const entries = readEntries(auditPath(convId));
  return entries[entries.length - 1];
}

const GO_TEST_CALL = {
  conversationId: "conv-123",
  stepIdx: 4,
  toolCall: { name: "run_command", args: { CommandLine: "go test ./..." } },
};

test("post-tool-use returns an empty object", () => {
  assert.deepEqual(runHook(GO_TEST_CALL), {});
});

test("post-tool-use appends one audit record for a test command", () => {
  runHook({ ...GO_TEST_CALL, conversationId: "conv-append" });
  const records = readEntries(auditPath("conv-append"));
  assert.equal(records.length, 1);
  assert.equal(records[0].isTest, true);
  assert.equal(records[0].tool, "run_command");
  assert.equal(records[0].stepIdx, 4);
  assert.equal(records[0].command, "go test ./...");
});

const TOKENS = {
  githubClassic: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  githubOauth: "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  githubFineGrained: "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789",
  gitlab: "glpat-abcdefghij0123456789",
  slack: ["xoxb", "123456789012", "abcdefghijklmnop"].join("-"),
  openai: "sk-proj-abcdefghijklmnopqrstuvwx",
  aws: "AKIAIOSFODNN7EXAMPLE",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk",
};

const REDACTION_CASES = [
  {
    name: "curl Authorization Bearer header",
    command: 'curl -H "Authorization: Bearer abc123def456" https://api.example.com/v1',
    expected: 'curl -H "Authorization: Bearer [REDACTED]" https://api.example.com/v1',
  },
  {
    name: "curl Authorization Basic header",
    command: "curl -H 'Authorization: Basic dXNlcjpwYXNz' https://api.example.com/v1",
    expected: "curl -H 'Authorization: Basic [REDACTED]' https://api.example.com/v1",
  },
  {
    name: "lowercase authorization header",
    command: 'curl -H "authorization: bearer abc123def456" https://api.example.com/v1',
    expected: 'curl -H "authorization: bearer [REDACTED]" https://api.example.com/v1',
  },
  {
    name: "x-api-key header",
    command: 'curl -H "x-api-key: abc123def456" https://api.example.com/v1',
    expected: 'curl -H "x-api-key: [REDACTED]" https://api.example.com/v1',
  },
  {
    name: "api-key header",
    command: "curl -H 'api-key: abc123def456' https://api.example.com/v1",
    expected: "curl -H 'api-key: [REDACTED]' https://api.example.com/v1",
  },
  {
    name: "environment assignment before a command",
    command: `GITHUB_TOKEN=${TOKENS.githubClassic} npm publish`,
    expected: "GITHUB_TOKEN=[REDACTED] npm publish",
  },
  {
    name: "exported quoted secret",
    command: "export SECRET_KEY='abc123' && node app.js",
    expected: "export SECRET_KEY=[REDACTED] && node app.js",
  },
  {
    name: "cmd.exe set",
    command: "set DB_PASSWORD=hunter2 && node app.js",
    expected: "set DB_PASSWORD=[REDACTED] && node app.js",
  },
  {
    name: "PowerShell env assignment",
    command: "$env:API_KEY = 'abc123'",
    expected: "$env:API_KEY = [REDACTED]",
  },
  {
    name: "PowerShell env assignment without spaces",
    command: '$env:AWS_ACCESS_KEY="abc123"; aws s3 ls',
    expected: "$env:AWS_ACCESS_KEY=[REDACTED]; aws s3 ls",
  },
  {
    name: "long flag with a separate value",
    command: "mysql --password hunter2 -u root",
    expected: "mysql --password [REDACTED] -u root",
  },
  {
    name: "long flag with an equals value",
    command: "mysql --password=hunter2 -u root",
    expected: "mysql --password=[REDACTED] -u root",
  },
  {
    name: "api key and private key flags",
    command: "tool --api-key abc123 --private-key=xyz789 --user bob",
    expected: "tool --api-key [REDACTED] --private-key=[REDACTED] --user bob",
  },
  {
    name: "flag name containing a keyword is matched case-insensitively",
    command: "deploy --Client-Secret abc123 --pwd=letmein",
    expected: "deploy --Client-Secret [REDACTED] --pwd=[REDACTED]",
  },
  {
    name: "flag followed by another flag keeps the flag",
    command: "npm publish --token --dry-run",
    expected: "npm publish --token --dry-run",
  },
  {
    name: "secret in a query string",
    command: 'curl "https://api.example.com/v1?client_secret=abc123&page=2"',
    expected: 'curl "https://api.example.com/v1?client_secret=[REDACTED]&page=2"',
  },
  {
    name: "JSON body password",
    command: `curl -d '{"user":"bob","password":"hunter2"}' https://api.example.com/login`,
    expected: `curl -d '{"user":"bob","password":[REDACTED]}' https://api.example.com/login`,
  },
  {
    name: "credentials in a URL",
    command: "git clone https://user:pass@github.com/org/repo.git",
    expected: "git clone https://user:[REDACTED]@github.com/org/repo.git",
  },
  {
    name: "URL credentials whose user name holds a keyword keep the host",
    command: `git clone https://x-access-token:${TOKENS.githubClassic}@github.com/org/repo.git`,
    expected: "git clone https://x-access-token:[REDACTED]@github.com/org/repo.git",
  },
  {
    name: "URL credentials with a keyword user and an api key flag",
    command: "git clone https://apikey:abc123@host.example.com/repo.git --token abc123",
    expected: "git clone https://apikey:[REDACTED]@host.example.com/repo.git --token [REDACTED]",
  },
  {
    name: "credentials in a URL with an at sign in the password",
    command: "git clone https://user:p@ss@github.com/org/repo.git",
    expected: "git clone https://user:[REDACTED]@github.com/org/repo.git",
  },
  ...Object.entries(TOKENS).map(([kind, token]) => ({
    name: `known token format: ${kind}`,
    command: `echo ${token} done`,
    expected: "echo [REDACTED] done",
  })),
  {
    name: "plain git command is unchanged",
    command: "git log --oneline -5 --author=bob",
    expected: "git log --oneline -5 --author=bob",
  },
  {
    name: "pwd and token-like host names are unchanged",
    command: 'cd "$(pwd)/src" && curl https://token.example.com:8443/status',
    expected: 'cd "$(pwd)/src" && curl https://token.example.com:8443/status',
  },
  {
    name: "git remote URL without credentials is unchanged",
    command: "git clone git@github.com:org/repo.git && git clone ssh://git@host:22/org/repo.git",
    expected: "git clone git@github.com:org/repo.git && git clone ssh://git@host:22/org/repo.git",
  },
];

for (const [index, { name, command, expected }] of REDACTION_CASES.entries()) {
  test(`post-tool-use stores a redacted command: ${name}`, () => {
    const record = runCommand(`redact-${index}`, command);
    assert.equal(record.command, expected);
    assert.equal(record.isTest, false);
    assert.equal(record.tool, "run_command");
  });
}

test("post-tool-use leaves a plain npm test command unchanged and flags it as a test", () => {
  const record = runCommand("plain-test", "npm test");
  assert.equal(record.command, "npm test");
  assert.equal(record.isTest, true);
});

test("post-tool-use keeps the entry format of a command record", () => {
  const record = runCommand("entry-format", "npm test");
  assert.deepEqual(Object.keys(record), ["ts", "stepIdx", "tool", "error", "isTest", "command"]);
  assert.equal(record.stepIdx, 1);
  assert.equal(record.error, null);
});

test("post-tool-use keeps the entry format of an edit record", () => {
  runHook({ conversationId: "entry-format-edit", stepIdx: 2, toolCall: { name: "edit_file", args: { Path: "src/a.mjs" } } });
  const [edit] = readEntries(auditPath("entry-format-edit"));
  assert.deepEqual(Object.keys(edit), ["ts", "stepIdx", "tool", "error", "path"]);
  assert.equal(edit.path, "src/a.mjs");
});

test("post-tool-use redacts before truncating to 240 characters", () => {
  const record = runCommand("straddle", `${"x".repeat(230)} TOKEN=${TOKENS.githubClassic} tail`);
  assert.equal(record.command, `${"x".repeat(230)} TOKEN=[RE`);
});

test("post-tool-use truncates a long plain command to 240 characters", () => {
  assert.equal(runCommand("long-plain", "y".repeat(500)).command, "y".repeat(240));
});

test("post-tool-use does not rotate a log under the threshold", () => {
  runCommand("small-log", "npm test");
  runCommand("small-log", "npm test");
  assert.equal(readEntries(auditPath("small-log")).length, 2);
  assert.equal(fs.existsSync(auditPath("small-log", ".1.jsonl")), false);
});

/** Write a log over the rotation threshold, plus a stale archive, then append one command. */
function rotateOversizedLog(convId) {
  const line = `${JSON.stringify({ pad: "a".repeat(1000) })}\n`;
  const oldLog = line.repeat(Math.ceil((5.1 * 1024 * 1024) / line.length));
  assert.ok(oldLog.length > ROTATE_THRESHOLD);
  fs.mkdirSync(path.dirname(auditPath(convId)), { recursive: true });
  fs.writeFileSync(auditPath(convId), oldLog);
  fs.writeFileSync(auditPath(convId, ".1.jsonl"), "stale\n");
  runCommand(convId, "npm test");
  return oldLog;
}

test("post-tool-use moves a log over 5 MiB to .1.jsonl, replacing the old archive", () => {
  const oldLog = rotateOversizedLog("rotate-archive");
  assert.equal(fs.statSync(auditPath("rotate-archive", ".1.jsonl")).size, oldLog.length);
});

test("post-tool-use starts a new log file after rotating", () => {
  rotateOversizedLog("rotate-new");
  const entries = readEntries(auditPath("rotate-new"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, "npm test");
});

test("post-tool-use creates the rotated log with mode 0600", { skip: process.platform === "win32" }, () => {
  rotateOversizedLog("rotate-mode");
  assert.equal(fs.statSync(auditPath("rotate-mode")).mode & 0o777, 0o600);
});

// The bound only has to catch catastrophic backtracking, so it includes the spawn and stays far above a loaded machine's slowdown.
const REDACTION_BOUND_MS = 20_000;

for (const [label, command] of [
  ["--pwd repeated", "--pwd".repeat(1700)],
  ["--token- repeated", "--token-".repeat(1100)],
]) {
  test(`post-tool-use redacts a long flag-heavy command (${label}) without catastrophic backtracking`, () => {
    const started = Date.now();
    const record = runCommand(`flag-heavy-${label.split(" ")[0]}`, command);
    assert.ok(Date.now() - started < REDACTION_BOUND_MS, `redaction took ${Date.now() - started} ms`);
    assert.equal(record.command, command.slice(0, 240));
  });
}
