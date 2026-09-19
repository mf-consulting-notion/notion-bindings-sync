/**
 * Unit tests for the verify-bindings gate's pure logic. Zero-dep: node:test.
 * Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiffForTokens, skipReason, isScannable, findOffenders } from "../verify-bindings.mjs";

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

test("scanDiffForTokens: page-body call-sites are caught (blocks.children)", () => {
  const diff = ["+  const blocks = await notion.blocks.children.list({ block_id: id });"].join("\n");
  assert.deepEqual([...scanDiffForTokens(diff)].sort(), ["block_id", "blocks.children"]);
});

test("scanDiffForTokens: page-to-Markdown rendering is caught", () => {
  assert.ok(scanDiffForTokens("+const n2m = new NotionToMarkdown({ notionClient });").has("notion-to-md"));
  assert.ok(scanDiffForTokens('+import { NotionToMarkdown } from "notion-to-md";').has("notion-to-md"));
});

test("scanDiffForTokens: JSX children do NOT fire the content tokens", () => {
  const diff = ["+  return <Layout>{children}</Layout>;", "+  const { children } = props;"].join("\n");
  assert.equal(scanDiffForTokens(diff).size, 0);
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

// ---- findOffenders: per-directory drift attribution ----------------------

const DRIFT = "@@\n+await notion.pages.update({ page_id, properties: {} });";
const CLEAN = "@@\n+const label = greet(name);";

test("findOffenders: single root manifest — code drift, manifest not in PR -> offender", () => {
  const { offenders, unowned } = findOffenders({
    changedFiles: ["src/sync.ts"],
    changedManifestDirs: new Set(),
    manifestDirs: [""],
    ignoreSubstrings: [],
    diffFor: () => DRIFT,
  });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].owner, "");
  assert.deepEqual(unowned, []);
});

test("findOffenders: root manifest touched -> its files pass", () => {
  const { offenders } = findOffenders({
    changedFiles: ["src/sync.ts"],
    changedManifestDirs: new Set([""]),
    manifestDirs: [""],
    ignoreSubstrings: [],
    diffFor: () => DRIFT,
  });
  assert.deepEqual(offenders, []);
});

test("findOffenders: monorepo — drift in service A (manifest absent) but B present -> only A offends", () => {
  const { offenders } = findOffenders({
    changedFiles: ["drive-worker/notion.ts", "contacts-worker/api.ts"],
    changedManifestDirs: new Set(["contacts-worker/"]), // only B's manifest in the PR
    manifestDirs: ["drive-worker/", "contacts-worker/"],
    ignoreSubstrings: [],
    diffFor: () => DRIFT,
  });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].file, "drive-worker/notion.ts");
  assert.equal(offenders[0].owner, "drive-worker/");
});

test("findOffenders: orphan code (no ancestor manifest) does NOT offend — out of scope, informational", () => {
  const { offenders, unowned } = findOffenders({
    changedFiles: ["shared/util.ts"],
    changedManifestDirs: new Set(["drive-worker/"]),
    manifestDirs: ["drive-worker/", "contacts-worker/"],
    ignoreSubstrings: [],
    diffFor: () => DRIFT,
  });
  assert.deepEqual(offenders, []); // policy: no manifest = no warning
  assert.equal(unowned.length, 1);
  assert.equal(unowned[0].file, "shared/util.ts");
});

test("findOffenders: clean diffs and ignored files neither offend nor report", () => {
  const { offenders, unowned } = findOffenders({
    changedFiles: ["drive-worker/notion.ts", "README.md", "drive-worker/bindings.json"],
    changedManifestDirs: new Set(),
    manifestDirs: ["drive-worker/"],
    ignoreSubstrings: [],
    diffFor: () => CLEAN,
  });
  assert.deepEqual(offenders, []);
  assert.deepEqual(unowned, []);
});

test("findOffenders: a deleted/renamed file (null diff) is skipped, not blocked", () => {
  const { offenders, unowned } = findOffenders({
    changedFiles: ["drive-worker/gone.ts"],
    changedManifestDirs: new Set(),
    manifestDirs: ["drive-worker/"],
    ignoreSubstrings: [],
    diffFor: () => null,
  });
  assert.deepEqual(offenders, []);
  assert.deepEqual(unowned, []);
});
