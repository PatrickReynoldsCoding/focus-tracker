# Project notes as Google Docs

Each project's notes ARE its Google Doc, `<project name> notes`, in the mode's Notes folder (`<mode folder>/Notes/`). Today's own note is the Doc `Today notes` in the same folder (see "Today's note" below). There is no markdown file and no formatted HTML copy any more: Paddy decided on 2026-11-14 that the Doc is the only store. Code: `src/modules/notes/server.js` and `src/modules/notes/view.html`. History: notes were first markdown files (2026-10-28), then markdown plus a formatted copy plus a Doc mirror (2026-10-30); schema step v5 moved them into the Docs (below).

## How it works

- **The editor loads the Doc and saves straight to it.** Opening a project (or Today's note) asks `notes.get`. The server exports the Doc as HTML through the Drive advanced service and turns it into the editor's tags (`fromDocHtml_`). A save (`notes.save`, same 1.2 s delay as before, drafts on the device, retries, conflict handling) sends the editor's HTML; the server cleans it with `sanitizeRichText_` and imports it over the Doc's content (`Drive.Files.update` with `text/html`, `docHtmlFor_`). The first save makes the Doc and puts its link in the project's notes cell.
- **No separate mirror step.** There is no "write the Doc on Done / leaving / hiding" and no "bring Doc edits back on open" any more (`syncDoc` and `checkDoc` are gone): every save is a Doc write, and every open is a Doc read.
- **Opening is cheap when nothing changed.** The page sends the version it holds (`known`); if the Doc's `modifiedTime` is still that version, the server answers `{ same: true }` after one small `Files.get`, without exporting the Doc. Otherwise it exports it, and an edit made in Google Docs shows in the editor ("Updated from the Google Doc"), unless something is being typed.
- **Formatting round-trips.** Headings H1 to H3, bold, italic, underline, strikethrough, text colours, highlights, bullet and numbered lists, links and quotes. Going to the Doc, `<font color>` becomes a `color` style (Docs reads styles). Coming back, Google's export puts styles in classes (`.c3{font-weight:700}`); `fromDocHtml_` reads the style block and turns each span's classes back into `b`, `i`, `u`, `s`, a colour or a highlight, drops Docs' default black text and white background, unwraps Google's link redirect (`https://www.google.com/url?q=...`), drops the link styling Docs adds around links, and reads an indented paragraph as a quote. Docs' heading styles are not turned into bold. Nested lists come back flat; images, tables and comments made in Docs are not shown in the app (their text is).
- **Versions are the Doc's `modifiedTime`.** `Notes.updated` is the version the app last wrote or read; `Notes.written` a fingerprint of the text then (`notesFingerprint_`: the plain text, formatting and blank lines left out). A save carries the version its text builds on (`_base`) and when it was edited (`_editedAt`):
  - same version, Doc not touched since: written;
  - the Doc's `modifiedTime` moved but its text is the one the app wrote (Google can touch the time after a write): no change, written;
  - the Doc changed (another device, or an edit in Google Docs) and has the same text: no conflict;
  - otherwise the newest edit wins (the Doc's `modifiedTime` against `_editedAt`), and the other text is kept as a conflict copy: a new Doc `<project name> notes - conflict <yyyymmddhhmm>` in the Notes folder, with a message and a Log line.
- **Drafts stay on the device** until the server has the text, one per browser window (`ft.draft.notes.<mode>.<project>` holds `{ tabs: { <window id>: draft } }`), so two windows with the same notes open (Today's panel and a pop-out, say) never overwrite each other's unsaved text. A window that is not typing loads the notes again when another window of the same browser saves them (a `storage` event on `ft.notes.saved.<mode>.<project>`).
- **Notes typed into the sheet's notes cell** (an assistant, or Paddy) are added to the end of the Doc on the next load (headings, lists, bold, italic and links from simple markdown, `notesMarkdownToHtml_`), the Doc is made if there is none, and the cell gets the Doc's link back.
- **Copy as markdown** converts the editor's content in the browser (`FT.htmlToMd`). `notes.get` also gives `text`, markdown made on the server (`notesHtmlToMarkdown_`), for assistants and tests.
- **A Doc deleted in Drive**: the notes read as empty and the next save makes a new Doc and links it.

## Today's note

Today's notes panel is one running note per mode, not a project's notes (since 2026-11-14; before that it showed the focus project's notes). Paddy keeps writing in it and clears it himself.

- **Stored like a project's notes:** its own Doc, `Today notes`, in the mode's Notes folder, and a row in the Notes tab. No other copy. Each mode has its own (its own spreadsheet and Notes folder).
- **Keyed by the reserved notes key `today`** in place of a project id: the row's `project_id`, the api's `projectId` (`notes.get`, `notes.save`), the editor's `data-project`, the drafts (`ft.draft.notes.<mode>.today`) and the saved signal between windows. Project ids are 8 hex characters, so they never clash. On the server `TODAY_NOTES_KEY_`, `isTodayNotes_` and `notesDocName_` in `src/modules/notes/server.js`; in the page `TODAY_NOTES_KEY` in `src/modules/notes/view.html`.
- **Everything else is the same code:** the editor and toolbar, the 1.2 s save, drafts per window, versions from the Doc's `modifiedTime`, conflict copies (`Today notes - conflict <yyyymmddhhmm>`), paper themes, Copy as markdown and Open in Docs.
- **Never a project:** the server makes no project lookup for it, sets no Projects notes cell, writes its conflict Log line with no project (so Insights and the project's log never show it), and the typed-notes import and migration v5 only look at projects. The guide for assistants says the Doc `Today notes` is not a project's notes.
- **One editor on screen:** Today's note and a project's notes are both the panel `notes` and share the editor's fixed element ids, so the pop-out rule (`ONE_COPY_ON_SCREEN` in `src/ui/popout.html`) keeps one of them on screen at a time: while either is in a window, the others say so. A phone has no windows, so every notes panel draws in place there.
- **Migration:** none. The old panel stored nothing of its own; the Doc is made on the first save.
- A project named "Today" would also have a Doc called `Today notes`. The app keeps them apart by Doc id; only the names in Drive match.

## Why Drive's HTML conversion, not DocumentApp

Two ways were considered: Drive's HTML export and import (one `Files.export` to read, one `Files.update` to write, through the Drive advanced service already enabled in `src/appsscript.json`), or `DocumentApp`, building the Doc element by element. **Chosen: Drive's conversion.**

- **Permissions:** it works with the `drive` scope the app already has, so no new OAuth scope and no new consent prompt. `DocumentApp` needs `https://www.googleapis.com/auth/documents`.
- **Speed:** a save is two Drive calls (`Files.get` for the version, `Files.update`), whatever the length of the notes; an unchanged open is one `Files.get`. `DocumentApp` needs `openById` plus a call per paragraph and per styled run to write, and the same to read, so it grows with the notes.
- **Fidelity:** Drive's converter handles every format the editor makes (checked against Google's documented export shape in tests; see "Not verified").
- **Not measured on Google yet.** These tests run against fakes; nothing here was timed on Google's servers. `notes.save` writes `notes.save <ms> ms` to the execution log (Apps Script editor, Executions) so the real time can be read after the next deploy. If a save is too slow, the first thing to try is `DocumentApp` for small edits.

## Migration (schema v5, `migrateNotesToDocs_`)

Runs once per mode when the app (or `migrateAllModes()` in the editor) first opens it after the update. For each Notes row that still has a markdown file or formatted copy:

- no Doc, or its Doc was deleted: the Doc is made from the formatted copy if it belonged to the markdown's version, else from the markdown;
- a Doc with the same text: kept, and given the formatted copy's formatting if there was one;
- a Doc with other text (edited in Docs and never brought back): the old notes are added at its end under the heading "Imported from old notes file", so nothing is lost;
- the row forgets the old files and gets `doc_id`, `updated`, `written` before the files go, so a run that stops part way never makes a Doc twice; then the old `.md` and `.html` files go to Drive's bin (`setTrashed(true)`, not deleted; restore from the bin within 30 days);
- the project's notes cell links the Doc (unless it holds typed notes, which are then added as above).

Then the Notes tab is laid out as `id, project_id, doc_id, updated, written` (a person's own columns kept). The spreadsheet is backed up first when there are files to move, unless the same run already made a backup. Running it again changes nothing. With many projects the first load after the update does a few Drive calls per project, so run `migrateAllModes()` from the Apps Script editor right after pushing.

Older conflict copies (`...-conflict-....md`) are left where they are.

## Not verified (needs trying after `clasp push`)

- Everything here runs against in-memory fakes of the Drive advanced service. Not checked on Google: that `Drive.Files.update` with `text/html` media replaces the Doc's content (conversion on update), what `Drive.Files.export(id, 'text/html', { alt: 'media' })` returns from Apps Script (the code accepts a Blob, a string or bytes), that Google's importer reads `<s>`, `<u>`, `color` and `background-color` styles and `<blockquote>` as expected, and the exact class names and indents of Google's export (the test uses its documented shape). Try a note with every toolbar format and open it in Docs and back.
- How long a save and an open take on Google (see above).
- Two devices saving the very first notes of a project at the same moment could each make a Doc; the second wins `doc_id`, the other Doc stays in the Notes folder.
