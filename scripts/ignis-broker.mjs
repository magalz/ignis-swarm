#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postToDaemon, runMcpBridge } from "./broker/bridge.mjs";
import {
  BROKER_VERSION,
  addHttpServer,
  describeServers,
  brokerDataDir,
  brokerHome,
  discoverLocalConfig,
  discoverMcpConfig,
  importMcpConfig,
  redactServerConfig,
  removeServer,
  resolveRepoRoot,
  storeImportedServers,
} from "./broker/config.mjs";
import { ensureDaemon, stopDaemon } from "./broker/lifecycle.mjs";
import {
  defaultMcpSourcePath,
  loadOnboardingState,
  probeEnvironment,
  resetOnboarding,
  parseOnboardingInput,
  saveOnboardingInput,
  skipOnboarding,
} from "./broker/onboarding.mjs";
import { runDaemon } from "./broker/server.mjs";
import {
  listTrustedLocalConfigs,
  readTrustedLocalConfig,
  revokeLocalConfig,
  trustLocalConfig,
} from "./broker/trust.mjs";

const ENTRY_SCRIPT = fileURLToPath(import.meta.url);
const BOOLEAN_FLAGS = new Set([
  "json",
  "full",
  "stdin",
  "dry-run",
  "all",
  "get",
  "probe",
  "revoke",
  "list",
  "skip",
  "reset",
  "version",
  "help",
]);

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        flags[key] = BOOLEAN_FLAGS.has(key) ? val !== "false" && val !== "0" : val;
        continue;
      }
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function cmdTrust({ flags, dataDir, asJson }) {
  const say = (value, lines) => console.log(asJson ? JSON.stringify(value, null, 2) : lines.join("\n"));
  if (flags.list) {
    const entries = listTrustedLocalConfigs(dataDir);
    say(
      { entries },
      entries.length === 0
        ? ["no trusted local broker configs"]
        : entries.map((e) => `${e.path}  ${String(e.sha256).slice(0, 12)}  ${e.trustedAt}  ${e.status}`)
    );
    return;
  }
  const dir = path.resolve(typeof flags.cwd === "string" ? flags.cwd : process.cwd());
  if (flags.revoke) {
    const file =
      typeof flags.file === "string"
        ? path.resolve(flags.file)
        : (discoverLocalConfig(dir) ?? path.join(resolveRepoRoot(dir), ".agents", "ignis-broker.json"));
    const revoked = revokeLocalConfig(dataDir, file);
    say({ path: file, revoked }, [revoked ? `revoked ${file}` : `nothing to revoke for ${file}`]);
    return;
  }
  const file = discoverLocalConfig(dir);
  if (!file) {
    throw new Error(`no local broker config found for ${dir} (it must be inside a git repository)`);
  }
  const read = readTrustedLocalConfig(dataDir, file);
  if (read.error) throw new Error(read.error.message);
  const servers = describeServers(read.parsed);
  const { sha256 } = trustLocalConfig(dataDir, file);
  const lines = [`config: ${file}`, `sha256: ${sha256}`, "servers:"];
  for (const s of servers) {
    const target = s.url ?? [s.command, ...(s.args ?? [])].join(" ");
    lines.push(`  - ${s.name} [${s.type}, ${s.enabled ? "enabled" : "disabled"}] ${target}`);
    if (s.env) lines.push(`      env: ${Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    if (s.headers) lines.push(`      headers: ${Object.entries(s.headers).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  lines.push("trusted");
  say({ path: file, sha256, servers, trusted: true }, lines);
}

async function postDaemon(home, dataDir, endpoint, body) {
  const resp = await postToDaemon({
    ensure: () => ensureDaemon(home, dataDir, ENTRY_SCRIPT),
    path: endpoint,
    body,
  });
  return resp.json();
}

function parseCallArgs(flags) {
  if (typeof flags.args === "string") {
    return JSON.parse(flags.args);
  }
  if (typeof flags["args-file"] === "string") {
    return JSON.parse(fs.readFileSync(flags["args-file"], "utf8"));
  }
  if (flags.stdin) {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }
  return {};
}

async function cmdDaemon({ home, dataDir, flags }) {
  const port = typeof flags.port === "string" ? Number(flags.port) : 0;
  await runDaemon(home, dataDir, Number.isFinite(port) ? port : 0);
}

async function cmdMcpBridge({ home, dataDir, cwd }) {
  await runMcpBridge(home, dataDir, ENTRY_SCRIPT, cwd);
}

async function cmdStop({ dataDir }) {
  const stopped = await stopDaemon(dataDir);
  console.log(stopped ? "ignis-broker daemon stopped." : "ignis-broker daemon was not running.");
}

async function cmdList({ home, dataDir, flags, positional, cwd, asJson }) {
  const res = await postDaemon(home, dataDir, "/v1/list", {
    server: positional[0],
    filter: typeof flags.filter === "string" ? flags.filter : undefined,
    cwd,
  });
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else if (Array.isArray(res.servers)) {
    for (const s of res.servers) {
      const fb = s.hasGlobalFallback ? " (+global fallback)" : "";
      console.log(
        `${s.name} [${s.transport}, ${s.primarySource}${fb}] state=${s.state} workspaces=${s.activeWorkspaces}`
      );
    }
  } else if (Array.isArray(res.tools)) {
    for (const t of res.tools) {
      console.log(`${t.name}: ${t.summary}`);
    }
  }
}

async function cmdDescribe({ home, dataDir, positional, cwd, asJson }) {
  const [server, tool] = positional;
  if (!server || !tool) throw new Error("usage: ignis-broker describe <server> <tool>");
  const res = await postDaemon(home, dataDir, "/v1/describe", { server, tool, cwd });
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`${res.schema.name} — ${res.schema.description}`);
    console.log(JSON.stringify(res.schema.inputSchema, null, 2));
  }
}

async function cmdCall({ home, dataDir, flags, positional, cwd, asJson }) {
  const [server, tool] = positional;
  if (!server || !tool) throw new Error("usage: ignis-broker call <server> <tool>");
  const res = await postDaemon(home, dataDir, "/v1/call", {
    server,
    tool,
    arguments: parseCallArgs(flags),
    cwd,
    maxBytes: typeof flags["max-bytes"] === "string" ? Number(flags["max-bytes"]) : undefined,
    full: Boolean(flags.full),
  });
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    for (const b of res.content || []) {
      console.log(b?.type === "text" && typeof b.text === "string" ? b.text : JSON.stringify(b));
    }
    if (res.meta?.fallbackFrom || res.meta?.truncated || res.meta?.retried) {
      console.error(`_meta: ${JSON.stringify(res.meta)}`);
    }
  }
  if (res.isError) process.exitCode = 1;
}

