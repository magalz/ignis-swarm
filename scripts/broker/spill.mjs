import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sliceUtf8Bytes(str, maxBytes) {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(str.slice(0, mid), "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let cut = str.slice(0, lo);
  if (cut.length > 0) {
    const lastCode = cut.charCodeAt(cut.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      cut = cut.slice(0, -1);
    }
  }
  return cut;
}

function writeSpillFile(spillDir, text) {
  try {
    fs.mkdirSync(spillDir, { recursive: true });
    const ts = Math.floor(Date.now() / 1000);
    const shortId = crypto.randomBytes(4).toString("hex");
    const filePath = path.join(spillDir, `${ts}-${shortId}.txt`);
    fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

export function truncateContentBlocks(blocks, maxBytes, maxLines, spillDir, full = false) {
  if (full || !maxBytes || !maxLines || !Array.isArray(blocks)) {
    return { content: blocks, truncated: false, spillPath: null };
  }

  const textParts = [];
  const textIndices = new Set();
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b && b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
      textIndices.add(i);
    }
  }

  const totalText = textParts.join("\n");
  const totalBytes = Buffer.byteLength(totalText, "utf8");
  const lines = totalText ? totalText.split(/\r?\n/) : [];
  const totalLines = lines.length;

  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { content: blocks, truncated: false, spillPath: null };
  }

  const spillPath = writeSpillFile(spillDir, totalText);
  let head = "";
  let headBytes = 0;
  let shownLines = 0;

  for (const line of lines) {
    if (shownLines >= maxLines) break;
    const prefix = head ? "\n" : "";
    const chunkBytes = Buffer.byteLength(prefix + line, "utf8");
    if (headBytes + chunkBytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - headBytes - (prefix ? 1 : 0));
      if (remaining > 0) {
        head += prefix + sliceUtf8Bytes(line, remaining);
        headBytes = Buffer.byteLength(head, "utf8");
        shownLines += 1;
      }
      break;
    }
    head += prefix + line;
    headBytes += chunkBytes;
    shownLines += 1;
  }

  const footer = spillPath
    ? `\n\n[ignis-broker truncated: ${shownLines}/${totalLines} lines (${headBytes}/${totalBytes} bytes). Full output saved to: ${spillPath}]`
    : `\n\n[ignis-broker truncated: ${shownLines}/${totalLines} lines (${headBytes}/${totalBytes} bytes).]`;

  const out = [];
  let inserted = false;
  for (let i = 0; i < blocks.length; i += 1) {
    if (textIndices.has(i)) {
      if (!inserted) {
        out.push({ type: "text", text: head + footer });
        inserted = true;
      }
    } else {
      out.push(blocks[i]);
    }
  }

  return { content: out, truncated: true, spillPath };
}

export function cleanupExpiredSpills(spillDir, ttlHours) {
  if (!fs.existsSync(spillDir)) return 0;
  const maxAgeMs = Math.max(0, ttlHours) * 3600 * 1000;
  const now = Date.now();
  let removed = 0;

  for (const entry of fs.readdirSync(spillDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(spillDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (maxAgeMs === 0 || now - stat.mtimeMs >= maxAgeMs) {
        fs.rmSync(fullPath, { force: true });
        removed += 1;
      }
    } catch {}
  }
  return removed;
}
