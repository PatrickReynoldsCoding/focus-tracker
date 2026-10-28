# Roadmap and decisions

Handoff notes so a fresh Claude session has the context this project was designed with. The owner is Paddy.

## Why this exists

Paddy juggles several coding projects, job-search goals and house maintenance, and loses track of anything he has not touched for a few days. He picks work on feel each morning and wants structure. The app picks one focus project per day, shows its next action and last note, and makes stopping cheap: one line on where he stopped, then he can let it go.

## Constraints and preferences

- Free to run: Google Sheets + Apps Script, deployed as a web app only he can open. Works on every device. Desktop is the main target, phone should be usable.
- Frictionless: open it and it works. Few clicks.
- Separation of concerns, plugin style: a small core and one folder per feature. Adding or removing a feature is a folder plus one config line. See AGENTS.md.
- Data readable by humans and by Claude: sheet tabs and plain markdown notes, no opaque blobs.
- Never link or copy sensitive Drive material. See AGENTS.md. Never commit his real links or ids.
- Excalidraw whiteboards per project (done, 2026-10-28; named, several per project since the Settings change): whiteboard module. React 18.2.0 and @excalidraw/excalidraw 0.17.6 load from jsDelivr only when a whiteboard opens. Saves `<mode folder>/Whiteboards/<project>-<id>.excalidraw` two seconds after a change and on close; reopens where you left off. Desktop only. Checked in real Chrome (draw, autosave, close, reopen).

## Requested changes, in the suggested order

### Batch 1: quick wins (done, 2026-10-28; tested with fakes only, not yet on Google's runtime)
Decisions Paddy made while it was built:
- Pomodoro breaks count as session time. Only Pause stops the session clock (and the pomodoro).
- When a work or break period ends, it alerts and then waits for a click ("Start break" / "Start work"). It does not move on by itself.
- The pomodoro is off by default and is switched on per session. Lengths are kept in user properties. A changed length applies from the next period.
- The Log has a `minutes` column: worked minutes without pauses, written on finish.
- The alert ticks on every tab while a session runs, not only on Today.
- A browser notification is sent when a break starts and when it ends (permission is asked when the pomodoro is switched on). Sound and tab title stay as the fallback, because Apps Script pages may block notifications. Not yet tried on Google's runtime.

Original requests:
- Desktop: a small icon at the right to stretch the page to full screen width (remember the choice per browser).
- Projects table: sortable and filterable (by category, status, text).
- Kanban: remove the single "new task" bar. Each column has its own add-task control.
- Today: when a session is started, allow pause, and a simple pomodoro timer (work/break lengths configurable, default 25/5). Session time excludes pauses. State is stored server side so it survives switching devices. Alert with sound and tab title, because browsers may block notifications inside Apps Script pages.

### Batch 2: Today behaviour (done, 2026-10-28)
- Swap focus opens a dialog: pick the project (ranked as Today ranks them) and an optional reminder (tomorrow, 3 days, next week). Each skip is a row in the Skips tab; the project page shows "Skipped N times". Due reminders are banners on Today ("Make it today's focus" or "Dismiss"), rows in the Reminders tab.
- The rotation's Edit button: usual lead per weekday (a category, any, or Away) plus "this week" changes, saved with the week's Monday so they stop applying the next week. The daily-minimum category is chosen there too. An Away day shows a calm panel with "Show my focus anyway".
- Paddy chose no morning email and no Google Calendar, so no new permissions were added.

Original plan:
- Swap focus: let him choose which project to switch to. The project swapped away from is remembered as skipped, not worked on. Design agreed in principle:
  - Skipping never counts as work, so it keeps its neglect and naturally resurfaces.
  - On swap, optional "remind me" (tomorrow, in 3 days, next week, none). A due reminder shows as a banner on Today. Optional morning email via a time-driven trigger.
  - Log each skip, and show "skipped N times" on the project.
- Weekly rotation is editable: a default rotation he can edit, plus an "edit this week" override per day (for example mark a day away or change its category) that resets automatically on Monday. A small icon opens it.
- A full calendar was judged too complex for now. A cheap later option: read Google Calendar all-day events titled "Away" to mark days off automatically.

