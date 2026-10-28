/**
 * Unit tests for Piece-aware bindings (Process Model V1, migration step 7): the
 * manifest's `pieceId` field, the Piece-grain reconcile key and re-pointing.
 * Network-free; run: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseManifest,
  computeDiff,
  reconcileManifest,
  normalizePageId,
  createPayload,
  updatePayload,
  pieceProblems,
  PIECES_DS,
  PENDING_STATUS,
  BODY_PROPERTY_ID,
} from "../sync-bindings.mjs";

const P1 = "4079eca4-d310-8191-9311-cca619d9e5b2";
const P2 = "4079eca4-d310-8127-b5e2-e5ef0a2e477b";

const manifest = (over = {}, databases) => ({
  buildPageId: "build-A",
  workspaceNotionId: "ws-1",
  databases: databases ?? [
    {
      id: "db1",
      name: "Deals",
      bindings: [
        { property: "Status", propertyId: "PID1", direction: "both" },
        { property: "Owner", propertyId: "PID2", direction: "read" },
      ],
    },
  ],
  ...over,
});

// ---- normalizePageId -------------------------------------------------------

test("normalizePageId: dashed, 32-hex and uppercase all normalize to lowercase dashed", () => {
  assert.equal(normalizePageId(P1), P1);
  assert.equal(normalizePageId(P1.replaceAll("-", "")), P1);
  assert.equal(normalizePageId(P1.toUpperCase()), P1);
});

test("normalizePageId: anything that is not a page id returns null", () => {
  for (const v of ["", "abc", `${P1}0`, "4079eca4-d310-8191-9311-cca619d9e5bz", 42, null, undefined]) {
    assert.equal(normalizePageId(v), null, String(v));
  }
});

// ---- parseManifest: pieceId -------------------------------------------------

test("parseManifest: a legacy manifest is not Piece-aware and carries no pieceId key", () => {
  const { pieceAware, desired } = parseManifest(manifest());
  assert.equal(pieceAware, false);
  for (const d of desired) assert.ok(!("pieceId" in d));
  assert.deepEqual(desired.map((d) => d.key), ["db1::PID1", "db1::PID2"]);
});

test("parseManifest: a top-level pieceId applies to every binding", () => {
  const { pieceAware, desired } = parseManifest(manifest({ pieceId: P1 }));
  assert.equal(pieceAware, true);
  assert.deepEqual(desired.map((d) => d.pieceId), [P1, P1]);
  assert.deepEqual(desired.map((d) => d.key), [`${P1}::db1::PID1`, `${P1}::db1::PID2`]);
});

test("parseManifest: database pieceId overrides the top level, binding overrides the database", () => {
  const { desired } = parseManifest(manifest({ pieceId: P1 }, [
    { id: "db1", pieceId: P2, bindings: [
      { property: "Status", propertyId: "PID1", direction: "both" },
      { property: "Owner", propertyId: "PID2", direction: "read", pieceId: P1 },
    ] },
    { id: "db2", bindings: [{ property: "Name", propertyId: "title", direction: "read" }] },
  ]));
  assert.deepEqual(desired.map((d) => [d.dbId, d.propertyId, d.pieceId]), [
    ["db1", "PID1", P2],
    ["db1", "PID2", P1],
    ["db2", "title", P1],
  ]);
});

test("parseManifest: pieceId null is explicitly Unresolved and overrides an inherited Piece", () => {
  const { desired } = parseManifest(manifest({}, [
    { id: "db1", pieceId: P1, bindings: [{ property: "Status", propertyId: "PID1", direction: "both", pieceId: null }] },
  ]));
  assert.equal(desired[0].pieceId, null);
  assert.equal(desired[0].key, "unresolved::db1::PID1");
});

test("parseManifest: a database-level pieceId null overrides a top-level Piece", () => {
  const { desired } = parseManifest(manifest({ pieceId: P1 }, [
    { id: "db1", pieceId: null, bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] },
    { id: "db2", bindings: [{ property: "Name", propertyId: "title", direction: "read" }] },
  ]));
  assert.deepEqual(desired.map((d) => d.pieceId), [null, P1]);
});

test("parseManifest: pieceId is normalized (32-hex → dashed lowercase)", () => {
  const { desired } = parseManifest(manifest({ pieceId: P1.replaceAll("-", "").toUpperCase() }));
  assert.equal(desired[0].pieceId, P1);
});

test("parseManifest: a malformed pieceId throws, naming where it sits", () => {
  assert.throws(() => parseManifest(manifest({ pieceId: "objektreport-worker" })), /pieceId.*objektreport-worker/);
  assert.throws(
    () => parseManifest(manifest({}, [{ id: "db1", name: "Deals", bindings: [{ property: "Status", propertyId: "PID1", direction: "both", pieceId: 7 }] }])),
    (e) => /pieceId/.test(e.message) && /Status/.test(e.message),
  );
});

test("parseManifest: in a Piece-aware manifest every binding needs a pieceId (aggregated)", () => {
  const m = manifest({}, [
    { id: "db1", name: "Deals", pieceId: P1, bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] },
    { id: "db2", name: "Portfolios", bindings: [
      { property: "Name", propertyId: "title", direction: "read" },
      { target: "body", direction: "read" },
    ] },
  ]);
  assert.throws(() => parseManifest(m), (e) => /pieceId/.test(e.message) && /Portfolios → "Name"/.test(e.message) && /Portfolios → body/.test(e.message));
});

test("parseManifest: a single pieceId: null makes the manifest Piece-aware", () => {
  const m = manifest({}, [
    { id: "db1", name: "Deals", bindings: [
      { property: "Status", propertyId: "PID1", direction: "both", pieceId: null },
      { property: "Owner", propertyId: "PID2", direction: "read" },
    ] },
  ]);
  assert.throws(() => parseManifest(m), /Deals → "Owner"/);
});

test("parseManifest: one property under two Pieces yields two rows", () => {
  const { desired } = parseManifest(manifest({}, [
    { id: "db1", bindings: [
      { property: "Portfolio", propertyId: "PID1", direction: "read", pieceId: P1 },
      { property: "Portfolio", propertyId: "PID1", direction: "write", pieceId: P2 },
    ] },
  ]));
  assert.deepEqual(desired.map((d) => d.key), [`${P1}::db1::PID1`, `${P2}::db1::PID1`]);
});

test("parseManifest: the same property under the same Piece twice is a duplicate", () => {
  const m = manifest({ pieceId: P1 }, [
    { id: "db1", bindings: [
      { property: "Portfolio", propertyId: "PID1", direction: "read" },
      { property: "Portfolio", propertyId: "PID1", direction: "write" },
    ] },
  ]);
  assert.throws(() => parseManifest(m), /duplicate/);
});

test("parseManifest: a body target binds to a Piece like any property", () => {
  const { desired } = parseManifest(manifest({ pieceId: P1 }, [{ id: "db1", bindings: [{ target: "body", direction: "read" }] }]));
  assert.equal(desired[0].key, `${P1}::db1::${BODY_PROPERTY_ID}`);
  assert.equal(desired[0].pieceId, P1);
});

// ---- computeDiff: Piece-grain keys and re-pointing --------------------------

/** An existing Synced Properties row, as fetchExisting returns it. */
const row = (over = {}) => ({
  pageId: "pg1", propName: "Status", dbId: "db1", propertyId: "PID1", direction: "Both",
  validationStatus: "Validated", pieceId: null, ...over,
});
const desiredOf = (m) => parseManifest(m).desired;
const diffOf = (m, existing) => computeDiff(desiredOf(m), existing, { pieceAware: parseManifest(m).pieceAware });

