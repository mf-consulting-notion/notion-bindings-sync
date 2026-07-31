# Plan: Multi-manifest sync (monorepo support)

## Problem

`notion-bindings-sync` today syncs exactly one `bindings.json` (the repo root). A
monorepo build — one repo, several top-level service folders each with their own
`bindings.json` (e.g. natwill: `drive-worker/bindings.json` +
`contacts-worker/bindings.json`) — can therefore only ever register one of its
builds. `register-build` phase 2 wants to scaffold exactly **one** workflow pair in
the repo root per caller and let the reconcile system handle the N builds inside.
This change makes both `sync` and `verify` discover and process **every build's**
`bindings.json` in the caller checkout instead of a single root file, while
keeping the single-root case byte-for-byte identical.

Discovery matches the `register-build` contract literally: a build's manifest sits
at the **build root**, which is either the **repo root** (single-build) or a
**top-level service folder** (monorepo, one level down). So discovery globs
`['bindings.json', '*/bindings.json']` — depth-0 and depth-1 only — **not** `**`.
This is deliberate: `**` would sync any stray `bindings.json` (a fixture, a vendored
example) into the *live* Synced Properties DB, and depth-limiting to the actual
build-root convention closes that footgun. Trade-off consciously accepted: a
grouping layout like `services/foo/bindings.json` (build two levels deep) is **not**
discovered — not our convention, and the explicit `MANIFEST` override covers it.

## Decisions reached during grilling

- **Verify = per-directory attribution** (John's call). `verify` discovers all
  manifests, self-gates only when zero exist, and attributes each offending code
  file to its **nearest-ancestor manifest directory**; a root manifest owns
  everything not under a deeper one. An offender passes only if *its owning*
  manifest is in the PR — real per-service drift protection, not a coarse "any
  manifest touched" wave-through. Rationale: the motivating case (natwill, no root
  manifest) must not be left inert; "a silent miss is the thing we refuse to allow"
  (README) applies per service.
- **Orphan code files** (Notion tokens fire, but no manifest exists anywhere in the
  file's ancestry — e.g. shared root code in a repo with only per-service
  manifests) **fail** the gate, attributed to "(no manifest covers this path)".
  Undeclared Notion surface with no owning manifest is exactly a silent miss;
  failing is consistent with the gate's stated value. Author opts out or adds a
  covering manifest.
- **Sync failure semantics = process-all-then-fail** (brief point 3). A malformed
  manifest (missing ids, unresolved `propertyId`, bad direction) records a failure
  and the loop continues to the next manifest; a non-zero exit at the end fails the
  run if *any* manifest was bad. Rationale: (a) builds are prune-isolated
  (`existingRowsForBuild` filters `Build relation contains buildPageId`), so
  applying manifest A after manifest B fails cannot corrupt B's rows — no
  cross-build blast radius; (b) reconcile is idempotent upsert, so a partial apply
  re-runs cleanly after the fix; (c) the author gets the *complete* drift report in
  one run instead of fix-one-rerun-see-next whack-a-mole. Fail-loud CI semantics are
  preserved by the terminal non-zero exit.
- **Explicit `MANIFEST` override is retained and takes precedence.** If the
  `manifest` input / `MANIFEST` env is non-empty → treat as a single explicit file
  (missing file → throw, exactly as today). If empty/unset → glob-discover. The
  distinction is carried by making the `action.yml` default the empty string.
- **Zero manifests discovered (glob mode) = benign no-op**, exit 0 with a clear log.
  Glob semantics make "no manifest" a valid state, and the `bindings.json` /
  `*/bindings.json` push
  trigger already guarantees relevance. (Explicit override pointing at a missing
  file still throws — back-compat.)
- **Discovery is `fs.globSync` (Node 22), not a dependency.** Verified against Node
  22: the array pattern `['bindings.json', '*/bindings.json']` matches exactly
  depth-0 + depth-1 (`*` does not cross `/`), auto-excludes `.git`, and the `exclude`
  callback still prunes a depth-1 `node_modules/bindings.json`. Zero-dependency stays
  a value of the codebase — no glob library, no `**`.
- **Shared discovery module.** `discoverManifests` lives in one new zero-dep file
  (`manifests.mjs`) imported by both scripts, rather than duplicated. Pure functions,
  import-safe.
- **No `CONTEXT.md` created.** Single-purpose action repo; the README is the
  vocabulary home. Terms used here (manifest, build, prune isolation, drift gate,
  Synced Properties) are all already README/code terms.

## Module changes

### New: `manifests.mjs` (shared, zero-dep, pure)

```
// Discover build manifests: repo-root + top-level-service-folder bindings.json,
// i.e. globs ['bindings.json', '*/bindings.json'] (depth-0 + depth-1 only, NOT **).
// Excludes node_modules and .git. Deterministically sorted. Returns absolute paths.
export function discoverManifests(rootDir: string): string[]

// Nearest-ancestor manifest directory for a file (longest matching dir prefix).
// manifestDirs are POSIX-style dir prefixes ("" = repo root, "drive-worker/", …).
// Returns the owning dir prefix, or null if no manifest is an ancestor.
export function ownerManifestDir(file: string, manifestDirs: string[]): string | null
```

