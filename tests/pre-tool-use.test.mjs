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
const DELETE_MAIN = "Blocked by ignis-swarm: deleting main/master on a remote is forbidden.";
const MIRROR = "before `git push --mirror`";

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
  ["echo \\'; git reset --hard; echo \\'", "deny", RESET_HARD],
  ["echo it\\'s fine", null],
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

  ["bash -c -- 'git reset --hard'", "deny", RESET_HARD],
  ['sh -c -- "git push -f origin main"', "deny", FORCE_MAIN],
  ["bash -c -x 'git reset --hard'", "deny", RESET_HARD],
  ["bash -lc -- 'git reset --hard'", "deny", RESET_HARD],
  ["pwsh -Command -- git reset --hard", "deny", RESET_HARD],
  ["bash -c -- 'echo hello'", null],

  ["echo `git reset --hard`", "deny", RESET_HARD],
  ["`git reset --hard`", "deny", RESET_HARD],
  ["echo ok; `git push -f origin main`", "deny", FORCE_MAIN],
  ['echo "`git reset --hard`"', "deny", RESET_HARD],
  ["echo `echo ok` `git reset --hard`", "deny", RESET_HARD],
  ["echo `\ngit reset --hard\n`", "deny", RESET_HARD],
  ["git commit -m 'docs: `npm test`'", null],
  ["echo `date`", null],
  ['Write-Output "Step 1`n"; git push --force origin main', "deny", FORCE_MAIN],
  ['Write-Host "a`n"; git reset --hard; Write-Host "b`n"', "deny", RESET_HARD],
  ['Write-Host "a`t"; git reset --hard', "deny", RESET_HARD],
  ['Write-Host "done`n"', null],
  ['Write-Host "a`n"; Write-Host "git reset --hard"', null],
  ['Write-Host `"x; git reset --hard', "deny", RESET_HARD],
  ["Write-Host `'x; git push -f origin main", "deny", FORCE_MAIN],
  ['Write-Host "a`"b"; git reset --hard', "deny", RESET_HARD],
  ['Write-Host `"a`"; git reset --hard', "deny", RESET_HARD],
  ['Write-Host `"git reset --hard`"', null],
  ['Write-Host `"x`"; git status', null],
  ['cd "C:\\Users\\x"', null],
  ['& "C:\\Program Files\\Git\\cmd\\git.exe" status', null],

  ["git reset --hard&>out", "deny", RESET_HARD],
  ["git reset --hard&>>out", "deny", RESET_HARD],
  ["git reset --hard>out", "deny", RESET_HARD],
  ["git reset --hard 2>&1", "deny", RESET_HARD],
  ["git reset --hard >out 2>&1", "deny", RESET_HARD],
  ["git push -f origin main&>out", "deny", FORCE_MAIN],
  ["git commit -n&>out", "deny", NO_VERIFY],
  ["git status&>out", null],
  ["git status 2>&1", null],

  ['git commit -m"init"', null],
  ["git commit -minit", null],
  ["git commit -mdone", null],
  ["git commit -mn", null],
  ["git commit -amn", null],
  ["git commit -Fn", null],
  ["git commit -tn", null],
  ["git commit -Cn HEAD", null],
  ['git commit -m"fix bug" -n', "deny", NO_VERIFY],
  ["git commit -nminit", "deny", NO_VERIFY],
  ['git commit -nm"fix bug"', "deny", NO_VERIFY],
  ["git clean -efoo", null],
  ["git clean -fe x", "force_ask", CLEAN_FORCE],
  ["git clean -e x -n", null],
  ["git push -o ci.skip origin feat", null],
  ["git push -oforce origin feat", null],
  ["git push -fo ci.skip origin main", "deny", FORCE_MAIN],
  ["git push -o ci.skip -f origin main", "deny", FORCE_MAIN],

  ["timeout 5 git reset --hard", "deny", RESET_HARD],
  ["timeout 5s git push -f origin main", "deny", FORCE_MAIN],
  ["timeout -s KILL 5 git reset --hard", "deny", RESET_HARD],
  ["timeout -k 2 10 git reset --hard", "deny", RESET_HARD],
  ["timeout --signal KILL 5 git reset --hard", "deny", RESET_HARD],
  ["timeout 5 npm test", null],
  ["nice git reset --hard", "deny", RESET_HARD],
  ["nice -n 10 git push -f origin main", "deny", FORCE_MAIN],
  ["nice -10 git reset --hard", "deny", RESET_HARD],
  ["nohup git reset --hard", "deny", RESET_HARD],
  ["doas git reset --hard", "deny", RESET_HARD],
  ["doas -u root git reset --hard", "deny", RESET_HARD],
  ["xargs git reset --hard", "deny", RESET_HARD],
  ["echo x | xargs -I{} git reset --hard", "deny", RESET_HARD],
  ["echo x | xargs -I {} git reset --hard", "deny", RESET_HARD],
  ["echo x | xargs -n 1 -P 4 git push -f origin main", "deny", FORCE_MAIN],
  ["xargs -0 sh -c 'git reset --hard'", "deny", RESET_HARD],
  ["watch -n 5 git reset --hard", "deny", RESET_HARD],
  ["stdbuf -oL git reset --hard", "deny", RESET_HARD],
  ["stdbuf -o L git reset --hard", "deny", RESET_HARD],
  ["find . -name x -exec git reset --hard \\;", "deny", RESET_HARD],
  ["find . -name x -exec git reset --hard ';'", "deny", RESET_HARD],
  ["find . -execdir git reset --hard {} +", "deny", RESET_HARD],
  ["find . -ok git push -f origin main \\;", "deny", FORCE_MAIN],
  ["find . -exec rm -rf / \\;", "deny", RM_ROOT],
  ["find . -exec sh -c 'git reset --hard' \\;", "deny", RESET_HARD],
  ["find . -exec echo hi \\; -exec git reset --hard \\;", "deny", RESET_HARD],
  ["find . \\( -name a -o -name b \\) -exec git reset --hard \\;", "deny", RESET_HARD],
  ["find . -exec echo hi \\; -exec git status \\;", null],
  ["find . -name x -exec echo {} \\;", null],
  ["find . -name x -print", null],
  ["xargs echo", null],
  ["watch -n 5 date", null],

  ['echo "$(git reset --hard)"', "deny", RESET_HARD],
  ['echo "it\'s $(git reset --hard)"', "deny", RESET_HARD],
  ['echo "$(echo "$(git reset --hard)")"', "deny", RESET_HARD],
  ['echo "x $(echo ok) $(git push -f origin main) y"', "deny", FORCE_MAIN],
  ["git commit $(echo x) --no-verify", "deny", NO_VERIFY],
  ['echo "$(git status)"', null],
  ["echo '$(git reset --hard)'", null],
  ['git commit -m "$(cat <<\'EOF\'\nfix: avoid git reset --hard in docs\nEOF\n)"', null],
  ['git commit -m "$(cat <<\'EOF\'\ngit reset --hard is dangerous\nEOF\n)"', null],
  ['git commit -m "$(cat <<\'EOF\'\nfix: don\'t touch it (see #12)\nEOF\n)"', null],
  ['git commit -m "$(cat <<EOF\ngit reset --hard in docs\nEOF\n)"', null],
  ['git commit -m "$(cat <<-EOF\n\tgit reset --hard in docs\n\tEOF\n)"', null],
  ['git commit -m "$(cat <<"EOF"\ngit push -f origin main\nEOF\n)"', null],
  ['git commit -m "$(cat <<\'EOF\'\nwip\nEOF\n)" --no-verify', "deny", NO_VERIFY],
  ["cat <<EOF\ngit push -f origin main\nEOF", null],
  ["cat <<'EOF'\ngit push -f origin main\nEOF", null],
  ['cat <<"EOF"\ngit push -f origin main\nEOF', null],
  ["cat <<-EOF\n\tgit push -f origin main\n\tEOF", null],
  ["cat << 'EOF'\ngit reset --hard\nEOF", null],
  ["cat <<EOF\r\ngit reset --hard\r\nEOF\r\n", null],
  ["cat <<A <<B\none\nA\ngit reset --hard\nB", null],
  ["cat <<EOF\nx\nEOF\ngit reset --hard", "deny", RESET_HARD],
  ["cat <<EOF && git reset --hard\nx\nEOF", "deny", RESET_HARD],
  ["cat <<EOF\ngit reset --hard", "deny", RESET_HARD],
  ["echo $((1<<2))\ngit reset --hard", "deny", RESET_HARD],
  ["cat <<EOF\n$(git reset --hard)\nEOF", "deny", RESET_HARD],
  ["cat <<'EOF'\n$(git reset --hard)\nEOF", null],

  ["echo 'git reset --hard' | bash", "deny", RESET_HARD],
  ["echo 'hello' | bash", null],
  ["echo git reset --hard | sh", "deny", RESET_HARD],
  ['printf "%s\\n" "git push -f origin main" | sh', "deny", FORCE_MAIN],
  ["echo 'git reset --hard' | zsh -s", "deny", RESET_HARD],
  ["echo 'git reset --hard' | tee x | sh", "deny", RESET_HARD],
  ["echo 'git reset --hard' | pwsh", "deny", RESET_HARD],
  ["echo 'git reset --hard' | pwsh -NoProfile", "deny", RESET_HARD],
  ['echo "git reset --hard" | cmd', "deny", RESET_HARD],
  ["echo 'git reset --hard' | bash -c 'echo ok'", null],
  ["echo 'git reset --hard' | pwsh -File x.ps1", null],
  ['echo "git reset --hard" | cmd /c echo ok', null],
  ["echo 'git reset --hard' | cat", null],
  ["echo 'git reset --hard' > notes.txt", null],
  ["echo 'git reset --hard'; bash", null],
  ["echo 'git reset --hard' && bash", null],
  ["echo 'a' | cat | bash", null],
  ["iex 'git reset --hard'", "deny", RESET_HARD],
  ['Invoke-Expression "git reset --hard"', "deny", RESET_HARD],
  ["Invoke-Expression -Command 'git reset --hard'", "deny", RESET_HARD],
  ["'git reset --hard' | iex", "deny", RESET_HARD],
  ["iex 'echo ok'", null],
  ["bash <<< 'git push -f origin main'", "deny", FORCE_MAIN],
  ['bash <<< "git reset --hard"', "deny", RESET_HARD],
  ["bash <<< 'echo ok'", null],
  ["cat <<< 'git reset --hard'", null],
  ["bash <<'EOF'\ngit reset --hard\nEOF", "deny", RESET_HARD],
  ["bash <<'EOF'\necho ok\nEOF", null],
  ["cat <<EOF | bash\ngit reset --hard\nEOF", "deny", RESET_HARD],

  ["git push --mirror", "force_ask", MIRROR],
  ["git push --mirror origin", "force_ask", MIRROR],
  ["git push origin --mirror", "force_ask", MIRROR],
  ["git push origin --delete main", "deny", DELETE_MAIN],
  ["git push --delete origin main", "deny", DELETE_MAIN],
  ["git push origin -d master", "deny", DELETE_MAIN],
  ["git push origin :main", "deny", DELETE_MAIN],
  ["git push origin :refs/heads/master", "deny", DELETE_MAIN],
  ["git push origin --delete feature/x", null],
  ["git push origin -d feature/x", null],
  ["git push origin :feature/x", null],
  ["git push origin --delete main-fix", null],

  ["Get-ChildItem | ForEach-Object { git reset --hard }", "deny", RESET_HARD],
  ["& {git reset --hard}", "deny", RESET_HARD],
  ["& { git reset --hard}", "deny", RESET_HARD],
  ["Get-ChildItem | % {git reset --hard}", "deny", RESET_HARD],
  ["ForEach-Object -Process {git -C $_.FullName reset --hard}", "deny", RESET_HARD],
  ["if ($x) {git push -f origin main}", "deny", FORCE_MAIN],
  ["foreach ($d in $dirs) { Push-Location $d; git reset --hard}", "deny", RESET_HARD],
  ["function Reset-All {git reset --hard}", "deny", RESET_HARD],
  ['pwsh -Command "& {git reset --hard}"', "deny", RESET_HARD],
  ["$sb={git reset --hard}; & $sb", "deny", RESET_HARD],
  ["Get-ChildItem | ForEach-Object{ git reset --hard }", "deny", RESET_HARD],
  ["git log @{u}..HEAD", null],
  ["echo {a,b}", null],
  ["$h = @{a=1; b=2}", null],
  ["xargs -I {} git -C {} status", null],
  ["1..3 | ForEach-Object { git push --force origin main }", "deny", FORCE_MAIN],
  ["try { git reset --hard } catch { }", "deny", RESET_HARD],
  ["Invoke-Command { git reset --hard }", "deny", RESET_HARD],
  [". { git reset --hard }", "deny", RESET_HARD],
  ["$sb = { git reset --hard }; & $sb", "deny", RESET_HARD],
  ['powershell -c "Get-ChildItem | % { git reset --hard }"', "deny", RESET_HARD],
  ["if ($x) { git status } else { git reset --hard }", "deny", RESET_HARD],
  ["{ git reset --hard; }", "deny", RESET_HARD],
  ["{ git reset --hard;}", "deny", RESET_HARD],
  ["f() { git push -f origin main; }", "deny", FORCE_MAIN],
  ["git submodule foreach git reset --hard", "deny", RESET_HARD],
  ["git submodule foreach --recursive git reset --hard", "deny", RESET_HARD],
  ["git submodule foreach -q 'git reset --hard'", "deny", RESET_HARD],
  ["git submodule foreach --quiet --recursive git push -f origin main", "deny", FORCE_MAIN],
  ["git submodule --quiet foreach git commit -n -m x", "deny", NO_VERIFY],
  ['git -C /repo submodule foreach "git reset --hard"', "deny", RESET_HARD],
  ["git submodule foreach 'git clean -fdx'", "force_ask", CLEAN_FORCE],
  ["git submodule foreach --recursive git clean -fd", "force_ask", CLEAN_FORCE],
  ["git submodule foreach git status", null],
  ["git submodule foreach 'echo reset --hard'", null],
  ["git submodule update --init --recursive", null],
  ["git reset HEAD@{1}", null],
  ["git rev-parse @{u}", null],
  ["find . -name '*.tmp' -exec rm {} +", null],
  ["echo ${var}", null],
  ["$h = @{ a = 1 }", null],
  ["git log --format=%H -n 1", null],
  ["Get-ChildItem | ForEach-Object { Write-Host $_.Name }", null],

  ['git commit -m "Block \\`git push --force origin main\\`"', null],
  ['gh pr create --body "Stops \\`git reset --hard\\` from running"', null],
  ["cat <<EOF > a.md\nRun \\`git reset --hard\\` never\nEOF", null],
  ["cat <<EOF > a.md\nRun `git reset --hard` never\nEOF", "deny", RESET_HARD],
  ["git commit -m x ^\n--no-verify", "deny", NO_VERIFY],
  ["git commit -m x `\n--no-verify", "deny", NO_VERIFY],
  ["git reset ^\n--hard", "deny", RESET_HARD],
  ["find . -type d -exec git -C {} reset --hard \\;", "deny", RESET_HARD],
  ["find . -name .git -execdir git -C {} push -f origin main \\;", "deny", FORCE_MAIN],
  ["xargs -I{} git -C {} reset --hard", "deny", RESET_HARD],
  ["git -C {} reset --hard", "deny", RESET_HARD],
  ['sh -c "echo \\`git reset --hard\\`"', "deny", RESET_HARD],
  ['bash -c "x=\\$(git reset --hard)"', "deny", RESET_HARD],
  ['bash -c "echo \\$(git push -f origin main)"', "deny", FORCE_MAIN],

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

test("evaluateCommand denies deleting main or master with the exact reason", () => {
  for (const command of ["git push origin --delete main", "git push origin -d master", "git push origin :main"]) {
    assert.deepEqual(evaluateCommand(command), { decision: "deny", reason: DELETE_MAIN }, command);
  }
});

test("evaluateCommand asks before analysing deeply nested shell wrappers", () => {
  let command = "git status";
  for (let depth = 0; depth < 12; depth += 1) {
    command = `sh -c "${command.replace(/[\\"]/g, "\\$&")}"`;
  }
  const result = evaluateCommand(command);
  assert.equal(result.decision, "force_ask");
  assert.match(result.reason, /deeply nested shell wrappers/);
  let shallow = "git reset --hard";
  for (let depth = 0; depth < 3; depth += 1) {
    shallow = `sh -c "${shallow.replace(/[\\"]/g, "\\$&")}"`;
  }
  assert.equal(evaluateCommand(shallow).decision, "deny");
});

test("evaluateCommand asks before analysing an oversized command line", () => {
  const result = evaluateCommand("a ".repeat(2_500_000));
  assert.equal(result.decision, "force_ask");
  assert.match(result.reason, /oversized command line/);
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