/** Every existing row and every desired row is accounted for exactly once. */
function assertAccounted(diff, desired, existing) {
  const rowsSeen = [...diff.toUpdate.map((c) => c.row), ...diff.toRepoint.map((c) => c.row), ...diff.toPrune];
  const matched = existing.length - rowsSeen.length;
  assert.equal(new Set(rowsSeen).size, rowsSeen.length, "an existing row appears twice");
  const desiredSeen = [...diff.toCreate, ...diff.toUpdate.map((c) => c.d), ...diff.toRepoint.map((c) => c.d)];
  assert.equal(new Set(desiredSeen).size, desiredSeen.length, "a desired row appears twice");
  assert.equal(diff.unchanged, desired.length - desiredSeen.length);
  assert.equal(diff.unchanged, matched);
}

test("computeDiff: a legacy manifest refuses a Build that already has Piece-grain rows", () => {
  assert.throws(() => computeDiff(desiredOf(manifest()), [row({ pieceId: P1 })], { pieceAware: false }), /Piece/);
});

test("computeDiff: Build-grain rows are re-pointed to the Piece in place, validation kept", () => {
  const existing = [row({ pageId: "a", propertyId: "PID1" }), row({ pageId: "b", propertyId: "PID2", propName: "Owner", direction: "Read" })];
  const m = manifest({ pieceId: P1 });
  const diff = diffOf(m, existing);
  assert.deepEqual(diff.toRepoint.map((c) => [c.row.pageId, c.d.pieceId, c.resetValidation]), [["a", P1, false], ["b", P1, false]]);
  assert.deepEqual([diff.toCreate.length, diff.toUpdate.length, diff.toPrune.length, diff.unchanged], [0, 0, 0, 0]);
  assertAccounted(diff, desiredOf(m), existing);
});

