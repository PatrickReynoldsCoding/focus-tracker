# Project notes as Google Docs

Each project's notes ARE its Google Doc, `<project name> notes`, in the mode's Notes folder (`<mode folder>/Notes/`). Notes that belong to no project (the Notes tab, below) are Docs named after the note in the same folder. There is no markdown file and no formatted HTML copy any more: Paddy decided on 2026-11-14 that the Doc is the only store. Code: `src/modules/notes/server.js` and `src/modules/notes/view.html`. History: notes were first markdown files (2026-10-28), then markdown plus a formatted copy plus a Doc mirror (2026-10-30); schema step v5 moved them into the Docs (below).

## How it works

- **The editor loads the Doc and saves straight to it.** Opening a project (or a note) asks `notes.get`. The server exports the Doc as HTML through the Drive advanced service and turns it into the editor's tags (`fromDocHtml_`). A save (`notes.save`, same 1.2 s delay as before, drafts on the device, retries, conflict handling) sends the editor's HTML; the server cleans it with `sanitizeRichText_` and imports it over the Doc's content (`Drive.Files.update` with `text/html`, `docHtmlFor_`). The first save makes the Doc and puts its link in the project's notes cell.
- **No separate mirror step.** There is no "write the Doc on Done / leaving / hiding" and no "bring Doc edits back on open" any more (`syncDoc` and `checkDoc` are gone): every save is a Doc write, and every open is a Doc read.
- **Opening is cheap when nothing changed.** The page sends the version it holds (`known`); if the Doc's `modifiedTime` is still that version, the server answers `{ same: true }` after one small `Files.get`, without exporting the Doc. Otherwise it exports it, and an edit made in Google Docs shows in the editor ("Updated from the Google Doc"), unless something is being typed.
- **Formatting round-trips.** Headings H1 to H3, bold, italic, underline, strikethrough, text colours, highlights, bullet and numbered lists, links and quotes. Going to the Doc, `<font color>` becomes a `color` style (Docs reads styles). Coming back, Google's export puts styles in classes (`.c3{font-weight:700}`); `fromDocHtml_` reads the style block and turns each span's classes back into `b`, `i`, `u`, `s`, a colour or a highlight, drops Docs' default black text and white background, unwraps Google's link redirect (`https://www.google.com/url?q=...`), drops the link styling Docs adds around links, and reads an indented paragraph as a quote. Docs' heading styles are not turned into bold. Nested lists come back flat; images, tables and comments made in Docs are not shown in the app (their text is).
- **Versions are the Doc's `modifiedTime`.** `Notes.updated` is the version the app last wrote or read; `Notes.written` a fingerprint of the text then (`notesFingerprint_`: the plain text, formatting and blank lines left out). A save carries the version its text builds on (`_base`) and when it was edited (`_editedAt`):
  - same version, Doc not touched since: written;
  - the Doc's `modifiedTime` moved but its text is the one the app wrote (Google can touch the time after a write): no change, written;
  - the Doc changed (another device, or an edit in Google Docs) and has the same text: no conflict;
  - otherwise the newest edit wins (the Doc's `modifiedTime` against `_editedAt`), and the other text is kept as a conflict copy: a new Doc `<project name> notes - conflict <yyyymmddhhmm>` in the Notes folder, with a message and a Log line.
- **Drafts stay on the device** until the server has the text, one per browser window (`ft.draft.notes.<mode>.<project>` holds `{ tabs: { <window id>: draft } }`), so two windows with the same notes open (the Notes tab and a pop-out, say) never overwrite each other's unsaved text. A window that is not typing loads the notes again when another window of the same browser saves them (a `storage` event on `ft.notes.saved.<mode>.<project>`).
- **Notes typed into the sheet's notes cell** (an assistant, or Paddy) are added to the end of the Doc on the next load (headings, lists, bold, italic and links from simple markdown, `notesMarkdownToHtml_`), the Doc is made if there is none, and the cell gets the Doc's link back.
- **Copy as markdown** converts the editor's content in the browser (`FT.htmlToMd`). `notes.get` also gives `text`, markdown made on the server (`notesHtmlToMarkdown_`), for assistants and tests.
- **A Doc deleted in Drive**: the notes read as empty and the next save makes a new Doc and links it.

## Notes of the Notes tab (since 2026-11-14)

Besides each project's notes, any number of notes that belong to no project live on the Notes tab (the tab that was called Lists), together with lists and to-do lists. Today's own note ("Today notes", 2026-11-14 morning) became one of them.

- **A note is a row of the Lists tab with `kind` `note`**, so its name, colour, place in the order, "Show on Today" and linked project work like a list's (lists module). Its text is its own Doc, named after the note (`Ideas`), in the mode's Notes folder, with a Notes row that has `list_id` where a project's has `project_id`. No other copy.
- **The api takes `listId`** for a note instead of `projectId` (`notes.get`, `notes.save`); the editor's `data-project`, the drafts (`ft.draft.notes.<mode>.<list id>`) and the saved signal between windows use the list id as the key. Ids are 8 hex characters, unique per tab; the Notes row says which kind of key it is.
- **The same code as a project's notes:** the editor and toolbar, the 1.2 s save, drafts per window, versions from the Doc's `modifiedTime`, conflict copies (`<note name> - conflict <yyyymmddhhmm>`), paper themes, Copy as markdown and Open in Docs.
- **Never a project:** no Projects notes cell, a conflict Log line with no project, nothing in Insights; the typed-notes import only looks at projects.
- **Renaming** the note renames its Doc (`notes.renameList`, one Drive call). **Deleting** it (with a confirm) puts the Doc in Drive's bin and removes its rows; Undo brings the rows back, and the Doc comes out of the bin the next time the note is read or saved (`untrashNotesDoc_`).
- **On Today and in pills:** a note is a panel `list-<id>` like a list (on Today when `show_today` is yes, in any pill, offered by Add feature). A project's notes can be a Today panel too (`pnote-<project id>`, `show_today` on its Notes row, `notes.setShowToday`) and are cards on the Notes tab unless "Project notes" is off.
- **On the Notes tab a note is a small card** showing its first lines; its editor is only on screen once the card is opened (the pop-up). **The first lines are kept on the Notes row** (`preview`, plain text, at most 300 characters, `notesPreviewOf_`), written whenever the app writes or reads the Doc (save, the typed-notes import, `notes.get`), so opening the tab reads no Doc at all: the previews come with the first load. A row saved before previews were kept has an empty `preview` and a non-empty `written`: the snapshot sends `preview: null`, and the page reads that note once (`notes.get`, a Drive metadata call and one UrlFetch export) when its card comes on screen, at most two at a time, showing quiet grey lines meanwhile; the server keeps the preview from then on. A note edited straight in Google Docs keeps its old preview until the app next reads it (when its card is opened). `notes.get` is bookkeeping, not an undo step (`NOT_UNDOABLE_`). The card shows the text this page holds when it has it (just typed, or loaded), so it is up to date the moment the pop-up closes.
- **Several notes on screen at once** (Today, a project page, the Notes tab's pop-up): each editor's element ids carry its key (`nt-text-<key>`, `nt-bar-<key>`...), and every handler finds the editor from the element used. The same notes must not be on screen twice (the second copy would write over the first), so a notes panel says `data-one-copy="note:<key>"` and the pop-out code (`src/ui/popout.html`) shows a placeholder for any other panel with that key while a window shows it; the Notes tab's pop-up asks the same through `FT.popout.otherCopyHtml`. A phone has no windows, so every notes panel draws in place there.
- **Migration (schema v6):** each mode's Notes row keyed `today` became the note "Today notes" (a new Lists row, `show_today` yes; the Doc and its text unchanged), and Today's saved layout, phone order and pills name its panel `list-<id>` where they said `notes`. Its id is kept in the script property `TODAY_NOTE_LIST.<mode>`, so a save from a page loaded before the update (or one that waited offline) that still says `projectId: 'today'` reaches it (`legacyTodayNoteId_`).
- A note and a project can share a name in Drive ("Today notes" and a project called "Today" whose Doc is "Today notes"); the app keeps them apart by Doc id.

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
