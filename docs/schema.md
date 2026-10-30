# Spreadsheet layout, version 2 (approved 2026-10-29)

Written 2026-10-29 for the November spec (`docs/SPEC-2026-11.md`). The migration and the core are built (see "As built" at the end); the features that use the new tabs come later. One layout that covers every feature in the spec, so the sheet changes once. The habit columns depend on the habits design (`docs/habits-ideas.md`) and may still change when it is approved.

## Goals

- A person (or an AI assistant) can open the sheet and understand it without the code.
- An assistant can add a project, a card, a resource or a note with plain rows, without making up ids.
- As few tabs as possible; nothing stored twice except readable names next to ids.
- Works the same if the app later talks to the sheet through the Sheets API (standalone app spike) instead of Apps Script.

## Rules for every tab

- **Two colours of tab.** Tabs for people are bright and come first. Tabs only the app uses are grey and come last; a note in cell A1's comment says "Used by the app. Do not edit."
- **Readable columns first.** In a people tab, the columns a person reads (name, title, status, note) are on the left. Ids and app columns are on the right with a grey header.
- **Names next to ids.** Where a row points at another row it has the id and the name, for example `project_id` and `project`. The app keeps the name in step when something is renamed. If an assistant fills in only the name, the app finds the id (when the name is unique).
- **Rows can be incomplete.** A row with an empty `id`, `order` or `created` is completed by the app the next time it loads. A row it cannot use (unknown project, bad value) is not deleted: the app writes the reason in its `problem` column and leaves it out until it is fixed.
- Cells stay plain text. Dates are ISO (`2026-10-29` or `2026-10-29T14:05:00Z`). Yes/no columns hold `yes` or are empty.
- Header row bold and frozen, a filter on people tabs, long text columns wrapped and wider.

## People tabs (bright, in this order)

