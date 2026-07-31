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
