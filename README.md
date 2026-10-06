# Graph Paper

A phone-first outliner that stores everything as a graph. Write nested lists of to-dos and notes; link any line to any other node with `@`; open a place like "Hardware store" to see every open to-do that points at it, across all your lists. It's an installable PWA that works offline, with all data in SQLite on the device, and it syncs between your devices through a small server of your own when it can reach one. Paste in a markdown draft and it keeps its nesting, checkboxes and numbering; on a computer, turn on Vim keys and edit in normal and insert mode.

**Try it: https://graph-paper-xi.vercel.app.** It runs in your browser, and you can install it to your home screen as an app. Everything stays on your device: there's no account, and nothing you write is sent anywhere. That copy has no sync, so export a backup from Settings now and then, or [run your own](#run-it-yourself) to sync between your devices.

<p align="center">
  <img src="docs/screenshots/outline.png" width="260" alt="A pad called Saturday: a numbered list of to-dos and a grocery checklist, with links coloured by what they point at: green places, a pink person, an amber room. The bottom bar has tabs for Places and Rooms.">
  <img src="docs/screenshots/context.png" width="260" alt="The Hardware store page: four open to-dos that link to it, labelled by relation. Two are buy at, a relation kept (one was written pick up at); grab at and return to are suggestions, outlined. Chips at the top filter by relation.">
  <img src="docs/screenshots/graph.png" width="260" alt="The graph around Saturday, three steps out: the numbered list as an ordered column, to-dos as boxes, notes as circles, and dashed links labelled with their relation to places, a person, a room and a waiting state.">
</p>

A pad with to-dos, notes and links to contexts of different kinds: places, a person, and a room from a kind of context you made, with its own tab (left). A place's page, with what links there labelled by relation; *buy at* is one you kept ("pick up at" counts as it too), the outlined ones are suggestions (middle). The pad's graph, with links labelled (right). `npm run screenshots` rebuilds all three from example data.

## Run it yourself

You need Node 22 or newer.

```sh
git clone https://github.com/vcavallo/graph-scratchpad.git
cd graph-scratchpad
npm install
npm run dev        # http://localhost:5173
```

### Host your own copy

