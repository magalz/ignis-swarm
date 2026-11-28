import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPlainObject, writePrivateFileAtomic } from "../lib/common.mjs";

const STORE_FILE = "trusted-local-configs.json";

export function trustStorePath(dataDir) {
  return path.join(dataDir, STORE_FILE);
}

function fold(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function normalizeTrustPath(file) {
  const resolved = path.resolve(file);
  const missing = [];
  for (let current = resolved; ; current = path.dirname(current)) {
    try {
      return fold(path.join(fs.realpathSync.native(current), ...missing));
    } catch {
      if (path.dirname(current) === current) return fold(resolved);
      missing.unshift(path.basename(current));
    }
  }
}

function assertContained(file) {
  const dir = path.dirname(path.dirname(path.resolve(file)));
  const real = fs.realpathSync.native(file);
  const expected = path.join(fs.realpathSync.native(dir), ".agents", "ignis-broker.json");
  if (fold(real) !== fold(expected)) {
    throw new Error(
      `refusing to trust ${file}: it resolves to ${real}; a local broker config must be a regular file in its own .agents folder, not a link`
    );
  }
}

function sha256Of(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonErrorOffset(text) {
  let i = 0;
  const fail = () => {
    throw i;
  };
  const ws = () => {
    while (i < text.length && [" ", "\t", "\n", "\r"].includes(text[i])) i++;
  };
  const expect = (ch) => {
    if (text[i] !== ch) fail();
    i++;
  };
  const string = () => {
    expect('"');
    for (;;) {
      const c = text[i];
      if (c === undefined || c < " ") fail();
      i++;
      if (c === '"') return;
      if (c !== "\\") continue;
      const esc = text[i];
      if (esc === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail();
        i += 5;
      } else if (esc !== undefined && '"\\/bfnrt'.includes(esc)) {
        i++;
      } else {
        fail();
      }
    }
  };
  const list = (close, item) => {
    i++;
    ws();
    if (text[i] === close) {
      i++;
      return;
    }
    for (;;) {
      ws();
      item();
      ws();
      if (text[i] === ",") i++;
      else {
        expect(close);
        return;
      }
    }
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") {
      list("}", () => {
        string();
        ws();
        expect(":");
        value();
      });
    } else if (c === "[") {
      list("]", value);
    } else if (c === '"') {
      string();
    } else {
      const literal = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
      literal.lastIndex = i;
      const m = literal.exec(text);
      if (!m) fail();
      i += m[0].length;
    }
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
  } catch (at) {
    return typeof at === "number" ? at : -1;
  }
  return -1;
}

export function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const given = /in JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(err.message);
    const reported = given ? Number(given[1]) : -1;
    const at = reported >= 0 && reported <= text.length ? reported : jsonErrorOffset(text);
    if (at < 0) throw new Error("invalid JSON");
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    const column = at - before.lastIndexOf("\n");
    throw new Error(`invalid JSON at line ${line}, column ${column}`);
  }
}

function parseObject(bytes) {
  const parsed = parseJsonSafely(bytes.toString("utf8"));
  if (!isPlainObject(parsed)) {
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
    const parsed = parseJsonSafely(raw);
    const configs = parsed?.configs;
    if (!isPlainObject(configs)) {
      throw new Error("missing configs object");
    }
    return { ...configs };
  } catch (err) {
    if (strict) throw new Error(`corrupt trust store ${storePath}: ${err.message}`);
    return {};
  }
}

function saveStore(dataDir, configs) {
  writePrivateFileAtomic(trustStorePath(dataDir), `${JSON.stringify({ version: 1, configs }, null, 2)}\n`);
}

export function trustStatus(entry, bytes) {
  if (bytes === null) return "missing";
  if (!entry || typeof entry.sha256 !== "string") return "untrusted";
  return entry.sha256 === sha256Of(bytes) ? "trusted" : "changed";
}

export function trustLocalConfig(dataDir, file, { nowMs = Date.now() } = {}) {
  assertContained(file);
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
    .map((p) => {
      let bytes = null;
      try {
        bytes = fs.readFileSync(p);
      } catch {}
      return {
        path: p,
        sha256: configs[p]?.sha256,
        trustedAt: configs[p]?.trustedAt,
        status: trustStatus(configs[p], bytes),
      };
    });
}

export function readTrustedLocalConfig(dataDir, file) {
  const key = normalizeTrustPath(file);
  let bytes;
  let parsed;
  try {
    assertContained(file);
    bytes = fs.readFileSync(file);
    parsed = parseObject(bytes);
  } catch (err) {
    return { path: key, error: err };
  }
  const entry = loadStore(dataDir, { strict: false })[key];
  return { path: key, sha256: sha256Of(bytes), parsed, status: trustStatus(entry, bytes) };
}
