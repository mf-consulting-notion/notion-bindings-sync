/**
 * Deterministic Build→Property binding sync (shared composite-action script).
 *
 * Reads a repo's committed `bindings.json` — the declared source of truth for
 * which Notion properties an integration reads/writes, WITH ids already resolved
 * at authoring time (register-build phase 2) — and reconciles it into the MF
 * "Synced Properties" mapping DB that Yanta bi-syncs (ADR 0007). Scoped to one
 * build.
 *
 * Deliberately resolution-free: it never reads the integration's target
 * databases, so the token needs access to only two MF databases — WRITE on
 * Synced Properties and READ on Builds (for the Build relation). That's what
 * lets ONE MF-scoped token serve every integration, including ones that write
 * to client workspaces (their db/property ids ride in the manifest as plain
 * text). A binding missing its `propertyId` FAILS the run — resolution is the
 * authoring tool's job, not CI's.
 *
 * Env: NOTION_TOKEN (required in sync), SYNCED_PROPERTIES_DS, MANIFEST (empty =
 * discover build manifests; a path = one explicit manifest), DRY_RUN (1/true =
 * report only). Zero dependencies — plain Node 22 (global fetch, fs.globSync).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverManifests } from "./manifests.mjs";

const NOTION_VERSION = "2025-09-03";
const BASE = "https://api.notion.com";
const REQUEST_GAP_MS = 350;
const SYNCED_PROPERTIES_DS = process.env.SYNCED_PROPERTIES_DS || "7d1aeaec-129e-4dde-9040-5761c86aef54";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
export const DIRECTION_LABEL = { read: "Read", write: "Write", both: "Both" };
// Validation ownership: this CI only DECLARES bindings and therefore only ever
// invalidates — new/changed rows get status "Pending validation" and cleared
// validator fields. Setting "Validated"/"Stale"/"Unresolved", "Last validated at"
// and "Validation source" is the validator's job (Make Agent with Yanta MCP).
export const PENDING_STATUS = "Pending validation";

// A page's BODY (its block content) is a real dependency but has no Notion
// property id, so it cannot be named the way every other binding is. It rides on
// a reserved sentinel id instead: `${dbId}::page_body` keys, diffs and prunes
// exactly like a property row, so reconcile/prune/validation learn nothing new.
// Grain is per DATABASE ("this build touches row bodies in this DB"), never per
// page — bindings are declared per database, so that is the only honest grain.
export const BODY_TARGET = "body";
export const BODY_PROPERTY_ID = "page_body";
export const BODY_PROPERTY_NAME = "Page body";

/**
 * Pure: one binding entry → its Synced Properties identity ({propName, propertyId}),
 * or null when the id is not resolved yet (the caller aggregates those).
 *
 * A `target` binding names something with no property id of its own — currently
 * only the page body. A binding that hand-writes the sentinel id instead is
 * normalized onto the SAME identity, so the two spellings can never produce two
 * rows for one dependency. An unknown target throws rather than no-opping: a
 * future target must fail loud on an action that predates it, not vanish.
 */
function bindingIdentity(b, label, where) {
  if (b.target !== undefined) {
    if (b.target !== BODY_TARGET) {
      throw new Error(`${label}: unknown binding target "${b.target}" for ${where} (the only target is "${BODY_TARGET}")`);
    }
    return { propName: BODY_PROPERTY_NAME, propertyId: BODY_PROPERTY_ID };
  }
  if (b.propertyId === BODY_PROPERTY_ID) return { propName: BODY_PROPERTY_NAME, propertyId: BODY_PROPERTY_ID };
  if (!b.propertyId) return null;
  return { propName: b.property, propertyId: b.propertyId };
}

/**
 * Pure: a database entry's optional `via` provenance marker, or undefined.
 *
 * Most bindings are evidenced by a call site in the repo — `register-build` phase 2
 * finds them by grepping for Notion API calls. A build that reads a database through
 * an AGGREGATING endpoint has no such call site: the properties it depends on are
 * materialized server-side and never appear in its code, so a grep concludes "this
 * build syncs nothing" while the coupling is real and invisible. `via` records how
 * the dependency arises, so a hand-authored binding reads as a deliberate API
 * declaration rather than as parsing code someone forgot to write.
 *
 * Declaration only: it is NOT written to Synced Properties. The property rows it
 * annotates already produce the Yanta edge; `via` exists for whoever next authors
 * or re-captures this manifest. Putting it on the wire would mean a schema change
 * on a shared DB plus a Yanta harvest change for information no consumer reads yet.
 */
function parseVia(db, label) {
  if (db.via === undefined) return undefined;
  if (typeof db.via !== "string" || !db.via.trim()) {
    throw new Error(`${label}: "via" for ${db.name ?? db.id} must be a non-empty string (e.g. "api:/v1/ai/plugins")`);
  }
  return db.via.trim();
}

/**
 * Pure: manifest JSON → normalized reconcile input. Throws on structural problems
 * (missing buildPageId/workspaceNotionId, bad direction, target or via, a duplicate
 * binding, any binding missing a resolved propertyId — with the full unresolved
 * list). `label` names the manifest in error messages (defaults to a generic tag).
 */