test("computeDiff: a re-pointed row with an empty validation status still self-heals", () => {
  const diff = diffOf(manifest({ pieceId: P1 }, [{ id: "db1", bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] }]), [row({ validationStatus: "" })]);
  assert.equal(diff.toRepoint[0].resetValidation, true);
});

test("computeDiff: re-point plus a direction change resets validation", () => {
  const diff = diffOf(manifest({ pieceId: P1 }, [{ id: "db1", bindings: [{ property: "Status", propertyId: "PID1", direction: "read" }] }]), [row()]);
  assert.equal(diff.toRepoint[0].resetValidation, true);
});

test("computeDiff: one Build-grain row, two Pieces → one re-point, one create", () => {
  const m = manifest({}, [{ id: "db1", bindings: [
    { property: "Status", propertyId: "PID1", direction: "both", pieceId: P1 },
    { property: "Status", propertyId: "PID1", direction: "write", pieceId: P2 },
  ] }]);
  const existing = [row({ pageId: "a" })];
  const diff = diffOf(m, existing);
  assert.deepEqual(diff.toRepoint.map((c) => [c.row.pageId, c.d.pieceId]), [["a", P1]]); // first in manifest order
  assert.deepEqual(diff.toCreate.map((d) => d.pieceId), [P2]);
  assertAccounted(diff, desiredOf(m), existing);
});

test("computeDiff: re-pointing works between Pieces and back to Unresolved", () => {
  const toP2 = diffOf(manifest({ pieceId: P2 }, [{ id: "db1", bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] }]), [row({ pieceId: P1 })]);
  assert.deepEqual(toP2.toRepoint.map((c) => [c.row.pieceId, c.d.pieceId]), [[P1, P2]]);
  const toNull = diffOf(manifest({ pieceId: null }, [{ id: "db1", bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] }]), [row({ pieceId: P1 })]);
  assert.deepEqual(toNull.toRepoint.map((c) => [c.row.pieceId, c.d.pieceId]), [[P1, null]]);
});

test("computeDiff: exact Piece-grain matches win over re-pointing; Build-grain leftovers are preferred", () => {
  const m = manifest({}, [{ id: "db1", bindings: [
    { property: "Status", propertyId: "PID1", direction: "both", pieceId: P1 },
    { property: "Status", propertyId: "PID1", direction: "both", pieceId: P2 },
  ] }]);
  // P1's row exists exactly; a stale Build-grain row and a row of a third Piece compete for P2.
  const P3 = "4079eca4-d310-816d-8624-d03523c639f3";
  const existing = [row({ pageId: "z-p3", pieceId: P3 }), row({ pageId: "p1", pieceId: P1 }), row({ pageId: "y-legacy" })];
  const diff = diffOf(m, existing);
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.toRepoint.map((c) => [c.row.pageId, c.d.pieceId]), [["y-legacy", P2]]);
  assert.deepEqual(diff.toPrune.map((e) => e.pageId), ["z-p3"]);
  assertAccounted(diff, desiredOf(m), existing);
});

