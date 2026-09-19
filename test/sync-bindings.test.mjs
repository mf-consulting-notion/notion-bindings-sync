/**
 * Unit tests for sync-bindings' network-free logic: manifest parsing, the
 * reconcile diff, and the multi-manifest driver (with injected deps). Zero-dep:
 * node:test. Run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseManifest,
  computeDiff,
  reconcileManifest,
  syncAll,
  BODY_PROPERTY_ID,
  BODY_PROPERTY_NAME,
} from "../sync-bindings.mjs";

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
const E = (over = {}) => ({ key: "db1::P1", pageId: "pg1", propName: "Status", dbId: "db1", direction: "Both", validationStatus: "Validated", ...over });

// --- page-body target -------------------------------------------------------
// The body has no Notion property id, so it rides a reserved sentinel id and must
// behave like any other row through keying, diffing and prune.

const bodyManifest = (binding) => ({
  buildPageId: "build-A",
  workspaceNotionId: "ws-1",
  databases: [{ id: "db1", name: "Skills", bindings: [binding] }],
});

test('parseManifest: target "body" normalizes to the sentinel row', () => {
  const { desired } = parseManifest(bodyManifest({ target: "body", direction: "read" }));
  assert.deepEqual(desired, [
    { key: `db1::${BODY_PROPERTY_ID}`, propName: BODY_PROPERTY_NAME, propertyId: BODY_PROPERTY_ID, dbId: "db1", direction: "read" },
  ]);
});

test("parseManifest: a hand-written sentinel propertyId normalizes to the same row", () => {
  const viaTarget = parseManifest(bodyManifest({ target: "body", direction: "write" })).desired;
  const viaId = parseManifest(bodyManifest({ property: "whatever the author typed", propertyId: BODY_PROPERTY_ID, direction: "write" })).desired;
  assert.deepEqual(viaId, viaTarget); // same key AND same name -> never two rows
});

test("parseManifest: body binding honours every direction", () => {
  for (const direction of ["read", "write", "both"]) {
    assert.equal(parseManifest(bodyManifest({ target: "body", direction })).desired[0].direction, direction);
  }
});

test("parseManifest: a body binding with a bad direction throws", () => {
  assert.throws(() => parseManifest(bodyManifest({ target: "body", direction: "sideways" })), /direction/);
});

test("parseManifest: an unknown target throws rather than silently no-opping", () => {
  assert.throws(() => parseManifest(bodyManifest({ target: "comments", direction: "read" })), /unknown binding target/);
});

test("parseManifest: a body binding needs no propertyId (not reported as unresolved)", () => {
  assert.doesNotThrow(() => parseManifest(bodyManifest({ target: "body", direction: "read" })));
});

test("parseManifest: body and property bindings coexist in one database", () => {
  const m = {
    buildPageId: "build-A",
    workspaceNotionId: "ws-1",
    databases: [{ id: "db1", name: "Skills", bindings: [
      { property: "Name", propertyId: "title", direction: "read" },
      { target: "body", direction: "read" },
    ] }],
  };
  assert.deepEqual(parseManifest(m).desired.map((d) => d.key), ["db1::title", `db1::${BODY_PROPERTY_ID}`]);
});

test("parseManifest: the same body target declared twice throws (would double-create)", () => {
  const m = {
    buildPageId: "build-A",
    workspaceNotionId: "ws-1",
    databases: [
      { id: "db1", name: "Skills", bindings: [{ target: "body", direction: "read" }] },
      { id: "db1", name: "Skills (again)", bindings: [{ target: "body", direction: "read" }] },
    ],
  };
  assert.throws(() => parseManifest(m), /declared twice/);
});

test("parseManifest: a duplicated property binding throws too", () => {
  const m = {
    buildPageId: "build-A",
    workspaceNotionId: "ws-1",
    databases: [{ id: "db1", bindings: [
      { property: "Status", propertyId: "PID1", direction: "read" },
      { property: "Status (dupe)", propertyId: "PID1", direction: "both" },
    ] }],
  };
  assert.throws(() => parseManifest(m), /declared twice/);
});

test("parseManifest: the body sentinel is scoped per database, not global", () => {
  const m = {
    buildPageId: "build-A",
    workspaceNotionId: "ws-1",
    databases: [
      { id: "db1", bindings: [{ target: "body", direction: "read" }] },
      { id: "db2", bindings: [{ target: "body", direction: "write" }] },
    ],
  };
  assert.deepEqual(parseManifest(m).desired.map((d) => d.key), [`db1::${BODY_PROPERTY_ID}`, `db2::${BODY_PROPERTY_ID}`]);
});

test("computeDiff: a body row diffs and prunes like any other row", () => {
  const [body] = parseManifest(bodyManifest({ target: "body", direction: "read" })).desired;
  const created = computeDiff([body], new Map());
  assert.deepEqual(created.toCreate.map((d) => d.key), [body.key]);

  const existing = new Map([[body.key, { key: body.key, pageId: "p1", propName: BODY_PROPERTY_NAME, dbId: "db1", direction: "Read", validationStatus: "Validated" }]]);
  assert.equal(computeDiff([body], existing).unchanged, 1);

  const flipped = { ...body, direction: "both" };
  assert.deepEqual(computeDiff([flipped], existing).toUpdate.map((d) => d.key), [body.key]);

  assert.deepEqual(computeDiff([], existing).toPrune.map((e) => e.pageId), ["p1"]);
});

// --- via: provenance for API-mediated dependencies ---------------------------
// Declaration-only: parsed, validated and logged, never written to Notion.

const viaManifest = (via) => ({
  buildPageId: "build-A",
  workspaceNotionId: "ws-1",
  databases: [{ id: "db1", name: "Skills", ...(via !== undefined && { via }), bindings: [
    { property: "Name", propertyId: "title", direction: "read" },
  ] }],
});

test("parseManifest: via rides along on every binding of its database", () => {
  const { desired } = parseManifest(viaManifest("api:/v1/ai/plugins"));
  assert.equal(desired[0].via, "api:/v1/ai/plugins");
});

test("parseManifest: via is absent (not undefined-valued) when unset", () => {
  assert.ok(!("via" in parseManifest(viaManifest(undefined)).desired[0]));
});

test("parseManifest: via is trimmed", () => {
  assert.equal(parseManifest(viaManifest("  api:/v1/ai/plugins  ")).desired[0].via, "api:/v1/ai/plugins");
});

test("parseManifest: a non-string or blank via throws", () => {
  for (const bad of ["", "   ", 42, true, {}, []]) {
    assert.throws(() => parseManifest(viaManifest(bad)), /via/, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test("parseManifest: via is per database, not global", () => {
  const m = {
    buildPageId: "build-A",
    workspaceNotionId: "ws-1",
    databases: [
      { id: "db1", via: "api:/v1/ai/plugins", bindings: [{ property: "Name", propertyId: "title", direction: "read" }] },
      { id: "db2", bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] },
    ],
  };
  const { desired } = parseManifest(m);
  assert.equal(desired[0].via, "api:/v1/ai/plugins");
  assert.ok(!("via" in desired[1]));
});

test("via: never reaches Notion, but is named in the CI log", async () => {
  const logs = [];
  const parsed = parseManifest(viaManifest("api:/v1/ai/plugins"));
  const created = [];
  await reconcileManifest(parsed, {
    dryRun: false,
    log: (m) => logs.push(m),
    fetchExisting: async () => new Map(),
    createRow: async (d) => created.push(d),
    updateRow: async () => {},
    archiveRow: async () => {},
  });
  assert.ok(logs.join("\n").includes("(via api:/v1/ai/plugins)"), "log should name the provenance");
  // createRow builds the Notion payload from propName/propertyId/dbId/direction only;
  // `via` is carried for the log and for the next author, never written.
  assert.equal(created.length, 1);
});

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

test("computeDiff: empty validation status self-heals to update (pre-migration rows)", () => {
  const diff = computeDiff([D()], new Map([["db1::P1", E({ validationStatus: "" })]]));
  assert.equal(diff.toUpdate.length, 1);
  assert.equal(diff.unchanged, 0);
});

test("computeDiff: any non-empty validation status is respected on unchanged bindings", () => {
  for (const status of ["Validated", "Delta-validated", "Pending validation", "Stale", "Unresolved"]) {
    const diff = computeDiff([D()], new Map([["db1::P1", E({ validationStatus: status })]]));
    assert.equal(diff.toUpdate.length, 0, status);
    assert.equal(diff.unchanged, 1, status);
  }
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
