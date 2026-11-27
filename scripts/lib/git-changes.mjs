import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const BUFFER_SLACK = 1024;
const NUL = Buffer.from([0]);
const SLASH = 0x2f;
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

function git(cwd, args, { env, timeoutMs, input, maxBuffer, extraEnv } = {}) {
  return spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    env: { ...(env ?? process.env), LC_ALL: "C", LANGUAGE: "C", GIT_OPTIONAL_LOCKS: "0", ...extraEnv },
    input,
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  });
}

function failure(res, action) {
  if (res.error) {
    const code = res.error.code === "ETIMEDOUT" ? "timeout" : res.error.code === "ENOBUFS" ? "too_large" : "git_failed";
    return { code, message: `git ${action}: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const detail = res.stderr?.toString("utf8").trim() || `exit ${res.signal ?? res.status}`;
    return { code: "git_failed", message: `git ${action} failed (exit ${res.status}): ${detail}` };
  }
  return null;
}

function firstLine(res) {
  return res.stdout.toString("utf8").replace(/\r?\n[\s\S]*$/, "");
}

function splitNul(buffer) {
  const parts = [];
  let start = 0;
  for (let end = buffer.indexOf(0, start); end !== -1; end = buffer.indexOf(0, start)) {
    if (end > start) parts.push(buffer.subarray(start, end));
    start = end + 1;
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    return;
  }
}

function readHead(root, env, timeoutMs) {
  const res = git(root, ["rev-parse", "--verify", "-q", "HEAD"], { env, timeoutMs });
  if (!res.error && res.status === 0) return { sha: firstLine(res) };
  if (!res.error && res.status === 1) return { unborn: true };
  return { error: failure(res, "rev-parse --verify HEAD") };
}

function invalidOptions(base, unified, maxBytes) {
  if (typeof base !== "string" || base === "" || base.trim() !== base || base.startsWith("-")) {
    return "base must be a git revision that does not start with '-' and has no surrounding whitespace";
  }
  if (unified !== undefined && !(Number.isInteger(unified) && unified >= 0)) {
    return "unified must be a non-negative integer";
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return "maxBytes must be a non-negative integer";
  }
  return null;
}

export function gitToplevel(cwd, { env, timeoutMs = 10_000 } = {}) {
  const res = git(cwd, ["rev-parse", "--show-toplevel"], { env, timeoutMs });
  if (!res.error && res.status !== 0 && /not a git repository/i.test(res.stderr?.toString("utf8") ?? "")) {
    return { notGit: true };
  }
  const error = failure(res, "rev-parse --show-toplevel");
  if (error) {
    return { error: res.error?.code === "ENOENT" ? { ...error, code: "ENOENT" } : error };
  }
  const top = firstLine(res);
  if (!top) return { error: { code: "git_failed", message: "git rev-parse --show-toplevel printed no path" } };
  return { root: path.resolve(top) };
}

export function headSha(root, { env, timeoutMs = 10_000 } = {}) {
  const head = readHead(root, env, timeoutMs);
  if (head.error) throw new Error(head.error.message);
  return head.unborn ? "unborn" : head.sha;
}

export function collectChanges(root, { base = "HEAD", unified, maxBytes = DEFAULT_MAX_BYTES, env, timeoutMs = 30_000 } = {}) {
  const result = { diff: "", bytes: 0, untracked: [], error: null };
  const invalid = invalidOptions(base, unified, maxBytes);
  if (invalid) {
    result.error = { code: "git_failed", message: invalid };
    return result;
  }
  const maxBuffer = maxBytes + BUFFER_SLACK;
  let scratch = null;
  try {
    const listed = git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { env, timeoutMs, maxBuffer });
    const listFailure = failure(listed, "ls-files");
    if (listFailure) {
      result.error = listFailure;
      return result;
    }
    const entries = splitNul(listed.stdout).filter((entry) => entry[entry.length - 1] !== SLASH);
    result.untracked = entries.map((entry) => entry.toString("utf8"));

    let baseRev = base;
    if (base === "HEAD") {
      const head = readHead(root, env, timeoutMs);
      if (head.error) {
        result.error = head.error;
        return result;
      }
      if (head.unborn) {
        const tree = git(root, ["hash-object", "-t", "tree", "--stdin"], { env, timeoutMs, input: "" });
        const treeFailure = failure(tree, "hash-object");
        if (treeFailure) {
          result.error = treeFailure;
          return result;
        }
        baseRev = firstLine(tree);
      }
    }

    let indexEnv;
    if (entries.length > 0) {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-git-index-"));
      const indexCopy = path.join(scratch, "index");
      const located = git(root, ["rev-parse", "--git-path", "index"], { env, timeoutMs });
      const locateFailure = failure(located, "rev-parse --git-path index");
      if (locateFailure) {
        result.error = locateFailure;
        return result;
      }
      const realIndex = path.resolve(root, firstLine(located));
      if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, indexCopy);
      indexEnv = { GIT_INDEX_FILE: indexCopy };
      const added = git(root, ["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env,
        timeoutMs,
        input: Buffer.concat(entries.flatMap((entry) => [entry, NUL])),
        extraEnv: { ...indexEnv, GIT_LITERAL_PATHSPECS: "1" },
      });
      const addFailure = failure(added, "add -N");
      if (addFailure) {
        result.error = addFailure;
        return result;
      }
    }

    const diffArgs = ["diff", ...DIFF_FLAGS];
    if (unified !== undefined) diffArgs.push(`--unified=${unified}`);
    diffArgs.push(baseRev, "--");
    const diffed = git(root, diffArgs, { env, timeoutMs, maxBuffer, extraEnv: indexEnv });
    const diffFailure = failure(diffed, "diff");
    if (diffFailure) {
      result.error = diffFailure;
      return result;
    }
    if (diffed.stdout.length > maxBytes) {
      result.error = { code: "too_large", message: `git diff output exceeds ${maxBytes} bytes` };
      return result;
    }
    result.diff = diffed.stdout.toString("utf8");
    result.bytes = diffed.stdout.length;
  } catch (err) {
    result.diff = "";
    result.bytes = 0;
    result.error = { code: "git_failed", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratch) removeDir(scratch);
  }
  return result;
}
