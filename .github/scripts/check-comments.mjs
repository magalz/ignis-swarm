import fs from "node:fs";
import path from "node:path";

const USAGE = "usage: node check-comments.mjs <dir|file>...";
const EXTENSIONS = new Set([".mjs", ".js", ".cjs"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "void", "in", "of", "delete", "throw", "new"]);
const WORD_CHAR = /[\w$#]|[^\u0000-\u007f\s]/;

function findComments(src) {
  const found = [];
  const templateDepth = [];
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let lineStart = i;
  let regexAllowed = true;
  let afterDot = false;

  const newline = (at) => {
    line += 1;
    lineStart = at + 1;
  };

  const report = (kind) => {
    found.push({ line, col: i - lineStart + 1, kind });
  };

  const skipEscape = () => {
    if (src[i + 1] === "\r" && src[i + 2] === "\n") {
      newline(i + 2);
      i += 3;
    } else {
      if (src[i + 1] === "\n") newline(i + 1);
      i += 2;
    }
  };

  const skipQuoted = (quote) => {
    i += 1;
    while (i < n && src[i] !== quote && src[i] !== "\n") {
      if (src[i] === "\\") skipEscape();
      else i += 1;
    }
    if (src[i] === quote) i += 1;
  };

  const skipTemplate = () => {
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        skipEscape();
      } else if (c === "`") {
        i += 1;
        return false;
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        templateDepth.push(0);
        return true;
      } else {
        if (c === "\n") newline(i);
        i += 1;
      }
    }
    return false;
  };

  const skipRegex = () => {
    let inClass = false;
    i += 1;
    while (i < n && src[i] !== "\n") {
      const c = src[i];
      if (c === "\\") {
        skipEscape();
        continue;
      }
      i += 1;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
    }
  };

  if (src.startsWith("#!", i)) {
    while (i < n && src[i] !== "\n") i += 1;
  }

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "\n") {
      newline(i);
      i += 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else if (c === "/" && next === "/") {
      report("line comment");
      while (i < n && src[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      report("block comment");
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k += 1) {
        if (src[k] === "\n") newline(k);
      }
      i = stop;
    } else if (c === "'" || c === '"') {
      skipQuoted(c);
      regexAllowed = false;
    } else if (c === "`") {
      i += 1;
      regexAllowed = skipTemplate();
    } else if (c === "/") {
      if (regexAllowed || /^[ \t]*$/.test(src.slice(lineStart, i))) {
        skipRegex();
        regexAllowed = false;
      } else {
        i += 1;
        regexAllowed = true;
      }
    } else if (c === "{") {
      if (templateDepth.length > 0) templateDepth[templateDepth.length - 1] += 1;
      regexAllowed = true;
      i += 1;
    } else if (c === "}") {
      const top = templateDepth.length - 1;
      i += 1;
      if (top >= 0 && templateDepth[top] === 0) {
        templateDepth.pop();
        regexAllowed = skipTemplate();
      } else {
        if (top >= 0) templateDepth[top] -= 1;
        regexAllowed = true;
      }
    } else if (WORD_CHAR.test(c)) {
      let end = i + 1;
      while (end < n && WORD_CHAR.test(src[end])) end += 1;
      regexAllowed = !afterDot && REGEX_KEYWORDS.has(src.slice(i, end));
      afterDot = false;
      i = end;
    } else {
      regexAllowed = c !== ")" && c !== "]" && !((c === "+" || c === "-") && src[i - 1] === c);
      afterDot = c === "." && src[i - 1] !== ".";
      i += 1;
    }
  }
  return found;
}

function listFiles(dir, files) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(child, files);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(child);
  }
}

function main(args) {
  if (args.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const files = [];
  for (const arg of args) {
    if (fs.statSync(arg).isDirectory()) listFiles(arg, files);
    else files.push(arg);
  }
  const report = [];
  for (const file of files) {
    const shown = file.split(path.sep).join("/");
    for (const { line, col, kind } of findComments(fs.readFileSync(file, "utf8"))) {
      report.push(`${shown}:${line}:${col}: ${kind}`);
    }
  }
  if (report.length > 0) process.stdout.write(`${report.join("\n")}\n`);
  return report.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (typeof err.code !== "string") throw err;
  process.stderr.write(`check-comments: ${err.message}\n`);
  process.exitCode = 2;
}
