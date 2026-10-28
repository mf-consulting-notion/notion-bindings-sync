# Plan: Piece-aware bindings (Process Model V1, migration step 7)

Notion Task: https://app.notion.com/p/3f99eca4d3108130affdd6a042ac5397 (log progress there).
Vocabulary: `CONTEXT.md`. Canonical rules: Notion "Process Model V1 — Spec" §4/§7/§8 and
glossary "Synced Properties Database" → Rules.

## Problem

Process Model V1 moves a binding from "a Build touches this property" to "this **Piece**
reads or writes this property": one Synced Properties row = property × exactly one Piece,
via the new relation `Bound to` (limit 1); `Resolution` (formula) shows Unresolved while
it is empty. The schema is live; the action still writes Build-grain rows only. Migration
happens **per Build** (when the Build gets its Pieces), so the action must run in a mixed
world: legacy manifests keep working byte-for-byte, Piece-aware manifests reattach their
existing rows to Pieces **in place** without losing page ids or validation state. Every
caller runs `@v1`, so this ships as a backward-compatible minor (`v1.5.0`).

## Verified external reality (2026-10-28)

- Synced Properties (`7d1aeaec-129e-4dde-9040-5761c86aef54`): `Bound to` id `xa%5DC`,
  relation → Pieces DS `99ff84d6-11be-4a5e-bb68-96317ab07410`, `limit: 1`, dual property
  "Synced Properties" on Pieces. `Resolution` id `qlz%3D`, formula
  `if(empty(prop("Bound to")), "Unresolved", "Resolved")`. `Build` (id `oXMu`) and
  `Make Scenario` unchanged. The action has never written `Make Scenario`.
- Pilot rows today: Objektreport Worker Build `4079eca4-d310-8186-858a-cbde7d859825`
  → 146 rows (query pages: 100 + more), all Bound to empty, all `Pending validation`.
  Assetbird Build `38a9eca4-d310-81ba-aa2c-e1e0b6174f55` → 11 rows, same state.
- Pilot Pieces exist, `Lifecycle: Active`, each `Part of` exactly its Build:
  Objektreport Worker `4079eca4-d310-8191-9311-cca619d9e5b2` (Worker);
  Assetbird Deals sync `4079eca4-d310-8127-b5e2-e5ef0a2e477b` (Worker),
  Assetbird Portfolio relation resolver `4079eca4-d310-818c-953a-c04cf3aaa131` (Script),
  Assetbird orphaned deals prune `4079eca4-d310-816d-8624-d03523c639f3` (Script).
- Pilot repo: `github.com/mf-consulting-notion/client-upestate-projektentwicklung-gmbh`
  (local `~/Code/upestate/client-upestate-projektentwicklung-gmbh`), monorepo with
  `objektreport-worker/bindings.json` (12 DBs, 146 bindings) and
  `assetbird-sync/bindings.json` (2 DBs, 11 bindings); root workflows
  `sync-bindings.yml` + `verify-bindings.yml` use `notion-bindings-sync@v1` in discovery
  mode. The local clone currently sits on a feature branch with an untracked file — work
  from a fresh branch/worktree off `main`.
- No Piece exists yet for this action itself (Pieces search "bindings" → none).
- Tags: `v1.0.0` … `v1.4.0`; next is `v1.5.0`.

## Decisions reached during grilling

Product (with John):
- Grain, transition and Unresolved rules as in the spec/glossary; `Build` keeps being
  written; legacy manifests unchanged; reattachment per Build, in place.
- Unresolved in a Piece-aware manifest is **explicit** (`"pieceId": null`); a binding
  with no effective `pieceId` in a Piece-aware manifest fails the run.
- Setting/changing only `Bound to` does **not** reset validation.
- Pilots (Objektreport, Assetbird) are migrated **in this work stream**, as a PR in the
  client monorepo, after the action release.

Engineering (mine, with rationale):
- **Field name `pieceId`**, matching `buildPageId`/`propertyId`. Value: a Notion page id
  (dashed or 32-hex, normalized to lowercase dashed) or `null`.
- **Three levels, nearest wins:** binding `pieceId` → database entry `pieceId` → top-level
  `pieceId`. The top level covers the common case (Objektreport: 146 bindings, one
  Piece) without repeating it 12 times; per-binding covers Assetbird.
