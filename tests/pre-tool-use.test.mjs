import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateCommand } from "../hooks/command-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function runHook(scriptRelPath, inputObj, extraEnv = {}) {
  const scriptPath = path.join(PLUGIN_ROOT, scriptRelPath);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 8000,
    windowsHide: true,
  });
  assert.equal(res.status, 0, `Hook ${scriptRelPath} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

const NO_VERIFY = "`--no-verify` bypasses";
const HOOKS_PATH = "overriding core.hooksPath bypasses";
const FORCE_MAIN = "force-pushing to main/master is forbidden";
const RESET_HARD = "`git reset --hard` destroys";
const FORCE_PUSH = "confirmation before any force push";
const CLEAN_FORCE = "before `git clean -f`";
const RM_ROOT = "root/wildcard deletion";
const REMOVE_ROOT = "recursive root deletion";

const ROWS = [
  ["git commit -n -m x", "deny", NO_VERIFY],
  ["git commit -nm x", "deny", NO_VERIFY],
  ["git commit -anm x", "deny", NO_VERIFY],
  ["git commit -an", "deny", NO_VERIFY],
  ["git commit --no-verify -m x", "deny", NO_VERIFY],
  ['git commit -m "wip" --no-verify', "deny", NO_VERIFY],
  ["git commit -m wip --no-verify", "deny", NO_VERIFY],
  ["git commit --no-veri -m x", "deny", NO_VERIFY],
  ['git commit "--no-verify" -m x', "deny", NO_VERIFY],
  ["git commit -m x \\\n--no-verify", "deny", NO_VERIFY],
  ["git commit -m x \\\r\n--no-verify", "deny", NO_VERIFY],
  ["git push --no-verify origin feat/a", "deny", NO_VERIFY],
  ["git merge --no-verify feat/a", "deny", NO_VERIFY],
  ["git rebase --no-verify main", "deny", NO_VERIFY],
  ["git cherry-pick --no-verify abc123", "deny", NO_VERIFY],
  ["git -C /repo commit --no-verify -m x", "deny", NO_VERIFY],
  ["git commit -am x", null],
  ["git commit -m x -- -n", null],
  ["git push -n origin feat/a", null],
  ["git merge --no-verify-signatures feat/a", null],
  ["git commit -m \"don't use --no-verify\"", null],
  ['git commit -m "- fix the bug in main"', null],
  ["HUSKY=0 git commit -m x", null],
  ["grep -- --no-verify README.md", null],

  ["git -c core.hooksPath=/dev/null commit -m x", "deny", HOOKS_PATH],
  ["git -c core.hookspath=/dev/null commit -m x", "deny", HOOKS_PATH],
  ["git --config-env=core.hooksPath=HOOKS push origin feat/a", "deny", HOOKS_PATH],
  ["git --config-env core.hooksPath=HOOKS merge feat/a", "deny", HOOKS_PATH],
  ["git -c core.hooksPath=/dev/null rebase main", "deny", HOOKS_PATH],
  ["git -c core.hooksPath=/dev/null cherry-pick abc123", "deny", HOOKS_PATH],
  ["git -c core.hooksPath=/dev/null status", null],
  ["git -c core.editor=true commit -m x", null],

  ["git push origin +main", "deny", FORCE_MAIN],
  ["git push -f origin HEAD:main", "deny", FORCE_MAIN],
  ["git push origin main --force", "deny", FORCE_MAIN],
  ["git push --force origin main", "deny", FORCE_MAIN],
  ["git push -fu origin main", "deny", FORCE_MAIN],
  ["git push -uf origin main", "deny", FORCE_MAIN],
  ["git push -f origin master", "deny", FORCE_MAIN],
  ["git push -f origin HEAD:refs/heads/main", "deny", FORCE_MAIN],
  ["git push origin +HEAD:refs/heads/master", "deny", FORCE_MAIN],
  ['git push -f origin "main"', "deny", FORCE_MAIN],
  ["git -C /repo push --force origin main", "deny", FORCE_MAIN],
  ["echo ok && git push -f origin main", "deny", FORCE_MAIN],
  ["git push --force --force-with-lease origin main", "deny", FORCE_MAIN],
  ["git push --force-with-lease origin main", "force_ask", FORCE_PUSH],
  ["git push --force-with-lease=main:abc origin main", "force_ask", FORCE_PUSH],
  ["git push --force-if-includes origin main", "force_ask", FORCE_PUSH],
  ["git push --force origin feature/main-fix", "force_ask", FORCE_PUSH],
  ["git push --force-with-lease origin feat/a", "force_ask", FORCE_PUSH],
  ["git push origin +feat/a", "force_ask", FORCE_PUSH],
  ["git push -f", "force_ask", FORCE_PUSH],
  ["git push -f origin", "force_ask", FORCE_PUSH],
  ["git push origin main", null],
  ["git push origin feature/main-fix", null],
  ["git push -u origin feat/a", null],
  ["git push origin main:feature", null],

  ["git reset --hard HEAD~1", "deny", RESET_HARD],
  ["git  reset   --hard", "deny", RESET_HARD],
  ["git -C /repo reset --hard origin/main", "deny", RESET_HARD],
  ["git --no-pager reset --hard", "deny", RESET_HARD],
  ["git -p reset --hard", "deny", RESET_HARD],
  ["git --git-dir=/x/.git --work-tree=/x reset --hard", "deny", RESET_HARD],
  ["git --git-dir /x/.git reset --hard", "deny", RESET_HARD],
  ["git reset --har", "deny", RESET_HARD],
  ['git reset "--hard"', "deny", RESET_HARD],
  ['"git" reset --hard', "deny", RESET_HARD],
  ["git reset --ha\\rd", "deny", RESET_HARD],
  ["git.exe reset --hard", "deny", RESET_HARD],
  ['& "C:\\Program Files\\Git\\cmd\\git.exe" reset --hard', "deny", RESET_HARD],
  ["sudo git reset --hard", "deny", RESET_HARD],
  ["sudo -u root git reset --hard", "deny", RESET_HARD],
  ["command git reset --hard", "deny", RESET_HARD],
  ["exec git reset --hard", "deny", RESET_HARD],
  ["env GIT_TRACE=1 git reset --hard", "deny", RESET_HARD],
  ["FOO=1 BAR=2 git reset --hard", "deny", RESET_HARD],
  ["git status; git reset --hard", "deny", RESET_HARD],
  ["git status || git reset --hard", "deny", RESET_HARD],
  ["git status | git reset --hard", "deny", RESET_HARD],
  ["git status\ngit reset --hard", "deny", RESET_HARD],
  ["git status\r\ngit reset --hard", "deny", RESET_HARD],
  ["echo x & git reset --hard", "deny", RESET_HARD],
  ["(git reset --hard)", "deny", RESET_HARD],
  ["echo $(git reset --hard)", "deny", RESET_HARD],
  ["if true; then git reset --hard; fi", "deny", RESET_HARD],
  ['bash -c "git reset --hard"', "deny", RESET_HARD],
  ["bash -lc 'git reset --hard'", "deny", RESET_HARD],
  ['/bin/bash -c "git push -f origin main"', "deny", FORCE_MAIN],
  ["sh -c 'echo ok && git reset --hard'", "deny", RESET_HARD],
  ['bash -c "echo \\"x\\" && git reset --hard"', "deny", RESET_HARD],
  ['sudo bash -c "git reset --hard"', "deny", RESET_HARD],
  ['pwsh -Command "git reset --hard"', "deny", RESET_HARD],
  ['pwsh -NoProfile -Command "git reset --hard"', "deny", RESET_HARD],
  ['powershell.exe -NoProfile -c "git reset --hard"', "deny", RESET_HARD],
  ["pwsh -Command git reset --hard", "deny", RESET_HARD],
  ['cmd /c "git reset --hard"', "deny", RESET_HARD],
  ["cmd /c git reset --hard", "deny", RESET_HARD],
  ['cmd.exe /k "git reset --hard"', "deny", RESET_HARD],
  ['git -C "C:\\repo\\" reset --hard', "deny", RESET_HARD],
  ["git reset --soft HEAD~1", null],
  ["git reset HEAD file.txt", null],
  ['echo "git reset --hard"', null],
  ["echo 'git reset --hard'", null],
  ['bash -c "echo git reset --hard"', null],
  ['pwsh -Command "echo git reset --hard"', null],
  ["git log --grep=force", null],
  ["git log --grep=--hard", null],
  ["git status", null],
  ["git", null],

  ["git clean -fdx", "force_ask", CLEAN_FORCE],
  ["git clean -d -f", "force_ask", CLEAN_FORCE],
  ["git clean --force -d", "force_ask", CLEAN_FORCE],
  ["git clean -fd", "force_ask", CLEAN_FORCE],
  ["git clean --f", "force_ask", CLEAN_FORCE],
  ["git -C /repo clean -df", "force_ask", CLEAN_FORCE],
  ["git clean -n", null],
  ["git clean -nd", null],

  ["rm -rf /", "deny", RM_ROOT],
  ["rm -fr /", "deny", RM_ROOT],
  ["rm -r -f /", "deny", RM_ROOT],
  ["rm -rf E:\\ && echo done", "deny", RM_ROOT],
  ["echo ok; rm -rf /", "deny", RM_ROOT],
  ["sudo rm -rf /", "deny", RM_ROOT],
  ['bash -c "rm -rf /"', "deny", RM_ROOT],
  ["Remove-Item -Recurse -Force C:\\", "deny", REMOVE_ROOT],
  ["Remove-Item -Force -Recurse C:\\", "deny", REMOVE_ROOT],
  ["rm -rf ./build", null],
  ['echo "rm -rf /"', null],
  ['echo "Remove-Item -Recurse -Force C:\\"', null],

  ["npm test", null],
  ["", null],
  ["   ", null],
];

for (const [command, decision, reason] of ROWS) {
  test(`evaluateCommand ${JSON.stringify(command)} is ${decision}`, () => {
    const result = evaluateCommand(command);
    if (decision === null) {
      assert.equal(result, null);
      return;
    }
    assert.ok(result, `expected ${decision}, got null`);
    assert.equal(result.decision, decision);
    assert.ok(
      result.reason.includes(reason),
      `reason ${JSON.stringify(result.reason)} should include ${JSON.stringify(reason)}`,
    );
  });
}

test("evaluateCommand ignores input that is not a command line", () => {
  for (const input of [undefined, null, 42, {}, []]) {
    assert.equal(evaluateCommand(input), null);
  }
});

test("evaluateCommand never throws on malformed command lines", () => {
  const malformed = [
    'echo "git reset --hard',
    "echo 'git reset --hard",
    "git reset --hard \\",
    "git commit -m x \\",
    ";;",
    "| git status",
    "&&",
    "git -C",
    "git -c",
    "git --config-env",
    "git push -f origin",
    "bash -c",
    "pwsh -Command",
    "cmd /c",
    "sudo",
    "sudo -u",
    "()",
    "$(",
    "\n\n",
  ];
  for (const command of malformed) {
    let result;
    assert.doesNotThrow(() => {
      result = evaluateCommand(command);
    }, `threw on ${JSON.stringify(command)}`);
    assert.ok(
      result === null || result.decision === "deny" || result.decision === "force_ask",
      `bad result for ${JSON.stringify(command)}`,
    );
  }
});

test("evaluateCommand returns the strongest verdict across segments", () => {
  assert.equal(evaluateCommand("git clean -fd && git reset --hard").decision, "deny");
  assert.equal(evaluateCommand("git reset --hard && git clean -fd").decision, "deny");
  assert.equal(evaluateCommand("npm test && git clean -fd").decision, "force_ask");
  assert.equal(evaluateCommand("git push -f origin feat/a ; git push -f origin main").decision, "deny");
});

function runCommand(commandLine) {
  return runHook("hooks/pre-tool-use.mjs", {
    toolCall: { name: "run_command", args: { CommandLine: commandLine } },
  });
}

test("pre-tool-use prints deny with a reason for blocked commands", () => {
  for (const command of [
    'git commit -m "wip" --no-verify',
    "git push --force origin main",
    "git reset --hard HEAD~1",
    "git -C /repo reset --hard origin/main",
    "git commit -nm x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "rm -fr /",
    "rm -r -f /",
    "rm -rf E:\\ && echo done",
    "Remove-Item -Force -Recurse C:\\",
  ]) {
    const out = runCommand(command);
    assert.equal(out.decision, "deny", `Expected deny for: ${command}`);
    assert.match(out.reason, /^Blocked by ignis-swarm: /);
  }
});

test("pre-tool-use prints force_ask for force pushes and git clean -f", () => {
  for (const command of [
    "git push --force-with-lease origin feat/a",
    "git push -f origin feature/main-fix",
    "git clean -fdx",
  ]) {
    const out = runCommand(command);
    assert.equal(out.decision, "force_ask", `Expected force_ask for: ${command}`);
    assert.match(out.reason, /requires explicit user confirmation/);
  }
});

test("pre-tool-use allows normal commands and quoted text", () => {
  for (const command of ["npm test", 'echo "git reset --hard"', "git commit -m \"don't use --no-verify\""]) {
    assert.deepEqual(runCommand(command), { decision: "allow" }, `Expected allow for: ${command}`);
  }
});
