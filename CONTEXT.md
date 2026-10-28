# Context — vocabulary

Canonical model: Notion **Process Model V1 — Spec** (§4 Synced Property, §8 Synced Properties)
and the glossary entry **Synced Properties Database**. This file only adds the
repo-local terms the code and plans use; when it disagrees with the spec, the spec wins.

| Term | Meaning here |
| --- | --- |
| **Build** | A row in the Builds DB; the functional system a manifest belongs to (`buildPageId`). Today's prune scope. |
| **Piece** | A row in the Pieces DB (`99ff84d6-11be-4a5e-bb68-96317ab07410`): an independently operated unit (Worker, script, scenario…). A binding names the Piece whose code makes the Notion call — never a library, never the trigger. |
| **Binding** | One Synced Properties row: one property (or the page body) × one Piece, with that Piece's direction. |
| **Bound to** | Synced Properties relation → Pieces (limit 1). Empty = Unresolved. Never filled with the Build as a stand-in. |
| **Resolution** | Formula on Synced Properties: `Unresolved` while Bound to is empty, else `Resolved`. Never written by this action. |
| **Unresolved** | The executing Piece is not known yet. Not the same as Validation status **Unverifiable** (schema could not be validated). |
| **Build-grain row** | A row with Build set and Bound to empty — every row written before Piece-aware manifests. |
| **Piece-grain row** | A row with Bound to set. One property touched by several Pieces of a Build = several Piece-grain rows. |
| **Legacy manifest** | A `bindings.json` with no `pieceId` field anywhere. Reconciles exactly as before (key `db::property`, Bound to untouched). |
| **Piece-aware manifest** | A `bindings.json` with at least one `pieceId` field (top level, database entry or binding). Every binding then has an effective `pieceId` — a Piece page id, or `null` = explicitly Unresolved. |
| **Re-point** | Reconcile move that changes only a row's Bound to (same database × property, different Piece or none) in place, instead of prune + create. Keeps the row's page id and validation state. |
