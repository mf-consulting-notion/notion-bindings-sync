/**
 * Shared, zero-dep manifest discovery + ownership for the bindings-sync action.
 *
 * A build's `bindings.json` sits at the BUILD ROOT, which — per the register-build
 * contract (one row per build; in a monorepo one row per top-level service folder)
 * — is either the repo root or a single top-level service folder. So discovery is
 * deliberately depth-0 + depth-1 only (root plus one directory level), NOT a
 * recursive glob: a recursive glob would sweep any stray manifest (a fixture, a
 * vendored copy) into the live Synced Properties DB. A build nested deeper (e.g.
 * a manifest two levels down) is out of convention — reach it with an explicit
 * MANIFEST override.
 *
 * Plain Node 22 (fs.globSync). No dependencies.
 */
import { globSync } from "node:fs";
import { resolve } from "node:path";

// Prune vendored / VCS dirs. globSync already skips `.git` by default; the depth-1
// glob would otherwise match `node_modules/bindings.json`, so exclude it explicitly.
const EXCLUDE_RE = /(^|\/)(node_modules|\.git)(\/|$)/;

/**
 * Discover build manifests under rootDir: the repo-root and any top-level
 * service-folder `bindings.json`. Returns absolute paths, deterministically sorted.
 */
export function discoverManifests(rootDir) {
  const rel = globSync(["bindings.json", "*/bindings.json"], {
    cwd: rootDir,
    exclude: (p) => EXCLUDE_RE.test(p),
  });
  return rel.map((p) => resolve(rootDir, p)).sort();
}

/**
 * The nearest-ancestor manifest directory that owns `file`, or null if none.
 * `manifestDirs` are POSIX dir prefixes: "" for the repo root, "drive-worker/" for
 * a service folder. Root ("") owns anything not under a deeper manifest. The
 * longest matching prefix wins; a trailing "/" keeps "drive-worker/" from
 * capturing "drive-worker-legacy/".
 */
export function ownerManifestDir(file, manifestDirs) {
  const f = file.split("\\").join("/");
  let owner = null;
  for (const dir of manifestDirs) {
    if (dir !== "" && !f.startsWith(dir)) continue;
    if (owner === null || dir.length > owner.length) owner = dir;
  }
  return owner;
}

/**
 * How many bindings a manifest declares explicitly Unresolved (`"pieceId": null`
 * on the binding, else its database entry, else the top level). Informational for
 * the verify gate — tolerant of malformed manifests (0), since sync is where those
 * fail.
 */
export function countExplicitUnresolved(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.databases)) return 0;
  const own = (holder, inherited) => (holder && Object.hasOwn(holder, "pieceId") ? holder.pieceId : inherited);
  let n = 0;
  for (const db of manifest.databases) {
    if (!db || !Array.isArray(db.bindings)) continue;
    const dbPiece = own(db, own(manifest, undefined));
    for (const b of db.bindings) if (own(b, dbPiece) === null) n++;
  }
  return n;
}
