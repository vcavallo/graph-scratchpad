# PLAN.md — MVP milestones

Work through these in order. Each milestone should be usable on an Android phone before moving on. Background, decisions, and the schema are in `CLAUDE.md`.

**Status (2026-10-04):** Milestones 0–7 are implemented. Each is covered by Vitest (data layer) and headless-Chromium checks (`npm run e2e`, phone emulation). Not yet verified on a real Android phone; that's the next step.

## Milestone 0 — Scaffold and storage

- Vite + Vue 3 + TypeScript project.
- `vite-plugin-pwa`: manifest, icons, a service worker that precaches the app shell so it runs offline.
- SQLite-WASM in a Web Worker using the `opfs-sahpool` VFS. Migration 1 creates the `nodes`, `edges`, and `meta` tables from `CLAUDE.md`.
- Call `navigator.storage.persist()` on first run and show the result somewhere in a settings screen.

**Done when:** the app installs to an Android home screen, opens in airplane mode, and a row written before closing is still there after reopening.

## Milestone 1 — Data layer

- Typed async API: create/update/soft-delete nodes; `createChild(parentId, afterSiblingId?)`, `indent`, `outdent`, `moveUp`, `moveDown`, `moveSubtree(nodeId, newParentId, afterSiblingId?)`, `getTree(padId)`, `getChildren(nodeId)`.
- Sibling ordering via `fractional-indexing` on `child` edges.
- Every tree operation is a single transaction and preserves the one-parent invariant.
- Vitest coverage for every operation, including edge cases: indenting the first child (no-op), outdenting a top-level item (no-op), moving a node under its own descendant (rejected).

**Done when:** tests pass in Node without a browser.

## Milestone 2 — Outline editor (one pad)

- Single pad, rendered as nested bullets.
- Enter = new sibling below; Backspace on an empty item = delete it and focus the previous one.
- Indent/outdent via Tab/Shift-Tab **and** on-screen buttons in a toolbar above the keyboard.
- Move up/down buttons. Drag-to-reorder can wait.
- Checkbox for `done`; collapse/expand a subtree.
- Edits save on blur and on a short debounce.

**Done when:** you can comfortably write and restructure a 20-item nested list on a phone.

## Milestone 3 — Links

- Typing `@` opens a fuzzy-search dropdown over all live nodes (any pad, plus places and people).
- Choosing a result inserts a `[[uuid]]` token, rendered as a chip showing the target's current text.
- "Create new" in the dropdown makes a new node inline, with a choice of kind: item, place, or person.
- On save, reconcile outgoing `link` edges with the tokens in the text, as described in `CLAUDE.md`.
- Tapping a chip navigates to that node.

**Done when:** an item on one list can link to a place, and renaming the place updates every chip.

## Milestone 4 — Node view and backlinks

- Tapping any node opens a node view showing its text, its children (editable inline), its outgoing links, and its **backlinks**: incoming `link` edges, each with a breadcrumb (pad → ancestors → item) and its done checkbox.
- Checking an item off from the backlinks list updates it everywhere.
- Index screens for places and people.

**Done when:** opening "Hardware store" shows every open item linked to it, across all pads, and you can check them off from there.

## Milestone 5 — Multiple pads

- Pad switcher: create, rename, delete, and reorder pads.
- Move an item (with its subtree) to a different pad.

## Milestone 6 — Export / import

- Export the whole database as JSON (nodes plus edges) via a file download or the share sheet.
- Import a file, replacing or merging data (replace is fine for the MVP).

**Done when:** an export from one phone or browser imports cleanly into a fresh install.

## Milestone 7 — Read-only graph view

- From any node view, show its neighborhood graph out to N hops (default 2) using a force-directed layout (`cytoscape.js` or `d3-force`).
- Visually distinguish `child` edges from `link` edges. Tapping a graph node opens its node view.

## Later (not MVP)

Typed edges in the UI (e.g. "buy at", "blocked by"), mirrors, graph editing, drag-to-reorder, location-triggered views (would require wrapping the app with Capacitor for native geolocation), sync between devices.
