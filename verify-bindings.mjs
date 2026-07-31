/**
 * Bindings-drift PR gate — deterministic, heuristic, CI-only. No Notion, no token.
 *
 * The on-merge `sync-bindings.mjs` trusts `bindings.json` blindly: it reconciles
 * whatever the manifest says into Synced Properties. That is only safe if the
 * manifest actually tracks the code. This gate closes the gap — it fails a PR
 * that CHANGES a build's Notion property call-sites but leaves `bindings.json`
 * untouched, so the mapping DB can't silently drift from reality.
 *
 * It is a heuristic, not a parser. It scans the PR's own diff hunks (base...head)
 * for Notion read/write call-site tokens on added/removed lines. If any fire and
 * the manifest is NOT part of the same PR, it fails — forcing a human/agent to
 * either re-run `register-build` phase 2 (capture bindings) or opt out. False
 * positives are expected and cheap to wave through; a silent miss is the thing
 * we refuse to allow.
 *
 * Self-gating: does nothing unless `bindings.json` exists (= a registered build).
 * Opt-out: `[skip-bindings-check]` in the PR title, a `skip-bindings-check` label,
 * or a `verifyIgnore` path list in the manifest.
 *
 * Env: MANIFEST (default bindings.json), BASE_SHA, HEAD_SHA (PR base/head commits),
 * PR_TITLE, PR_LABELS (newline- or comma-separated). Zero deps — plain Node 20+.
 *
 * Exit 0 = clean (or skipped/opted-out). Exit 1 = drift (fails the check), or a
 * misconfiguration that stops the gate from being able to judge.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { discoverManifests, ownerManifestDir } from "./manifests.mjs";

const SKIP_MARKER = "[skip-bindings-check]";
const SKIP_LABEL = "skip-bindings-check";

// Extensions we treat as "code that could hold Notion call-sites". TS/JS-leaning
// by design (see the issue's scope note); a few others for polyglot builds.
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb)$/;

// The action's own scripts legitimately contain these tokens as pattern literals;
// never let the gate flag its own tooling when this repo dogfoods it.
const ALWAYS_IGNORE = new Set(["sync-bindings.mjs", "verify-bindings.mjs"]);

// Heuristic Notion call-site tokens. Each is [label, regex] tested per diff line.
export const TOKENS = [
  ["pages.create", /\bpages\.create\b/],
  ["pages.update", /\bpages\.update\b/],
  ["dataSources", /\bdataSources\b/],
  ["data_source_id", /\bdata_source_id\b/],
  ["database_id", /\bdatabase_id\b/],
  ["properties:/=", /\bproperties\s*[:=]/],
  [".query(", /\.query\s*\(/],
];

/** Scan a unified-diff string; return the set of token labels hit on +/- lines. */
export function scanDiffForTokens(diff) {
  const hits = new Set();
  for (const line of diff.split("\n")) {
    // Only added/removed content lines — not the +++/--- file headers.
    if ((line[0] !== "+" && line[0] !== "-") || line.startsWith("+++") || line.startsWith("---")) continue;
    const body = line.slice(1);
    for (const [label, re] of TOKENS) if (re.test(body)) hits.add(label);
  }
  return hits;
}

