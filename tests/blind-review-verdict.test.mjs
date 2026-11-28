import assert from "node:assert/strict";
import test from "node:test";
import { noVerdictReason, parseVerdict } from "../scripts/run-blind-review.mjs";

const NO_VERDICT_EMPTY = "headless reviewer returned no verdict (empty output)";
const NO_VERDICT_PREFIX = "headless reviewer returned no verdict (no Status line): ";

function table(name, rows) {
  for (const [text, expected] of rows) {
    test(`${name}: ${JSON.stringify(text)}`, () => {
      assert.equal(parseVerdict(text), expected);
    });
  }
}

table("the house-style Status line is accepted in every markdown decoration", [
  ["Status: PASS\n", "PASS"],
  ["**Status:** PASS\n", "PASS"],
  ["**Status**: PASS\n", "PASS"],
  ["**Status: PASS**\n", "PASS"],
  ["**Status:** `PASS`\n", "PASS"],
  ["- **Status:** `ISSUES`\n", "ISSUES"],
  ["_Status: Issues_\n", "ISSUES"],
  ["`Status: PASS`\n", "PASS"],
  ["> Status: PASS\n", "PASS"],
  [">Status: ISSUES\n", "ISSUES"],
  ["- Status: ISSUES\n", "ISSUES"],
  ["> **Status:** PASS\n", "PASS"],
  ["Findings follow.\r\n\r\n**Status:** PASS\r\n", "PASS"],
  ["**Status:** ISSUES", "ISSUES"],
]);

table("the verdict is case-insensitive and normalised to upper case", [
  ["Found a race condition in app.js.\n\n**Status: issues**\n", "ISSUES"],
  ["  `Status: pass`\n", "PASS"],
  ["*Status : Issues*", "ISSUES"],
  ["STATUS: PASS", "PASS"],
]);

table("PASS must be a whole word", [
  ["Status: PASSED\n", null],
  ["**Status:** PASSED\n", null],
  ["Status: ISSUESFOUND\n", null],
]);

table("a verdict never crosses a newline", [
  ["Status:\nPASS\n", null],
  ["Status:\n\nISSUES\n", null],
  ["**Status:**\n  PASS\n", null],
  ["Status\n: PASS\n", null],
]);

table("output with no Status line has no verdict", [
  ["", null],
  ["  \n\t\n", null],
  ["app.js line 1 looks fine to me.\n", null],
  ["Overall Status: PASS\n", null],
  ["Status: unknown\n", null],
  ["The reviewer wrote Status: ISSUES in the middle of a sentence.\n", null],
]);

table("a documentation template line naming both verdicts is not a verdict", [
  ["Status: PASS | ISSUES\n", null],
  ["**Status:** PASS | ISSUES\n", null],
  ["Status: PASS / ISSUES\n", null],
  ["- Status: ISSUES / PASS\n", null],
  ["End with Status: PASS | ISSUES\nStatus: ISSUES\n", "ISSUES"],
  ["Status: PASS\nTemplate: Status: PASS | ISSUES\n", "PASS"],
]);

table("the last Status line wins", [
  ["**Status:** PASS\n\nWait, a bug.\n\n> _Status: Issues_\n", "ISSUES"],
  ["- Status: ISSUES\nRetracted.\n**Status: PASS**\n", "PASS"],
  ["Status: PASS\nOn reflection, one bug.\nStatus: ISSUES\n", "ISSUES"],
  ["Status: ISSUES\nRetracted.\nStatus: PASS\n", "PASS"],
]);

for (const text of ["", "  \n\t\n"]) {
  test(`an empty or whitespace-only output gives the empty-output reason: ${JSON.stringify(text)}`, () => {
    assert.equal(noVerdictReason(text), NO_VERDICT_EMPTY);
  });
}

const DETAIL_CASES = [
  ["app.js line 1 looks fine to me.\n", "app.js line 1 looks fine to me."],
  ["Overall Status: PASS\n", "Overall Status: PASS"],
  ["Status: unknown\n", "Status: unknown"],
  ["Status: PASSED\n", "Status: PASSED"],
  ["**Status:** PASSED\n", "**Status:** PASSED"],
  ["Status: ISSUESFOUND\n", "Status: ISSUESFOUND"],
  ["The reviewer rambled.\r\n\r\n\tIt never\n   gave a verdict.\n", "The reviewer rambled. It never gave a verdict."],
];

for (const [text, detail] of DETAIL_CASES) {
  test(`the reason carries the output as the detail, one line, trimmed: ${JSON.stringify(text)}`, () => {
    assert.equal(noVerdictReason(text), `${NO_VERDICT_PREFIX}${detail}`);
  });
}

const LONG_OUTPUT = `${"a".repeat(150)}\n${"b".repeat(300)}\n`;

test("the reason carries the first 200 characters of the output", () => {
  assert.equal(noVerdictReason(LONG_OUTPUT), `${NO_VERDICT_PREFIX}${"a".repeat(150)} ${"b".repeat(49)}`);
});

test("the reason for a long output stays on a single line", () => {
  assert.doesNotMatch(noVerdictReason(LONG_OUTPUT), /[\r\n]/);
});
