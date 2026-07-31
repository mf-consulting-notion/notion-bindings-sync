# notion-bindings-sync

A GitHub composite action that pushes a repo's declared `bindings.json`
(Build→Property bindings) into the MF **Synced Properties** Notion DB, which
[Yanta](https://github.com/mf-consulting-notion/yanta) bi-syncs into its schema
model (ADR 0007). Deterministic, per-build **upsert + prune** — no code
introspection, no LLM.

A repo may hold **more than one build**: a monorepo has one `bindings.json` per
top-level service folder (e.g. `drive-worker/bindings.json` +
`contacts-worker/bindings.json`). The action discovers and reconciles **all** of
them, each scoped to its own build — see [Multi-build (monorepo)](#multi-build-monorepo).

## Division of labour

- **Authoring** — `register-build` phase 2 (run where the integration's target-DB
  access exists) discovers the read/write surface, resolves property names →
  Notion ids, and writes them into the integration repo's `bindings.json`. Ids
  live in the manifest, so CI never touches the target databases.
- **CI — sync (this action, default mode)** — on merge to `main`, reads the
  manifest and reconciles that build's rows in Synced Properties.
- **CI — verify (this action, `mode: verify`)** — a PR gate that fails when a PR
  changes the build's Notion property call-sites but leaves `bindings.json`
  untouched, so the manifest can't silently drift from the code. No token; reads
  no Notion. See [Drift gate](#drift-gate-verify-mode).

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
    paths: ['bindings.json', '*/bindings.json']
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

## Multi-build (monorepo)

One workflow pair covers the whole repo — the reconcile system handles the N builds
inside, so `register-build` can drop a single sync + verify pair per caller.

- **Discovery** globs `bindings.json` and `*/bindings.json` — the **repo root** and
  each **top-level service folder**, matching the register-build convention that a
  build's manifest lives at its build root. This is depth-0 + depth-1 only, *not*
  recursive: a stray `bindings.json` in a fixture or vendored copy is never swept
  into the live mapping DB. `node_modules/` and `.git/` are excluded. A build nested
  deeper (`services/foo/bindings.json`) is out of convention — point at it with the
  explicit `manifest:` input.
- **Per-build isolation.** Each manifest reconciles only *its* build's rows
  (`Build relation contains buildPageId`), so build A's manifest can never create or
  prune build B's rows. Order doesn't matter; re-runs are idempotent.
- **Fail-loud, don't fail-fast.** Every manifest is processed; a malformed one
  (missing `buildPageId`, unresolved `propertyId`, bad direction) is reported and
  the run still fails non-zero at the end — so one bad manifest can't mask the others
  and a partial apply is safe to re-run.
- **Single explicit manifest.** Set `manifest: path/to/bindings.json` to sync/verify
  exactly one file (skips discovery). Empty (the default) = discover all.

## Drift gate (verify mode)

`sync` trusts `bindings.json` blindly — it reconciles whatever the manifest says.
That is only safe if the manifest tracks the code. The **verify** mode is the
guard: run it as a `pull_request` check (companion to the on-merge sync job). It
scans the PR's own diff (`base...head`) for Notion call-site tokens — `pages.create`,
`pages.update`, `dataSources`, `data_source_id`, `database_id`, `properties:`/`=`,
`.query(` — on added/removed lines. If any fire **and** `bindings.json` is not in
the same PR, it fails the check.

It is a heuristic, not a parser: false positives are expected and cheap to wave
through; a silent miss is what we refuse to allow. Behaviour:

- **Self-gating** — does nothing unless a `bindings.json` exists somewhere (= a
  registered build).
- **Per-build attribution (monorepo).** Each offending code file is attributed to
  its **nearest-ancestor** manifest directory (a root manifest owns everything not
  under a deeper one). It passes only if *that* build's `bindings.json` is in the
  PR — so drift in `drive-worker/` isn't waved through just because
  `contacts-worker/bindings.json` was touched. Single-manifest repos behave exactly
  as before. A code file with **no** ancestor manifest (undeclared surface) always
  offends.
- **Opt-out** — `[skip-bindings-check]` in the PR title, a `skip-bindings-check`
  label, or a `"verifyIgnore": ["path/fragment"]` array in a manifest (unioned across
  all manifests).
- **No token, no Notion calls.** Needs the PR base/head SHAs and a full checkout
  (`fetch-depth: 0`) so the `base...head` diff resolves.

Add `.github/workflows/verify-bindings.yml` (this repo dogfoods the same file):

```yaml
name: Verify property bindings (drift gate)
on:
  pull_request:
jobs:
  verify-bindings:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: mf-consulting-notion/notion-bindings-sync@v1
        with:
          mode: verify
          base-sha: ${{ github.event.pull_request.base.sha }}
          head-sha: ${{ github.event.pull_request.head.sha }}
          pr-title: ${{ github.event.pull_request.title }}
          pr-labels: ${{ join(github.event.pull_request.labels.*.name, '\n') }}
```

The gate needs no secret, so it works on forks and needs no per-repo setup beyond
this file. When `register-build` scaffolds a caller, it can drop both the sync and
verify workflows together — a single pair per caller, whether the repo holds one
build or many (discovery + per-build attribution handle the rest).

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

`MANIFEST` set = that one file; `MANIFEST` unset = discover all build manifests under
the cwd (root + top-level service folders), same as CI.

```
# one explicit manifest
NOTION_TOKEN='ntn_…' DRY_RUN=1 MANIFEST=/abs/path/to/bindings.json node sync-bindings.mjs

# discover every build manifest in this checkout
cd /path/to/caller-repo && NOTION_TOKEN='ntn_…' DRY_RUN=1 node /path/to/sync-bindings.mjs
```

Verify the drift gate locally against a PR range (no token):

```
BASE_SHA=$(git merge-base origin/main HEAD) HEAD_SHA=$(git rev-parse HEAD) \
  PR_TITLE="$(git log -1 --format=%s)" node verify-bindings.mjs
```

Run the unit tests: `node --test`.
