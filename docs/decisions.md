# Decisions

Curated, load-bearing decisions worth re-reading before changing this action.
(For the full autonomous audit trail see `docs/decision-log.md`.)

## Manifest discovery is depth-0 + depth-1, never recursive `**`

`discoverManifests` globs `['bindings.json', '*/bindings.json']` — the repo root and
each top-level service folder — not `**/bindings.json`.

**Why:** a build's manifest lives at its *build root*, which the register-build
contract defines as the repo root (single build) or a top-level service folder
(monorepo). More importantly, `sync` writes to the **live** Synced Properties Notion
DB. A recursive `**` would sweep any stray `bindings.json` — a test fixture, a
vendored copy, an example — into that live DB. Depth-limiting to the actual
build-root convention makes the blast radius exactly the declared builds.

**Consequence / escape hatch:** a build nested deeper than one level
(`services/foo/bindings.json`) is out of convention and is **not** auto-discovered.
Reach it with the explicit `manifest:` input (single-file mode). The workflow
`paths:` trigger mirrors the same set (`['bindings.json', '*/bindings.json']`;
GitHub's `*` does not cross `/`).

If you ever need true recursion, that's a contract change — reconsider the
register-build build-root convention first, not just this glob.