export function parseManifest(manifest, label = "bindings.json") {
  const buildPageId = manifest.buildPageId;
  const workspaceNotionId = manifest.workspaceNotionId;
  if (!buildPageId) throw new Error(`${label}: missing buildPageId`);
  if (!workspaceNotionId) throw new Error(`${label}: missing workspaceNotionId`);

  const desired = [];
  const unresolved = [];
  const seen = new Set();
  for (const db of manifest.databases ?? []) {
    const via = parseVia(db, label);
    for (const b of db.bindings ?? []) {
      const where = `${db.name ?? db.id} → ${b.target !== undefined ? b.target : `"${b.property}"`}`;
      const identity = bindingIdentity(b, label, where);
      if (!identity) {
        unresolved.push(`${db.name ?? db.id} → "${b.property}"`);
        continue;
      }
      if (!DIRECTION_LABEL[b.direction]) {
        throw new Error(`${label}: bad direction "${b.direction}" for ${db.id} → ${identity.propName}`);
      }
      // computeDiff keys rows but does not deduplicate `desired`: a key declared
      // twice would create the row twice. Rare for named properties, easy to hit
      // with the nameless body target (same DB listed twice) — so fail loud.
      const key = `${db.id}::${identity.propertyId}`;
      if (seen.has(key)) throw new Error(`${label}: duplicate binding ${where} — ${key} is declared twice`);
      seen.add(key);
      desired.push({
        key,
        propName: identity.propName,
        propertyId: identity.propertyId,
        dbId: db.id,
        direction: b.direction,
        // Declaration-only (never written to Notion); omitted entirely when unset
        // so the reconcile row shape is unchanged for the overwhelming majority.
        ...(via !== undefined && { via }),
      });
    }
  }
  if (unresolved.length) {
    throw new Error(
      `${label}: bindings missing a resolved propertyId (run register-build phase 2 to fill ids):\n  ` +
        unresolved.join("\n  "),
    );
  }
  return { buildPageId, workspaceNotionId, desired };
}

/**
 * Pure: the network-free reconcile diff. `existing` is a Map keyed by
 * `${dbId}::${propertyId}` of the build's current Synced Properties rows.
 */
export function computeDiff(desired, existing) {
  const desiredByKey = new Map(desired.map((d) => [d.key, d]));
  const toCreate = desired.filter((d) => !existing.has(d.key));
  const toUpdate = desired.filter((d) => {
    const e = existing.get(d.key);
    // Empty validationStatus self-heals rows created before the validation
    // properties existed (converges on the next regular run, no manual backfill).
    return e && (e.direction !== DIRECTION_LABEL[d.direction] || e.propName !== d.propName || !e.validationStatus);
  });
  const toPrune = [...existing.values()].filter((e) => !desiredByKey.has(e.key));
  const unchanged = desired.length - toCreate.length - toUpdate.length;
  return { toCreate, toUpdate, toPrune, unchanged };
}

/**
 * Reconcile ONE parsed manifest via injected side-effects. Network-free in tests.
 * deps = { fetchExisting(buildPageId)->Map, createRow(d,build,ws), updateRow(pageId,d),
 *          archiveRow(pageId), dryRun, log(msg) }. Returns the applied diff.
 * Prune is structurally build-scoped: `existing` only ever holds this build's rows.
 */
export async function reconcileManifest(parsed, deps) {
  const { buildPageId, workspaceNotionId, desired } = parsed;
  const existing = await deps.fetchExisting(buildPageId);
  const diff = computeDiff(desired, existing);
  const { toCreate, toUpdate, toPrune, unchanged } = diff;

  deps.log(
    `bindings sync (${deps.dryRun ? "DRY RUN" : "apply"}) — build ${buildPageId}\n` +
      `  create ${toCreate.length} · update ${toUpdate.length} · prune ${toPrune.length} · unchanged ${unchanged}`,
  );
  for (const d of toCreate) deps.log(`  + ${d.dbId.slice(0, 8)} ${d.propName} [${d.direction}]${viaNote(d)}`);
  for (const d of toUpdate) deps.log(`  ~ ${d.dbId.slice(0, 8)} ${d.propName} [${d.direction}]${viaNote(d)}`);
  for (const e of toPrune) deps.log(`  - ${e.dbId.slice(0, 8)} ${e.propName}`);
  if (deps.dryRun) return diff;

  for (const d of toCreate) await deps.createRow(d, buildPageId, workspaceNotionId);
  for (const d of toUpdate) await deps.updateRow(existing.get(d.key).pageId, d);
  for (const e of toPrune) await deps.archiveRow(e.pageId);
  return diff;
}

/** CI-log suffix naming a binding's non-code provenance, or "" for the normal case. */
function viaNote(d) {
  return d.via ? ` (via ${d.via})` : "";
}

