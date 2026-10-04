# CLAUDE.md

## What this is

A phone-first note-taking app that feels like a nested to-do list but stores everything as a graph.

You write in an outline: nested bullets, reorderable, indent/outdent. Any bullet can link to any other node, even one in a different list. For example, "buy 3/4-inch PVC elbows" on a project list links to a "Hardware store" node, so opening "Hardware store" shows everything you need to get there, across all lists. The outline is the main editing surface; a read-only graph view is secondary.

Core insight: **the outline already is a graph.** Nesting is a `child` edge from parent to child, sibling order is a property of that edge, and cross-list links are a second kind of edge. Everything points at stable node IDs, so moving or re-nesting an item never breaks its links.

## Decisions already made

- **Platform:** Progressive web app (PWA), installed to the Android home screen, fully offline after the first load. There is no backend, no accounts, and no sync. All data stays on the device. Static hosting only.
- **Stack:** Vue 3 + Vite + TypeScript. Use `vite-plugin-pwa` for the service worker and manifest.
- **Storage:** SQLite compiled to WebAssembly (`@sqlite.org/sqlite-wasm`), running in a Web Worker, using the `opfs-sahpool` VFS. That VFS persists to the browser's private file system (OPFS) and, unlike the plain `opfs` VFS, does **not** need COOP/COEP headers or SharedArrayBuffer.
- **Durability:** Call `navigator.storage.persist()` on first run. JSON export/import exists early so data is never one cache-clear from loss.
- **IDs:** UUIDv4 strings (`crypto.randomUUID()`), never positional.
- **Sibling order:** Fractional indexing (the npm `fractional-indexing` package) stored as a string `sort_key` on `child` edges, so a reorder updates one row.
- **Links are references, not mirrors.** A link points to another node; it doesn't make the node appear in two outlines. (Mirrors are a possible later feature.)
- **Edges are the source of truth.** Node text contains link tokens of the form `[[<uuid>]]`, rendered as chips showing the target node's *current* text. When a node's text is saved, its outgoing `link` edges are reconciled to match the tokens in the text, adding missing edges and removing stale ones, inside one transaction.

## Data model

```sql
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,          -- uuid
  kind        TEXT NOT NULL DEFAULT 'item',  -- 'pad' | 'item' | 'place' | 'person'
  text        TEXT NOT NULL DEFAULT '',  -- may contain [[uuid]] link tokens
  done        INTEGER NOT NULL DEFAULT 0,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,          -- unix ms
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER                    -- soft delete; NULL = live
);

CREATE TABLE edges (
  id          TEXT PRIMARY KEY,          -- uuid
  src         TEXT NOT NULL REFERENCES nodes(id),
  dst         TEXT NOT NULL REFERENCES nodes(id),
  type        TEXT NOT NULL,             -- 'child' | 'link' (more types later, e.g. 'buy_at')
  sort_key    TEXT,                      -- fractional index; only for 'child' edges
  created_at  INTEGER NOT NULL
);

CREATE INDEX edges_src ON edges(src, type, sort_key);
CREATE INDEX edges_dst ON edges(dst, type);
-- Tree invariant: a node has at most one incoming 'child' edge.
CREATE UNIQUE INDEX one_parent ON edges(dst) WHERE type = 'child';

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, etc.
```

Conventions within the model:
- A **pad** (a scratch pad / list) is a root node with `kind = 'pad'` and no parent.
- **Places and people** are ordinary nodes with `kind = 'place'` or `'person'`. They usually have no parent; they exist to be linked to. They're listed in their own index screens.
- "Backlinks" for a node = incoming `link` edges, each shown with the source node's breadcrumb path (pad → ancestors → item).
- Deleting a node soft-deletes it and its subtree. Link chips pointing to a deleted node render as struck-through, not as broken tokens.
- Migration 2 adds `nodes.sort_key`: a fractional key ordering root nodes (pads), since they have no incoming `child` edge to carry order. NULL for everything else.
- Migration 3 adds `nodes.numbered`: 1 means this node's children are a numbered (ordered) list. The outline shows 1. 2. 3.; the graph lays them out as a column beside the parent, in order (`GraphEdge.index`).
- Sibling keys are computed against *all* children, including soft-deleted ones, so keys stay unique and restored nodes return to their old position.
- Soft deletes share one `deleted_at` per batch; `restoreSubtree` revives exactly that batch (and the parent's batch, if the parent is deleted too).
- `meta` keys: `schema_version`, `inbox_id` (the pad that "create new item" in the link picker files into), `seeded` (welcome pad created once).

## Code conventions

- All SQL lives in the worker-side data layer (`src/db/`). Components talk to it through a typed async API (`src/db/api.ts`) over `postMessage`. No SQL in components.
- Tree operations (`createChild`, `indent`, `outdent`, `moveUp`, `moveDown`, `moveSubtree`, `deleteSubtree`) and link reconciliation each run in a single transaction.
- The outline is optimistic: it applies an operation to its local tree copy first (mirrors in `src/lib/treeOps.ts`, which must match the store's no-op rules), passing a client-generated UUID for new nodes, then calls the worker and reloads. Loads that race a write are discarded and retried (`useLoader`).
- Schema changes go through numbered migrations keyed on `meta.schema_version`.
- Unit tests for the data layer with Vitest. The data layer must be testable in Node, so keep the SQLite-specific bootstrap separate from the query logic.
- Mobile-first UI. Every action reachable by keyboard shortcut also needs an on-screen control, because Android soft keyboards have no Tab key.
- Test on Android Chrome early and often, not just desktop. `npm run e2e` drives headless Chromium with Pixel 7 touch emulation; it can't stand in for a real soft keyboard.
- Deploy with `npm run deploy` (see README): served at https://framework.pirate-emperor.ts.net:10002 on the tailnet.

## Not in scope for the MVP

Graph editing, typed-edge UI beyond plain links, mirrors, geofencing/location triggers, sync, multi-device, accounts, rich text beyond link chips.

See `PLAN.md` for the ordered milestones.
