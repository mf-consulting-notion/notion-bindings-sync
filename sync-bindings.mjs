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
 * databases, so the token needs access to only three MF databases — WRITE on
 * Synced Properties, READ on Builds (for the Build relation) and READ on Pieces
 * (for the Bound to relation and the pieceId preflight). That's what
 * lets ONE MF-scoped token serve every integration, including ones that write
 * to client workspaces (their db/property ids ride in the manifest as plain
 * text). A binding missing its `propertyId` FAILS the run — resolution is the
 * authoring tool's job, not CI's.
 *
 * Env: NOTION_TOKEN (required in sync), SYNCED_PROPERTIES_DS, PIECES_DS, MANIFEST (empty =
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
// Pieces (Process Model V1): the target of Synced Properties' `Bound to`. Read
// only — to check a manifest's pieceIds before any write.
export const PIECES_DS = process.env.PIECES_DS || "99ff84d6-11be-4a5e-bb68-96317ab07410";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
export const DIRECTION_LABEL = { read: "Read", write: "Write", both: "Both" };
// Validation ownership: this CI only DECLARES bindings and therefore only ever
// invalidates — new/changed rows get status "Pending validation" and cleared
// validator fields. Setting "Validated"/"Stale"/"Unverifiable", "Last validated at"
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
 * Pure: a Notion page id in any accepted spelling (dashed or 32-hex, any case) →
 * lowercase dashed, the form the API returns in relations; null if it isn't one.
 * Keys compare manifest ids against `Bound to` ids, so both sides must agree.
 */
export function normalizePageId(v) {
  if (typeof v !== "string") return null;
  const hex = v.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Key segment for an explicitly Unresolved binding (`"pieceId": null`). Not a page
// id, so it can never collide with a real Piece.
const UNRESOLVED_KEY = "unresolved";

/**
 * Pure: the `pieceId` declared on one manifest level — undefined (not declared
 * here), null (explicitly Unresolved) or a normalized page id. A malformed value
 * throws: a typo must not silently turn a binding Unresolved.
 */
function parsePieceId(holder, label, where) {
  if (!Object.hasOwn(holder, "pieceId")) return undefined;
  if (holder.pieceId === null) return null;
  const id = normalizePageId(holder.pieceId);
  if (!id) {
    throw new Error(`${label}: bad pieceId ${JSON.stringify(holder.pieceId)} for ${where} (expected a Pieces page id or null)`);
  }
  return id;
}

/**
 * Pure: a manifest is Piece-aware as soon as ANY level declares `pieceId` (null
 * included). From then on every binding must resolve one — see parseManifest.
 */
function isPieceAware(manifest) {
  return (
    Object.hasOwn(manifest, "pieceId") ||
    (manifest.databases ?? []).some(
      (db) => Object.hasOwn(db, "pieceId") || (db.bindings ?? []).some((b) => Object.hasOwn(b, "pieceId")),
    )
  );
}

/**
 * Pure: manifest JSON → normalized reconcile input. Throws on structural problems
 * (missing buildPageId/workspaceNotionId, bad direction, target, via or pieceId, a
 * duplicate binding, any binding missing a resolved propertyId — with the full
 * unresolved list — and, in a Piece-aware manifest, any binding without a pieceId).
 * `label` names the manifest in error messages (defaults to a generic tag).
 *
 * Piece-aware manifests (Process Model V1) bind each row to the Piece whose code
 * makes the call: `pieceId` on the binding, else its database entry, else the
 * manifest's top level; `null` = explicitly Unresolved. Their keys carry the Piece,
 * so one property touched by two Pieces is two rows. Legacy manifests keep the
 * `${dbId}::${propertyId}` key and no `pieceId` at all.
 */
export function parseManifest(manifest, label = "bindings.json") {
  const buildPageId = manifest.buildPageId;
  const workspaceNotionId = manifest.workspaceNotionId;
  if (!buildPageId) throw new Error(`${label}: missing buildPageId`);
  if (!workspaceNotionId) throw new Error(`${label}: missing workspaceNotionId`);

  const pieceAware = isPieceAware(manifest);
  const topPiece = parsePieceId(manifest, label, "the manifest");
  const desired = [];
  const unresolved = [];
  const pieceless = [];
  const seen = new Set();
  for (const db of manifest.databases ?? []) {
    const via = parseVia(db, label);
    // Not `??`: an explicit null (Unresolved) must override an inherited Piece.
    const ownDbPiece = parsePieceId(db, label, db.name ?? db.id);
    const dbPiece = ownDbPiece !== undefined ? ownDbPiece : topPiece;
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
      const ownPiece = parsePieceId(b, label, where);
      const pieceId = ownPiece !== undefined ? ownPiece : dbPiece;
      if (pieceAware && pieceId === undefined) {
        pieceless.push(where);
        continue;
      }
      // computeDiff keys rows but does not deduplicate `desired`: a key declared
      // twice would create the row twice. Rare for named properties, easy to hit
      // with the nameless body target (same DB listed twice) — so fail loud.
      const key = pieceAware
        ? `${pieceId ?? UNRESOLVED_KEY}::${db.id}::${identity.propertyId}`
        : `${db.id}::${identity.propertyId}`;
      if (seen.has(key)) throw new Error(`${label}: duplicate binding ${where} — ${key} is declared twice`);
      seen.add(key);
      desired.push({
        key,
        propName: identity.propName,
        propertyId: identity.propertyId,
        dbId: db.id,
        direction: b.direction,
        // Omitted entirely in legacy manifests, so their row shape is unchanged.
        ...(pieceAware && { pieceId }),
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
  if (pieceless.length) {
    throw new Error(
      `${label}: this manifest names Pieces, so every binding needs a pieceId ` +
        `(a Pieces page id, or null for Unresolved) — missing on:\n  ` +
        pieceless.join("\n  "),
    );
  }
  return { buildPageId, workspaceNotionId, pieceAware, desired };
}

/** Pure: an existing row's reconcile key — the same shape parseManifest gives `desired`. */
function rowKey(e, pieceAware) {
  return pieceAware ? `${e.pieceId ?? UNRESOLVED_KEY}::${e.dbId}::${e.propertyId}` : `${e.dbId}::${e.propertyId}`;
}

/**
 * Pure: does this row need its declaration rewritten (and validation voided)?
 * Empty validationStatus self-heals rows created before the validation
 * properties existed (converges on the next regular run, no manual backfill).
 */
function declarationChanged(e, d) {
  return e.direction !== DIRECTION_LABEL[d.direction] || e.propName !== d.propName || !e.validationStatus;
}

/**
 * Pure: the network-free reconcile diff. `existing` is the build's current
 * Synced Properties rows ({pageId, propName, dbId, propertyId, direction,
 * validationStatus, pieceId}). Returns
 *   { toCreate: desired[], toUpdate: change[], toRepoint: change[], toPrune: row[], unchanged }
 * with change = { row, d, resetValidation }.
 *
 * Piece-aware (`pieceAware: true`): rows key on Piece × database × property. A
 * desired row with no exact match takes over a leftover row of the SAME database ×
 * property instead of prune + create — a RE-POINT that only moves `Bound to`, so
 * the row keeps its page id and its validation state (validation concerns the
 * schema, not the Piece). Leftover rows are offered Build-grain first, then by
 * page id; desired rows claim them in manifest order. This one rule covers
 * adopting Build-grain rows, moving between Pieces and falling back to Unresolved.
 *
 * Legacy: keys ignore the Piece, exactly as before Piece-aware manifests — and a
 * Build that already has Piece-grain rows is refused, because dropping pieceIds
 * would silently un-bind or collide them.
 */
export function computeDiff(desired, existing, { pieceAware = false } = {}) {
  if (!pieceAware) {
    const bound = existing.filter((e) => e.pieceId);
    if (bound.length) {
      throw new Error(
        `this Build already has ${bound.length} Piece-bound row(s) in Synced Properties, but the manifest names no ` +
          `Piece — add the pieceIds back (or "pieceId": null for Unresolved) instead of dropping them`,
      );
    }
  }

  // Index existing rows by key. Duplicates (two rows, one key) converge: the
  // lowest page id stays, the rest prune.
  const byKey = new Map();
  const toPrune = [];
  for (const e of existing) {
    const key = rowKey(e, pieceAware);
    const held = byKey.get(key);
    if (!held) {
      byKey.set(key, e);
    } else {
      const [keep, drop] = e.pageId < held.pageId ? [e, held] : [held, e];
      byKey.set(key, keep);
      toPrune.push(drop);
    }
  }

  const toUpdate = [];
  const leftoverDesired = [];
  let unchanged = 0;
  for (const d of desired) {
    const e = byKey.get(d.key);
    if (!e) leftoverDesired.push(d);
    else if (declarationChanged(e, d)) toUpdate.push({ row: e, d, resetValidation: true });
    else unchanged++;
    if (e) byKey.delete(d.key);
  }
  const leftoverRows = [...byKey.values()];

  const toCreate = [];
  const toRepoint = [];
  if (pieceAware) {
    const slot = (x) => `${x.dbId}::${x.propertyId}`;
    const free = new Map();
    // Build-grain rows first (adopting them is the migration), then by page id.
    const order = (a, b) => {
      if ((a.pieceId === null) !== (b.pieceId === null)) return a.pieceId === null ? -1 : 1;
      return a.pageId < b.pageId ? -1 : 1;
    };
    for (const e of [...leftoverRows].sort(order)) {
      if (!free.has(slot(e))) free.set(slot(e), []);
      free.get(slot(e)).push(e);
    }
    for (const d of leftoverDesired) {
      const e = free.get(slot(d))?.shift();
      if (e) toRepoint.push({ row: e, d, resetValidation: declarationChanged(e, d) });
      else toCreate.push(d);
    }
    for (const rest of free.values()) toPrune.push(...rest);
  } else {
    toCreate.push(...leftoverDesired);
    toPrune.push(...leftoverRows);
  }
  return { toCreate, toUpdate, toRepoint, toPrune, unchanged };
}

/**
 * Reconcile ONE parsed manifest via injected side-effects. Network-free in tests.
 * deps = { checkPieces(pieceIds,build), fetchExisting(buildPageId)->row[],
 *          createRow(d,build,ws), updateRow(pageId,payload), archiveRow(pageId),
 *          dryRun, log(msg) }. Returns the applied diff.
 * Prune is structurally build-scoped: `existing` only ever holds this build's rows.
 * Named Pieces are checked first — also in a dry run — so a wrong pieceId fails
 * before anything is read or written.
 */
export async function reconcileManifest(parsed, deps) {
  const { buildPageId, workspaceNotionId, pieceAware, desired } = parsed;
  const pieceIds = [...new Set(desired.map((d) => d.pieceId).filter(Boolean))];
  if (pieceIds.length) await deps.checkPieces(pieceIds, buildPageId);
  const existing = await deps.fetchExisting(buildPageId);
  const diff = computeDiff(desired, existing, { pieceAware });
  const { toCreate, toUpdate, toRepoint, toPrune, unchanged } = diff;

  // Legacy manifests log exactly what they always did; the Piece counts appear
  // only once a manifest names Pieces.
  const pieceCounts = pieceAware
    ? ` · re-point ${toRepoint.length}` + ` · unresolved ${desired.filter((d) => d.pieceId === null).length}`
    : "";
  deps.log(
    `bindings sync (${deps.dryRun ? "DRY RUN" : "apply"}) — build ${buildPageId}\n` +
      `  create ${toCreate.length} · update ${toUpdate.length} · prune ${toPrune.length} · unchanged ${unchanged}` +
      pieceCounts,
  );
  for (const d of toCreate) deps.log(`  + ${d.dbId.slice(0, 8)} ${d.propName} [${d.direction}]${pieceNote(d.pieceId)}${viaNote(d)}`);
  for (const { d } of toUpdate) deps.log(`  ~ ${d.dbId.slice(0, 8)} ${d.propName} [${d.direction}]${viaNote(d)}`);
  for (const { row, d } of toRepoint) {
    deps.log(`  > ${d.dbId.slice(0, 8)} ${d.propName} ${shortPiece(row.pieceId)} → ${shortPiece(d.pieceId)}`);
  }
  for (const e of toPrune) deps.log(`  - ${e.dbId.slice(0, 8)} ${e.propName}${pieceAware ? pieceNote(e.pieceId) : ""}`);
  if (deps.dryRun) return diff;

  for (const d of toCreate) await deps.createRow(d, buildPageId, workspaceNotionId);
  for (const c of toUpdate) await deps.updateRow(c.row.pageId, updatePayload(c, { setPiece: false }));
  for (const c of toRepoint) await deps.updateRow(c.row.pageId, updatePayload(c, { setPiece: true }));
  for (const e of toPrune) await deps.archiveRow(e.pageId);
  return diff;
}

/** CI-log form of a Piece: its first 8 hex chars, or ∅ for Unresolved. */
function shortPiece(pieceId) {
  return pieceId ? pieceId.slice(0, 8) : "∅";
}

/** CI-log suffix naming the Piece of a Piece-grain row, or "" for a legacy one. */
function pieceNote(pieceId) {
  return pieceId === undefined ? "" : ` @${shortPiece(pieceId)}`;
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
    checkPieces: (pieceIds, buildPageId) => checkPieces(pieceIds, buildPageId, TOKEN),
    fetchExisting: (buildPageId) => existingRowsForBuild(buildPageId, TOKEN),
    createRow: (d, build, ws) => request("/v1/pages", "POST", createPayload(d, build, ws), TOKEN),
    updateRow: (pageId, payload) => request(`/v1/pages/${pageId}`, "PATCH", payload, TOKEN),
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
  const out = [];
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
      out.push({
        pageId: r.id,
        propName: plain(r.properties["Property Name"]?.title),
        dbId,
        propertyId,
        direction: r.properties["Direction"]?.select?.name ?? "",
        validationStatus: r.properties["Validation status"]?.select?.name ?? "",
        pieceId: r.properties["Bound to"]?.relation?.[0]?.id ?? null,
      });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Pure: POST body for a new Synced Properties row. `Build` is always written
 * (still the prune scope and still read downstream); `Bound to` only for a named
 * Piece — an Unresolved or legacy row leaves it empty, which Resolution reads as
 * Unresolved. Never falls back to the Build.
 */
export function createPayload(d, buildPageId, workspaceNotionId) {
  return {
    parent: { type: "data_source_id", data_source_id: SYNCED_PROPERTIES_DS },
    properties: {
      "Property Name": { title: [{ text: { content: d.propName } }] },
      "Property Notion ID": { rich_text: [{ text: { content: d.propertyId } }] },
      "Database Notion ID": { rich_text: [{ text: { content: d.dbId } }] },
      "Workspace Notion ID": { rich_text: [{ text: { content: workspaceNotionId } }] },
      Build: { relation: [{ id: buildPageId }] },
      ...(typeof d.pieceId === "string" && { "Bound to": { relation: [{ id: d.pieceId }] } }),
      Direction: { select: { name: DIRECTION_LABEL[d.direction] } },
      "Validation status": { select: { name: PENDING_STATUS } },
    },
  };
}

/**
 * Pure: PATCH body for an update or a re-point (change = {d, resetValidation}).
 * `setPiece` writes `Bound to` (empty for Unresolved). Validation is voided only
 * when the declaration itself changed — a re-point alone keeps it, because
 * validation concerns the schema, not which Piece touches it.
 */
export function updatePayload({ d, resetValidation }, { setPiece }) {
  return {
    properties: {
      "Property Name": { title: [{ text: { content: d.propName } }] },
      Direction: { select: { name: DIRECTION_LABEL[d.direction] } },
      ...(setPiece && { "Bound to": { relation: d.pieceId ? [{ id: d.pieceId }] : [] } }),
      // A changed declaration voids any prior validation — reset to pending and
      // clear the validator-owned fields.
      ...(resetValidation && {
        "Validation status": { select: { name: PENDING_STATUS } },
        "Last validated at": { date: null },
        "Validation source": { select: null },
      }),
    },
  };
}

/**
 * Pure: why a fetched Pieces page can't take this Build's bindings ([] = fine).
 * Bindings exist only for live Pieces of the manifest's own Build — anything else
 * is a stale or mistyped pieceId that Notion would accept (or reject opaquely).
 */
export function pieceProblems(page, buildPageId) {
  const problems = [];
  if (normalizePageId(page.parent?.data_source_id) !== normalizePageId(PIECES_DS)) problems.push("is not a Pieces page");
  if (page.in_trash || page.archived) problems.push("is in the trash");
  const partOf = (page.properties?.["Part of"]?.relation ?? []).map((r) => normalizePageId(r.id));
  if (!partOf.includes(normalizePageId(buildPageId))) problems.push(`is not Part of build ${buildPageId}`);
  if (page.properties?.Lifecycle?.select?.name === "Retired") problems.push("is Retired (a Retired Piece has no bindings)");
  return problems;
}

/** Fetch each named Piece and fail with every problem at once (before any write). */
async function checkPieces(pieceIds, buildPageId, TOKEN) {
  const problems = [];
  for (const id of pieceIds) {
    try {
      const page = await request(`/v1/pages/${id}`, "GET", undefined, TOKEN);
      for (const p of pieceProblems(page, buildPageId)) problems.push(`${id} ${p}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`${id} could not be read (does the token have READ on Pieces?) — ${msg}`);
    }
  }
  if (problems.length) throw new Error(`Piece check failed:\n  ${problems.join("\n  ")}`);
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
