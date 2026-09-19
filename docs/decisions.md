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

## The page body is a binding target on a reserved sentinel property id

A page's block content is a real dependency — for a content-publishing build it is
*the* dependency — but it has no Notion property id, so the property-grained v1
manifest could not express it at all. It is now declared as
`{"target": "body", "direction": "read"}` and lands in Synced Properties as a row
with `Property Notion ID` = `page_body`, `Property Name` = `Page body`.

**Why a sentinel id and not a new column:** the reconcile key is
`${dbId}::${propertyId}` and *everything* hangs off it — create/update/prune, the
per-build isolation, the validation-status self-heal. A sentinel id slots into that
key untouched, so no diff, prune or validation logic learns a new case, and every
existing consumer of the mapping DB keeps working on the shape it already reads.
A new column would have meant a schema change on a shared DB plus a matching change
in Yanta's harvest — for a distinction that is already carried by the id.

**Why per-database grain:** bindings are declared per database, not per page, so
"this build touches row bodies in this DB" is the only claim the manifest can
honestly make — and it is the question a Notion editor is asking anyway ("does
anything downstream read this content?"). Per-page grain would need a page-level
manifest concept that does not exist.

**Why `target` rather than hand-writing the id:** the action owns the sentinel, so
a typo (`page-body`, `pageBody`) fails the run instead of silently creating a junk
row that no one reads. The hand-written form is still normalized onto the same row
so the two spellings can never yield two rows for one dependency. An **unknown**
target throws rather than no-ops: an older action must refuse a manifest it cannot
fully apply, not half-apply it.

**Consequence:** Yanta must tolerate `page_body` in its schema view — the id does
not resolve against a harvested Notion schema. Tracked as a Yanta issue; until it
ships, such rows render as an unresolved property there.

**Also, while in here:** `parseManifest` now rejects a duplicate
`${dbId}::${propertyId}`. `computeDiff` never deduplicated `desired`, so a twice-declared
binding created the row twice. Rare for named properties, easy to hit with the
nameless body target (same DB listed in two database entries).


## `via` marks API-mediated bindings, in the manifest only

A database entry may carry `"via": "api:/v1/ai/plugins"`, recording that its
bindings are evidenced by an API contract rather than by a call site in the repo.
It is parsed, validated, echoed in the CI log — and never written to Notion.

**Why it is needed:** phase-2 discovery greps for Notion call sites. A build that
reads a database through an aggregating endpoint has none, so the convention reads
it as "not a syncing build" while it in fact depends on several properties. Those
bindings therefore get authored by hand, and without a marker the next author
cannot tell a deliberate API declaration from parsing code someone forgot to write
— and might "fix" it by deleting rows phase 2 cannot re-find.

**Why not a column in Synced Properties:** the rows it annotates are ordinary
property rows and already produce the Yanta edge — the dependency is visible
either way. Only the *provenance* is new, and its audience is the manifest's next
author, not the Notion editor. Putting it on the wire would cost a schema change
on a shared DB plus a Yanta harvest change for something no consumer reads yet.
Revisit if Yanta ever wants to distinguish the two evidence kinds visually.

**Accepted gap:** the drift gate still cannot protect these bindings. It greps for
call-site tokens and an API-mediated build has none to change, so a `via` database's
bindings can go stale with nothing failing a PR. Making phase 2 resolve what an
aggregating endpoint materializes is the real fix, and it belongs in `register-build`,
not here.
