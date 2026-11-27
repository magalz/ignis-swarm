import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolvePlatformCommand } from "../scripts/broker/adapters.mjs";
import { brokerDataDir, brokerHome, resolveConfig } from "../scripts/broker/config.mjs";
import { readDaemonInfo } from "../scripts/broker/lifecycle.mjs";
import { loadOnboardingState, probeEnvironment } from "../scripts/broker/onboarding.mjs";
import { isInteractiveUserSession, readStdin, resolveWorkspace } from "./lib.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isProjectWorkspace(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "docs"];
  return markers.some((m) => fs.existsSync(path.join(dir, m)));
}

function findDecisionIndexHint(cwd) {
  const found = [];
  if (fs.existsSync(path.join(cwd, "docs", "adr", "INDEX.md"))) found.push("docs/adr/INDEX.md");
  if (fs.existsSync(path.join(cwd, "docs", "bdr", "INDEX.md"))) found.push("docs/bdr/INDEX.md");
  if (found.length === 0) return null;
  return `[ignis-swarm] Decision indexes detected (${found.join(", ")}). Check relevant ADRs/BDRs before planning or modifying architecture.`;
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

function buildReviewRoutingNotice(routing) {
  const strategy = routing?.strategy;
  if (strategy !== "headless_always" && strategy !== "antigravity_first") return null;
  const backend = routing.headlessBackend || "unconfigured";
  const model =
    routing.headlessModel ||
    (backend === "claude" ? "opus" : backend === "unconfigured" ? "none" : "config-default");
  const effort = routing.effort || "high";
  const runnerPath = path.resolve(PLUGIN_ROOT, "scripts", "run-blind-review.mjs");
  if (strategy === "headless_always") {
    return (
      `[ignis-swarm][Phase 4 Review Routing] strategy=headless_always (backend=${backend}, model=${model}, effort=${effort}). ` +
      `Mandatory: run \`node "${runnerPath}" --base <base-sha> --backend auto\` BEFORE native \`blind-edge-hunter\` (native fallback allowed only if \`fallbackToNative: true\`).`
    );
  }
  return (
    `[ignis-swarm][Phase 4 Review Routing] strategy=antigravity_first (native Gemini Pro \`blind-edge-hunter\` first; headless fallback=${backend}/${model}, effort=${effort}). ` +
    `If native quota runs out, run \`node "${runnerPath}" --base <base-sha> --backend auto --fallback\`.`
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
  } else {
    if (onboarding.memtrace?.enabled === true) {
      messages.push(checkMemtraceStatus(cwd));
    }
    if (isInteractiveUserSession(payload)) {
      const notice = buildReviewRoutingNotice(onboarding.reviewRouting);
      if (notice) messages.push(notice);
    }
  }

  const indexHint = findDecisionIndexHint(cwd);
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