| Tab | Columns (left to right) | Notes |
|---|---|---|
| **Start here** | – | A short guide: what each tab is, how to add a project, card, resource or note, the safety rules. Written by the app, refreshed after each migration. Same text as the Drive guide for assistants, shorter. |
| **Projects** | name, category, status, next_action, locked_until, last_touched, notes, problem · id, created, updated_at | `notes` is the link to the project's notes file or Doc, filled in when it is created. |
| **Tasks** | title, column, project, list, note, color, problem · id, project_id, list_id, column_id, order, note_html, created, updated_at | Kanban cards and list items. Exactly one of `project_id` / `list_id` is set (today `project_id` also holds list ids, which is confusing). `note` is the plain text; `note_html` the formatted copy the app shows. An assistant writes `note` only and the app makes the HTML. |
| **Lists** | name, project, show_today, display, seconds, color, problem · id, project_id, order, created | `project` is new: a list linked to a project shows on its page. |
| **Resources** | title, type, value, group, project, category, note, problem · id, project_id, added | `type`: link, drive, phone, email or text. `value`: the address, number or text. `group`: free text, for example "Code", "Suppliers". Empty `project` means shared by the category. Today's `url` becomes `value` with type link (or drive for Google Drive addresses). |
| **Habits** | name, intention, sessions, per, size, small_version, goal, step_up_every, prompts, category, description, status, problem · id, next_prompt, started, order, updated_at | As in `docs/habits-ideas.md` §3. `intention`: free text (Paddy's choice), for example "5 cardio sessions a week" or "just trying it out". `per`: day or week. The daily minimum becomes one row here. |
| **To-dos** | title, day, done, project, note, problem · id, project_id, order, created, updated_at | One-off small tasks. Empty `day` means anytime. `done` is the date it was done. |
| **Whiteboards** | name, project, show_today, file, updated, problem · id, project_id, file_id, created | `project` is now optional. |
| **Links** | from, type, to, note, problem · id, from_id, to_id, created | Linked projects. `type`: blocks (from must be done before to starts) or relates. Read as "<from> blocks <to>". |
| **Criteria** | text, done, project, problem · id, project_id, order, created, updated_at | Acceptance criteria. |
| **Log** | date, project, where_stopped, next_action, minutes · id, project_id | Sessions. Shown in Insights → Logs. |
| **Categories** | label, color · id, order | |

## App tabs (grey, last)

| Tab | Columns | Notes |
|---|---|---|
| Columns | id, project_id, list_id, name, order | Board columns and list groups. Grey because Tasks shows the column name. |
| Habit log | id, habit_id, habit, day, kind, count, value, updated_at | One row per habit per day (`done`, `plan`), plus rows for level changes and step-up answers, so past weeks compare with the target that applied then. Provisional. |
| Notes | id, project_id, file_id, file_url, updated, doc_id | Which notes file (and Google Doc, if that ships) belongs to which project. |
| Stickies | id, project_id, text, color, opacity, x, y, w, h, created | Placement data, mostly not for people. |
| Skips | id, project_id, to_project_id, date | |
| Reminders | id, project_id, due, created, done | |
| Thumbs | id, image, updated | Small WebP (or JPEG) previews of whiteboards as data URLs (under 45 000 characters). `id` is the whiteboard's id (see As built). |
| Settings | key, value | Per-mode settings that live in user properties today and must move for the standalone app: weekly rotation, this week's changes, layouts. One readable row per setting, for example `rotation.monday = coding`. Session and pomodoro state stay in user properties (they change every few seconds). |
| Undo | id, created, action, changes, kind | Cleared by the migration: old entries use old column names. |

## What changes from today

1. Tasks and Columns: `project_id` splits into `project_id` and `list_id` (found by checking the Lists tab). Readable `project`, `list` and `column` names are added.
2. Resources: `url` → `value`; new `type` and `group`.
3. Lists: new `project_id` / `project`.
4. Whiteboards: `project_id` optional; new `show_today`.
5. New tabs: Start here, Habits, To-dos, Habit log, Links, Thumbs, Settings.
6. Projects gain `notes` (link) and `problem`; every people tab gains `problem`.
7. Rotation and layouts move from user properties into Settings.
8. Columns are reordered in every tab (people columns left), tabs are coloured and reordered.

## How the migration runs

- `src/core/migrate.js`: a schema number per mode in script properties (`SCHEMA_VERSION.<mode>`; today counts as 1) and an ordered list of steps. It runs once when a mode first loads after the update, under the script lock.
- First it copies the mode's spreadsheet into the mode folder as `Focus Tracker - <mode> - backup before v2 - <date>`. If the copy fails, nothing is changed.
- Each tab is rewritten in one `setValues` call (read all, build the new rows, write to a new sheet, then swap names), so a half-done migration leaves the old tab in place. Running it twice changes nothing.
- The browser's saved copy is dropped (`SCHEMA` bump in `offline.html`). Queued offline changes still apply: they are API calls, not columns.
- Tested with the in-memory fakes from a fixture shaped like today's sheet. Paddy is asked before it is deployed on his real data.

## Open questions

- Settings tab: move rotation and layouts now (needed for the standalone app), or later? Done now, with the migration.
- Hide the grey tabs entirely (an assistant can still read hidden tabs), or only colour them? Only coloured for now.
- Thumbnails in the sheet (simple, about 20 KB a board) or as PNG files next to the `.excalidraw` files (cleaner, but the page cannot show a private Drive image without an extra call)? In the sheet (2026-10-30).

## As built (2026-10-29)

The migration, the tab styles, the Settings tab and the completing of typed rows are in the core (`src/core/migrate.js`, `schema.js`, `complete.js`, `settings.js`); tests in `tests/migrate.test.js`. Not run on Google yet, not deployed. What differs from the design above, and why:

- **Tasks `note`.** The plain-text copy (`note_text` before) is now `note`, as designed. The formatted copy is made from `note` only when `note_html` is empty, because old plain copies were made by an older converter and do not always match the HTML; comparing them would throw away formatting. So to rewrite a card's note in the sheet, write `note` and empty `note_html` (Start here says so).
- **Who is checked.** A row with an id and no problem is the app's own and is never judged, only completed (an empty `order` or `created` is filled). Checks (required columns, names to ids, categories, types) run on rows with no id, rows with a problem, and rows with a name but no id. This keeps old rows that predate a column (a whiteboard with no name) working, and keeps the check free when nothing is missing.
- **Defaults.** An empty `id`, `order` or `created` is filled on any row. Other defaults (status `active`, a next action, `last_touched`, a resource's type from its address, a resource's category from its project) only on new rows. A category may be typed as its label ("Coding"); it is stored as the id.
- **A card for a board with no columns.** If an assistant adds a card to a project or list that has no columns yet, the app makes one (the column named, or "To do"), so the card is not stuck. An unknown column on a board that has columns is a problem that lists the columns.
- **Missing targets.** On a row being checked, an id that points at nothing ("No project with id ...") is a problem. A flagged row is never deleted by the app, also not when its project is deleted.
- **Log and Categories** have no `problem` column (as designed), so a row there can be completed but not flagged.
- **Settings rows.** `rotation.monday` ... `rotation.sunday` hold a category id, `away` or `any`; `rotation.daily_minimum` a category id or `none`; `week.of` the Monday of the week the `week.<day>` rows apply to (an empty value means the usual day); `layout.<page>` the page's layout as JSON. An empty value means not set, so a day can be reset by clearing its cell. Settings are not undoable (they were not before). The old user properties are left in place, not deleted.
- **Backup.** Named with the mode's label: `Focus Tracker - Personal - backup before v2 - 2026-10-29`. Its file id is kept in `SCHEMA_BACKUP.v2.<mode>`, so a retry after a failure does not copy the half-migrated sheet again.
- **Tab rewrite.** The new tab is written as `<tab> (updating)`. A leftover one from a stopped run is deleted, or renamed into place if the old tab was already gone. Blank rows are dropped. Columns and tabs the app does not know are kept: own columns after the v2 columns, own tabs between the people tabs and the app tabs.
- **Grey tabs** are coloured, not hidden. The "Used by the app" text is a cell note on A1.
- **Tabs not made by the migration.** Habits, To-dos, Links, Habit log and Thumbs are made by their modules when they exist; `TAB_STYLE` gives them their colour, filter and place when `Table.ensure` creates them. Thumbs uses the whiteboard id as its `id` (below).
- **Names next to ids.** Kept in step by `Table`: an insert or update that sets an id fills its name, and renaming a project, list or column rewrites the name in every tab that shows it (one write per tab). These name writes are not recorded for undo; undoing a rename rewrites them again.
- **The browser.** Kanban columns and cards carry `owner` (their project or list id) so pages filter on one field; calls still send the owner id as `projectId` and the server works out `project_id` or `list_id`. Resources keep taking `url` in `add`. Rows that are not links (phone, email, text, typed in the sheet) show as text. The saved copy is dropped (`SCHEMA` 2); the offline queue is kept (`QUEUE_SCHEMA` 1).
- **Lists `project`, Whiteboards `show_today`, Resources `group`** are stored and kept in step. Lists `project` and Whiteboards `show_today` are used since 2026-10-30 (a linked list shows on its project's page; a board can be shown on Today); Resources `group` comes later.
- **Thumbs** (2026-10-30) has `id, image, updated`, not `whiteboard_id`: `Table` needs an `id` column, and the row's id is the whiteboard's id, so there is one row per board and no second copy of the id to drift. `updated` is the board's `updated` when the preview was made. The whiteboard module makes the tab. The previews are not sent with the first load; the browser asks for the ones it shows (`whiteboard.thumbs`). The open question below is settled: in the sheet.
- **Whiteboards without a project** (2026-10-30): `project_id` and `project` empty; the Drive file is `<name>-<id>.excalidraw`. Deleting a project still takes its boards out of the app (their files stay in Drive), as before.
- **Links** (2026-10-30) is made by the `links` module (setup, or the first load after the update). A typed row needs a project on both sides that are not the same; duplicates and blocking circles are refused by the app's own calls, not flagged in typed rows.
- `migrateAllModes()` can be run from the Apps Script editor to migrate every mode that has a spreadsheet before the app is opened.

### Risks on Google's runtime (what the fakes cannot prove)

- **Time and the lock.** The first load of each mode copies the spreadsheet and rewrites about 14 tabs, then styles and orders them: likely tens of seconds. Other requests wait 15 s for the script lock and then fail with a lock error (another device, a second tab). Run `migrateAllModes()` from the editor right after `clasp push`, before opening the app.
- **API behaviour.** `makeCopy` of the spreadsheet (if the Personal sheet is bound to the script, the copy also gets a copy of the script project), `insertSheet` position, `setActiveSheet` and `moveActiveSheet` in a web app execution, `setTabColor`, `createFilter`, `setNote`, `setWrap`, `setColumnWidth`: only stubbed in the fakes.
- **Cell types.** Cells typed by hand outside the app's text format come back as numbers, booleans or dates. Dates become ISO text (a date alone at midnight in the script's time zone); the rest becomes plain text. Formulas become their values in rewritten tabs (the backup keeps them).
- **What a tab rewrite loses.** Formatting, data validation, conditional formats, column widths, filter views, protected ranges and notes on the old tabs; formulas, charts or named ranges elsewhere that point at a rewritten tab break (`#REF!`). All of it is in the backup.
- **Writes over a person's typing.** Completing typed rows writes the span from the first to the last changed row in one call, and a rename writes the name column over a span. A person editing a row inside that span at the same second could lose that edit.
- **Cost after the update.** Each load reads the Settings tab; saving a layout or the rotation writes the sheet instead of a user property; adding a card reads Projects (for the readable name); a project rename reads up to seven tabs. A flagged row is checked again on every load (one lock and a few reads) until it is fixed.
- **Rolling back.** Older code reads a v2 sheet wrongly (list boards empty, resources without addresses). To go back, restore the backup copy, not only the code.
- **Before this update and unchanged:** writing below the tab's last row (about row 1000 in a tab made by the app) is not checked; Google may refuse it.
