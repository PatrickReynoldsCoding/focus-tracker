# Focus Tracker

A daily focus picker and project tracker that runs for free on Google Sheets and Apps Script. Open the web app on any device, see one project to work on, and park it with one line when you stop.

Features: Today (focus pick, session timer with pause and an optional pomodoro, daily job-search minimum), Projects (sortable and filterable), per-project Kanban (rename, add and delete columns, add tasks in any column, horizontal or vertical), notes saved as markdown files in Drive, Resources (links to Drive files per category or project) and a session Log with minutes worked, and Lists (groups and items edited like a vertical Kanban, optionally shown on Today). Click a card to give it a colour and a formatted note. On desktop, the grid icon at the top right lets you drag and resize panels, and the arrows icon stretches the page to full width.

Modes: Personal and Work keep separate data. Each has its own spreadsheet and its own folder inside the "Focus Tracker" Drive folder; the folder icon in the header opens it. Categories are edited on the Projects tab. A new mode is an entry in `MODES` in `src/core/config.js`; its spreadsheet and folder are created the first time you switch to it.

Data lives in your own spreadsheet, one tab per table, readable and editable by hand. Notes are plain `.md` files in a Drive folder.

## Layout

```
src/
  appsscript.json        manifest (scopes, web app settings)
  core/                  config, sheet access, module registry, rpc, setup, seed
  ui/                    page shell, shared styles, client core
  modules/
    today/ projects/ kanban/ notes/ resources/ log/
      server.js          <id>Module(): tables, snapshot, api
      view.html          FT.module({...}): tab and/or slots on other pages
tests/                   run with: npm test
AGENTS.md                rules for Claude sessions (read this)
```

## Setup with clasp

Prerequisites: a Google account, Node.js 18 or newer, and this repo cloned locally. From the repo root:

```sh
npm install -g @google/clasp
clasp login
clasp create --type sheets --title "Focus Tracker" --rootDir src
clasp push
clasp open
```

Turn on the Apps Script API once at https://script.google.com/home/usersettings if `clasp login` or `create` complains.

In the Apps Script editor that opens:

1. Pick `setup` in the function dropdown and Run it. Approve the permissions (Google may say the app is unverified, which is expected for your own script: Advanced, then continue). It remembers the spreadsheet, creates every tab and finds or creates a Drive folder called "Focus Tracker".
2. Optional: run `seedStarterData` to fill an empty tracker with the example projects from the design preview.
3. Deploy, New deployment, type Web app, Execute as: Me, Who has access: Only myself. Open the URL and bookmark it or add it to your home screen. Or from the terminal: `clasp deploy --description "v1"`.

To publish later changes: `clasp push`, then `clasp deploy --deploymentId <id>` to keep the same URL.

If you already created a Drive folder for the tracker, set a Script Property called `FOLDER_ID` to its id before running `setup` (Project Settings, Script Properties).

The Drive scope is the broad one because the app writes notes into a folder you may have created yourself. Nothing reads or copies the files your Resources links point to.

## Updating and testing

- After pulling changes: `clasp push`, then `clasp deploy --deploymentId <id>` so your bookmarked URL serves the new version. While developing, `clasp push --watch` pushes on every save and the editor's "Test deployment" URL always serves the latest code.
- `npm install` once, then `npm test` runs the server tests and a simulated-browser test. They use fakes for Google services, so they check the logic and the UI wiring but not Google's runtime.

## Troubleshooting

- `clasp create` fails or says the API is off: enable the Apps Script API at https://script.google.com/home/usersettings.
- "No spreadsheet linked yet": run `setup` once from the Apps Script editor.
- Blank page or "Could not load": open the editor, Executions, and read the error. A file-not-found error on `include` points at a file name, see Known limits below.
- Changes not showing: the web app URL serves a deployed version. Run `clasp deploy --deploymentId <id>` or use the Test deployment URL.

## Adding or removing a feature

Add: create `src/modules/<id>/server.js` with a function `<id>Module()` and `view.html` calling `FT.module({ id: '<id>', ... })`, then add `'<id>'` to `MODULES` in `src/core/config.js`. Remove: delete the folder and that line. The module contract is documented at the top of `src/core/registry.js` (server) and `src/ui/shell.html` (client). Slots let a module add panels to other pages (`project.page`, `projects.tab`) without editing them.

## Known limits

- Every action is a round trip to Apps Script, usually under a second. Kanban moves update the screen first and save in the background; everything else waits for the server.
- No whiteboard yet. The plan is an Excalidraw page per project saving `.excalidraw` files into the Drive folder, as its own module.
- Tests use fakes for Google services. File names with folders (`core/sheetdb`, `modules/kanban/view`) rely on clasp keeping the folder prefix in Apps Script file names, which it does, and on `HtmlService` accepting those names in `include()`. If the first load fails with a "file not found" error, that is the first place to look.