/**
 * Drive every discovered manifest. A malformed manifest is RECORDED and the loop
 * continues (builds are prune-isolated, so a partial apply corrupts nothing and
 * re-runs idempotently); the caller fails the run non-zero if `failures` is
 * non-empty. Returns { applied: label[], failures: {manifest,error}[] }.
 */
export async function syncAll(manifestPaths, deps) {
  const applied = [];
  const failures = [];
  for (const path of manifestPaths) {
    const label = deps.labelFor(path);
    try {
      const parsed = parseManifest(deps.readManifest(path), label);
      await reconcileManifest(parsed, deps);
      applied.push(label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ manifest: label, error: msg });
      deps.log(`bindings sync: FAILED ${label} — ${msg}`);
    }
  }
  return { applied, failures };
}

async function main() {
  const override = process.env.MANIFEST;
  // Explicit override → exactly that file (missing = throw, back-compat). Otherwise
  // discover the build manifests in the caller checkout (cwd = GITHUB_WORKSPACE).
  const manifestPaths = override ? [resolve(process.cwd(), override)] : discoverManifests(process.cwd());
  if (manifestPaths.length === 0) {
    console.log("bindings sync: no bindings.json found in the checkout — nothing to sync.");
    return;
  }

  // Only now that there's work to do is the token required.
  const TOKEN = req("NOTION_TOKEN");
  const deps = {
    dryRun: DRY_RUN,
    log: (m) => console.log(m),
    labelFor: (p) => p.slice(process.cwd().length + 1) || p,
    readManifest: (p) => JSON.parse(readFileSync(p, "utf8")),
    fetchExisting: (buildPageId) => existingRowsForBuild(buildPageId, TOKEN),
    createRow: (d, build, ws) => createRow(d, build, ws, TOKEN),
    updateRow: (pageId, d) => updateRow(pageId, d, TOKEN),
    archiveRow: (pageId) => archiveRow(pageId, TOKEN),
  };

  const { applied, failures } = await syncAll(manifestPaths, deps);
  if (failures.length) {
    console.error(
      `bindings sync: ${failures.length} of ${manifestPaths.length} manifest(s) failed:\n  ` +
        failures.map((f) => `${f.manifest}: ${f.error}`).join("\n  "),
    );
    process.exit(1);
  }
  console.log(`done — ${applied.length} manifest(s) reconciled.`);
}

async function existingRowsForBuild(buildPageId, TOKEN) {
  const out = new Map();
  let cursor;
  do {
    const res = await request(`/v1/data_sources/${SYNCED_PROPERTIES_DS}/query`, "POST", {
      filter: { property: "Build", relation: { contains: buildPageId } },
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    }, TOKEN);
    for (const r of res.results) {
      const propertyId = plain(r.properties["Property Notion ID"]?.rich_text);
      const dbId = plain(r.properties["Database Notion ID"]?.rich_text);
      if (!propertyId || !dbId) continue;
      const key = `${dbId}::${propertyId}`;
      out.set(key, {
        key,
        pageId: r.id,
        propName: plain(r.properties["Property Name"]?.title),
        dbId,
        direction: r.properties["Direction"]?.select?.name ?? "",
        validationStatus: r.properties["Validation status"]?.select?.name ?? "",
      });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

function createRow(d, buildPageId, workspaceNotionId, TOKEN) {
  return request("/v1/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: SYNCED_PROPERTIES_DS },
    properties: {
      "Property Name": { title: [{ text: { content: d.propName } }] },
      "Property Notion ID": { rich_text: [{ text: { content: d.propertyId } }] },
      "Database Notion ID": { rich_text: [{ text: { content: d.dbId } }] },
      "Workspace Notion ID": { rich_text: [{ text: { content: workspaceNotionId } }] },
      Build: { relation: [{ id: buildPageId }] },
      Direction: { select: { name: DIRECTION_LABEL[d.direction] } },
      "Validation status": { select: { name: PENDING_STATUS } },
    },
  }, TOKEN);
}

function updateRow(pageId, d, TOKEN) {
  return request(`/v1/pages/${pageId}`, "PATCH", {
    properties: {
      "Property Name": { title: [{ text: { content: d.propName } }] },
      Direction: { select: { name: DIRECTION_LABEL[d.direction] } },
      // A changed declaration voids any prior validation — reset to pending and
      // clear the validator-owned fields.
      "Validation status": { select: { name: PENDING_STATUS } },
      "Last validated at": { date: null },
      "Validation source": { select: null },
    },
  }, TOKEN);
}

// Archived rows drop out of Yanta's next fetch, so its own prune removes them.
function archiveRow(pageId, TOKEN) {
  return request(`/v1/pages/${pageId}`, "PATCH", { archived: true }, TOKEN);
}

function plain(rt) {
  return (rt ?? []).map((t) => t.plain_text ?? "").join("").trim();
}

let lastRequestAt = 0;
async function request(path, method, body, TOKEN) {
  const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`Notion ${res.status} on ${method} ${path}: ${await res.text()}`);
  return res.json();
}

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

// Only run when executed directly — keeps the exports import-safe for tests.
if (process.argv[1] && resolve(process.argv[1]).endsWith("sync-bindings.mjs")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
