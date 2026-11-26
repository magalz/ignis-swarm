import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlatformCommand } from "../scripts/broker/adapters.mjs";
import { brokerDataDir, brokerHome, resolveConfig } from "../scripts/broker/config.mjs";
import { readDaemonInfo } from "../scripts/broker/lifecycle.mjs";
import { loadOnboardingState, probeEnvironment } from "../scripts/broker/onboarding.mjs";

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function isProjectWorkspace(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "docs"];
  return markers.some((m) => fs.existsSync(path.join(dir, m)));
}

function resolveWorkspace(payload) {
  if (payload.cwd && fs.existsSync(payload.cwd)) return payload.cwd;
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    return payload.workspacePaths[0];
  }
  return "";
}

function checkDecisionIndexes(cwd) {
  const found = [];
  if (fs.existsSync(path.join(cwd, "docs", "adr", "INDEX.md"))) found.push("docs/adr/INDEX.md");
  if (fs.existsSync(path.join(cwd, "docs", "bdr", "INDEX.md"))) found.push("docs/bdr/INDEX.md");
  if (found.length === 0) return null;
  return `[ignis-swarm] Decision indexes detected (${found.join(", ")}). Check relevant ADRs/BDRs before planning or modifying architecture.`;
}

function isInteractiveUserSession(payload) {
  if (
    payload.isSubagent === true ||
    payload.subagent === true ||
    Boolean(payload.parentConversationId)
  ) {
    return false;
  }
  if (typeof payload.lastUserInput === "string" && payload.lastUserInput.trim().length > 0) {
    return true;
  }
  if (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) {
    try {
      const fd = fs.openSync(payload.transcriptPath, "r");
      try {
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead).toString("utf8");
        if (/"type"\s*:\s*"USER_INPUT"/.test(head)) {
          return true;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {}
  }
  return false;
}

async function checkBrokerWarning(cwd, home, dataDir) {
  const explicitCmd = (process.env.IGNIS_BROKER_CMD || "").trim();
  const hasGlobalConfig = fs.existsSync(path.join(home, "servers.json"));
  const hasLocalConfig = fs.existsSync(path.join(cwd, ".agents", "ignis-broker.json"));

  if (!explicitCmd && !hasGlobalConfig && !hasLocalConfig) {
    return null;
  }

  let data = null;
  if (explicitCmd) {
    let resolved;
    try {
      resolved = resolvePlatformCommand(explicitCmd, ["status", "--cwd", cwd, "--json"], process.env);
    } catch {
      return null;
    }
    const res = spawnSync(resolved.command, resolved.args, {
      cwd,
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      ...resolved.options,
    });
    if (res.error || res.status !== 0 || !res.stdout) {
      return null;
    }
    try {
      data = JSON.parse(res.stdout.trim());
    } catch {
      return null;
    }
  } else {
    try {
      const cfg = resolveConfig(home, cwd);
      if (cfg.localConfigError) {
        return `[ignis-broker Alert] Local config error detected (${cfg.localConfigError}). Global fallback config is active.`;
      }
    } catch {}

    const info = readDaemonInfo(dataDir);
    if (info?.port && info?.token) {
      try {
        const resp = await fetch(`http://127.0.0.1:${info.port}/v1/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${info.token}`,
            Connection: "close",
          },
          body: JSON.stringify({ cwd }),
          signal: AbortSignal.timeout(400),
        });
        if (resp.ok) {
          data = await resp.json();
        }
      } catch {
        return null;
      }
    }
  }

  if (!data) return null;
  if (data.localConfigError) {
    return `[ignis-broker Alert] Local config error detected (${data.localConfigError}). Global fallback config is active.`;
  }
  if (Array.isArray(data.recentFallbacks) && data.recentFallbacks.length > 0) {
    const latest = data.recentFallbacks[data.recentFallbacks.length - 1];
    return `[ignis-broker Notice] Recent fallback on \`${latest.server}\`: ${latest.from} -> ${latest.to} (${latest.reason}).`;
  }
  return null;
}

function buildOnboardingNotice(home, dataDir) {
  const fromMcpPath = (process.env.IGNIS_MCP_CONFIG_PATH || "").trim() || undefined;
  const probe = probeEnvironment(home, dataDir, fromMcpPath);
  const mcpSummary =
    probe.discoveredMcps.length > 0
      ? probe.discoveredMcps.map((m) => `${m.name} (${m.transport})`).join(", ")
      : "none";
  const cliSummary = Object.entries(probe.clis)
    .map(([name, info]) => `${name}=${info.available ? "yes" : "no"}`)
    .join(", ");

  return (
    `[ignis-swarm][First-Run Onboarding Required] Load skill \`ignis-onboarding\` before starting the user's request (or let the user skip). ` +
    `Discovered MCPs (redacted): ${mcpSummary}. Local CLIs: ${cliSummary}. ` +
    `(Main interactive session only — subagents and /swarm workers must ignore this.)`
  );
}

function checkMemtraceStatus(cwd) {
  const cmd = (process.env.IGNIS_MEMTRACE_CMD || "").trim() || "memtrace";
  let resolved;
  try {
    resolved = resolvePlatformCommand(cmd, ["status"], process.env);
  } catch (err) {
    return `[ignis-swarm][Memtrace Alert] memtrace status failed (${err.message}).`;
  }
  const res = spawnSync(resolved.command, resolved.args, {
    cwd,
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    ...resolved.options,
  });

  if (res.error || res.status !== 0) {
    const detail = (res.stderr || res.stdout || res.error?.message || `exit ${res.status}`)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || "unhealthy";
    return `[ignis-swarm][Memtrace Alert] memtrace status failed (${detail}).`;
  }

  const summary =
    (res.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || "healthy";
  return `[ignis-swarm][Memtrace] Active (${summary}).`;
}

async function main() {
  const payload = readStdin();
  const cwd = resolveWorkspace(payload);

  if (!isProjectWorkspace(cwd)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const home = brokerHome();
  const dataDir = brokerDataDir(home);
  const messages = [];

  let onboarding = null;
  try {
    onboarding = loadOnboardingState(dataDir);
  } catch {
    onboarding = null;
  }

  if (!onboarding || onboarding.completed !== true) {
    if (isInteractiveUserSession(payload)) {
      try {
        messages.push(buildOnboardingNotice(home, dataDir));
      } catch {}
    }
  } else if (onboarding.memtrace?.enabled === true) {
    messages.push(checkMemtraceStatus(cwd));
  }

  const indexHint = checkDecisionIndexes(cwd);
  if (indexHint) messages.push(indexHint);

  const brokerNotice = await checkBrokerWarning(cwd, home, dataDir);
  if (brokerNotice) messages.push(brokerNotice);

  if (messages.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      injectSteps: [{ systemMessage: { systemMessage: messages.join("\n") } }],
    })
  );
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