async function cmdStatus({ home, dataDir, cwd, asJson }) {
  const res = await postDaemon(home, dataDir, "/v1/status", { cwd });
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(
      `ignis-broker v${res.version} pid=${res.pid} port=${res.port} uptime=${res.uptimeSecs}s`
    );
    if (res.localConfigError) console.log(`local_config_error: ${res.localConfigError}`);
    for (const s of res.servers || []) {
      console.log(
        `  ${s.name} [${s.transport}, ${s.primarySource}] state=${s.state} active=${s.activeWorkspaces}`
      );
    }
  }
}

async function cmdRestart({ home, dataDir, flags, positional, cwd, asJson }) {
  const res = await postDaemon(home, dataDir, "/v1/restart", {
    server: positional[0],
    cwd: flags.cwd ? cwd : undefined,
  });
  console.log(asJson ? JSON.stringify(res, null, 2) : `evicted ${res.evicted} pooled backend(s).`);
}

function cmdImportMcp({ home, flags }) {
  const sourcePath = defaultMcpSourcePath(flags.from);
  const only =
    typeof flags.servers === "string"
      ? flags.servers.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
  const imported = importMcpConfig(sourcePath, only);
  const entries = Object.entries(imported.servers);

  if (flags["dry-run"]) {
    const redacted = Object.fromEntries(entries.map(([name, cfg]) => [name, redactServerConfig(cfg)]));
    console.log(JSON.stringify({ ...imported, servers: redacted }, null, 2));
    return;
  }

  const { wrote, merged } = storeImportedServers(home, imported.servers);
  console.log(`Imported ${entries.length} server(s) into ${merged.dest}:`);
  for (const [name, cfg] of entries) {
    const tags = [];
    if (cfg.perWorkspace) tags.push("perWorkspace");
    if (!cfg.enabled) tags.push("disabled");
    const extra = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    console.log(`  - ${name} [${cfg.transport}]${extra}`);
  }
  if (wrote.length > 0) console.log(`Stored ${wrote.length} secret(s) in ${path.join(home, ".env")}: ${wrote.join(", ")}`);
  console.log(`Your original ${sourcePath} was NOT modified.`);
}

