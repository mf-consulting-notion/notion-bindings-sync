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
 * Env: NOTION_TOKEN (required), SYNCED_PROPERTIES_DS, MANIFEST (default
 * bindings.json), DRY_RUN (1/true = report only). Zero dependencies — plain
 * Node 20+ (global fetch).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const NOTION_VERSION = "2025-09-03";
const BASE = "https://api.notion.com";
const REQUEST_GAP_MS = 350;
const SYNCED_PROPERTIES_DS = process.env.SYNCED_PROPERTIES_DS || "7d1aeaec-129e-4dde-9040-5761c86aef54";
const MANIFEST = process.env.MANIFEST || "bindings.json";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const TOKEN = req("NOTION_TOKEN");
const DIRECTION_LABEL = { read: "Read", write: "Write", both: "Both" };

async function main() {
  // Manifest is read from the CALLER repo's checkout (cwd = GITHUB_WORKSPACE).
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), MANIFEST), "utf8"));
  const buildPageId = manifest.buildPageId;
  const workspaceNotionId = manifest.workspaceNotionId;
  if (!buildPageId) throw new Error(`${MANIFEST}: missing buildPageId`);
  if (!workspaceNotionId) throw new Error(`${MANIFEST}: missing workspaceNotionId`);

  // Build the desired set straight from the manifest — no Notion resolution.
  const desired = [];
  const unresolved = [];
  for (const db of manifest.databases ?? []) {
    for (const b of db.bindings ?? []) {
      if (!b.propertyId) {
        unresolved.push(`${db.name ?? db.id} → "${b.property}"`);
        continue;
      }
      if (!DIRECTION_LABEL[b.direction]) {
        throw new Error(`${MANIFEST}: bad direction "${b.direction}" for ${db.id} → ${b.property}`);
      }
      desired.push({
        key: `${db.id}::${b.propertyId}`,
        propName: b.property,
        propertyId: b.propertyId,
        dbId: db.id,
        direction: b.direction,
      });
    }
  }
  if (unresolved.length) {
    throw new Error(
      `bindings missing a resolved propertyId (run register-build phase 2 to fill ids):\n  ` + unresolved.join("\n  "),
    );
  }

  const existing = await existingRowsForBuild(buildPageId);
  const desiredByKey = new Map(desired.map((d) => [d.key, d]));
  const toCreate = desired.filter((d) => !existing.has(d.key));
  const toUpdate = desired.filter((d) => {
    const e = existing.get(d.key);
    return e && (e.direction !== DIRECTION_LABEL[d.direction] || e.propName !== d.propName);
  });
  const toPrune = [...existing.values()].filter((e) => !desiredByKey.has(e.key));
  const unchanged = desired.length - toCreate.length - toUpdate.length;

  console.log(
    `bindings sync (${DRY_RUN ? "DRY RUN" : "apply"}) — build ${buildPageId}\n` +
      `  create ${toCreate.length} · update ${toUpdate.length} · prune ${toPrune.length} · unchanged ${unchanged}`,
  );
  for (const d of toCreate) console.log(`  + ${d.dbId.slice(0, 8)} ${d.propName} [${d.direction}]`);
  for (const d of toUpdate) console.log(`  ~ ${d.dbId.slice(0, 8)} ${d.propName} [${d.direction}]`);
  for (const e of toPrune) console.log(`  - ${e.dbId.slice(0, 8)} ${e.propName}`);
  if (DRY_RUN) return;

  for (const d of toCreate) await createRow(d, buildPageId, workspaceNotionId);
  for (const d of toUpdate) await updateRow(existing.get(d.key).pageId, d);
  for (const e of toPrune) await archiveRow(e.pageId);
  console.log("done.");
}

async function existingRowsForBuild(buildPageId) {
  const out = new Map();
  let cursor;
  do {
    const res = await request(`/v1/data_sources/${SYNCED_PROPERTIES_DS}/query`, "POST", {
      filter: { property: "Build", relation: { contains: buildPageId } },
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
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
      });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

function createRow(d, buildPageId, workspaceNotionId) {
  return request("/v1/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: SYNCED_PROPERTIES_DS },
    properties: {
      "Property Name": { title: [{ text: { content: d.propName } }] },
      "Property Notion ID": { rich_text: [{ text: { content: d.propertyId } }] },
      "Database Notion ID": { rich_text: [{ text: { content: d.dbId } }] },
      "Workspace Notion ID": { rich_text: [{ text: { content: workspaceNotionId } }] },
      Build: { relation: [{ id: buildPageId }] },
      Direction: { select: { name: DIRECTION_LABEL[d.direction] } },
    },
  });
}

function updateRow(pageId, d) {
  return request(`/v1/pages/${pageId}`, "PATCH", {
    properties: {
      "Property Name": { title: [{ text: { content: d.propName } }] },
      Direction: { select: { name: DIRECTION_LABEL[d.direction] } },
    },
  });
}

// Archived rows drop out of Yanta's next fetch, so its own prune removes them.
function archiveRow(pageId) {
  return request(`/v1/pages/${pageId}`, "PATCH", { archived: true });
}

function plain(rt) {
  return (rt ?? []).map((t) => t.plain_text ?? "").join("").trim();
}

let lastRequestAt = 0;
async function request(path, method, body) {
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
