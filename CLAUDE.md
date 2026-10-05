# CLAUDE.md

## What this is

The app is called **Graph Paper** (manifest name, title, UI text). Internal identifiers keep the old name `graph-scratchpad` and must not be renamed: the OPFS directory and database file, the Web Lock, the export file’s `app` field, deploy paths, and the systemd services.

A phone-first note-taking app that feels like a nested to-do list but stores everything as a graph.

You write in an outline: nested bullets, reorderable, indent/outdent. Any bullet can link to any other node, even one in a different list. For example, "buy 3/4-inch PVC elbows" on a project list links to a "Hardware store" node, so opening "Hardware store" shows everything you need to get there, across all lists. The outline is the main editing surface; a read-only graph view is secondary.

Core insight: **the outline already is a graph.** Nesting is a `child` edge from parent to child, sibling order is a property of that edge, and cross-list links are a second kind of edge. Everything points at stable node IDs, so moving or re-nesting an item never breaks its links.

## Decisions already made

- **Platform:** Progressive web app (PWA), installed to the Android home screen, fully offline after the first load. Local-first: the device's database is the truth the app works from, and it never waits on the network.
- **Sync (progressive enhancement):** when the serving site has `/api/sync` (`server/serve.mjs` with `SYNC_DB`), the app syncs in the background. Per-field last-writer-wins by hybrid logical clock, through a small self-hosted server on the tailnet (the Pi). No accounts: the tailnet is the access control. See README "How sync works".
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
  kind        TEXT NOT NULL DEFAULT 'item',  -- 'pad' | 'item' | 'place' | 'person' | 'relation' | 'category'
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
- Migration 9: kinds of context. A node of kind `category` is a kind (Places, Rooms…), named by its text, with settings in `nodes.props` (JSON: icon, pinned, tone); `nodes.category` says what kind of context a node is (synced). Places and People exist from the start with fixed ids (`PLACES_ID`, `PEOPLE_ID`) and clock '0', so every device has the same two; older `place`/`person` nodes belong to them (`effectiveCategory`). "Is the database empty" checks ignore them. Contexts stay where they are in lists; kinds are suggested from the relations pointing at them (`#categorySuggester`). Up to 3 kinds are pinned to the bottom bar; the rest are under the Contexts tab.
- Migration 3 adds `nodes.numbered`: 1 means this node's children are a numbered (ordered) list. The outline shows 1. 2. 3.; the graph lays them out as a column beside the parent, in order (`GraphEdge.index`).
- Migration 4 adds `nodes.task`: 1 means a to-do (checkbox), 0 a plain bullet note. Invariants: only items can be to-dos, and only to-dos can be done (`setDone(true)` makes a bullet a to-do; `setTask(false)` unchecks). "Open" everywhere means `task = 1 AND done = 0`. A new item copies the to-do flag of the item next to it (`#taskFor`, mirrored by `taskFor` in treeOps); with no neighbouring item it's a to-do, except under a place/person. Items created from the link picker are bullets. `TreeNode.links` counts live incoming links, excluding finished to-dos.
- Sibling keys are computed against *all* children, including soft-deleted ones, so keys stay unique and restored nodes return to their old position.
- Soft deletes share one `deleted_at` per batch; `restoreSubtree` revives exactly that batch (and the parent's batch, if the parent is deleted too).
- `meta` keys: `schema_version`, `inbox_id` (the pad that "create new item" in the link picker files into), `seeded` (welcome pad created once), and for sync `device_id`, `sync_enabled`, `sync_cursor`, `sync_epoch`, `sync_schema`.
- Migration 5 adds `sync_clock` (per node and field: clock time of the last change, and whether it's unsent) with triggers on `nodes` and child `edges`, and `nodes.purged` (emptied from the trash; the row stays as a tombstone). Clock '0' marks the untouched welcome pad (never sent unless edited, dropped when joining a server that has data); '' marks a field not yet received. Sibling ties on sort key break by node id, the same on every device.
- Migration 6 adds `edges.phrase`: what a link means ("buy at", "waiting on"), guessed from the words before and after its token (`src/lib/relations.ts`) every time links are reconciled. Derived like link edges, so not synced; bumping `PHRASES_VERSION` recomputes them on next start. This is step 1 of emergent typed connections; step 2 (done) refines them with Claude Haiku on the server: migration 7 adds `nodes.rels`, a server-written synced field `{ linkedId: { r, h } }` used while `h` matches `textHash(text)` (src/lib/textHash.ts must match server/relations-ai.mjs). Step 3 (done): your vocabulary is nodes of kind `relation` (text = name, child lines = other wordings); `NO_RELATION_ID` is a fixed-id relation whose wordings mean "not a relation". Migration 8 adds `nodes.link_rels` (synced, `{ linkedId: relationId }`) for links you labelled by hand. What a link shows is resolved when read (`#vocab` / `#resolve` in store.ts): pinned relation, else the relation whose name or wording matches the suggestion, else the suggestion. Relations and their wordings are left out of search unless `kinds` asks for them. The API key lives only in a file on the Pi; never print, copy or commit it (the GitHub repo is public).

## Code conventions

- All SQL lives in the worker-side data layer (`src/db/`). Components talk to it through a typed async API (`src/db/api.ts`) over `postMessage`. No SQL in components.
- Tree operations (`createChild`, `indent`, `outdent`, `moveUp`, `moveDown`, `moveSubtree`, `deleteSubtree`) and link reconciliation each run in a single transaction.
- The outline is optimistic: it applies an operation to its local tree copy first (mirrors in `src/lib/treeOps.ts`, which must match the store's no-op rules), passing a client-generated UUID for new nodes, then calls the worker and reloads. Loads that race a write are discarded and retried (`useLoader`).
- Schema changes go through numbered migrations keyed on `meta.schema_version`.
- Unit tests for the data layer with Vitest. The data layer must be testable in Node, so keep the SQLite-specific bootstrap separate from the query logic.
- Mobile-first UI. Every action reachable by keyboard shortcut also needs an on-screen control, because Android soft keyboards have no Tab key.
- Test on Android Chrome early and often, not just desktop. `npm run e2e` drives headless Chromium with Pixel 7 touch emulation; it can't stand in for a real soft keyboard.
- Deploy with `npm run deploy:pi` (the Pi, https://utility-server-pi.pirate-emperor.ts.net, app + sync) and `npm run deploy` (the Framework, https://framework.pirate-emperor.ts.net:10002, which proxies sync to the Pi). See README.
- Sync: every write is captured by triggers (migration 5), so Store methods don't need sync code. A new syncing column needs a trigger in a new migration, an entry in `SYNC_COLUMNS` and `#fieldValues` in store.ts, and a test in tests/sync.test.ts.

## Not in scope for the MVP

Graph editing, typed-edge UI beyond plain links, mirrors, geofencing/location triggers, accounts, rich text beyond link chips. (Sync between your own devices is in, via your own server; real-time collaboration isn't.)

See `PLAN.md` for the ordered milestones.