`npm run build` makes a static site in `dist/`. Any static host with HTTPS will do: the on-device database (SQLite compiled to WebAssembly, stored in the browser's private file system with the `opfs-sahpool` VFS) needs no special headers. `vercel.json` is set up for Vercel, so `npx vercel --prod` from a clone deploys it, or:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvcavallo%2Fgraph-scratchpad)

### Sync between your devices

Sync needs a small server of your own: `server/serve.mjs`, Node 22, no dependencies. One process serves the app and `/api/sync`, with the data in Node's built-in SQLite.

```sh
npm run build
SYNC_DB=./sync/sync.sqlite3 npm run serve    # http://127.0.0.1:8742
```

It listens on localhost only and has no accounts, so anyone who can reach it can read and write what it syncs. Put HTTPS in front of it somewhere private. The easy way is [Tailscale](https://tailscale.com): `tailscale serve --bg --https=443 http://127.0.0.1:8742` makes it `https://<machine>.<tailnet>.ts.net` on your own devices and nowhere else. Open that address on each device: the app finds the server and turns sync on by itself.

Settings for `server/serve.mjs`:

- `SYNC_DB`: where to keep the sync database. A copy is saved to `backups/` next to it every day (seven kept).
- `SYNC_UPSTREAM`: instead, pass `/api/sync` through to a sync server elsewhere (to serve the app from a second machine).
- `HOST`, `PORT`: default `127.0.0.1`, `8742`.
- `RELATIONS_KEY_FILE`: a file holding an Anthropic API key, for [link labels](#link-labels-on-the-server) by Claude Haiku (default: `anthropic-api-key` in the directory above `SYNC_DB`'s). Without one, each device labels links itself. `RELATIONS_MODEL` and `RELATIONS_MAX_CALLS_PER_DAY` (300) tune it.

To keep it running:

- `npm run deploy` builds, tests, and publishes a release on this machine (`~/.local/share/graph-scratchpad`), for the systemd user unit in `deploy/graph-scratchpad.service`.
- `npm run deploy:remote` publishes one to another machine over ssh. Set `DEPLOY_HOST` (and optionally `DEPLOY_REMOTE_ROOT`) in a `.env.deploy` file, which is gitignored. On NixOS, `deploy/nixos/graph-scratchpad.nix` is a module that runs it as a hardened system service with nixpkgs' Node and can publish it with `tailscale serve`.

A release is the built app (with `.gz` siblings) plus the server, copied to `releases/<timestamp>/` with `current` repointed atomically. New static files are live on the next request, and the server restarts only when its own code changed. An installed app shows "A new version is ready" and reloads when you tap it.

## Development

```sh
npm run dev          # Vite dev server
npm test             # data-layer unit tests (Vitest, in Node, same sqlite-wasm build)
npm run typecheck
npm run e2e          # builds, then drives headless Chromium (Pixel 7 emulation, touch)
npm run icons        # regenerate the PWA icons (dependency-free PNG drawing)
npm run screenshots  # rebuild the README screenshots from example data
```

The e2e suites (`e2e/*.mjs`) use `playwright-core` with a Chromium or Chrome already on your system; set `CHROMIUM=/path/to/chromium` if it isn't found. Screenshots land in `e2e/shots/`.

`CLAUDE.md` is the design document: the decisions already made, the data model and its migrations, and the code conventions. `PLAN.md` has the milestones. Inside, the project is still called `graph-scratchpad`: the repo, the on-device database, export files, and the servers' paths and services.

### Layout

- `src/db/store.ts`: all SQL and graph logic (tree ops, link reconciliation, search, export/import). Synchronous; runs against any `SqlDb`.
- `src/db/worker.ts`: browser bootstrap: sqlite-wasm with the `opfs-sahpool` VFS, plus a Web Lock so a second tab waits instead of fighting over file handles.
- `src/db/api.ts`: typed `postMessage` client (`api.indent(id)` etc.), derived from the Store's method types.
- `src/components/Outline.vue`: the editor. It applies each operation to a local copy of the tree immediately (with client-generated UUIDs) so focus moves inside the key handler and the Android keyboard stays up, then sends the same operation to the worker and reloads.
- `src/components/EditableText.vue`: one contenteditable line with atomic link chips; caret offsets are measured in stored-text units.
- `src/db/sync.ts`, `src/db/syncRunner.ts`, `src/db/hlc.ts`: the sync client (see below). `server/serve.mjs` serves the app and `/api/sync`; `server/sync-server.mjs` is the server's merge logic, on Node's built-in SQLite.

## Using it

- **Tap a line** to edit. **Enter** starts a new line (it splits the line if the caret is mid-text). On an empty nested last line, Enter outdents it.
- **Backspace** on an empty line deletes it. At the start of a line, it merges the line into the one above, unless other items link to it or it has children.
- The **bar above the keyboard** has outdent, indent, move up, move down, insert link, checkbox, more (open, move to another pad, turn into a place or person, collapse, delete), and hide keyboard.
- **To-dos and notes.** A line is either a to-do (with a checkbox) or a plain bullet note. The checkbox button in the bar switches it; so does typing `[] ` or `- ` at the start of a line. New lines follow the line you came from, so checklists stay checklists. The first line of a pad is a to-do, and notes under a place or person are plain bullets. ⋯ → **Add/Remove checkboxes** switches every line inside at once. Only to-dos count as "open", and a parent shows how many of its to-dos are done (2/5).
- **Turn into a place / person** creates a standalone place (or person) named after the line, and leaves the line in your list as a link to it. On a hardware keyboard: Tab / Shift-Tab, Alt-Shift-↑/↓ to move, Ctrl-Enter to check off, Ctrl-Shift-Enter to switch to-do/note, Ctrl-↑/↓ to collapse or expand.
- **Move to…** (in the ⋯ menu) opens a browser next to the line: tap a pad or item to look inside it, then **Move into “…”**. Search works too.
- **Numbered lists.** Type `1. ` (or `1) `) at the start of any line to number the list it’s in, or use **Number the items inside** (⋯ on a line, or the page menu for a whole pad). In the graph, numbered lists hang off their parent as an ordered column.
- **Type `@`** at the start of a word, or tap the @ button, to search all items, places, and people. You can also create a new place, person, or item from the same search. New items go into an "Inbox" pad.
- **Pulling items into another list.** A line that is nothing but a link stands for what it links to. Link a to-do from your brain-dump list into "Today" and that line shows the to-do’s checkbox; check it off there and it’s done everywhere. Counts and progress count it once, and the to-do’s own page lists the lists it’s **Also on**. Add any other words to the line and it’s an ordinary line again, with its own checkbox. The other way round: ⋯ → **Send to…** on any to-do puts such a line at the end of the list you pick (browse or search, like Move), and the last list you sent to is one tap away (**Send to “Today”**).
- **Tap a chip** to open what it links to. **Tap a bullet** to open that item, with its children, outgoing links, and what links here.
- **Linked here.** A line that other lines link to shows a count at its right; tap it to see them: open to-dos first, then plain mentions, then the done ones (folded away). Finished to-dos don't count. This makes any line a status or tag: put "waiting" in a States pad, link to-dos to it with @, and its page lists what you're waiting on. Each link is labelled with what its wording says, read from the words around it ("buy elbows at [[Hardware store]]" is *buy at*, "waiting on [[Sam]]" is *waiting on*, "[[Sam]] owes me" is *owes*); when a page has more than one kind, chips at the top filter by them, and the graph shows the labels on its link lines. With sync on a server that has an Anthropic API key, Claude Haiku then reads each new or edited linked line on the server and refines the label, reusing the ones already in use ("pick up at" and "grab at" become *buy at*); the labels arrive through sync. `node scripts/example-pad.mjs https://your-sync-server` adds a "Relations playground" pad to try it on.
- **Your relations.** Labels start as suggestions (outlined). Tap one, or a chip’s **Keep or rename**, to **Keep** it, **Call it something else** (one of your relations, or a new name: "pick up at" then counts as *buy at*), or say it’s **Not a relation**. Kept relations are drawn solid and listed in Settings → **Relations**, each with a page of its links grouped by what they link to, and the other ways you write it as an editable list. Rename or merge from there. **Label just this link** picks the relation for a single line, whatever its wording. Haiku is told your relations, so its labels follow your vocabulary.
- **Facts.** Some things are true, not just written down: Alex is *cofounder of* Acme. On Alex’s page, **Add a fact** (or ⋯ → **Add a fact…**), pick or name the relation, then what it’s about (or make it on the spot: "New in Projects: Acme"). Alex’s page lists it under **Facts**; Acme’s lists Alex under **Linked here**, labelled *cofounder of*; the graph draws a labelled arrow. A note you already wrote under Alex, like "cofounder of @Acme", can become one: ⋯ → **Make it a fact about “Alex”** (its words start as the relation). Notes are never made into facts for you. Each fact’s ⋯ changes the relation or what it points to, turns it back into a note, or removes it.
- **Contexts.** A context is anything you link to and come back to: a place, a person, a room, a project. Kinds of context are yours to make: Places and People to start, then Rooms, Projects, Stores… Any line can be one, right where it is: ⋯ → **Make it a context…** and pick a kind (or tap the kind tag on its page to change it). Each kind has a page listing its contexts with their open to-dos, and a box to add another. The **Contexts** tab lists every kind, plus the other things you link to; when the way you link to one matches a kind (things you sweep "in" look like Rooms), it suggests that kind. Contexts take their kind’s icon and colour in chips, rows and the graph, and @ offers "New in Rooms: …".
- **Tabs.** Give up to three kinds a tab in the bar (Settings → Bottom bar, a kind’s ⋯ menu, or the pin on the Contexts tab); the rest live under Contexts. Places has a tab to start.
- **Graph** (the node icon at the top right of any item) shows its neighborhood 1–3 steps out. Solid lines are nesting and dashed arrows are links; to-dos are boxes (ticked and dimmed when done) and notes are circles. Drag nodes around; tap one to make it the focus (back steps to the previous one); **Open** on the card goes to its page.
- **Sync.** When the site it's served from has a sync server, the app turns sync on by itself and says so once. Every change is saved on the device first and sent in the background: shortly after you edit, when the app comes back to the foreground or the network returns, and right away when another device changes something. Offline, nothing changes except that changes wait. A new device downloads your lists instead of showing the welcome pad. Settings → Sync & data shows the state, has **Sync now**, and can turn it off for this device.
- **Pasting a draft.** Paste several lines (a markdown list written in vim, say) and they keep their shape. Indentation nests lines, whether it’s 2 spaces, 4 or tabs, and a `#` heading takes the lines below it, up to the next heading of its level. `[ ]` and `[x]` make to-dos (checked off for `[x]`); `- `, `* `, `1. ` and headings make notes; `1. ` numbers its list. A line with no marker follows the line before it. Blank lines and `---` rules are dropped. Pasted into a line, the first pasted line joins it and the lines indented under it go inside; pasted into a pad’s title, the first line names the pad.
- **Vim keys.** For a computer keyboard: Settings → Keyboard → **Turn on Vim keys** (this device only). `Esc` goes to normal mode, where the cursor is a block: `h` `j` `k` `l` move (`j`/`k` go between lines and keep the column), `w` `b` `e` jump words (a link chip counts as one), `0` `^` `$` `gg` `G` go to the ends. `x` `X` `dd` `dw` `de` `db` `D` delete (`dd` deletes the line, with Undo), `cw` `cc` `C` `s` `S` `r` change, `o` `O` open a line below or above, `>>` `<<` indent and outdent, `za` `zc` `zo` fold. `yy` copies the line (with what’s inside it) and `p` / `P` put it below or above, where `o` / `O` would open a line; `dd` cuts, and the first `p` after it moves the line itself, so links to it keep working. `u` undoes the last change made with Vim keys (one step: an edit to a line, what you typed in one go, a deleted, opened or put line, an indent), and `u` again redoes it, as in the original vi. `gx` opens the link under the cursor, or anywhere else, the line itself, starting on its title. `Ctrl-O` and `Ctrl-I` go back and forward between pages, like vim’s jump list, landing on the line (and character) you were on. `i` `a` `I` `A` go back to typing. Ctrl shortcuts work in both modes. The mode shows in the bar at the bottom, and tapping it switches. New lines and a new pad’s name start in insert mode. There’s one register, and no counts or visual mode.
- **Settings** has three tabs. **General**: what your links mean, the trash, the bottom bar, appearance (light, dark, or the system’s, the default; per device) and keyboard. **Sync & data**: sync, export or import a JSON backup, and whether storage is persistent. **About**: version and source. **Trash** lets you restore deleted items.

## How it works

### Sync

Each node is a handful of fields (text, done, to-do, kind, collapsed, numbered, deleted, purged, and its place: parent + sort key). Every field remembers when it last changed, as a hybrid logical clock time: wall-clock based, but it never runs backwards and always moves past anything seen from another device. Triggers on the tables (migration 5) record each local change in `sync_clock`, so the Store's methods know nothing about sync.

A sync round trip sends the fields not yet sent and gets back every field the server has newer than this device's cursor. Each field keeps whichever value is newest, so editing a line's text on the phone and checking it off on the desktop both survive; two edits to the same field keep the later one. Links aren't sent; each device rebuilds them from the text. After merging, the device repairs what a merge can break, as ordinary local edits that sync back: a to-do that's done but not a to-do (the newer of the two fields wins), and a loop from two devices moving lines into each other (the most recently moved line goes to the Inbox). Emptying the trash leaves tombstones so it reaches other devices. The server's database has an identity; if it's ever replaced, devices notice and send it everything again. `tests/sync.test.ts` checks three devices converge after hundreds of random edits; `SYNC_FUZZ=50 npx vitest run tests/sync.test.ts` soaks it.

### Link labels on the server

`server/relations-ai.mjs`: when the sync server finds an API key (`RELATIONS_KEY_FILE`, default `anthropic-api-key` next to the `sync/` directory; with the NixOS module, `/var/lib/graph-scratchpad/anthropic-api-key`, mode 600, outside the repo and the Nix store), it batches lines whose links have no label for their current text, asks Claude Haiku (tool use, with the relations already in use as vocabulary), and writes the answers as a `rels` field on each line: `{ linkedId: { r, h } }`, where `h` hashes the text it read. Devices use a label only while their text still hashes the same, and their own guess otherwise. Capped at `RELATIONS_MAX_CALLS_PER_DAY` (300); a call labels up to 40 links for a fraction of a cent. `GET /api/sync` reports counts and the last error.

## Data safety

- Data lives in the browser's private file system for that exact origin. The hosted copy, your own server and `localhost` are separate databases; with sync on, a new origin fills itself from the server.
- With sync on, the server keeps a copy of everything, plus daily snapshots. Importing a backup while sync is on merges it in (its version of each entry wins) instead of replacing everything.
- The app calls `navigator.storage.persist()` on first run; Settings shows whether it was granted. Installed PWAs on Android usually get it.
- Uninstalling the app or clearing site data deletes everything on that device. Export a backup from Settings first.

## License

Public domain, under [the Unlicense](https://unlicense.org/): copy it, change it, sell it, no strings attached. See `LICENSE`.
