#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postToDaemon, runMcpBridge } from "./broker/bridge.mjs";
import {
  BROKER_VERSION,
  addHttpServer,
  brokerDataDir,
  brokerHome,
  discoverMcpConfig,
  importMcpConfig,
  mergeServersConfig,
  removeServer,
} from "./broker/config.mjs";
import { ensureDaemon, stopDaemon } from "./broker/lifecycle.mjs";
import {
  loadOnboardingState,
  probeEnvironment,
  resetOnboarding,
  saveOnboardingState,
  skipOnboarding,
} from "./broker/onboarding.mjs";
import { runDaemon } from "./broker/server.mjs";

const ENTRY_SCRIPT = fileURLToPath(import.meta.url);
const BOOLEAN_FLAGS = new Set([
  "json",
  "full",
  "stdin",
  "dry-run",
  "all",
  "get",
  "probe",
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
        "Commands: list | describe | call | status | restart | stop | daemon | mcp-bridge | import-mcp | discover-mcp | register-mcp | add-http-mcp | unregister-mcp | onboarding",
      ].join("\n")
    );
    return;
  }

  if (cmd === "daemon") {
    const port = typeof flags.port === "string" ? Number(flags.port) : 0;
    await runDaemon(home, dataDir, Number.isFinite(port) ? port : 0);
    return;
  }

  if (cmd === "mcp-bridge") {
    await runMcpBridge(home, dataDir, ENTRY_SCRIPT, cwd);
    return;
  }

  if (cmd === "stop") {
    const stopped = await stopDaemon(dataDir);
    console.log(stopped ? "ignis-broker daemon stopped." : "ignis-broker daemon was not running.");
    return;
  }

  if (cmd === "list") {
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
    return;
  }

  if (cmd === "describe") {
    const [server, tool] = positional;
    if (!server || !tool) throw new Error("usage: ignis-broker describe <server> <tool>");
    const res = await postDaemon(home, dataDir, "/v1/describe", { server, tool, cwd });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`${res.schema.name} — ${res.schema.description}`);
      console.log(JSON.stringify(res.schema.inputSchema, null, 2));
    }
    return;
  }

  if (cmd === "call") {
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
    return;
  }

  if (cmd === "status") {
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
    return;
  }

  if (cmd === "restart") {
    const res = await postDaemon(home, dataDir, "/v1/restart", {
      server: positional[0],
      cwd: flags.cwd ? cwd : undefined,
    });
    console.log(asJson ? JSON.stringify(res, null, 2) : `evicted ${res.evicted} pooled backend(s).`);
    return;
  }

  if (cmd === "import-mcp") {
    const sourcePath =
      typeof flags.from === "string"
        ? flags.from
        : path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
    const only =
      typeof flags.servers === "string"
        ? flags.servers.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    const imported = importMcpConfig(sourcePath, only);
    const rendered = JSON.stringify(imported, null, 2);

    if (flags["dry-run"]) {
      console.log(rendered);
      return;
    }

    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const dest = path.join(home, "servers.json");
    fs.writeFileSync(dest, rendered, { encoding: "utf8", mode: 0o600 });
    const entries = Object.entries(imported.servers);
    console.log(`Imported ${entries.length} server(s) into ${dest}:`);
    for (const [name, cfg] of entries) {
      const tags = [];
      if (cfg.perWorkspace) tags.push("perWorkspace");
      if (!cfg.enabled) tags.push("disabled");
      const extra = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.log(`  - ${name} [${cfg.transport}]${extra}`);
    }
    console.log(`Your original ${sourcePath} was NOT modified.`);
    return;
  }

  if (cmd === "discover-mcp") {
    const sourcePath =
      typeof flags.from === "string"
        ? flags.from
        : path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
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
    return;
  }

  if (cmd === "register-mcp") {
    const sourcePath =
      typeof flags.from === "string"
        ? flags.from
        : path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
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
    const merged = mergeServersConfig(home, imported.servers, {
      perWorkspaceSet,
      cliFallbackMap,
    });
    const entries = Object.entries(merged.servers);
    if (asJson) {
      console.log(JSON.stringify({ dest: merged.dest, servers: Object.keys(merged.servers) }, null, 2));
    } else {
      console.log(`Registered ${entries.length} server(s) in ${merged.dest}:`);
      for (const [name, cfg] of entries) {
        const tags = [];
        if (cfg.perWorkspace) tags.push("perWorkspace");
        if (cfg.cliFallback) tags.push(`cliFallback=${cfg.cliFallback}`);
        if (cfg.enabled === false) tags.push("disabled");
        const extra = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        console.log(`  - ${name} [${cfg.transport}]${extra}`);
      }
    }
    return;
  }

  if (cmd === "add-http-mcp") {
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
    return;
  }

  if (cmd === "unregister-mcp") {
    const [name] = positional;
    if (!name) throw new Error("usage: ignis-broker unregister-mcp <name>");
    const removed = removeServer(home, name);
    if (asJson) {
      console.log(JSON.stringify({ name, removed }, null, 2));
    } else {
      console.log(removed ? `Removed server ${name}.` : `Server ${name} not found.`);
    }
    return;
  }

  if (cmd === "onboarding") {
    if (flags.get) {
      console.log(JSON.stringify(loadOnboardingState(dataDir), null, 2));
      return;
    }
    if (flags.probe) {
      const fromPath = typeof flags.from === "string" ? flags.from : undefined;
      const codexHome = typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined;
      console.log(JSON.stringify(probeEnvironment(home, dataDir, fromPath, codexHome), null, 2));
      return;
    }
    if (typeof flags.save === "string") {
      const patch = JSON.parse(flags.save);
      console.log(JSON.stringify(saveOnboardingState(dataDir, patch), null, 2));
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
    throw new Error("usage: ignis-broker onboarding (--get | --probe | --save '<json>' | --skip | --reset)");
  }

  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(`error: ${err.message || String(err)}`);
  process.exit(1);
});