test("computeDiff: an explicitly Unresolved binding matches its Build-grain row exactly", () => {
  const diff = diffOf(manifest({ pieceId: null }, [{ id: "db1", bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] }]), [row()]);
  assert.deepEqual([diff.unchanged, diff.toRepoint.length, diff.toCreate.length], [1, 0, 0]);
});

test("computeDiff: duplicate existing rows converge — the lowest page id stays, the rest prune", () => {
  for (const existing of [[row({ pageId: "b" }), row({ pageId: "a" })], [row({ pageId: "a" }), row({ pageId: "b" })]]) {
    const legacy = computeDiff(desiredOf(manifest({}, [{ id: "db1", bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] }])), existing);
    assert.equal(legacy.unchanged, 1);
    assert.deepEqual(legacy.toPrune.map((e) => e.pageId), ["b"]);
  }
});

test("computeDiff: rows of another database × property are never re-pointed onto this one", () => {
  const m = manifest({ pieceId: P1 }, [{ id: "db1", bindings: [{ property: "Status", propertyId: "PID1", direction: "both" }] }]);
  const existing = [row({ pageId: "other", propertyId: "PID9" })];
  const diff = diffOf(m, existing);
  assert.deepEqual([diff.toCreate.length, diff.toRepoint.length, diff.toPrune.length], [1, 0, 1]);
});

// ---- payload builders --------------------------------------------------------

const desiredRow = (pieceId) => ({ key: "k", propName: "Status", propertyId: "PID1", dbId: "db1", direction: "both", ...(pieceId !== undefined && { pieceId }) });
const VALIDATION_FIELDS = ["Validation status", "Last validated at", "Validation source"];

test("createPayload: Bound to only for a named Piece; Build always; validation pending", () => {
  const named = createPayload(desiredRow(P1), "build-A", "ws-1").properties;
  assert.deepEqual(named["Bound to"], { relation: [{ id: P1 }] });
  assert.deepEqual(named.Build, { relation: [{ id: "build-A" }] });
  assert.deepEqual(named["Validation status"], { select: { name: PENDING_STATUS } });
  assert.ok(!("Bound to" in createPayload(desiredRow(null), "build-A", "ws-1").properties)); // Unresolved
  assert.ok(!("Bound to" in createPayload(desiredRow(undefined), "build-A", "ws-1").properties)); // legacy
});

test("updatePayload: a pure re-point moves Bound to and leaves validation alone", () => {
  const props = updatePayload({ d: desiredRow(P1), resetValidation: false }, { setPiece: true }).properties;
  assert.deepEqual(props["Bound to"], { relation: [{ id: P1 }] });
  for (const f of VALIDATION_FIELDS) assert.ok(!(f in props), f);
});

test("updatePayload: re-point to Unresolved clears Bound to", () => {
  assert.deepEqual(updatePayload({ d: desiredRow(null), resetValidation: false }, { setPiece: true }).properties["Bound to"], { relation: [] });
});

test("updatePayload: a declaration change resets validation and does not touch Bound to", () => {
  const props = updatePayload({ d: desiredRow(P1), resetValidation: true }, { setPiece: false }).properties;
  assert.ok(!("Bound to" in props));
  assert.deepEqual(props["Validation status"], { select: { name: PENDING_STATUS } });
  assert.deepEqual(props["Last validated at"], { date: null });
  assert.deepEqual(props["Validation source"], { select: null });
});

// ---- pieceProblems: the preflight's verdict on one Pieces page ---------------

const BUILD = "38a9eca4-d310-81ba-aa2c-e1e0b6174f55";
const piecePage = (over = {}) => ({
  id: P1,
  parent: { type: "data_source_id", data_source_id: PIECES_DS },
  in_trash: false,
  properties: {
    "Part of": { relation: [{ id: BUILD }] },
    Lifecycle: { select: { name: "Active" } },
  },
  ...over,
});

test("pieceProblems: an active Piece that is Part of the Build passes (any id spelling)", () => {
  assert.deepEqual(pieceProblems(piecePage(), BUILD), []);
  assert.deepEqual(pieceProblems(piecePage(), BUILD.replaceAll("-", "")), []);
});

