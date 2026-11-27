import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(PLUGIN_ROOT, ".github", "scripts", "check-comments.mjs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "check-comments-"));

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;

function fixtureDir(files) {
  const dir = path.join(ROOT, `case-${counter++}`);
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
}

function runFixture(files, args = Object.keys(files)) {
  return run(args, fixtureDir(files));
}

function assertClean(res) {
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
}

function assertFindings(res, expected) {
  assert.equal(res.error, undefined);
  assert.equal(res.stderr, "");
  assert.equal(res.stdout, expected.map((line) => `${line}\n`).join(""));
  assert.equal(res.status, 1);
}

const lines = (...parts) => `${parts.join("\n")}\n`;

const CLEAN = {
  "url inside a double-quoted string": lines(
    'const u = "see // here";',
    'const v = "http://example.com/a//b";',
  ),
  "comment markers inside single-quoted strings": lines("const a = '//';", "const b = '/* x */';"),
  "escaped quotes do not end a string": lines(
    String.raw`const s = "a \" // still string";`,
    String.raw`const t = 'it\'s // fine';`,
  ),
  "backslash line continuation inside a string": 'const s = "a \\\n// still string";\n',
  "double slash inside a template literal": lines("const t = `see // here /* x */`;"),
  "double slash inside a template expression string": lines("const t = `a ${'//'} b`;"),
  "nested templates and braces inside an expression": lines(
    "const t = `a ${ { k: `x // ${'//'}` }.k } // b`;",
  ),
  "regex with escaped slashes": lines(String.raw`const r = /https?:\/\//;`),
  "regex used as a call argument": lines(String.raw`const x = s.replace(/\/\/.*$/, "");`),
  "regex after an arrow": lines(String.raw`const f = (s) => /\//.test(s);`),
  "regex after return": lines(String.raw`function f(s) { return /\//.test(s); }`),
  "regex after typeof": lines(String.raw`const k = typeof /\//;`),
  "regex containing character classes with slashes": lines(
    String.raw`const r = /[/]\/[//]/;`,
    "const q = /[///]/;",
  ),
  "escaped backtick and escaped expression opener inside a template": lines(
    "const t = `a \\` // b \\${ // c`;",
  ),
  "regex containing a block comment opener": lines(String.raw`const r = /\/\*|\*\//;`),
  "regex on a line of its own inside an array": lines(
    "const rs = [",
    String.raw`  /\/\//,`,
    String.raw`  /https?:\/\//i,`,
    "];",
  ),
  "regex at the start of a line after a closing paren": lines(
    "if (ok)",
    String.raw`  /\//.test(s);`,
  ),
  "division chains": lines(
    "const q = a / b / c;",
    "const r = (a + b) / c / d;",
    "const s = x[0] / y / z;",
    "const t = n++ / 2 / 3;",
    "const u = 4 / 2 / 1;",
    "const w = myreturn / 2 / 3;",
  ),
  "shebang line": lines("#!/usr/bin//env node", "const a = 1;"),
  "shebang line after a byte order mark": `\uFEFF${lines("#!/usr/bin//env node", "const a = 1;")}`,
  "crlf line endings with a template and a string continuation": [
    'const a = "//";',
    "const b = `x",
    "// y`;",
    'const s = "p \\',
    '// q";',
    "const c = 1;",
    "",
  ].join("\r\n"),
  "empty file": "",
};

const REGEX_KEYWORDS = ["return", "typeof", "case", "void", "in", "of", "delete", "throw", "new"];
const REGEX_PRECEDERS = [
  ...["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"],
  ...[">", "+", "-", "*", "%", "^", "~", "<"],
];

for (const keyword of REGEX_KEYWORDS) {
  CLEAN[`regex after the keyword ${keyword}`] = lines(String.raw`${keyword} /\//.test(s);`);
}

for (const preceder of REGEX_PRECEDERS) {
  CLEAN[`regex after ${preceder}`] = lines(String.raw`x ${preceder} /\//.test(s);`);
}

for (const [name, source] of Object.entries(CLEAN)) {
  test(`passes: ${name}`, () => {
    assertClean(runFixture({ "case.mjs": source }));
  });
}

const FLAGGED = {
  "semicolon directly followed by a line comment": ["a=1;//c\n", ["case.mjs:1:5: line comment"]],
  "line comment on its own line": ["// hi\nconst a = 1;\n", ["case.mjs:1:1: line comment"]],
  "trailing line comment": ["const a = 1; // trailing\n", ["case.mjs:1:14: line comment"]],
  "block comment": ["const a = 1; /* x */\n", ["case.mjs:1:14: block comment"]],
  "line numbers continue after a multi-line block comment": [
    "/* a\nb */\nconst z = 1; // after\n",
    ["case.mjs:1:1: block comment", "case.mjs:3:14: line comment"],
  ],
  "comment after a template with an expression": [
    "const t = `${x}`; // c\n",
    ["case.mjs:1:19: line comment"],
  ],
  "comment after a regex": [String.raw`const r = /a\/b/g; // c` + "\n", ["case.mjs:1:20: line comment"]],
  "comment after a string that contains slashes": [
    'const u = "//"; // c\n',
    ["case.mjs:1:17: line comment"],
  ],
  "block comment inside a template expression": [
    "const t = `a ${x /* c */} b`;\n",
    ["case.mjs:1:18: block comment"],
  ],
  "comment after a division": ["const q = a / b; // c\n", ["case.mjs:1:18: line comment"]],
  "comment after a shebang line": [
    "#!/usr/bin//env node\n// c\n",
    ["case.mjs:2:1: line comment"],
  ],
  "crlf line endings": [
    "const a = 1;\r\nconst b = 2; // c\r\n",
    ["case.mjs:2:14: line comment"],
  ],
  "byte order mark is not counted in the column": [
    "\uFEFFconst a = 1; // c\n",
    ["case.mjs:1:14: line comment"],
  ],
  "unterminated string does not swallow later lines": [
    "const a = 'oops;\nconst b = 1; // c\n",
    ["case.mjs:2:14: line comment"],
  ],
  "unterminated regex does not swallow later lines": [
    "const r = /oops\nconst b = 1; // c\n",
    ["case.mjs:2:14: line comment"],
  ],
  "comment after a regex with a character class": [
    "const r = /[/]/; // c\n",
    ["case.mjs:1:18: line comment"],
  ],
  "line numbers continue after a multi-line template": [
    "const t = `a\nb`; // c\n",
    ["case.mjs:2:5: line comment"],
  ],
  "line numbers continue after a string continuation": [
    'const s = "a \\\nb"; // c\n',
    ["case.mjs:2:5: line comment"],
  ],
  "line numbers continue after a string continuation with crlf": [
    'const s = "a \\\r\nb"; // c\r\n',
    ["case.mjs:2:5: line comment"],
  ],
  "unterminated block comment swallows the rest of the file": [
    "/* open\n// inner\n",
    ["case.mjs:1:1: block comment"],
  ],
};

FLAGGED["comment inside a template expression after an object literal"] = [
  "const t = `${ { a: 1 }.a // real\n}`;\n",
  ["case.mjs:1:26: line comment"],
];

const DIVIDENDS = [
  ...["a", "(a)", "x[0]", "n++", "n--", "4", '"s"', "'s'", "`t`", "a.b", "myreturn", "ofx"],
  ...["$", "_", `${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}`],
];

for (const dividend of DIVIDENDS) {
  const source = `const q = ${dividend} / 2; // c\n`;
  FLAGGED[`comment after dividing ${dividend}`] = [
    source,
    [`case.mjs:1:${source.indexOf("//") + 1}: line comment`],
  ];
}

for (const [name, [source, expected]] of Object.entries(FLAGGED)) {
  test(`fails: ${name}`, () => {
    assertFindings(runFixture({ "case.mjs": source }), expected);
  });
}

test("walks directories recursively, skips node_modules and other extensions", () => {
  const dir = fixtureDir({
    "a.mjs": "const a = 1;\n",
    "b/c.js": "// c\n",
    "b/d.cjs": "const d = 1; /* d */\n",
    "b/node_modules/x.js": "// skipped\n",
    "b/notes.txt": "// skipped\n",
  });
  assertFindings(run(["b", "a.mjs"], dir), [
    "b/c.js:1:1: line comment",
    "b/d.cjs:1:14: block comment",
  ]);
  assertFindings(run(["."], dir), ["b/c.js:1:1: line comment", "b/d.cjs:1:14: block comment"]);
});

test("a file named on the command line is scanned whatever its extension", () => {
  const dir = fixtureDir({ "notes.txt": "x // y\n" });
  assertFindings(run(["notes.txt"], dir), ["notes.txt:1:3: line comment"]);
});

test("exits 2 with a usage message when no path is given", () => {
  const res = run([], PLUGIN_ROOT);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /usage/i);
});

test("exits 2 when a path does not exist", () => {
  const res = runFixture({ "ok.mjs": "const a = 1;\n" }, ["ok.mjs", "missing.mjs"]);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /missing\.mjs/);
});

test("a missing path stops the run before any file is scanned", () => {
  const res = runFixture({ "bad.mjs": "// c\n" }, ["bad.mjs", "missing.mjs"]);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, "");
});

test("the real hooks and scripts directories have no comments", () => {
  const res = run([path.join(PLUGIN_ROOT, "hooks"), path.join(PLUGIN_ROOT, "scripts")], PLUGIN_ROOT);
  assertClean(res);
});

test("the checker passes its own check", () => {
  assertClean(run([SCRIPT], PLUGIN_ROOT));
});
