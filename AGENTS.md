# Instructions for Claude (and any other agent) working on Focus Tracker

Read this file at the start of every session that touches this project or the tracker's Drive folder. Then read `docs/ROADMAP.md` for the requirements, decisions and planned work before you plan anything.

## Never link or copy sensitive material

The Resources feature stores links to Google Drive files. Before adding, suggesting or editing any link:

1. Only link a file the owner has named or clearly pointed at. Never browse Drive and add links on your own initiative.
2. Check the file first. If it contains bank or card details, passwords, ID or passport numbers, tax references, health records or similar, stop and ask the owner to confirm before linking. A link is one click away from the contents.
3. Never copy the contents of a linked file into the sheet, the notes files or this repository. Store the link, a title and a short note only.
4. Never put the owner's real links, file IDs, spreadsheet IDs or folder IDs in the repository. They belong in the sheet and in Script Properties.
6. Imported data (for example from Todoist) lives only in git-ignored `src/private/` while it waits to be imported. Never commit it, and delete it once the import has run.
5. If in doubt, ask.

## Check that a change is needed now

This tracker exists to cut Paddy's procrastination, so building it can become procrastination too. Vibecoding loops (ask for a change, see it, ask for another) waste a lot of time.

When Paddy asks for a change to this project (a new feature, a tweak, a restyle):

1. Before you build, ask him one short question: "Are you sure you need this right now, or is it procrastination?"
2. Wait for his answer. If he says he needs it, build it. If he is unsure, suggest he does the task he was avoiding first and puts this change on a list for later.
3. Ask once per request, not after every small follow-up. Do not lecture. Keep it friendly and short.
4. Fixing a bug that stops him using the tracker is not a new feature. Fix it without asking.

## How the code is organised

