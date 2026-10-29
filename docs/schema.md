# Spreadsheet layout, version 2 (approved 2026-10-29)

Written 2026-10-29 for the November spec (`docs/SPEC-2026-11.md`). Nothing here is built yet. One layout that covers every feature in the spec, so the sheet changes once. The habit columns depend on the habits design (`docs/habits-ideas.md`) and may still change when it is approved.

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
| Thumbs | whiteboard_id, image, updated | Small WebP previews of whiteboards as data URLs (under 45 000 characters). |
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

- Settings tab: move rotation and layouts now (needed for the standalone app), or later?
- Hide the grey tabs entirely (an assistant can still read hidden tabs), or only colour them?
- Thumbnails in the sheet (simple, about 20 KB a board) or as PNG files next to the `.excalidraw` files (cleaner, but the page cannot show a private Drive image without an extra call)?
