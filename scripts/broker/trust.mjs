import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameWithRetry } from "./review-state.mjs";

const STORE_FILE = "trusted-local-configs.json";

export function trustStorePath(dataDir) {
  return path.join(dataDir, STORE_FILE);
}

function fold(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function normalizeTrustPath(file) {
  try {
    return fold(fs.realpathSync.native(file));
  } catch {
    return fold(path.resolve(file));
  }
}

function sha256Of(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseObject(bytes) {
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("top level must be a JSON object");
  }
  return parsed;
}

function loadStore(dataDir, { strict }) {
  const storePath = trustStorePath(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    if (strict) throw new Error(`cannot read trust store ${storePath}: ${err.message}`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    const configs = parsed?.configs;
    if (!configs || typeof configs !== "object" || Array.isArray(configs)) {
      throw new Error("missing configs object");
    }
    return { ...configs };
  } catch (err) {
    if (strict) throw new Error(`corrupt trust store ${storePath}: ${err.message}`);
    return {};
  }
}

function saveStore(dataDir, configs) {
  const storePath = trustStorePath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${storePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, configs }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameWithRetry(temp, storePath);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export function trustLocalConfig(dataDir, file, { nowMs = Date.now() } = {}) {
  const bytes = fs.readFileSync(file);
  try {
    parseObject(bytes);
  } catch (err) {
    throw new Error(`refusing to trust ${file}: not a valid JSON object config: ${err.message}`);
  }
  const key = normalizeTrustPath(file);
  const sha256 = sha256Of(bytes);
  const configs = loadStore(dataDir, { strict: true });
  configs[key] = { sha256, trustedAt: new Date(nowMs).toISOString() };
  saveStore(dataDir, configs);
  return { path: key, sha256 };
}

export function revokeLocalConfig(dataDir, file) {
  const configs = loadStore(dataDir, { strict: true });
  const key = normalizeTrustPath(file);
  if (!Object.hasOwn(configs, key)) return false;
  delete configs[key];
  saveStore(dataDir, configs);
  return true;
}

export function listTrustedLocalConfigs(dataDir) {
  const configs = loadStore(dataDir, { strict: false });
  return Object.keys(configs)
    .sort()
    .map((p) => ({ path: p, sha256: configs[p]?.sha256, trustedAt: configs[p]?.trustedAt }));
}

export function readTrustedLocalConfig(dataDir, file) {
  const key = normalizeTrustPath(file);
  let bytes;
  let parsed;
  try {
    bytes = fs.readFileSync(file);
    parsed = parseObject(bytes);
  } catch (err) {
    return { path: key, error: err };
  }
  const sha256 = sha256Of(bytes);
  const entry = loadStore(dataDir, { strict: false })[key];
  let status = "untrusted";
  if (entry && typeof entry.sha256 === "string") {
    status = entry.sha256 === sha256 ? "trusted" : "changed";
  }
  return { path: key, sha256, parsed, status };
}
