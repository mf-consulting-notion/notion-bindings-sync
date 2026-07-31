/**
 * Unit tests for sync-bindings' network-free logic: manifest parsing, the
 * reconcile diff, and the multi-manifest driver (with injected deps). Zero-dep:
 * node:test. Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest, computeDiff, reconcileManifest, syncAll } from "../sync-bindings.mjs";

const GOOD = {
  buildPageId: "build-A",
  workspaceNotionId: "ws-1",
  databases: [
    {
      id: "db1",
      name: "Tasks",
      bindings: [
        { property: "Status", propertyId: "PID1", direction: "both" },
        { property: "Owner", propertyId: "PID2", direction: "read" },
      ],
    },
  ],
};

test("parseManifest: happy path yields normalized desired rows", () => {
  const { buildPageId, workspaceNotionId, desired } = parseManifest(GOOD);
  assert.equal(buildPageId, "build-A");
  assert.equal(workspaceNotionId, "ws-1");
  assert.deepEqual(desired, [
    { key: "db1::PID1", propName: "Status", propertyId: "PID1", dbId: "db1", direction: "both" },
    { key: "db1::PID2", propName: "Owner", propertyId: "PID2", dbId: "db1", direction: "read" },
  ]);
});

test("parseManifest: missing buildPageId throws", () => {
  assert.throws(() => parseManifest({ ...GOOD, buildPageId: undefined }), /buildPageId/);
});

test("parseManifest: missing workspaceNotionId throws", () => {
  assert.throws(() => parseManifest({ ...GOOD, workspaceNotionId: undefined }), /workspaceNotionId/);
});

test("parseManifest: bad direction throws", () => {
  const bad = { ...GOOD, databases: [{ id: "db1", bindings: [{ property: "X", propertyId: "P", direction: "sideways" }] }] };
  assert.throws(() => parseManifest(bad), /direction/);
});

test("parseManifest: unresolved propertyId throws with aggregated list", () => {
  const bad = {
    ...GOOD,
    databases: [
      { id: "db1", name: "Tasks", bindings: [{ property: "Status", direction: "both" }] },
      { id: "db2", name: "Docs", bindings: [{ property: "Title", direction: "read" }] },
    ],
  };
  assert.throws(() => parseManifest(bad), (e) => /propertyId/.test(e.message) && /Status/.test(e.message) && /Title/.test(e.message));
});

test("parseManifest: empty databases yields no desired rows", () => {
  assert.deepEqual(parseManifest({ buildPageId: "b", workspaceNotionId: "w" }).desired, []);
});

// ---- computeDiff ---------------------------------------------------------

const D = (over = {}) => ({ key: "db1::P1", propName: "Status", propertyId: "P1", dbId: "db1", direction: "both", ...over });
const E = (over = {}) => ({ key: "db1::P1", pageId: "pg1", propName: "Status", dbId: "db1", direction: "Both", ...over });

test("computeDiff: new desired row -> create", () => {
  const diff = computeDiff([D()], new Map());
  assert.equal(diff.toCreate.length, 1);
  assert.equal(diff.toUpdate.length, 0);
  assert.equal(diff.toPrune.length, 0);
  assert.equal(diff.unchanged, 0);
});

test("computeDiff: identical existing row -> unchanged", () => {
  const diff = computeDiff([D()], new Map([["db1::P1", E()]]));
  assert.deepEqual([diff.toCreate.length, diff.toUpdate.length, diff.toPrune.length, diff.unchanged], [0, 0, 0, 1]);
});

test("computeDiff: direction change -> update", () => {
  const diff = computeDiff([D({ direction: "read" })], new Map([["db1::P1", E({ direction: "Both" })]]));
  assert.equal(diff.toUpdate.length, 1);
  assert.equal(diff.unchanged, 0);
});

test("computeDiff: renamed property -> update", () => {
  const diff = computeDiff([D({ propName: "State" })], new Map([["db1::P1", E({ propName: "Status" })]]));
  assert.equal(diff.toUpdate.length, 1);
});

test("computeDiff: existing row absent from desired -> prune", () => {
  const diff = computeDiff([], new Map([["db1::P1", E()]]));
  assert.equal(diff.toPrune.length, 1);
  assert.equal(diff.toPrune[0].pageId, "pg1");
});

// ---- reconcileManifest / syncAll (injected deps, network-free) ------------

/** In-memory deps capturing every side-effect call. */
function recorder(existingByBuild, { dryRun = false } = {}) {
  const calls = { create: [], update: [], archive: [], fetched: [] };
  const deps = {
    dryRun,
    log: () => {},
    readManifest: (p) => p, // manifests are passed pre-parsed as the "path"
    labelFor: (p) => p.label ?? "manifest",
    fetchExisting: (buildPageId) => {
      calls.fetched.push(buildPageId);
      return new Map(existingByBuild[buildPageId] ?? []);
    },
    createRow: (d, b, w) => calls.create.push({ d, b, w }),
    updateRow: (pageId, d) => calls.update.push({ pageId, d }),
    archiveRow: (pageId) => calls.archive.push(pageId),
  };
  return { deps, calls };
}

