# Focus Tracker – guide for AI assistants

This guide is for any AI assistant (Claude, ChatGPT, Gemini or another) that can read and edit the owner's Google Drive and Google Sheets. It says how to add and change things in Focus Tracker so the app can use them. The app writes this Doc from its own code and rewrites it when the app changes, so do not edit it: your changes would be lost.

## In short

- Focus Tracker keeps everything in Google Drive, in the folder "Focus Tracker". It has one subfolder per mode ("Personal" or "Work"), and each subfolder holds that mode's spreadsheet. If the owner does not say which mode, ask.
- Add things by adding rows at the bottom of a tab. Change things by changing cells. Never delete rows, never move, rename or delete columns or tabs, and never edit the grey tabs.
- Fill only the columns on the left, the ones with a white header. Leave the grey-header columns (from id on) empty: the app fills them the next time it opens.
- Point at other rows by their name (a card's project, a link's from and to), written exactly as in their own tab.
- Never create files in Drive. The app only sees files it made itself. Notes go into the project's notes Doc or its notes cell (see "Notes").
- Never put sensitive information in the sheet, and never copy the contents of a file into it (see "Safety rules").
- If the app cannot use a row, it writes the reason in that row's problem column. Read the problem columns when you finish.

## Where things go

| What to save | Where | How |
|---|---|---|
| A new project or goal | Projects | A row with name, category and next_action. |
| The next step on a project | Projects, next_action | One short, concrete sentence. Replace the old one. |
| Notes, ideas, research, meeting notes, decisions | The project's notes | See "Notes". Not in cards, not in new files. |
| A task on a project | Tasks | A row with title, project and column (To do, Doing or Done). |
| What "done" means for a project | Criteria | One row per criterion, with project. |
| A code repository (GitHub, GitLab) | Resources | type link, value the https:// address, group Code, project. |
| A web page, shop, article or video | Resources | type link, with a group that fits (Code, Docs, Design, Suppliers, Contacts, Reference). |
| A Google Drive file the owner named | Resources | type drive, value its https://docs.google.com/ or https://drive.google.com/ address. |
| A phone number or an email address | Resources | type phone or email, with a title saying whose it is. |
| A short fact to keep (a size, a model number) | Resources | type text, value the text. |
| One project has to wait for another | Links | from the one that goes first, type blocks, to the one that waits. |
| Two projects belong together | Links | type relates. |
| Something to repeat (exercise, practice) | Habits | name, sessions and per, for example 3 and week. Start low. |
| A one-off small task (shopping, an appointment) | To-dos | title, and day if it is for a day. |
| Items that are not a project (books, films, ideas) | Tasks with list | title, list and column (the list's group). A new list is a row in Lists. |
| A record of a work session | Log | project, where_stopped and minutes. |
| A drawing | Nowhere | Whiteboards are made in the app. Describe it in the notes instead. |
| Anything else, or you are not sure | Ask the owner |  |

Resource groups: use the same group for the same kind of thing, so a project's page stays tidy. Use a group the project already has when one fits. Suggested groups:

| Group | For |
|---|---|
| Code | repositories (GitHub, GitLab), issue trackers, builds |
| Docs | design documents, specs, manuals |
| Design | mock-ups, drawings, colour schemes |
| Suppliers | shops and trades: website, phone, email |
| Contacts | people to call or write to |
| Reference | articles, videos and other reading |

## Notes

Each project has notes: formatted text the owner reads and edits in the app. They are kept in a notes file and a Google Doc called "<project name> notes" in the mode's Notes folder. The notes cell in Projects holds the Doc's link.

- **The notes cell holds a Google Docs link** (https://docs.google.com/document/...): open that Doc and add your text to it. Keep what is there. Add new text at the end, under a heading with the date, for example "## 2026-11-03". The app brings the Doc's text into the project the next time the project is opened.
- **The notes cell is empty, or holds another link** (an older notes file): write the notes into the notes cell itself, as plain text, replacing the link. The app adds the text to the end of the project's notes when it next opens, makes the Doc, and puts the link back in the cell.
- Notes may use simple markdown: # for a heading, - for a list item, **bold**, *italic*, and [text](https://...) for a link. One paragraph per line.
- Never create a new Doc or file for notes, and never rename or move the notes Doc: the app could no longer find it.
- A card has its own short note: the note column in Tasks. To change a card's note, write note and empty its note_html cell.

## Rules for every row

- Cells are plain text. Dates look like 2026-11-03, a time like 2026-11-03T14:05:00Z. Yes/no columns hold yes or are empty.
- Leave id, order, created and the other grey-header columns empty in a new row. The app fills them, and the ids next to the names (project_id, column_id and so on), the next time it opens.
- A name must match exactly one row in its tab. Capital letters do not matter; spelling does. If two rows share the name, the app does not guess: it writes a problem instead.
- A category is a label from the Categories tab of the same spreadsheet, for example "Coding". Read that tab first; never make up a category.
- A new project and the rows that point at it can be added in the same edit, in any order.
- Do not write in the problem column. When a row has a problem, change the cell it names; the app clears the problem the next time it opens.

## The tabs

People tabs come first and are brightly coloured. Grey tabs (Columns, Habit log, Notes, Stickies, Skips, Reminders, Thumbs, Settings, Undo) are used by the app only: do not edit them. The "Start here" tab is a short version of this guide.

### Projects

One row per project or goal.

| Column | You fill it | Meaning |
|---|---|---|
| name | yes | The project's name. No two projects share a name. |
| category | yes | A category label from the Categories tab, for example "Coding". Never make up a category: ask. |
| status | if known | One of: active, paused, done, archived. Empty means active. |
| next_action | if known | The next small, concrete step, one sentence. Empty means "Decide the first small step". |
| locked_until | if known | A date (2026-11-03): the project is left out of the daily pick until then. Usually empty. |
| last_touched | no, the app does | When work last happened. Filled by the app. |
| notes | if known | The link to the project's notes Doc, filled by the app. See "Notes" for how to add notes. |
| problem | no, the app does | Why the app cannot use this row. Written by the app; fix the row and it clears. |

App columns, leave them empty: id, created, updated_at.

### Tasks

Cards on a project's board, and the items of a list.

| Column | You fill it | Meaning |
|---|---|---|
| title | yes | What to do, short. |
| column | if known | The board column by name, for example "To do", "Doing" or "Done". Empty means the first column. A new project's board starts with To do, Doing, Done. |
| project | yes | The project's name, exactly as in Projects. Fill project or list, not both. |
| list | if known | The list's name, exactly as in Lists, for an item on a list instead of a project card. Then column is the list's group. |
| note | if known | Details, plain text. Line breaks and https:// addresses are kept. |
| color | if known | A colour number from 1 to 8, or empty. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, project_id, list_id, column_id, order, note_html, created, updated_at.

- column_id: To move a card to another column, write the column's name in column and empty column_id. The app finds the new column.

- note_html: The formatted copy of note, made by the app. To change a card's note, write note and empty note_html.

### Lists

Lists that are not projects, such as "Read and watch". Their items are rows in Tasks with list filled in.

| Column | You fill it | Meaning |
|---|---|---|
| name | yes | The list's name. No two lists share a name. |
| project | if known | A project's name: the list then also shows on that project's page. |
| show_today | if known | yes to show the list on Today, or empty. |
| display | if known | Empty shows the whole list; one shows one item at a time. |
| seconds | if known | With display one: how many seconds each item shows. |
| color | if known | A colour number from 1 to 8, or empty. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, project_id, order, created.

### Resources

Links and other things kept with a project, or shared by a whole category.

| Column | You fill it | Meaning |
|---|---|---|
| title | yes | A short name, for example "garden-irrigation repo". |
| type | yes | One of: link, drive, phone, email, text. link: a web address; drive: a Google Drive file or folder; phone, email: a number or address; text: a short note. |
| value | yes | The address (starting with https:// for link and drive), the phone number, the email address or the text. |
| group | if known | Free text that groups resources on the project's page. Use these where they fit: Code, Docs, Design, Suppliers, Contacts, Reference. |
| project | if known | The project's name. Empty means shared by the whole category. |
| category | if known | A category label. Needed only when project is empty; otherwise the project's category is used. |
| note | if known | One short line about it. Never the contents of the file. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, project_id, added.

### Habits

Things done again and again, n sessions a day or a week.

| Column | You fill it | Meaning |
|---|---|---|
| name | yes | The habit, for example "Cardio". |
| intention | if known | Free text: how serious it is, for example "5 cardio sessions a week" or "just trying it out". |
| sessions | yes | How many sessions, a whole number, 1 or more. Start low. |
| per | yes | One of: day, week. |
| size | if known | How big one session is, for example "10 min". |
| small_version | if known | The smallest version that still counts on a bad day. |
| goal | if known | Where building up stops, written like "5 a week, 30 min". |
| step_up_every | if known | How often the app asks to step up, for example "2 weeks". Empty for never. |
| prompts | if known | on, off or at goal. Empty means off. |
| category | if known | A category label, if the habit belongs to one. |
| description | if known | Why, in a sentence. |
| status | if known | One of: active, paused, ended. Empty means active. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, next_prompt, started, order, updated_at.

### To-dos

One-off small tasks, such as grocery shopping or a job interview, for a day or anytime.

| Column | You fill it | Meaning |
|---|---|---|
| title | yes | What to do. |
| day | if known | The date it is for (2026-11-03), today or later. Empty means anytime. |
| done | no, the app does | The date it was ticked off. Filled by the app. |
| project | if known | A project's name, if it belongs to one. |
| note | if known | Details, plain text. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, project_id, order, created, updated_at.

### Whiteboards

Drawings. Only the app can make one (it makes the drawing file), so never add rows here.

| Column | You fill it | Meaning |
|---|---|---|
| name | no, the app does | The whiteboard's name. |
| project | no, the app does | The project it belongs to, or empty. |
| show_today | if known | yes to show it on Today, or empty. |
| file | no, the app does | The drawing file in Drive. |
| updated | no, the app does | When it was last saved. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, project_id, file_id, created.

### Links

Projects that depend on each other. Read a row as "<from> <type> <to>".

| Column | You fill it | Meaning |
|---|---|---|
| from | yes | A project's name. |
| type | yes | blocks: from must be done before to can start (to is left out of the daily pick until then); relates: they belong together. |
| to | yes | Another project's name. |
| note | if known | Why, in a few words. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, from_id, to_id, created.

### Criteria

Acceptance criteria: what "done" means for a project.

| Column | You fill it | Meaning |
|---|---|---|
| text | yes | One thing that is true when the project is done. |
| done | if known | yes when it is met, or empty. |
| project | yes | The project's name. |
| problem | no, the app does | Why the app cannot use this row. Written by the app. |

App columns, leave them empty: id, project_id, order, created, updated_at.

### Log

One row per working session. Mostly written by the app when a session ends.

| Column | You fill it | Meaning |
|---|---|---|
| date | if known | When the session was. Empty means now. |
| project | yes | The project's name. |
| where_stopped | yes | Where the work stopped, one sentence. |
| next_action | if known | The next step that was set. |
| minutes | if known | Minutes worked, a whole number. |

App columns, leave them empty: id, project_id.

### Categories

The categories projects are grouped by. Change them in the app, not here.

| Column | You fill it | Meaning |
|---|---|---|
| label | no, the app does | The category's name. Use these labels in the category columns of other tabs. |
| color | no, the app does | A colour number from 1 to 8. |

App columns, leave them empty: id, order.

## Worked example: a new project

The owner says:

> Save this in Focus Tracker as a new house project, "Garden irrigation". Notes: drip lines on the two back beds, a timer on the outside tap, the water butt as a backup. First measure the beds and choose a drip kit; I'm already sketching the layout. The code for the timer is on GitHub at https://github.com/example/garden-irrigation. It can't start until the garden fence repair is done. Done means every bed gets water from the timer.

The assistant reads the Categories tab (House is there) and the Projects tab (no project is called "Garden irrigation" yet; "Garden fence repair" exists), then adds these rows. Every other column stays empty.

**Projects**

| name | category | next_action | notes |
|---|---|---|---|
| Garden irrigation | House | Measure the two back beds | # Plan\nDrip lines on the two back beds.\n- Timer on the outside tap\n- Water butt as a backup |

**Tasks**

| title | column | project | note |
|---|---|---|---|
| Measure the beds | To do | Garden irrigation |  |
| Choose a drip kit | To do | Garden irrigation | Compare two kits that fit the outside tap |
| Sketch the layout | Doing | Garden irrigation |  |

**Resources**

| title | type | value | group | project |
|---|---|---|---|---|
| garden-irrigation repo | link | https://github.com/example/garden-irrigation | Code | Garden irrigation |

**Links**

| from | type | to | note |
|---|---|---|---|
| Garden fence repair | blocks | Garden irrigation | The fence posts go in first |

**Criteria**

| text | project |
|---|---|
| Every bed gets water from the timer | Garden irrigation |

Why: the notes go in the notes cell because the project is new and has no notes Doc yet (\n above is a line break inside the cell). The cards name their columns: a new project's board starts with To do, Doing, Done. The repository is a resource of type link in the group Code. "Can't start until" is a blocks link from the project that goes first. The next time the app opens it fills every id, makes the board and the notes, and shows "Waiting on Garden fence repair".

## Changing an existing project safely

- Find the project's row in Projects by its name. If no row or more than one row has that name, ask the owner which project is meant.
- Change cells in place: next_action, status (active, paused, done, archived), a criterion's done, a resource's value.
- To move a card (for example to Done), write the column's name in its column cell and empty its column_id cell. To change a card's note, write note and empty note_html. These two are the only grey cells you may change.
- Add new cards, resources, criteria and links as new rows at the bottom of their tab, pointing at the project by name.
- Never delete a row, also not one you added by mistake: tell the owner, who can delete it in the app (with undo). To finish a project, set status to done; to drop it, archived.
- Do not rename projects, lists or columns in the sheet: rename them in the app, which keeps the names in other tabs in step.
- Never change an id or any other grey-header cell (except column_id and note_html as above), never sort a tab or move rows, and never touch the grey tabs.
- Before adding a resource or a card, check it is not there already.

## Safety rules

- Never put bank or card details, passwords, ID or passport numbers, tax references, health records or anything similar in the sheet or the notes.
- Only link a Drive file the owner named or clearly pointed at. Never browse Drive and add links on your own.
- Before linking a file, check it. If it holds sensitive material like the above, ask the owner to confirm first: a link is one click away from the contents.
- Never copy the contents of a linked file into the sheet or the notes. Keep the link, a title and a short note only.
- If in doubt, ask.

## Checklist before you finish

- [ ] Every new row is in the right tab (see "Where things go"), at the bottom, with only white-header columns filled.
- [ ] Every project, list, column and category name is spelled exactly as in its own tab.
- [ ] Notes went into the project's notes Doc or its notes cell, and no new file was made.
- [ ] No row was deleted or moved, no column or tab was changed, no grey tab was touched.
- [ ] No sensitive information was added, and no file contents were copied.
- [ ] You told the owner what you added and changed, and that the app finishes the rows the next time it opens. If you can, check the problem columns after the owner has opened the app.
