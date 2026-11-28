import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule, isPlainObject, renameWithRetry, writePrivateFileAtomic } from "../scripts/lib/common.mjs";
import { mkTemp, removeTree, runNode } from "./helpers.mjs";

const COMMON_URL = pathToFileURL(path.resolve(import.meta.dirname, "..", "scripts", "lib", "common.mjs")).href;

test("isPlainObject accepts only non-null, non-array objects", () => {
  for (const value of [{}, { a: 1 }, Object.create(null)]) assert.equal(isPlainObject(value), true);
  for (const value of [null, undefined, [], "x", 1, true, () => {}]) assert.equal(isPlainObject(value), false, String(value));
});

test("isMainModule is true only in the script node was started with", (t) => {
  const dir = mkTemp("ignis-common-main-");
  t.after(() => removeTree(dir));
  const main = path.join(dir, "main.mjs");
  const imported = path.join(dir, "imported.mjs");
  fs.writeFileSync(imported, `import { isMainModule } from ${JSON.stringify(COMMON_URL)};\nexport const importedIsMain = isMainModule(import.meta.url);\n`);
  fs.writeFileSync(
    main,
    `import { isMainModule } from ${JSON.stringify(COMMON_URL)};\nimport { importedIsMain } from "./imported.mjs";\nconsole.log(JSON.stringify({ main: isMainModule(import.meta.url), imported: importedIsMain }));\n`
  );

  const res = runNode(main, [], { timeoutMs: 20_000 });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { main: true, imported: false });
});

test("writePrivateFileAtomic writes the text, creates the folder and leaves no temp file", (t) => {
  const dir = mkTemp("ignis-common-write-");
  t.after(() => removeTree(dir));
  const file = path.join(dir, "nested", "state.json");

  writePrivateFileAtomic(file, "first\n");
  writePrivateFileAtomic(file, "second\n");

  assert.equal(fs.readFileSync(file, "utf8"), "second\n");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
});

test("writePrivateFileAtomic keeps the old file and removes its temp file when the rename fails", (t) => {
  const dir = mkTemp("ignis-common-fail-");
  t.after(() => removeTree(dir));
  const target = path.join(dir, "target");
  fs.mkdirSync(path.join(target, "occupied"), { recursive: true });

  assert.throws(() => writePrivateFileAtomic(target, "text\n"));

  assert.equal(fs.statSync(target).isDirectory(), true, "the existing target is untouched");
  assert.deepEqual(fs.readdirSync(dir), ["target"], "no temp file is left behind");
});

test("renameWithRetry moves a file and rethrows a non-retryable error at once", (t) => {
  const dir = mkTemp("ignis-common-rename-");
  t.after(() => removeTree(dir));
  const from = path.join(dir, "from");
  const to = path.join(dir, "to");
  fs.writeFileSync(from, "x");

  renameWithRetry(from, to);

  assert.equal(fs.readFileSync(to, "utf8"), "x");
  assert.throws(() => renameWithRetry(path.join(dir, "missing"), to), { code: "ENOENT" });
});