- **A property touched by several Pieces is listed once per Piece** (same `propertyId`,
  different `pieceId`). Keeps one binding entry = one row; no array-valued field.
- **Piece-aware = any `pieceId` key present anywhere in the manifest** (including
  `null`). Then every binding resolves an effective `pieceId` or the manifest fails.
- **Reconcile key by mode.** Legacy: `${dbId}::${propertyId}` (unchanged).
  Piece-aware: `${pieceId ?? "unresolved"}::${dbId}::${propertyId}`.
- **Re-point instead of prune+create.** After exact-key matching, leftover desired and
  leftover existing rows are paired per `${dbId}::${propertyId}`: existing sorted
  Build-grain first, then by page id; desired in manifest order; pair by index → update
  `Bound to` in place. Leftovers → create / prune as before. This covers legacy adoption
  (∅→Piece), moves between Pieces and Piece→∅ with one rule.
- **Validation reset only on a declaration change** (direction or name) or an empty
  status (existing self-heal). A re-point alone leaves `Validation status`,
  `Last validated at`, `Validation source` untouched — validation concerns the schema,
  not the Piece.
- **Downgrade guard:** a legacy manifest whose Build already has Piece-grain rows fails
  loud (it would otherwise silently collide keys or un-bind rows). Removing `pieceId`s is
  never a silent operation.
- **Piece preflight (fail loud, before any write, also in dry-run):** for each distinct
  non-null `pieceId`: `GET /v1/pages/{id}` must succeed, its parent data source must be
  Pieces, `Part of` must contain `buildPageId`, `Lifecycle` must not be `Retired`
  ("bindings exist only for Pieces that aren't Retired"). Catches a wrong or stale id
  that Notion would otherwise accept or reject with an opaque 400. Costs 1–3 GETs per
  manifest.
- **Scope stays the Build** (`Build contains buildPageId`); `Build` is written on every
  row, Piece-grain included. The provenance-key question is deferred until `Build` is
  dropped (see Out of scope).
- **Duplicate existing rows** (two rows with the same key) — today silently collapsed by
  the Map. Now the extra rows are pruned, so the DB converges to one row per key.
- **Reporting:** sync log per manifest gains `re-point N` and `unresolved N`; re-points
  print as `> <db8> <name> <from8|∅> → <to8|∅>`. Verify mode logs, per manifest, the
  count of explicitly Unresolved bindings — informational, never a failure.
- **Own manifest:** add `Bound to` (`xa%5DC`, `both` — read in fetch, written in
  create/re-point). Stays legacy until a Piece for this action exists.

## Module changes

### `sync-bindings.mjs`

**`parseManifest(manifest, label)`** → `{ buildPageId, workspaceNotionId, pieceAware, desired }`

- `Desired = { key, propName, propertyId, dbId, direction, pieceId, via? }` where
  `pieceId` is `undefined` (legacy), `string` (normalized dashed lowercase) or `null`.
- New errors (thrown, aggregated like the unresolved-propertyId list where it makes
  sense): malformed `pieceId` (not a uuid, not null); Piece-aware manifest with a binding
  whose effective `pieceId` is `undefined`; duplicate key (now includes the Piece).
- Helper `normalizePageId(v)` (exported, pure).

**`computeDiff(desired, existing, { pieceAware })`** — `existing` becomes an **array** of
`ExistingRow = { pageId, propName, dbId, propertyId, direction, validationStatus, pieceId: string|null }`.

Returns `{ toCreate: Desired[], toUpdate: Change[], toRepoint: Change[], toPrune: ExistingRow[], unchanged: number }`
with `Change = { row: ExistingRow, d: Desired, resetValidation: boolean }`.
- Legacy mode: keys ignore `pieceId`; throws the downgrade-guard error if any existing
  row has `pieceId !== null`.