function cmdDiscoverMcp({ home, flags, asJson }) {
  const sourcePath = defaultMcpSourcePath(flags.from);
  const items = discoverMcpConfig(sourcePath, home);
  if (asJson) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    for (const item of items) {
      const tags = [];
      if (item.alreadyManaged) tags.push("managed");
      if (item.disabled) tags.push("disabled");
      if (item.suggestedPerWorkspace) tags.push("perWorkspace?");
      const extra = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.log(`  - ${item.name} [${item.transport}]${extra}`);
    }
  }
}

function cmdRegisterMcp({ home, flags, asJson }) {
  const sourcePath = defaultMcpSourcePath(flags.from);
  if (!flags.all && typeof flags.servers !== "string") {
    throw new Error("usage: ignis-broker register-mcp (--all | --servers a,b) [--from <path>]");
  }
  const only =
    flags.all
      ? null
      : flags.servers.split(",").map((s) => s.trim()).filter(Boolean);
  const imported = importMcpConfig(sourcePath, only);
  const perWorkspaceSet = new Set(
    typeof flags["per-workspace"] === "string"
      ? flags["per-workspace"].split(",").map((s) => s.trim()).filter(Boolean)
      : []
  );
  const cliFallbackMap = new Map();
  if (typeof flags["cli-fallback"] === "string") {
    for (const pair of flags["cli-fallback"].split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (k && v) cliFallbackMap.set(k, v);
      }
    }
  }
  const { wrote, merged } = storeImportedServers(home, imported.servers, {
    perWorkspaceSet,
    cliFallbackMap,
  });
  const entries = Object.entries(merged.servers);
  if (asJson) {
    console.log(JSON.stringify({ dest: merged.dest, servers: Object.keys(merged.servers), secrets: wrote }, null, 2));
  } else {
    console.log(`Registered ${entries.length} server(s) in ${merged.dest}:`);
    if (wrote.length > 0) console.log(`Stored ${wrote.length} secret(s) in ${path.join(home, ".env")}: ${wrote.join(", ")}`);
    for (const [name, cfg] of entries) {
      const tags = [];
      if (cfg.perWorkspace) tags.push("perWorkspace");
      if (cfg.cliFallback) tags.push(`cliFallback=${cfg.cliFallback}`);
      if (cfg.enabled === false) tags.push("disabled");
      const extra = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.log(`  - ${name} [${cfg.transport}]${extra}`);
    }
  }
}

function cmdAddHttpMcp({ home, flags, positional, asJson }) {
  const [name, url] = positional;
  if (!name || !url) {
    throw new Error("usage: ignis-broker add-http-mcp <name> <url> [--auth-env VAR] [--header-name Authorization]");
  }
  const authEnv = typeof flags["auth-env"] === "string" ? flags["auth-env"] : undefined;
  const headerName = typeof flags["header-name"] === "string" ? flags["header-name"] : undefined;
  const merged = addHttpServer(home, { name, url, authEnv, headerName });
  if (asJson) {
    console.log(JSON.stringify({ name, server: merged.servers[name] }, null, 2));
  } else {
    console.log(`Added HTTP server ${name} (${url}) to ${merged.dest}`);
  }
}