/** Opt-out decision from PR title + labels. Returns a reason string, or null. */
export function skipReason(prTitle, prLabels) {
  if (prTitle && prTitle.includes(SKIP_MARKER)) return `PR title carries ${SKIP_MARKER}`;
  // Tolerate every separator a caller might produce: real newline, comma, or the
  // LITERAL "\n" that `join(labels.*.name, '\n')` can emit in a GitHub expression.
  const labels = (prLabels || "")
    .split(/\\n|[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (labels.includes(SKIP_LABEL)) return `PR has the "${SKIP_LABEL}" label`;
  return null;
}

/** True if a changed file is a candidate for scanning (code, not ignored). */
export function isScannable(file, ignoreSubstrings) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (ALWAYS_IGNORE.has(base)) return false;
  if (!CODE_EXT.test(file)) return false;
  for (const frag of ignoreSubstrings) if (frag && file.includes(frag)) return false;
  return true;
}

/**
 * Per-directory drift attribution. Each changed code file whose diff fires a Notion
 * token is attributed to its nearest-ancestor manifest directory (`ownerManifestDir`).
 * It offends unless THAT manifest is part of the PR (`changedManifestDirs`). Files
 * with no ancestor manifest (owner === null) always offend — undeclared surface.
 * `diffFor(file)` yields the file's unified diff (or null to skip a deleted/renamed).
 */
export function findOffenders({ changedFiles, changedManifestDirs, manifestDirs, ignoreSubstrings, diffFor }) {
  const offenders = [];
  for (const file of changedFiles) {
    if (!isScannable(file, ignoreSubstrings)) continue;
    const diff = diffFor(file);
    if (!diff) continue;
    const hits = scanDiffForTokens(diff);
    if (!hits.size) continue;
    const owner = ownerManifestDir(file, manifestDirs);
    if (owner !== null && changedManifestDirs.has(owner)) continue; // author is on the owning manifest
    offenders.push({ file, tokens: [...hits], owner });
  }
  return offenders;
}

/** Human label for an owning manifest dir: "" -> root manifest, null -> none. */
function ownerLabel(owner) {
  if (owner === null) return "(no manifest covers this path)";
  return `${owner}bindings.json`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function pass(msg) {
  console.log(msg);
  process.exit(0);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function main() {
  const cwd = process.cwd();

  // Resolve the build manifests. Explicit MANIFEST override → exactly that file; a
  // missing override is a misconfiguration (a typo would otherwise silently disable
  // the gate), so it FAILS rather than self-gating. No override → discover every
  // root/top-level-service bindings.json, and self-gate only when none exist.
  const override = process.env.MANIFEST;
  let manifestPaths;
  if (override) {
    const abs = resolve(cwd, override);
    if (!existsSync(abs)) {
      fail(`bindings-verify: MANIFEST override "${override}" does not exist — cannot judge drift. Fix the path or unset it to auto-discover.`);
    }
    manifestPaths = [abs];
  } else {
    manifestPaths = discoverManifests(cwd);
    // 1. Self-gate: no registered build anywhere → nothing to protect.
    if (manifestPaths.length === 0) {
      pass("bindings-verify: no bindings.json in this repo — not a registered build, skipping.");
    }
  }

  // Relative manifest paths + their owning dir prefixes ("" = repo root).
  const relManifests = manifestPaths.map((p) => p.slice(cwd.length + 1));
  const manifestDirs = relManifests.map((r) => {
    const i = r.lastIndexOf("/");
    return i === -1 ? "" : r.slice(0, i + 1);
  });

  // 2. Opt-out.
  const skip = skipReason(process.env.PR_TITLE, process.env.PR_LABELS);
  if (skip) pass(`bindings-verify: skipped — ${skip}.`);

  // 3. Need the PR range to compute the diff.
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA;
  if (!base || !head) {
    fail(
      "bindings-verify: BASE_SHA and HEAD_SHA are required (pass github.event.pull_request.base.sha / head.sha, " +
        "and checkout with fetch-depth: 0). Cannot judge drift without the PR range.",
    );
  }

  let changed;
  try {
    changed = git(["diff", "--name-only", `${base}...${head}`]).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    fail(
      `bindings-verify: could not compute the diff ${base}...${head} — ${e.message}\n` +
        "Ensure the base commit is fetched (actions/checkout with fetch-depth: 0).",
    );
  }

  // 4. Which manifests' OWN dirs are part of this PR → author is on those builds.
  const changedSet = new Set(changed);
  const changedManifestDirs = new Set();
  relManifests.forEach((r, i) => {
    if (changedSet.has(r)) changedManifestDirs.add(manifestDirs[i]);
  });

  // 5. Attribute each drifting code file to its owning manifest; offend unless that
  //    manifest is in the PR. verifyIgnore is the union across all manifests.
  const ignoreSubstrings = readVerifyIgnore(manifestPaths);
  const offenders = findOffenders({
    changedFiles: changed,
    changedManifestDirs,
    manifestDirs,
    ignoreSubstrings,
    diffFor: (file) => {
      try {
        return git(["diff", `${base}...${head}`, "--", file]);
      } catch {
        return null; // deleted/renamed edge — don't block on it
      }
    },
  });

  if (offenders.length === 0) {
    pass("bindings-verify: no Notion call-site changes without a matching bindings.json update — clean.");
  }

  const lines = [
    "bindings-verify: this PR changes Notion property call-sites without updating the owning bindings.json.",
    "The Synced Properties mapping would drift from the code. Offending changes:",
    ...offenders.map((o) => `  • ${o.file}  [${o.tokens.join(", ")}]  → owner: ${ownerLabel(o.owner)}`),
    "",
    "Fix one of:",
    "  - Re-capture bindings: run register-build phase 2 (\"capture bindings\") and commit the updated bindings.json",
    "    for the offending build (a monorepo build owns the manifest in its own top-level folder).",
    `  - If this change does not affect the Notion property surface, opt out: add ${SKIP_MARKER} to the PR title`,
    `    or the "${SKIP_LABEL}" label, or add a path fragment to "verifyIgnore" in the owning bindings.json.`,
  ];
  fail(lines.join("\n"));
}

/** Union of every discovered manifest's verifyIgnore path fragments. */
function readVerifyIgnore(manifestPaths) {
  const out = [];
  for (const p of manifestPaths) {
    try {
      const m = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(m.verifyIgnore)) out.push(...m.verifyIgnore);
    } catch {
      // unreadable/unparseable manifest → contributes no ignores
    }
  }
  return out;
}

// Only run the gate when executed directly (keeps the exports import-safe for tests).
if (process.argv[1] && resolve(process.argv[1]).endsWith("verify-bindings.mjs")) {
  main();
}
