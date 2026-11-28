import fs from "node:fs";

export function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function resolveWorkspace(payload) {
  if (payload?.cwd && fs.existsSync(payload.cwd)) return payload.cwd;
  if (Array.isArray(payload?.workspacePaths) && payload.workspacePaths.length > 0) {
    return payload.workspacePaths[0];
  }
  return "";
}

export function isSubagentPayload(payload) {
  return (
    payload?.isSubagent === true ||
    payload?.subagent === true ||
    Boolean(payload?.parentConversationId)
  );
}

export function isInteractiveUserSession(payload) {
  if (isSubagentPayload(payload)) return false;
  if (typeof payload?.lastUserInput === "string" && payload.lastUserInput.trim().length > 0) {
    return true;
  }
  if (typeof payload?.transcriptPath === "string" && payload.transcriptPath.trim()) {
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

export function sanitizeConversationId(id) {
  const raw = String(id || "").trim() || "unknown";
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}