- `src/core/` is the small shared core: config, sheet access (`sheetdb.js`), module registry, `rpc`, setup. Avoid putting feature logic here.
- `src/modules/<id>/` is one feature. Each has `server.js` (defines `<id>Module()`) and `view.html` (calls `FT.module({...})`).
- `src/ui/` is the page shell, shared styles and the client core (`FT`).
- Modules talk to each other only through `ctx.call` / `ctx.optional` on the server and through `FT.store` slices on the client. A module may read another module's slice but only changes its own data through its own api.
- Adding a feature: create `src/modules/<id>/`, add the id to `MODULES` in `src/core/config.js`. Removing it: delete the folder and that one line.
- Modes (`MODES` in `src/core/config.js`, helpers in `src/core/mode.js`): each mode has its own spreadsheet and its own subfolder of the "Focus Tracker" Drive folder. `bootstrap(mode)` and `rpc(module, fn, args, mode)` set the mode first, so `Table`, `getSpreadsheet_()` and `getSubfolder_()` always work on the active mode. Per-user state that belongs to a mode uses `modeKey_('name')`. A mode-only feature is a module listed in that mode's `modules`.
- A project's next action is hidden unless turned on (Settings default, or the project's own choice in ⚙ Project settings). A view that shows it asks `FT.nextActionShown(p)` (projects module) first.
- Categories are data, not config: each mode's Categories tab, edited in the app. Check them through `ctx.call('categories', 'ids')`.
- Pages lay out their panels with `FT.layout(page, [{ id, title, description, html, w }])` (shell.html), so they can be moved (by the title at any time on a desktop; press and hold then drag on a phone), removed and added back in "Edit layout" mode. `FT.layout(page, panels, { pager: { pinned: id, offPage, templates } })` shows the page on a phone as one pinned panel, a row of pills and the chosen pill's panels (Today); pills and their switches are edited in Today settings (`src/modules/layout/view.html`, through `FT.pills` in shell.html) and saved per mode (`layout.<page>.pills`, `layout.<page>.view`). A panel can give `short` (its name in a pill), `count` (for its pill), `kind` (`list`, `todo`, `note` or `whiteboard`), `compact` for the pinned version, and `top` to go above a saved grid when it is new. A module offers panels only a pill shows (lists, to-do lists, notes and whiteboards not on Today) through the slot `today.pillPanels`. Slots that add panels give each one a stable `id`, a `title` and a one-line `description` (shown in "Add feature"). A module that can put something on a page that is not there yet offers it through the slot `addable.<page>` (`[{ id, title, description, panel, add }]`, `add` shows it at once and saves behind). Panel heights follow their content by themselves (a ResizeObserver in shell.html).
- On a desktop any panel can be popped out into a window that stays on every tab (`src/ui/popout.html`); a phone has no windows and draws every panel in place. For a panel to work there, its buttons and inputs carry their own ids (`data-project`, `data-owner`, `data-id`) rather than reading `FT.state.projectId`, and code that scans the page looks in `#popRoot` as well as `#app`. A panel that needs the open project goes in `PANELS_TIED_TO_THE_OPEN_PROJECT` there. A panel whose content may be on screen only once (a notes editor: its notes would be written over by a second copy) marks it in its html with `data-one-copy="<key>"` (`note:<project or note id>`); while a window shows it, any other panel with that key shows a placeholder (code that draws such html outside FT.layout, like the Notes tab's pop-up, asks `FT.popout.otherCopyHtml(html)`). Several different notes can be on screen at once: each editor's element ids carry its key (`nt-text-<key>`).
- The Notes tab (module `lists`, page key `lists`) is a grid of small cards like Google Keep, not FT.layout panels (no Edit layout, no Pop out there; old `layout.lists` rows are ignored): one card per row of the Lists tab in its `order` (a list shows its first items, a to-do list its first open to-dos with tick boxes that send `todos.tick` (`FT.todos.cardPreview`), a note the first lines of its Doc (`FT.notes.previewOf`)), then one per project's notes through the slot `lists.tab` unless the "Project notes" switch is off (`layout.lists.view`). The cards are dealt into columns row by row (two on a phone); search, filter chips and + New (a round button on a phone) sit above them. A card opens in a pop-up drawn inside `#app` (a dialog on a desktop, the whole screen on a phone; Esc, ✕, the dim area or the phone's back button close it) that holds the real editor, the same code as on Today: `FT.kanban.boardHtml` for a list, `FT.todos.bodyHtml` for a to-do list, `FT.notes.blockHtml` for a note, plus the name, colour swatches, On Today, ⚙ Settings and Delete. Cards are dragged into a new order (a long press on a phone) through `lists.move` (any number of places). A note's first lines are kept on its Notes row (`preview`), so the tab reads no Doc; a card whose note has none yet asks for it once when it is on screen (docs/notes-docs.md). `FT.lists.create(name, kind)` makes one on screen at once (+ New and the pill sheet use it). A to-do opens the card dialog through `FT.kanban.openCard(card, opts)`, the same code as a list item.
- Speed matters: every sheet call is slow on Google. Read tables through `Table` (cached per request) and prefer `insertMany`. On the client, changes the user makes often (cards, list items) update `FT.store` and render first, then call `FT.rpc` with `{ render: false }` and `.catch(FT.saveFailed)`; new items get `FT.newId()` and the server accepts it through `clientId_()`.
- Offline (`src/ui/offline.html`, `src/core/conflicts.js`, docs/offline-design.md): `FT.rpc` queues changes made while Google cannot be reached. A new call that updates the screen first (the pattern above) can be added to `QUEUEABLE` there; a table whose rows can be edited offline gets an `updated_at` header (stamped by `Table`) and a line in `CONFLICT_TARGETS_`. Bump `SCHEMA` in offline.html when the shape of `bootstrap` data changes, so old saved copies are dropped.
- Undo works on sheet rows only. A call whose row changes are bookkeeping goes in `NOT_UNDOABLE_` (core/undo.js). Settings rows are not undone, unless written with `setSettingsWithUndo_` (core/settings.js; only the phone's pills so far).
- Rich text from the browser is cleaned on the server with `sanitizeRichText_` before it is stored. Never store or render browser HTML without it.
- Cells are plain text. Dates are ISO strings. Numbers are listed in a table's `numeric` argument.

## Assistants editing the user's sheet

Any user's AI assistant (Claude or another, with a Google Drive or Sheets connector) may add and change rows in the user's spreadsheet. It learns how from the guide the app writes from the code: `src/core/guide.js`. The same generator makes the Doc "Focus Tracker – guide for AI assistants" in the root "Focus Tracker" folder, the Start here tab, the paragraph in Settings → AI assistant, and `docs/assistant-guide.md` (`node scripts/write-guide.js`; a test fails while it is out of date).

- A new people tab needs a line in `TAB_STYLE` (`src/core/schema.js`) and an entry in `guideTabs_()`. A new column in a people tab needs its meaning there too; a test fails until it has one.
- A new kind of information needs a line in "Where things go", so assistants put it in the right place.
- Rows an assistant types are completed or flagged by `src/core/complete.js` (the `complete` rules in `TAB_STYLE`). When the guide tells assistants to type something, add a test that types it into the fake sheet and loads the app.
- The guide holds no data from the sheet: no ids, addresses, names or categories. Mode names and the Doc's own address only.

## Deploying to Apps Script

Paddy has given standing permission: after `npm test` passes and the change is committed, run `npx clasp push -f` and then `npx clasp deploy --deploymentId <id> --description "<short text>"` without asking first. Run `npx clasp deployments` to list the ids. Use the newest versioned deployment (not `@HEAD`), so the bookmarked URL keeps working. Never create a new deployment: it changes the URL. Tell Paddy what you deployed. `.clasp.json` stays git-ignored and ids stay out of the repository.

## Checks

Run `npm install` once, then `npm test`. The server tests run the real server code against in-memory fakes of Sheets, Drive and Properties. The browser test loads the real page in jsdom and clicks through it. Neither runs on Google's servers, so anything that depends on Apps Script itself still needs trying after `clasp push`.

`tests/browser.test.js` runs the real page in Chrome (desktop and phone sized) against a deliberately slow fake server (`tests/support/devserver.js`) and fails if a button gives no feedback within 300 ms, if a change does not reach the server, if a refused save is not rolled back with a message, or if something covers the main controls. It needs Chrome (set `CHROME_PATH`, or install google-chrome or chromium) and skips itself if there is none, so say so when you report test results. When you add a button that saves something, show its effect on screen first with `FT.optimistic(apply, send)` and add it to that test.
