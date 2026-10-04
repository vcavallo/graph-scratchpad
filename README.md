# Graph Scratchpad

A phone-first outliner that stores everything as a graph. Write nested lists; link any line to any other node with `@`; open a place like "Hardware store" to see every open item that points at it, across all your lists. It's an installable PWA that works offline, with all data in SQLite on the device.

See `CLAUDE.md` for the design decisions and data model, and `PLAN.md` for milestones.

## Using it

- **Tap a line** to edit. **Enter** starts a new line (it splits the line if the caret is mid-text). On an empty nested last line, Enter outdents it.
- **Backspace** on an empty line deletes it. At the start of a line, it merges the line into the one above, unless other items link to it or it has children.
- The **bar above the keyboard** has outdent, indent, move up, move down, insert link, more (open, move to another pad, make it a place or person, collapse, delete), and hide keyboard. On a hardware keyboard: Tab / Shift-Tab, Alt-Shift-↑/↓ to move, Ctrl-Enter to check off, Ctrl-↑/↓ to collapse or expand.
- **Type `@`** at the start of a word, or tap the @ button, to search all items, places, and people. You can also create a new place, person, or item from the same search. New items go into an "Inbox" pad.
- **Tap a chip** to open what it links to. **Tap a bullet** to open that item, with its children, outgoing links, and backlinks.
- **Places / People** tabs list every place and person with their open-item counts. Check items off right from a place's backlinks.
- **Graph** (the node icon at the top right of any item) shows its neighborhood 1–3 steps out. Solid lines are nesting and dashed arrows are links.
- **Settings** shows whether storage is persistent and lets you export or import a JSON backup. **Trash** lets you restore deleted items.
- Pasting several lines creates one item per line, with `-`, `*`, and `[ ]` markers stripped.

## Development

```sh
npm install
npm run dev        # Vite dev server
npm test           # data-layer unit tests (Vitest, Node, same sqlite-wasm build)
npm run typecheck
npm run e2e        # builds, then drives headless Chromium (Pixel 7 emulation, touch)
npm run icons      # regenerate PWA icons (dependency-free PNG drawing)
```

The e2e suites (`e2e/*.mjs`) use `playwright-core` with the system Chromium (`/run/current-system/sw/bin/chromium`, or set `CHROMIUM=`). Screenshots land in `e2e/shots/`.

### Layout

- `src/db/store.ts`: all SQL and graph logic (tree ops, link reconciliation, search, export/import). Synchronous; runs against any `SqlDb`.
- `src/db/worker.ts`: browser bootstrap: sqlite-wasm with the `opfs-sahpool` VFS, plus a Web Lock so a second tab waits instead of fighting over file handles.
- `src/db/api.ts`: typed `postMessage` client (`api.indent(id)` etc.), derived from the Store's method types.
- `src/components/Outline.vue`: the editor. It applies each operation to a local copy of the tree immediately (with client-generated UUIDs) so focus moves inside the key handler and the Android keyboard stays up, then sends the same operation to the worker and reloads.
- `src/components/EditableText.vue`: one contenteditable line with atomic link chips; caret offsets are measured in stored-text units.

## Hosting on this machine (tailnet)

The build is served by a tiny static server running as a systemd user service, published on the tailnet over HTTPS by `tailscale serve`. HTTPS is required for the service worker and OPFS.

```sh
npm run deploy     # build + unit tests, then publish a new release
```

`deploy` copies `dist/` into `~/.local/share/graph-scratchpad/releases/<timestamp>/`, gzips text assets, and atomically repoints the `current` symlink. The server picks it up on the next request; the installed app shows "A new version is ready" and reloads when you tap it.

One-time setup (already done on the Framework, except the step that needs root):

```sh
cp deploy/graph-scratchpad.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now graph-scratchpad   # serves 127.0.0.1:8742
sudo tailscale serve --bg --https=10002 http://127.0.0.1:8742
```

Then open **https://framework.pirate-emperor.ts.net:10002** in Chrome on the phone and choose "Add to Home screen" / "Install app".

## Data safety

- Data lives in the browser's origin-private file system for that exact origin (`https://framework.pirate-emperor.ts.net:10002`). A different host or port is a different, empty database.
- The app calls `navigator.storage.persist()` on first run; Settings shows whether it was granted. Installed PWAs on Android usually get it.
- Uninstalling the app or clearing site data deletes everything. Export a backup from Settings first.