function cmdUnregisterMcp({ home, positional, asJson }) {
  const [name] = positional;
  if (!name) throw new Error("usage: ignis-broker unregister-mcp <name>");
  const removed = removeServer(home, name);
  if (asJson) {
    console.log(JSON.stringify({ name, removed }, null, 2));
  } else {
    console.log(removed ? `Removed server ${name}.` : `Server ${name} not found.`);
  }
}

function readOnboardingInput(flags) {
  const given = [typeof flags.save === "string", typeof flags["save-file"] === "string", flags.stdin === true];
  if (given.filter(Boolean).length > 1) {
    throw new Error("onboarding takes only one of --save, --save-file and --stdin");
  }
  if (typeof flags.save === "string") return flags.save;
  if (typeof flags["save-file"] === "string") {
    try {
      return fs.readFileSync(flags["save-file"], "utf8");
    } catch (err) {
      throw new Error(`cannot read ${flags["save-file"]}: ${err.code ?? "read error"}`);
    }
  }
  if (flags.stdin === true) return fs.readFileSync(0, "utf8");
  return null;
}

function cmdOnboarding({ home, dataDir, flags, cwd }) {
  if (flags.get) {
    console.log(JSON.stringify(loadOnboardingState(dataDir), null, 2));
    return;
  }
  if (flags.probe) {
    const fromPath = typeof flags.from === "string" ? flags.from : undefined;
    const codexHome = typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined;
    console.log(JSON.stringify(probeEnvironment(home, dataDir, fromPath, codexHome, cwd), null, 2));
    return;
  }
  const raw = readOnboardingInput(flags);
  if (raw !== null) {
    console.log(JSON.stringify(saveOnboardingInput(dataDir, parseOnboardingInput(raw)), null, 2));
    return;
  }
  if (flags.skip) {
    console.log(JSON.stringify(skipOnboarding(dataDir), null, 2));
    return;
  }
  if (flags.reset) {
    console.log(JSON.stringify(resetOnboarding(dataDir), null, 2));
    return;
  }
  throw new Error("usage: ignis-broker onboarding (--get | --probe [--cwd <dir>] | --save '<json>' | --save-file <path> | --stdin | --skip | --reset)");
}

const COMMANDS = {
  trust: cmdTrust,
  daemon: cmdDaemon,
  "mcp-bridge": cmdMcpBridge,
  stop: cmdStop,
  list: cmdList,
  describe: cmdDescribe,
  call: cmdCall,
  status: cmdStatus,
  restart: cmdRestart,
  "import-mcp": cmdImportMcp,
  "discover-mcp": cmdDiscoverMcp,
  "register-mcp": cmdRegisterMcp,
  "add-http-mcp": cmdAddHttpMcp,
  "unregister-mcp": cmdUnregisterMcp,
  onboarding: cmdOnboarding,
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(`ignis-broker ${BROKER_VERSION}`);
    return;
  }

  const [cmd, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  const home = brokerHome();
  const dataDir = brokerDataDir(home);
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const asJson = Boolean(flags.json);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        `ignis-broker ${BROKER_VERSION} — resilient local MCP broker daemon`,
        "Commands: trust [--cwd <dir>] [--revoke [--file <path>] | --list] [--json] | list | describe | call | status | restart | stop | daemon | mcp-bridge | import-mcp | discover-mcp | register-mcp | add-http-mcp | unregister-mcp | onboarding",
      ].join("\n")
    );
    return;
  }

  const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!handler) throw new Error(`unknown command: ${cmd}`);
  await handler({ home, dataDir, flags, positional, cwd, asJson });
}

main().catch((err) => {
  console.error(`error: ${err.message || String(err)}`);
  process.exit(1);
});