test("pieceProblems: wrong database, other Build, Retired and trashed are each reported", () => {
  assert.match(pieceProblems(piecePage({ parent: { type: "data_source_id", data_source_id: "7d1aeaec-129e-4dde-9040-5761c86aef54" } }), BUILD).join(), /not a Pieces page/);
  assert.match(pieceProblems(piecePage({ properties: { "Part of": { relation: [] }, Lifecycle: { select: null } } }), BUILD).join(), /not Part of/);
  assert.match(pieceProblems(piecePage({ properties: { "Part of": { relation: [{ id: BUILD }] }, Lifecycle: { select: { name: "Retired" } } } }), BUILD).join(), /Retired/);
  assert.match(pieceProblems(piecePage({ in_trash: true }), BUILD).join(), /trash/);
});

// ---- reconcileManifest: preflight, ordering, logging -------------------------

function fakeDeps(existing = [], { dryRun = false, checkPieces } = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    dryRun,
    log: (m) => logs.push(m),
    checkPieces: checkPieces ?? (async (ids, build) => calls.push(["check", ids, build])),
    fetchExisting: async (build) => (calls.push(["fetch", build]), existing),
    createRow: async (d) => calls.push(["create", d.key]),
    updateRow: async (pageId, payload) => calls.push(["update", pageId, payload]),
    archiveRow: async (pageId) => calls.push(["archive", pageId]),
  };
  return { deps, calls, logs };
}

test("reconcileManifest: checks the distinct named Pieces first, then writes re-points with Bound to", async () => {
  const m = manifest({}, [{ id: "db1", bindings: [
    { property: "Status", propertyId: "PID1", direction: "both", pieceId: P1 },
    { property: "Status", propertyId: "PID1", direction: "both", pieceId: P2 },
    { property: "Owner", propertyId: "PID2", direction: "read", pieceId: P1 },
    { property: "Note", propertyId: "PID3", direction: "read", pieceId: null },
  ] }]);
  const { deps, calls, logs } = fakeDeps([row({ pageId: "a" })]);
  await reconcileManifest(parseManifest(m), deps);
  assert.deepEqual(calls[0], ["check", [P1, P2], "build-A"]);
  assert.deepEqual(calls[1], ["fetch", "build-A"]);
  const repoint = calls.find((c) => c[0] === "update");
  assert.equal(repoint[1], "a");
  assert.deepEqual(repoint[2].properties["Bound to"], { relation: [{ id: P1 }] });
  assert.ok(!("Validation status" in repoint[2].properties));
  const log = logs.join("\n");
  assert.match(log, /re-point 1/);
  assert.match(log, /unresolved 1/);
  assert.match(log, />.*Status.*∅ → 4079eca4/);
});

test("reconcileManifest: a failing Piece check stops before any read or write", async () => {
  const { deps, calls } = fakeDeps([], { checkPieces: async () => { throw new Error("Piece check failed"); } });
  await assert.rejects(reconcileManifest(parseManifest(manifest({ pieceId: P1 })), deps), /Piece check failed/);
  assert.deepEqual(calls, []);
});

test("reconcileManifest: legacy and all-Unresolved manifests skip the Piece check", async () => {
  for (const m of [manifest(), manifest({ pieceId: null })]) {
    const { deps, calls, logs } = fakeDeps();
    await reconcileManifest(parseManifest(m), deps);
    assert.ok(!calls.some((c) => c[0] === "check"));
    if (!parseManifest(m).pieceAware) assert.doesNotMatch(logs.join("\n"), /re-point|unresolved/); // legacy log unchanged
  }
});

test("reconcileManifest: legacy prune lines carry no Piece note", async () => {
  const { deps, logs } = fakeDeps([row({ propertyId: "STALE", propName: "Old" })]);
  await reconcileManifest(parseManifest(manifest()), deps);
  assert.ok(logs.some((l) => l === "  - db1 Old"), logs.join("\n"));
});

test("reconcileManifest: dry-run still runs the Piece check but writes nothing", async () => {
  const { deps, calls } = fakeDeps([row()], { dryRun: true });
  await reconcileManifest(parseManifest(manifest({ pieceId: P1 })), deps);
  assert.deepEqual(calls.map((c) => c[0]), ["check", "fetch"]);
});
