import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 5;
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPath(file) {
  const real = fs.realpathSync.native(file);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

function pause(ms) {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRIES || !RETRYABLE_RENAME_CODES.has(err?.code)) throw err;
      pause(20 + Math.floor(Math.random() * 31));
    }
  }
}

export function writePrivateFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameWithRetry(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw err;
  }
}