- `discoverManifests`: `globSync(['bindings.json', '*/bindings.json'], { cwd: rootDir, exclude })`,
  `exclude = (p) => /(^|\/)(node_modules|\.git)(\/|$)/.test(p)`, map to absolute,
  `.sort()` for deterministic order.
- `ownerManifestDir`: normalize to `/`-separated; among `manifestDirs`, pick the
  longest that is `"" `(root) or a prefix ending in `/` that `file` starts with;
  ties impossible (prefixes are nested). Root `""` matches any file.

### `sync-bindings.mjs`

Current: top-level `TOKEN = req("NOTION_TOKEN")` (throws at import), one `main()`
reading one `MANIFEST`, does resolution→diff→apply inline, runs unconditionally at
module load.

Intended: import-safe (no top-level throws, guarded `main()`), pure logic extracted,
a multi-manifest driver with injected side-effects.

New/changed exported interface:

```
// Pure: manifest JSON -> normalized reconcile input. Throws Error on structural
// problems (missing buildPageId/workspaceNotionId, bad direction, any binding
// missing propertyId — with the aggregated unresolved list, as today).
export function parseManifest(json): { buildPageId, workspaceNotionId, desired: Desired[] }

// Pure: the network-free reconcile diff.
export function computeDiff(desired: Desired[], existing: Map<key, ExistingRow>):
  { toCreate: Desired[], toUpdate: Desired[], toPrune: ExistingRow[], unchanged: number }

// Reconcile ONE parsed manifest via injected deps (network-free in tests).
// deps = { fetchExisting(buildPageId)->Map, createRow, updateRow, archiveRow,
//          dryRun: bool, log(msg) }
export async function reconcileManifest(parsed, deps): Promise<diff>

// Drive all manifests. Never throws on a bad manifest — records it and continues.
// Returns { applied: string[], failures: {manifest, error}[] }.
export async function syncAll(manifestPaths: string[], deps): Promise<Result>
```

- `key` = `` `${dbId}::${propertyId}` ``, unchanged. `Desired`/`ExistingRow` shapes
  unchanged from current inline code.
- `main()`: resolve manifest list (explicit override → `[resolve(cwd, MANIFEST)]`;
  else `discoverManifests(cwd)`); if empty → log no-op, exit 0. Read
  `NOTION_TOKEN` here (not at module top). Wire production `deps` as closures over a
  token-bound `request`. `await syncAll(...)`; print per-manifest summary; if
  `failures.length` → `process.exit(1)`.
- Invariant preserved: `fetchExisting(buildPageId)` is always scoped to one build,
  so `computeDiff`'s `toPrune` can only ever contain that build's rows — prune
  isolation is structural, not incidental.
- Guard: `if (process.argv[1] && resolve(process.argv[1]).endsWith("sync-bindings.mjs")) main().catch(...)`.

### `verify-bindings.mjs`

Current: self-gates on root `bindings.json` only; global "manifest in PR → pass";
one scan pass; `readVerifyIgnore` reads the one manifest.

Intended: discover all manifests; per-owner attribution; union verifyIgnore.

New/changed exported interface (keeps existing exports `scanDiffForTokens`,
`skipReason`, `isScannable`, `TOKENS`):

```
// Pure: given the changed files, which manifests changed, the manifest dir set,
// the ignore fragments, and an injected per-file diff getter, return offenders.
// diffFor(file) -> unified-diff string (git-free / injectable for tests).
export function findOffenders({
  changedFiles: string[], changedManifestDirs: Set<string>,
  manifestDirs: string[], ignoreSubstrings: string[], diffFor: (f)=>string|null
}): { file: string, tokens: string[], owner: string }[]
```

- `main()`: manifests via override-or-discover. **Self-gate**: zero manifests →
  pass/skip. Opt-out (title/labels) unchanged. Require BASE/HEAD unchanged.
  `changed = diff --name-only base...head`. `manifestDirs` = dir-prefix of each
  discovered manifest ("" for root). `changedManifestDirs` = dirs whose manifest
  path ∈ changed. `findOffenders` with `diffFor = (f) => git(diff base...head -- f)`.
  `ignoreSubstrings` = union of every discovered manifest's `verifyIgnore`.
- Per file with token hits: owner = `ownerManifestDir(file, manifestDirs)`. If
  `owner === null` → offender label "(no manifest covers this path)". Else if
  `owner ∈ changedManifestDirs` → OK. Else → offender labelled with owner's manifest
  path. `ALWAYS_IGNORE` (own scripts) still applies via `isScannable`.
- Failure message: list offenders as `file [tokens] (owner: <manifest|none>)`; same
  three remedies (re-capture / opt-out / verifyIgnore).
- Back-compat: single root manifest (or explicit override) → `manifestDirs = [""]`,
  root owns all, "root manifest in PR → pass" falls out → behaviour identical.