test("reconcileManifest: applies create/update/prune via deps, scoped to its build", async () => {
  const existing = {
    "build-A": [["db1::P1", E({ pageId: "pgA-stale", key: "db1::P1" })]],
  };
  const { deps, calls } = recorder(existing);
  const parsed = { buildPageId: "build-A", workspaceNotionId: "ws-1", desired: [D({ key: "db1::P2", propertyId: "P2" })] };
  await reconcileManifest(parsed, deps);
  assert.deepEqual(calls.fetched, ["build-A"]);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].b, "build-A");
  assert.deepEqual(calls.archive, ["pgA-stale"]); // stale row pruned
});

test("reconcileManifest: dryRun performs no writes", async () => {
  const { deps, calls } = recorder({ "build-A": [["db1::P1", E()]] }, { dryRun: true });
  await reconcileManifest({ buildPageId: "build-A", workspaceNotionId: "w", desired: [] }, deps);
  assert.deepEqual([calls.create, calls.update, calls.archive], [[], [], []]);
});

test("syncAll: processes every manifest", async () => {
  const mA = { label: "drive-worker/bindings.json", buildPageId: "build-A", workspaceNotionId: "w", databases: [{ id: "db1", bindings: [{ property: "S", propertyId: "P1", direction: "both" }] }] };
  const mB = { label: "contacts-worker/bindings.json", buildPageId: "build-B", workspaceNotionId: "w", databases: [{ id: "db2", bindings: [{ property: "T", propertyId: "P9", direction: "read" }] }] };
  const { deps, calls } = recorder({});
  const res = await syncAll([mA, mB], deps);
  assert.deepEqual(res.failures, []);
  assert.deepEqual(res.applied, ["drive-worker/bindings.json", "contacts-worker/bindings.json"]);
  assert.deepEqual(calls.fetched.sort(), ["build-A", "build-B"]);
  assert.equal(calls.create.length, 2);
});

test("syncAll: prune isolation — build A never prunes build B's rows", async () => {
  // Each build's existing rows are distinct and stale (absent from desired).
  const existing = {
    "build-A": [["dbA::PA", E({ key: "dbA::PA", pageId: "pgA", dbId: "dbA" })]],
    "build-B": [["dbB::PB", E({ key: "dbB::PB", pageId: "pgB", dbId: "dbB" })]],
  };
  // A desires nothing (its stale row prunes); B desires its row (no prune).
  const mA = { label: "A", buildPageId: "build-A", workspaceNotionId: "w", databases: [] };
  const mB = { label: "B", buildPageId: "build-B", workspaceNotionId: "w", databases: [{ id: "dbB", bindings: [{ property: "S", propertyId: "PB", direction: "both" }] }] };
  const { deps, calls } = recorder(existing);
  await syncAll([mA, mB], deps);
  // Only A's own stale row is archived — pgB (build B's row) is untouched.
  assert.deepEqual(calls.archive, ["pgA"]);
  assert.ok(!calls.archive.includes("pgB"));
});

test("syncAll: a malformed manifest is recorded but does not stop the others", async () => {
  const bad = { label: "broken/bindings.json", workspaceNotionId: "w", databases: [] }; // missing buildPageId
  const good = { label: "ok/bindings.json", buildPageId: "build-A", workspaceNotionId: "w", databases: [{ id: "db1", bindings: [{ property: "S", propertyId: "P1", direction: "both" }] }] };
  const { deps, calls } = recorder({});
  const res = await syncAll([bad, good], deps);
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0].manifest, /broken/);
  assert.match(res.failures[0].error, /buildPageId/);
  assert.deepEqual(res.applied, ["ok/bindings.json"]); // good one still applied
  assert.equal(calls.create.length, 1);
});
