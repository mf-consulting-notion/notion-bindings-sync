/**
 * Unit tests for shared manifest discovery + ownership. Zero-dep: node:test.
 * Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { discoverManifests, ownerManifestDir } from "../manifests.mjs";

/** Build a throwaway repo tree; return its root dir. */
function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), "bindings-discover-"));
  for (const d of [
    "drive-worker",
    "contacts-worker",
    "services/foo",
    "a/b",
    "node_modules",
    "sub/node_modules",
    ".git/x",
  ]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  for (const f of [
    "bindings.json", // root build
    "drive-worker/bindings.json", // depth-1 service build
    "contacts-worker/bindings.json", // depth-1 service build
    "services/foo/bindings.json", // depth-2 grouping — NOT a build root
    "a/b/bindings.json", // depth-2 — not discovered
    "node_modules/bindings.json", // vendored — excluded
    "sub/node_modules/bindings.json", // nested vendored — excluded
    ".git/x/bindings.json", // vcs — excluded
  ]) {
    writeFileSync(join(root, f), "{}");
  }
  return root;
}

test("discoverManifests: finds root + depth-1 service folders only", () => {
  const root = fixtureTree();
  const found = discoverManifests(root).map((p) => p.slice(root.length + 1).split(sep).join("/"));
  assert.deepEqual(found, ["bindings.json", "contacts-worker/bindings.json", "drive-worker/bindings.json"]);
});

test("discoverManifests: ignores depth-2, node_modules and .git", () => {
  const root = fixtureTree();
  const found = discoverManifests(root).map((p) => p.slice(root.length + 1).split(sep).join("/"));
  assert.ok(!found.some((f) => f.includes("services/foo")), "depth-2 grouping must not be discovered");
  assert.ok(!found.some((f) => f.includes("a/b")), "depth-2 must not be discovered");
  assert.ok(!found.some((f) => f.includes("node_modules")), "node_modules must be excluded");
  assert.ok(!found.some((f) => f.includes(".git")), ".git must be excluded");
});

test("discoverManifests: returns absolute, deterministically sorted paths", () => {
  const root = fixtureTree();
  const found = discoverManifests(root);
  assert.ok(
    found.every((p) => p.startsWith(root)),
    "paths must be absolute (rooted at the tree)",
  );
  assert.deepEqual(found, [...found].sort(), "must be sorted");
});

test("discoverManifests: empty tree yields []", () => {
  const root = mkdtempSync(join(tmpdir(), "bindings-empty-"));
  assert.deepEqual(discoverManifests(root), []);
});

test("ownerManifestDir: nearest ancestor wins over root", () => {
  const dirs = ["", "drive-worker/", "contacts-worker/"];
  assert.equal(ownerManifestDir("drive-worker/notion.ts", dirs), "drive-worker/");
  assert.equal(ownerManifestDir("drive-worker/deep/nested/x.ts", dirs), "drive-worker/");
});

test("ownerManifestDir: root manifest owns files under no deeper manifest", () => {
  const dirs = ["", "drive-worker/"];
  assert.equal(ownerManifestDir("shared/util.ts", dirs), "");
  assert.equal(ownerManifestDir("index.ts", dirs), "");
});

test("ownerManifestDir: orphan (no ancestor manifest) is null", () => {
  const dirs = ["drive-worker/", "contacts-worker/"];
  assert.equal(ownerManifestDir("shared/util.ts", dirs), null);
  assert.equal(ownerManifestDir("index.ts", dirs), null);
});

test("ownerManifestDir: a service file is not owned by a sibling service", () => {
  const dirs = ["drive-worker/", "contacts-worker/"];
  assert.equal(ownerManifestDir("contacts-worker/api.ts", dirs), "contacts-worker/");
  // 'drive-worker-legacy/' must NOT be captured by the 'drive-worker/' prefix
  assert.equal(ownerManifestDir("drive-worker-legacy/api.ts", ["drive-worker/"]), null);
});
