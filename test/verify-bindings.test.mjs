/**
 * Unit tests for the verify-bindings gate's pure logic. Zero-dep: node:test.
 * Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiffForTokens, skipReason, isScannable } from "../verify-bindings.mjs";

test("scanDiffForTokens: flags an added pages.update call-site", () => {
  const diff = [
    "diff --git a/src/sync.ts b/src/sync.ts",
    "--- a/src/sync.ts",
    "+++ b/src/sync.ts",
    "@@ -1,2 +1,3 @@",
    " const x = 1;",
    "+await notion.pages.update({ page_id, properties: { Status: {} } });",
  ].join("\n");
  const hits = scanDiffForTokens(diff);
  assert.ok(hits.has("pages.update"));
  assert.ok(hits.has("properties:/="));
});

test("scanDiffForTokens: flags a removed call-site too (direction change)", () => {
  const diff = ["@@", "-  const rows = await notion.dataSources.query({ data_source_id });"].join("\n");
  const hits = scanDiffForTokens(diff);
  assert.ok(hits.has("dataSources"));
  assert.ok(hits.has("data_source_id"));
});

test("scanDiffForTokens: ignores the +++/--- file headers", () => {
  const diff = ["--- a/properties.ts", "+++ b/properties.ts", " unchanged line"].join("\n");
  // headers contain 'properties' but must not be scanned; context line has no token
  assert.equal(scanDiffForTokens(diff).size, 0);
});

test("scanDiffForTokens: clean diff yields no hits", () => {
  const diff = ["@@", "+  const label = greet(name);", "-  const label = hi(name);"].join("\n");
  assert.equal(scanDiffForTokens(diff).size, 0);
});

test("scanDiffForTokens: database_id is caught", () => {
  const hits = scanDiffForTokens("+  parent: { database_id: DB }");
  assert.ok(hits.has("database_id"));
});

test("skipReason: title marker opts out", () => {
  assert.match(skipReason("Refactor client [skip-bindings-check]", ""), /title/);
});

test("skipReason: label opts out (newline, comma, or literal \\n separated)", () => {
  assert.match(skipReason("Some PR", "bug\nskip-bindings-check\nchore"), /label/);
  assert.match(skipReason("Some PR", "bug, skip-bindings-check"), /label/);
  // GitHub's join(..., '\n') can emit a literal backslash-n instead of a newline:
  assert.match(skipReason("Some PR", "bug\\nskip-bindings-check\\nchore"), /label/);
});

test("skipReason: nothing to skip returns null", () => {
  assert.equal(skipReason("Normal PR title", "bug, enhancement"), null);
});

test("isScannable: code files yes, manifest/docs/lockfiles no", () => {
  assert.equal(isScannable("src/notion.ts", []), true);
  assert.equal(isScannable("app/api/route.py", []), true);
  assert.equal(isScannable("bindings.json", []), false);
  assert.equal(isScannable("README.md", []), false);
  assert.equal(isScannable("pnpm-lock.yaml", []), false);
});

test("isScannable: the action's own scripts are never scanned (dogfood safety)", () => {
  assert.equal(isScannable("sync-bindings.mjs", []), false);
  assert.equal(isScannable("verify-bindings.mjs", []), false);
});

test("isScannable: verifyIgnore path fragments are honored", () => {
  assert.equal(isScannable("src/legacy/oldSync.ts", ["src/legacy/"]), false);
  assert.equal(isScannable("src/current/sync.ts", ["src/legacy/"]), true);
});
