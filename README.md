# notion-bindings-sync

A GitHub composite action that pushes a repo's declared `bindings.json`
(Build→Property bindings) into the MF **Synced Properties** Notion DB, which
[Yanta](https://github.com/mf-consulting-notion/yanta) bi-syncs into its schema
model (ADR 0007). Deterministic, per-build **upsert + prune** — no code
introspection, no LLM.

## Division of labour

- **Authoring** — `register-build` phase 2 (run where the integration's target-DB
  access exists) discovers the read/write surface, resolves property names →
  Notion ids, and writes them into the integration repo's `bindings.json`. Ids
  live in the manifest, so CI never touches the target databases.
- **CI (this action)** — on merge to `main`, reads the manifest and reconciles
  that build's rows in Synced Properties.

## Why one token works for every integration

Because ids are pre-resolved in the manifest, this action only ever reads/writes
**MF** databases — regardless of which workspace the integration itself writes to
(a client build's db/property ids ride in the manifest as plain text). So the
*same* MF-scoped token value serves every caller — currently copied into each
repo as its own secret rather than set once org-wide (see "One-time setup" below).

**Token scope** (`NOTION_BINDINGS_TOKEN`): a Notion internal integration with
- **write** on *Synced Properties*
- **read** on *Builds* (the `Build` field is a relation; setting it needs access to the related DB)

Nothing else — not the integrations' target DBs, not GitHub Repos.

## Use it

In each integration repo, add `.github/workflows/sync-bindings.yml`:

```yaml
name: Sync Notion property bindings
on:
  push:
    branches: [main]
    paths: [bindings.json]
  workflow_dispatch:
jobs:
  sync-bindings:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mf-consulting-notion/notion-bindings-sync@v1
        with:
          notion-token: ${{ secrets.NOTION_BINDINGS_TOKEN }}
          # dry-run: "true"   # optional: report the diff without writing
```

## One-time setup per caller repo

- **Secret**: add `NOTION_BINDINGS_TOKEN` (scope above) as a **repo** Actions
  secret in each caller. An org-wide secret would be simpler (set once, every
  caller inherits it), but that scoping requires a paid GitHub org plan, which
  `mf-consulting-notion` isn't on — so each repo gets its own copy of the same
  token value instead (stored in 1Password, item "Sync Bindings"). If the org
  ever upgrades, these can be consolidated back into one org secret.
- **Private action access**: this repo is private, so let other org repos consume
  its action — *Settings → Actions → General → Access → "Accessible from
  repositories in the mf-consulting-notion organization"*.

## Versioning

Callers pin the major tag `@v1`. Cut releases by moving `v1` to the latest good
commit (and tagging `v1.x.y` for the specific point). Breaking the manifest
contract or the reconcile semantics → bump to `@v2`.

## Manifest shape

Canonical reference (field meanings, the ids-pre-resolved rule, full example):
[bindings.json Manifest — Reference (v1)](https://app.notion.com/p/80f67a0876604e4a87148638c47be92a)
in MF Consulting → Docs. Don't re-derive the shape from this repo's code as a
substitute for reading it — that's how the two drift. Shortest possible shape,
for orientation only:

```json
{
  "buildPageId": "<Builds registry page id>",
  "workspaceNotionId": "<target workspace's Notion id>",
  "databases": [
    { "id": "<data_source_id>", "name": "Human label", "bindings": [
      { "property": "Status", "propertyId": "XIvk", "direction": "both" }
    ] }
  ]
}
```

A binding without a `propertyId` fails the run — resolution is the authoring
tool's job (`register-build` phase 2), not CI's.

## Local dry-run

```
NOTION_TOKEN='ntn_…' DRY_RUN=1 MANIFEST=/abs/path/to/bindings.json node sync-bindings.mjs
```
