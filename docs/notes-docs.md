# Project notes as Google Docs

SPEC-2026-11 "Google integration": each project's notes are also a Google Doc called `<project name> notes`, opened with "Open in Docs", only if it does not slow the app down. Built 2026-10-30. Code: `src/modules/notes/server.js` (`syncDoc`, `checkDoc`, `toDocMarkdown_`, `fromDocMarkdown_`) and `src/modules/notes/view.html`.

## How it works

- **The markdown file stays the source.** The editor saves to `<mode folder>/Notes/<project>-<id>.md` exactly as before: same 1.2 s delay, drafts on the device, versioned saves, conflict copies, retries. Nothing in that path waits for the Doc or calls Google Docs.
- **The Doc is a mirror, written when editing is finished.** That means Done (phone), leaving the project page, or hiding/closing the page. The browser then sends `notes.syncDoc({ projectId })`:
  - after the save still to go (so the Doc gets the saved text), never while typing;
  - in parallel (`parallel: true`), so it is not in the save queue and no later save waits for it (tested with a held `syncDoc`);
  - `render: false, quiet: true, noMerge: true`: it does not redraw the page or show errors, and a reply cannot overwrite newer data on screen;
  - at most once per 30 s per project from one page (a later request waits for the 30 s and then runs);
  - one at a time per project, so two quick requests cannot make two Docs.
  On the server it does nothing (no Drive call) if the Doc already holds this markdown version (`Notes.doc_synced === Notes.updated`).
- **The Doc is made lazily**, on the first sync. Opening a project that has notes but no Doc yet also asks for that first sync, in the background, so older notes get their Doc and "Open in Docs" without having to be edited first. The Doc's id is kept in `Notes.doc_id`, and `Projects.notes` (the link in the sheet) changes to the Doc's address. The markdown file stays in Drive. A Doc deleted in Drive is made again on the next sync.
- **"Open in Docs"** replaces "Open file in Drive". It shows once the Doc exists.
- **Edits made in the Doc come back.** On opening a project (at most once per 30 s), the browser sends `notes.checkDoc` in parallel. The server compares the Doc's Drive `modifiedTime` with `Notes.doc_seen` (the `modifiedTime` the app saw when it last wrote or read the Doc), which costs one small Drive call. If the Doc changed since:
  - the export is turned back into the app's markdown. If it is the same notes (only blank lines, `*` bullets or trailing spaces differ) nothing happens;
  - if the markdown did not change since the last mirror, the Doc's text is saved into the markdown through the same versioned save the editor uses. The editor shows it ("Updated from the Google Doc") if nothing is being typed. If something is being typed, the typed text's next save meets the usual version conflict, and both texts are kept;
  - if the markdown changed too, the markdown stays, the Doc's text is saved as `<project>-<id>-conflict-<time>-doc.md` in the Notes folder, a Log line and a message say so, and the next sync writes the kept notes into the Doc.
  - `syncDoc` makes the same check before it writes, so a Doc edit that was never brought in is kept as a conflict copy, not overwritten.
  - An empty export is never taken as "the Doc was cleared", because it could be Drive answering with nothing.

## Conversion, and why no new permission

Google converts both ways: Drive's markdown import (upload `text/markdown` as a Google Doc) and Drive's markdown export (`files.export` as `text/markdown`), through the **Drive advanced service (v3)**, which is enabled in `src/appsscript.json`. It uses the `drive` scope the app already has, so **no new OAuth scope and no new consent prompt**. The alternative, `DocumentApp`, needs the extra `https://www.googleapis.com/auth/documents` scope and a hand-written converter both ways (headings, bold, italic, lists, quotes, links), so it was not used.

The app keeps one line per paragraph; standard markdown joins lines that are not separated by a blank line. So `toDocMarkdown_` puts a blank line between blocks (list items and quote lines that follow one another stay together), and `fromDocMarkdown_` reverses that, drops the empty `>` lines between quote paragraphs and removes escapes the app's editor does not use (`\.`, `\-`, `\#` and so on). Empty paragraphs in the app's notes do not survive a trip through the Doc (Docs merges them).

## Deviation from the spec: where the Doc goes

The spec says "in the root of the project's folder". There is no per-project folder today: notes live in `<mode folder>/Notes/`, whiteboards in `<mode folder>/Whiteboards/`. So the Doc goes in the same **Notes** folder as the markdown file, next to it. If project folders are added later, `syncDoc` is the one place to change (the `parents` of `Drive.Files.create`); existing Docs could be moved with `DriveApp.getFileById(id).moveTo(folder)`.

## Speed: measure on Google

The editor's save is untouched, so typing and saving cannot be slower. The Doc work happens in background calls that the page does not wait for. What is not known yet is how long those calls take on Google, and whether they slow other calls by using Apps Script's concurrent-execution allowance. Both calls return `ms`, and `syncDoc` also returns `timings` (`read`: the markdown file, `check`: looking for Doc edits, `write`: Drive import, `sheet`: the Notes row). Both write a line to the execution log (`notes.syncDoc 1234 ms {...}`), visible in the Apps Script editor under Executions. If `syncDoc` is slow enough to matter, raise the 30 s gap (`DOC_GAP_MS` in view.html); if even that hurts, remove the triggers in view.html and say so.

## Not verified (needs trying after `clasp push`)

- Everything here runs against in-memory fakes of the Drive advanced service. Not checked on Google: that `Drive.Files.update` with `text/markdown` media replaces the Doc's content (conversion on update), what `Drive.Files.export(id, 'text/markdown', { alt: 'media' })` returns from Apps Script (the code accepts a Blob, a string or bytes), the exact markdown Google exports, and that `modifiedTime` from the update reply is the one `Files.get` reports later (if Google bumps it a little later, the next open finds "the same notes" and only updates `doc_seen`).
- Two devices opening the same older project at the same moment could each make a Doc (no lock, so saves are never held up by a Doc write). The second one wins `doc_id`; the other Doc stays in the Notes folder.
- Renaming a project renames its Doc only when its notes are next changed and written to the Doc.