### `action.yml`

- `manifest` input default `bindings.json` → `""`. Update description: empty =
  discover build manifests (`bindings.json` + `*/bindings.json`); a path = one
  explicit manifest. Applies to both
  `sync` and `verify` steps (both already pass `MANIFEST: ${{ inputs.manifest }}`).

### `.github/workflows/sync-bindings.yml`

- `paths: [bindings.json]` → `paths: ['bindings.json', '*/bindings.json']` (same
  depth-0 + depth-1 set as discovery; GitHub `paths` `*` does not cross `/`).

## Implementation steps

1. **`manifests.mjs`** — new file: `discoverManifests` + `ownerManifestDir`. Unit
   test both (temp dir tree for discovery; string cases for ownership).
2. **Make `sync-bindings.mjs` import-safe & extract pure logic** — move
   `NOTION_TOKEN` read into `main()`; extract `parseManifest` and `computeDiff` from
   the current inline `main()` with **no behaviour change**; add the argv guard.
   Existing single-manifest run must still work (manual dry-run against this repo's
   own `bindings.json`).
3. **Add `reconcileManifest` + `syncAll`** — refactor `main()` to resolve the
   manifest list (override vs `discoverManifests`), wire production `deps`, loop with
   failure aggregation, terminal non-zero exit. Zero-manifest no-op.
4. **Upgrade `verify-bindings.mjs`** — discover all manifests, `findOffenders` pure
   function with per-owner attribution + union `verifyIgnore`, rewrite `main()`
   around it. Keep all current exports.
5. **`action.yml` + workflow triggers** — `manifest` default `""` (+ description);
   `sync-bindings.yml` `paths: ['bindings.json', '*/bindings.json']`.
6. **README** — Use-it snippet (`paths`), a "Multi-build (monorepo)" subsection for
   both sync and verify semantics, the explicit-`MANIFEST`-override behaviour,
   node_modules/.git exclusion, and the Local-dry-run `MANIFEST` note. Confirm the
   "register-build can drop both workflows together" line now holds for single **and**
   monorepo.
7. **Tests green** — `node --test` (existing verify tests unchanged + new sync tests
   + new manifests tests all pass).

## Test approach

Everything network-free and git-free via extracted pure functions + injected deps.

- **`test/manifests.test.mjs`** (new): `discoverManifests` over a `mkdtemp` tree —
  finds root + depth-1 service folders, **ignores** depth-2 (`a/b/bindings.json`,
  `services/foo/bindings.json`) and `node_modules/`/`.git/`; deterministic sort.
  `ownerManifestDir` — nearest-ancestor wins, root `""` fallback, orphan → `null`.
- **`test/sync-bindings.test.mjs`** (new):
  - `parseManifest`: happy path → `desired`; missing `buildPageId` throws; bad
    `direction` throws; missing `propertyId` throws with the aggregated list.
  - `computeDiff`: create/update/prune/unchanged classification against a given
    `existing` Map (fixture data, no network).
  - `syncAll` with in-memory `deps`: **two manifests both processed**; a
    `fetchExisting` fake keyed by `buildPageId` returning per-build rows proves
    **prune isolation** — build A's run never lists build B's rows in `toPrune`; one
    malformed manifest → recorded in `failures`, the other still applied, `failures`
    non-empty (drives the non-zero exit).
- **`test/verify-bindings.test.mjs`** (extend): keep all current cases; add
  `ownerManifestDir` cases and a `findOffenders` case — two-service monorepo, drift
  in service A code with A's manifest absent from the PR but B's present → offender =
  the A file only; orphan file with tokens and no ancestor manifest → offender
  labelled "(no manifest covers this path)".

Test stand-ins: in-memory `deps` (Maps + arrays capturing `createRow`/`updateRow`/
`archiveRow` calls) for `syncAll`; an injected `diffFor` map for `findOffenders`;
`fs.mkdtempSync` fixture trees for discovery.

## Inputs needed

None. The change is code + docs only; no new credentials, IDs, or accounts. The
existing `NOTION_BINDINGS_TOKEN` secret and Synced Properties data-source id are
unchanged. Post-merge tag move (`v1` → new commit, tag `v1.x.y`) is a release step
noted below, not a build input.

## Open questions

None.

## Out of scope

- **`register-build/SKILL.md`** — untouched; phase-2 monorepo scaffolding is a
  separate session. This PR only *enables* the "one workflow pair per caller" model.
- **`@v2` / breaking changes** — this is additive (root case stays valid), so it
  stays `@v1`. After merge: move the `v1` tag to the new commit and tag `v1.x.y`.
- **Cross-manifest dedup / global validation** — each manifest reconciles its own
  build independently; no attempt to detect the same property claimed by two builds.
- **Parser-grade verify** — the drift gate stays a heuristic; per-directory
  attribution does not make it a real Notion-call parser.
- **Symlink-following / configurable ignore globs** — discovery uses `globSync`
  defaults plus the fixed `node_modules`/`.git` exclude; no per-repo glob config.
