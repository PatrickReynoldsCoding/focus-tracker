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
- Kept for later: an Excalidraw whiteboard per project that saves into the Drive folder and reopens where he left off. Desktop only is fine. Build it as its own module after the core is wired up. Embedding the full Excalidraw site inside an Apps Script page is unreliable; bundling the open-source library into the page is the likelier route.

## Requested changes, in the suggested order

### Batch 1: quick wins (done, 2026-10-28; tested with fakes only, not yet on Google's runtime)
Decisions Paddy made while it was built:
- Pomodoro breaks count as session time. Only Pause stops the session clock (and the pomodoro).
- When a work or break period ends, it alerts and then waits for a click ("Start break" / "Start work"). It does not move on by itself.
- The pomodoro is off by default and is switched on per session. Lengths are kept in user properties. A changed length applies from the next period.
- The Log has a `minutes` column: worked minutes without pauses, written on finish.
- The alert ticks on every tab while a session runs, not only on Today.

Original requests:
- Desktop: a small icon at the right to stretch the page to full screen width (remember the choice per browser).
- Projects table: sortable and filterable (by category, status, text).
- Kanban: remove the single "new task" bar. Each column has its own add-task control.
- Today: when a session is started, allow pause, and a simple pomodoro timer (work/break lengths configurable, default 25/5). Session time excludes pauses. State is stored server side so it survives switching devices. Alert with sound and tab title, because browsers may block notifications inside Apps Script pages.

### Batch 2: Today behaviour
- Swap focus: let him choose which project to switch to. The project swapped away from is remembered as skipped, not worked on. Design agreed in principle:
  - Skipping never counts as work, so it keeps its neglect and naturally resurfaces.
  - On swap, optional "remind me" (tomorrow, in 3 days, next week, none). A due reminder shows as a banner on Today. Optional morning email via a time-driven trigger.
  - Log each skip, and show "skipped N times" on the project.
- Weekly rotation is editable: a default rotation he can edit, plus an "edit this week" override per day (for example mark a day away or change its category) that resets automatically on Monday. A small icon opens it.
- A full calendar was judged too complex for now. A cheap later option: read Google Calendar all-day events titled "Away" to mark days off automatically.

### Batch 3: richer boards and layout
- Each Kanban task gets a note with different text sizes, colours and bullets, and the task itself gets a colour option. Plan: a small rich-text editor in a task dialog, stored as sanitised HTML in a sheet cell (watch the cell size limit), with a plain-text fallback for readability by hand and by Claude.
- Every panel movable by grabbing its border, like Grafana. Plan: a grid layout library loaded from a CDN, behind an "Edit layout" toggle so nothing moves by accident, desktop only, layout saved per page per mode.

### Batch 4: modes (done, 2026-10-28)
Built as planned, with these decisions from Paddy:
- One Drive folder "Focus Tracker" with a subfolder per mode (`Personal/`, `Work/`). Each holds that mode's spreadsheet and `Notes/`. The spreadsheet and Notes from before modes moved into `Personal/` on first load.
- The header has a mode switcher and a folder icon that opens the mode's Drive folder. Work mode uses a blue accent.
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