### Batch 3: richer boards and layout (done, 2026-10-28)
- Click a card (or list item) to open it: title, card colour and a rich-text note (bold, italic, underline, lists, small/normal/large, text colours, links). Stored as cleaned HTML in `note_html` (core/richtext.js keeps a small allowlist) plus a plain-text copy in `note_text`. The first lines show on the card.
- Panels on Today, project pages, the Projects tab and the Lists tab can be moved and resized: header icon "Edit layout" (desktop only), GridStack 10.3.1 from jsDelivr, heights follow content. Layout saved per page and per mode in user properties (layout module). Phone, or no CDN: panels flow in order.
- Checked in real Chrome with a local Playwright harness (drag, resize, reload, editor toolbar), not only in jsdom.

Original plan:
- Each Kanban task gets a note with different text sizes, colours and bullets, and the task itself gets a colour option. Plan: a small rich-text editor in a task dialog, stored as sanitised HTML in a sheet cell (watch the cell size limit), with a plain-text fallback for readability by hand and by Claude.
- Every panel movable by grabbing its border, like Grafana. Plan: a grid layout library loaded from a CDN, behind an "Edit layout" toggle so nothing moves by accident, desktop only, layout saved per page per mode.

### Sticky notes (done, 2026-10-28, requested by Paddy)
- Floating sticky notes on project pages (stickies module, Stickies tab): "+ Note" and a Hide/Show button at the bottom right; while hidden the button shows how many notes there are. Drag by the top strip, resize from the corner, type directly (saves 0.8 s after the last change, and on page close). The strip holds only ⋯ (options menu beside the note: 15 pastel colours and a paper slider) and × (delete). The paper slider from 40% to 100% (only the paper goes see-through, the text stays solid, so a note can never vanish). x is a percentage of the page width, y pixels from the top. New notes step past existing ones. Delete with Undo. Hide/show is per browser.

### Settings, named whiteboards (done, 2026-10-28, requested by Paddy)
- A ⚙ Settings button in the header replaces the folder icon. It holds "Open <mode> folder in Drive" and the theme: Light, Dark or Same as computer (kept in the browser as `ft.theme`, applied in index.html before the page draws). The dark colours now apply for `data-theme="dark"`, or for the computer's dark mode unless `data-theme="light"`.
- A project can have any number of named whiteboards (Whiteboards tab gained `name` and `created`; old rows show as "Whiteboard"). Create, open, rename (also renames the Drive file), remove with Undo (the file stays in Drive). Excalidraw always uses its light, white canvas.

### Session on the focus project page (done, 2026-10-28, requested by Paddy)
- Today's focus project page starts with the session: the timer, pomodoro and session buttons while a session runs, or a "Today's focus" bar with Start session. Other project pages show nothing there (today module, slot `project.page`, id `session`).

### One item at a time (done, 2026-10-28, requested by Paddy)
- List Settings has "Display on Today": Full list, or One at a time. One at a time shows a random item as a quote card (option A of the mockups) in the list's colour, with its whole card note under it, and moves to another item every n seconds (5-3600, default 30). No progress bar and no More/Less, at Paddy's request. Order is shuffled and no item repeats until all were shown; ‹ › skip. Clicking the quote opens the item. The Lists tab keeps the full list for editing and shows a "One at a time on Today" label.
- `FT.fitPanel(el)` re-measures a grid panel whose content changed without a redraw.

### Links, acceptance criteria, Esc (done, 2026-10-28, requested by Paddy)
- Web addresses in card titles and note previews, next actions, "Last time", the Log and resource notes are clickable (`FT.linkify`, new tab). A link inside a clickable card opens the link, not the card. Addresses typed into a card note become links when saved; in the editor Cmd/Ctrl + click opens them.
- Each project page has an "Acceptance criteria" checklist above the Kanban (criteria module, Criteria tab): add with Enter, tick, click to edit, drag to reorder, delete with Undo, "Hide checked" per project (browser-local).
- Esc leaves Edit layout (after closing a dialog, if one is open).

### Speed, undo and editing (done, 2026-10-28, requested by Paddy)
- Duplicate cards were real: while a save was slow (about 1.5 s on Apps Script) the text stayed in the box, so a second Enter saved it twice. Now new cards show at once with an id made in the browser, the box clears, and the server refuses a repeated id.
- Speed: each sheet tab is read once per request and writes keep that copy up to date (sheetdb.js), header and rows come in one read. Sheet calls fell from 86 to 44 to open the app and from 44 to 12 to add a card. Card add, move, edit and delete show on screen first and save in the background, one save at a time and in order; a reply's data is only used when no later save is waiting. The browser warns before closing the tab while saves are pending.
- Undo: every call records its row changes; they are kept in the mode's Undo tab (last 30) and the header button or Cmd/Ctrl+Z puts the newest back. Deletes are immediate with an Undo button in the message. Notes, whiteboards and the Today session are not undone.
- Drag and drop (SortableJS 1.15.2 from jsDelivr, short press on touch) replaces the move arrows on boards and lists, including order inside a column. The card dialog has a Column/Group choice as well.
- Panels can be hidden in Edit layout ("Hide", then "Show ..." in the bar). Lists have a colour: "⚙ Settings" on a list (Lists tab and Today) opens name, colour swatches with a live preview of the list, and Show on Today. A coloured list has a solid top bar and a tint. The project form has "+ New category…". Enter saves inline name fields.

