# Instructions for Claude (and any other agent) working on Focus Tracker

Read this file at the start of every session that touches this project or the tracker's Drive folder. Then read `docs/ROADMAP.md` for the requirements, decisions and planned work before you plan anything.

## Never link or copy sensitive material

The Resources feature stores links to Google Drive files. Before adding, suggesting or editing any link:

1. Only link a file the owner has named or clearly pointed at. Never browse Drive and add links on your own initiative.
2. Check the file first. If it contains bank or card details, passwords, ID or passport numbers, tax references, health records or similar, stop and ask the owner to confirm before linking. A link is one click away from the contents.
3. Never copy the contents of a linked file into the sheet, the notes files or this repository. Store the link, a title and a short note only.
4. Never put the owner's real links, file IDs, spreadsheet IDs or folder IDs in the repository. They belong in the sheet and in Script Properties.
5. If in doubt, ask.

## How the code is organised

- `src/core/` is the small shared core: config, sheet access (`sheetdb.js`), module registry, `rpc`, setup. Avoid putting feature logic here.
- `src/modules/<id>/` is one feature. Each has `server.js` (defines `<id>Module()`) and `view.html` (calls `FT.module({...})`).
- `src/ui/` is the page shell, shared styles and the client core (`FT`).
- Modules talk to each other only through `ctx.call` / `ctx.optional` on the server and through `FT.store` slices on the client. A module may read another module's slice but only changes its own data through its own api.
- Adding a feature: create `src/modules/<id>/`, add the id to `MODULES` in `src/core/config.js`. Removing it: delete the folder and that one line.
- Modes (`MODES` in `src/core/config.js`, helpers in `src/core/mode.js`): each mode has its own spreadsheet and its own subfolder of the "Focus Tracker" Drive folder. `bootstrap(mode)` and `rpc(module, fn, args, mode)` set the mode first, so `Table`, `getSpreadsheet_()` and `getSubfolder_()` always work on the active mode. Per-user state that belongs to a mode uses `modeKey_('name')`. A mode-only feature is a module listed in that mode's `modules`.
- Categories are data, not config: each mode's Categories tab, edited in the app. Check them through `ctx.call('categories', 'ids')`.
- Pages lay out their panels with `FT.layout(page, [{ id, html, w }])` (shell.html), so they can be moved in "Edit layout" mode. Slots that add panels give each one a stable `id`.
- Rich text from the browser is cleaned on the server with `sanitizeRichText_` before it is stored. Never store or render browser HTML without it.
- Cells are plain text. Dates are ISO strings. Numbers are listed in a table's `numeric` argument.

## Checks

Run `npm install` once, then `npm test`. The server tests run the real server code against in-memory fakes of Sheets, Drive and Properties. The browser test loads the real page in jsdom and clicks through it. Neither runs on Google's servers, so anything that depends on Apps Script itself still needs trying after `clasp push`.
