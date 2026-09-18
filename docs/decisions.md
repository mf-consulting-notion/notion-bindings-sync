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

## The sync only invalidates — it never validates

Since the Synced Properties DB grew validation properties (`Validation status`,
`Last validated at`, `Validation source`), this action writes exactly one of them:
`Validation status` → `Pending validation`, on **create** and on any **update**
(a changed declaration voids prior validation, so updates also clear the two
validator-owned fields).

**Why:** the action is deliberately resolution-free — one MF-scoped token, no read
access to target databases — so it *cannot* verify a binding against reality.
Validation (setting `Validated`/`Stale`/`Unresolved`, `Last validated at`,
`Validation source`) is owned by the validator: the Notion Make Agent with Yanta
MCP access. One validator for all rows, regardless of whether the declaration came
from this CI or from the agent itself.

**Self-healing backfill:** rows created before the migration have an empty status;
`computeDiff` treats empty `validationStatus` as `toUpdate`, so old rows converge
to `Pending validation` on their build's next regular sync run — no manual
backfill. Any *non-empty* status is respected and left untouched on unchanged
bindings.