### Todoist import into Work (pushed 2026-10-28)
- Paddy chose to import all 54 open Todoist tasks as they are, accepting that iManage-internal content goes into his personal Google account.
- Mapping: "Current Stuff" becomes project "Current work" (sections are columns) except "keep in mind" (list "Keep in mind", shown on Today) and "todo" (project "Admin"). "Read and Watch" becomes a list with its sections as groups. Subtasks are their own cards ("parent → child"), descriptions and due dates go into card notes, Todoist P1/P2/P3 become red/orange/blue cards.
- Mechanism: `core/import.js` runs `pendingImportData_()` from git-ignored `src/private/` once, when the target mode first opens. The data file must be deleted and pushed again after the import ran. Never commit it.

### Lists (done, 2026-10-28, requested by Paddy)
- A Lists tab with any number of named lists (for example "Keep in mind", "Read and Watch"). Each list has groups and items, edited exactly like a vertical Kanban: a list is a Kanban board owned by the list id.
- "Show on Today" puts a list on Today as its own panel (slot `today.panels`).

### Batch 4: modes (done, 2026-10-28)
Built as planned, with these decisions from Paddy:
- One Drive folder "Focus Tracker" with a subfolder per mode (`Personal/`, `Work/`). Each holds that mode's spreadsheet and `Notes/`. The spreadsheet and Notes from before modes moved into `Personal/` on first load.
- The header has a mode menu (a dropdown) and a folder icon that opens the mode's Drive folder. Work mode uses a blue accent.
- "+ New mode…" in the menu makes a mode in the app (2026-10-28): kept in the CUSTOM_MODES script property, with its own Sheet and folder made on first open, one "General" category and its own accent colour. Renaming or deleting a mode is not built yet.
- Categories are editable in the app (Projects tab), per mode. Work starts with Delivery, Ops, Learning, Career, Admin. A category in use cannot be deleted.
- Work mode has no daily minimum and no lead categories by default (Batch 2 makes the rotation editable).
- PR notifications: dropped, not wanted.

Original plan:
- Modes are a parent concept above categories. Everything built so far is "Personal" mode. Add a "Work" mode with the same features and separate data.
- Decision: one spreadsheet and one Drive folder per mode, so work data stays apart and can be deleted cleanly.
- Suggested design: a `MODES` config where each mode has an id, label, its own categories, its own module list, and the property keys for its spreadsheet and folder. `getSpreadsheet_` and the Drive helpers take the mode. A mode switcher in the header. `rpc` and `bootstrap` carry the mode. Modules stay unchanged where possible; Table gets the mode from the context.
- Work mode has an extra tab, PRs (see below). That is just a module listed only in Work's module list.

### Separate project: PR notifications (dropped 2026-10-28, not wanted)
- Wanted: search work GitHub for his open PRs and notify him when someone comments, as a macOS notification on his work Mac.
- Apps Script cannot show native macOS notifications. Recommendation: a small local tool on the work Mac using the `gh` CLI (already signed in) run by a scheduled job (launchd) that checks for new comments and calls the macOS notification command. This also keeps a work token out of his personal Google account.
- Check his employer's policy before putting work PR data or tokens in a personal Google account.
- Optional later: the local tool writes the current open-PR list somewhere the Work mode PRs tab can display.

## Known gaps and untested assumptions

- Only tested against in-memory fakes of Sheets, Drive and Properties, plus a simulated browser. Never run on Google's runtime. The main assumption is that file names with folder prefixes (`modules/kanban/view`) work with `HtmlService` in `include()`. If the first load fails with a file-not-found error, look there first.
- Every action is a round trip to Apps Script (usually under a second). Kanban moves are optimistic; most other actions wait for the server.
- Example data came from the design preview. `seedStarterData` loads it. Resource links are not seeded.

## How to work on it

Run `npm install` once, then `npm test` after every change. Deploy with `clasp push` and `clasp deploy --deploymentId <id>`. Commit per batch with a clear message.