- `toUpdate`: same key, direction/name differ or validation status empty →
  `resetValidation: true` (today's semantics).
- `toRepoint`: paired as decided above; `resetValidation` true only if direction/name
  also differ or status is empty.
- Duplicate existing keys: first by page id is matched, the rest go to `toPrune`.
- Invariant: every existing row appears in exactly one of matched/updated/re-pointed/
  pruned; every desired row in exactly one of matched/updated/re-pointed/created.

**Pure payload builders (exported, tested):**
- `createPayload(d, buildPageId, workspaceNotionId)` — today's properties, plus
  `"Bound to": { relation: [{ id }] }` when `d.pieceId` is a string. Omitted for `null`
  and `undefined`.
- `updatePayload(change, { setPiece })` — always `Property Name` + `Direction`; plus
  `"Bound to": { relation: d.pieceId ? [{ id }] : [] }` when `setPiece`; plus the
  validation trio (`Pending validation`, `Last validated at: null`,
  `Validation source: null`) only when `resetValidation`.

**`reconcileManifest(parsed, deps)`** — order: `deps.checkPieces(distinctPieceIds, buildPageId)`
(skipped when none) → `fetchExisting` → `computeDiff` → log → (dry-run stops) → create →
update → re-point → prune. `deps` gains `checkPieces`, and `updateRow(pageId, payload)`
takes a built payload.

**I/O:** `existingRowsForBuild` returns `ExistingRow[]` incl. `pieceId` from
`properties["Bound to"].relation[0]?.id ?? null`. New `checkPieces` (GET per Piece,
aggregated error listing every bad id with the reason). Pieces DS id as a constant with
env override `PIECES_DS` (mirrors `SYNCED_PROPERTIES_DS`).

### `manifests.mjs`
- New pure `countExplicitUnresolved(manifest)` → number of bindings whose effective
  `pieceId` is `null`. Tolerant of malformed manifests (returns 0; sync is where they
  fail).

### `verify-bindings.mjs`
- After discovery, log per manifest `bindings-verify: <label> — N binding(s) Unresolved
  (pieceId: null)` when N > 0. No effect on the exit code.

### `action.yml`, `README.md`, `docs/decisions.md`, `docs/decision-log.md`, `bindings.json`
- Token scope everywhere: **READ on Pieces** added (relation write + preflight).
- README "Manifest shape": `pieceId` section (levels, explicit null, Piece-aware rule,
  multiple Pieces per property, re-point semantics, downgrade guard).
- decisions.md: one entry "Bindings bind Pieces; reattachment re-points in place".
- Own `bindings.json`: add `{ "property": "Bound to", "propertyId": "xa%5DC", "direction": "both" }`.

## Implementation steps

1. **Parse `pieceId`.** `normalizePageId`, three-level resolution, Piece-aware detection,
   new errors, key with Piece. Tests first (see Test approach). `node --test` green.
2. **Diff by mode.** `computeDiff` on arrays, legacy key unchanged, downgrade guard,
   exact match → update → re-point pairing → create/prune, duplicate-row pruning,
   `resetValidation` flags. Migrate existing `computeDiff` tests from `Map` to arrays
   (mechanical; semantics must not change for legacy).
3. **Payload builders + I/O.** `createPayload`/`updatePayload`, `existingRowsForBuild`
   reads `Bound to`, `checkPieces`, `reconcileManifest` ordering and logging
   (`re-point`, `unresolved`). Fake-deps tests assert call order and payloads.
4. **Verify reporting.** `countExplicitUnresolved` + log line. Tests.
5. **Docs + own manifest + action.yml.** README, decisions.md, decision-log.md, own
   `bindings.json`, input descriptions. Self-dogfood: the repo's own verify workflow
   must pass on the PR.
6. **Live dry-run (read-only) before release.** With `NOTION_TOKEN` = the bindings
   token (from `.env`, see Inputs), `DRY_RUN=1`, against temporary copies of the pilot
   manifests with `pieceId`s added:
   - Objektreport (top-level `pieceId`): expect `create 0 · update 0 · re-point 146 ·
     prune 0 · unresolved 0`, preflight OK.
   - Assetbird (per-binding per the attribution table): expect `re-point 11 · create 4 ·
     prune 0` (if every one of the 11 properties keeps ≥ 1 Piece).
   - A legacy manifest (this repo's own) → identical output to `v1.4.0`
     (`unchanged` only, plus the new `Bound to` binding as `create 1`).
   - Negative: a `pieceId` of a Piece not Part of the Build → preflight fails, no writes.
   Record the outputs in the Task log.
7. **Release.** PR → review → squash-merge; tag `v1.5.0`. **Moving `v1` changes every
   caller — confirm with John before moving it.** After the move, the next push of any
   legacy caller must still log identical numbers (spot-check one run).
8. **Pilot PR in the client monorepo** (fresh branch off `main`): Objektreport top-level
   `pieceId`; Assetbird per-binding per the attribution table (11 → 15 entries). Local
   dry-run with the PR's manifests (expect step 6 numbers). **Merging triggers live
   writes — confirm with John before merging.**
9. **Verify live.** Synced Properties: Objektreport 146 rows, all `Bound to` = Objektreport
   Worker, `Resolution` Resolved, validation fields unchanged (still Pending), same page
   ids as before. Assetbird 15 rows, 11 original page ids kept, 4 new with
   `Pending validation`. No rows of other Builds touched. Pieces page "Objektreport
   Worker" shows 146 rows under "Synced Properties".
10. **Close out.** Update the Notion reference "bindings.json Manifest — Reference (v1)"
    (`80f67a08…`): `pieceId` field row, Piece-aware section, token scope (+ Pieces).
    Task log with evidence; Task Done once pilots verify.

## Test approach

All unit tests are network-free (`node --test`), extending `test/sync-bindings.test.mjs`
and `test/verify-bindings.test.mjs` in the existing style (plain fixtures, injected
`deps`).

- **parseManifest:** legacy manifest → `pieceAware: false`, keys unchanged, every
  `pieceId` undefined; top-level only; db overrides top; binding overrides db; binding
  `null` overrides a db string; 32-hex normalized to dashed; malformed id throws;
  Piece-aware with one binding lacking any level throws (names the binding); same
  property under two Pieces → two desired rows; same property + same Piece twice →
  duplicate error; body target with `pieceId`.
- **computeDiff:** legacy parity (all existing legacy cases still pass on arrays);
  downgrade guard throws; Objektreport shape (N Build-grain rows, all desired under P)
  → N re-points, `resetValidation` false on rows with a status, true on an empty status;
  Assetbird shape (one property under two Pieces, one Build-grain row) → 1 re-point +
  1 create; Piece→∅ re-point; P1→P2 re-point; re-point + direction change →
  `resetValidation` true; duplicate existing rows → extras pruned; invariant check
  helper asserting every row is accounted for exactly once.
- **Payload builders:** create with string / null / undefined `pieceId`; update with and
  without `setPiece` and `resetValidation` (assert the validation trio is absent on a
  pure re-point).
- **reconcileManifest with fake deps:** `checkPieces` called first with distinct ids and
  not called for legacy; a throwing `checkPieces` → no fetch, no writes; dry-run → no
  writes; log contains `re-point` and `unresolved` counts.
- **verify:** `countExplicitUnresolved` levels and tolerance; log line present only when
  N > 0; exit code unaffected.
- **Integration:** steps 6 and 9 above against the live DB (dry-run first, live only after
  John's go).

## Inputs needed

1. **Grant the Notion integration "Sync Bindings" (the `NOTION_BINDINGS_TOKEN`
   integration) access to the Pieces DB** (read). Without it the relation write and the
   preflight return 404. Needed before step 6.
2. **The bindings token locally for the dry-run:** put it into
   `/Users/john/Code/mf-consulting/notion-bindings-sync/.env` as
   `NOTION_TOKEN=…` (from 1Password item "Sync Bindings"). Not into chat.
   (`.env` is gitignored.)
3. **The Assetbird attribution table** (11 Build-grain → 15 Piece-grain rows: property ×
   Piece × direction) from the Yanta session — paste it or point to where it lives.
   Needed for step 8 (and the Assetbird dry-run in step 6).
4. **Go/no-go at two live touches:** moving `v1` (step 7) and merging the pilot PR
   (step 8).

## Open questions

None.

## Out of scope

- Creating or discovering Pieces (Yanta session, per Build); a Piece for this action.
- Dropping `Build` / `Make Scenario` from Synced Properties, and the provenance key for
  Unresolved rows that it would require — revisit when John deprecates `Build`. Known
  transitional limit until then: a Piece shared by two Builds and declared in both
  manifests yields one row per Build for the same Piece × property.
- Pruning on Piece retirement beyond what the manifest declares (removing a Piece's
  bindings from the manifest prunes them; the action does not watch `Lifecycle` except
  in the preflight).
- Moving bindings to a client home workspace after a handover (spec §7).
- Yanta's synced-properties reader; register-build phase-2 authoring of `pieceId`.
- Migrating any Build other than the two pilots.
