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
