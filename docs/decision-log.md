# Decision log

Engineering calls made during implementation. One line each; rationale terse.

- **Discovery depth-0 + depth-1, not recursive** — `discoverManifests` globs
  `['bindings.json', '*/bindings.json']`, matching the register-build build-root
  convention (repo root or top-level service folder). Recursive `**` would sync
  stray/fixture/vendored manifests into the live Synced Properties DB.
- **Shared `manifests.mjs`** — `discoverManifests` + `ownerManifestDir` extracted to
  one zero-dep module imported by both sync and verify, over duplicating in each.
- **`ownerManifestDir` uses trailing-slash prefixes** — "" = root, "svc/" = service
  dir; prevents "drive-worker/" from capturing "drive-worker-legacy/".
- **Import-safe modules via `argv[1]` guard + deferred token** — `NOTION_TOKEN` read
  moved into `main()`; both scripts only run `main()` when executed directly, so
  their pure exports import cleanly in tests without a token.
- **`syncAll` takes injected `deps`** (readManifest/labelFor/fetchExisting/create/
  update/archive/log/dryRun) — makes the multi-manifest driver + prune isolation
  network-free unit-testable; prod wires the deps as token-bound closures.
- **Sync loop = process-all-then-fail-nonzero** — a malformed manifest is recorded
  in `failures` and the loop continues; `main()` exits 1 if any failed. Builds are
  prune-isolated so partial apply is safe and idempotent; author gets the full report.
- **Verify self-gate on ANY manifest; per-owner attribution** — offender passes only
  if its nearest-ancestor manifest is in the PR; orphan (no ancestor manifest) always
  offends. `verifyIgnore` unioned across all manifests.
- **`manifest` input default `""`** — empty = discover; non-empty = single explicit
  file (missing file: sync throws, verify self-gates/skips — preserves back-compat).
- **Workflow `paths` mirror discovery** — `['bindings.json', '*/bindings.json']`
  (GitHub `*` doesn't cross `/`), so the push trigger fires on the same depth-0+1 set.
- **[senior-review r1] Token read after empty-manifest check** — sync `main()`
  discovers manifests and returns the no-op BEFORE `req("NOTION_TOKEN")`, so a
  zero-manifest repo logs "nothing to sync" (exit 0) instead of failing on a missing
  token.
- **[senior-review r2] Missing explicit override fails, not skips** — verify only
  self-gates in DISCOVERY mode; a non-empty `MANIFEST` override pointing at a missing
  file fails loud (a typo must not silently disable the drift gate), matching sync.
- **[design follow-up] Orphan code is OUT OF SCOPE, not an offender** — REVERSES the
  earlier "orphan always offends" call. A changed file with Notion call-sites but no
  ancestor manifest no longer fails verify: it logs an informational line and passes
  (exit 0). Policy: "no bindings.json = no warning" — the gate guards only builds
  that declare a property surface; shared infra without a manifest (e.g. natwill
  `packages/notion/`) is deliberately not its beat. This is a consciously accepted
  silent-miss along the shared-code axis, bounded by: (a) register-build (Session B)
  will scaffold a skeleton `bindings.json` early for every syncing build, so real
  builds always have a manifest; (b) property changes almost always land in the build
  folder, not a generic helper; (c) the gate is run NON-REQUIRED (a branch-protection
  setting, not code) so it's advisory anyway. `findOffenders` now returns
  `{ offenders, unowned }`.
- **[framing correction] The glob change is a UNIFORMITY win, not a bug fix** — the
  multi-manifest discovery does not repair anything broken. A monorepo like natwill
  already syncs today via an explicit `manifest:`-override job per build. What this
  buys is uniform scaffolding: register-build can drop ONE standard root workflow pair
  per caller instead of a hand-maintained N-job file, and the reconcile system fans
  out to all builds.
- **Page body = reserved sentinel propertyId `page_body`** — authored as
  `{"target":"body","direction":…}`, normalized by `parseManifest` to
  `Page body`/`page_body`. Rides the existing `${dbId}::${propertyId}` key, so
  create/update/prune/validation are unchanged. Per-DATABASE grain (bindings are
  declared per database; per-page is not expressible and not the question being
  asked). Hand-written sentinel id accepted and normalized onto the same row;
  unknown `target` THROWS (an older action must not half-apply a newer manifest).
- **`parseManifest` rejects duplicate keys** — `computeDiff` does not dedupe
  `desired`, so a key declared twice double-created the row. Latent for named
  properties, reachable with the nameless body target.
- **Verify gains CONTENT tokens** — `blocks.children`, `block_id`,
  `notion-to-md`/`NotionToMarkdown`/`n2m`, so a body binding has a drift gate at all.
  Bare `children:` deliberately excluded: JSX fires it everywhere and a noisy gate
  gets ignored, which is worse than a known blind spot.

- **`via` on the DATABASE entry, manifest-only** — validated non-empty string,
  carried onto that DB's desired rows, echoed in the CI log, never written to
  Notion. The annotated rows are ordinary property rows and already produce the
  Yanta edge; only provenance is new and its audience is the next author. A Synced
  Properties column would mean a shared-DB schema change + Yanta harvest change for
  data no consumer reads. Omitted from the row object entirely when unset (keeps the
  reconcile shape unchanged).
- **Drift gate deliberately still blind to `via` bindings** — no call sites to grep;
  the real fix (phase 2 resolving what an aggregating endpoint materializes) belongs
  in register-build.

## 2026-10-28 — Piece-aware bindings (plan: docs/plans/piece-aware-bindings.md)

- **Field `pieceId`**, matching `buildPageId`/`propertyId`; dashed or 32-hex, normalized to lowercase dashed (the form `Bound to` returns), so manifest and row keys compare.
- **Three levels (binding → database → top level)** — the top level covers the common one-Piece Build (Objektreport: 146 bindings) without 12 repetitions.
- **Several Pieces on one property = the binding listed once per Piece** — keeps one entry = one row; no array-valued field.
- **Piece-aware as soon as any `pieceId` key exists**, then every binding must resolve one (aggregated error) — a forgotten id must not silently become Unresolved.
- **Re-point pairing per database × property**, Build-grain rows first, then page id; desired in manifest order — deterministic, and adopting legacy rows is the common case.
- **Duplicate existing rows converge** (lowest page id stays) — previously the Map silently hid the extras.
- **`existing` is an array** (keys computed in `computeDiff`) — the key now depends on the manifest's mode, which the fetch can't know.
- **Payloads are pure builders** (`createPayload`, `updatePayload`) — the no-validation-reset rule is a payload property, so it is tested on the payload.
- **Piece check runs in dry-run too** — a dry-run is the place to learn that an id is wrong.
- **Legacy CI log unchanged**; Piece-aware manifests add `re-point` / `unresolved` counts and `>` lines.
- **Verify reports `pieceId: null` counts, never fails on them** — Unresolved is a valid state, and verify reads no Notion.
- **`pieces-ds` action input** mirrors `synced-properties-ds`.
- **Own manifest gains `Bound to` (both)**; stays legacy until this action has a Piece.
