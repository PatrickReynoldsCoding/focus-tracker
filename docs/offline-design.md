# Offline use: design and options

Status: design only (2026-10-28). Nothing here is built. Written for the "Local cache" item in the mobile spec.

## The problem in one paragraph

Paddy wants the app usable with no signal, mostly on the phone. Two separate things have to work offline: **the page itself loading**, and **the data**. The data part is easy to design. The page-loading part is where Apps Script gets in the way.

## Why the current setup cannot load offline

- A web app opens at `script.google.com/macros/s/<id>/exec`. Google serves a wrapper page there, and our HTML runs inside a sandboxed iframe on a `*.googleusercontent.com` origin.
- A service worker has to be registered from a JavaScript file on the same origin as the page, served at a path we control. We control neither the outer origin nor any file paths. So: no service worker, no offline page load.
- For the same reason we cannot serve a web app manifest. "Add to home screen" makes a plain shortcut that opens the URL and needs a connection. This is also why the shortcut icon is a grey letter (see the icon item).
- Consequence: with no signal the bookmark shows Chrome's offline error, whatever we cache in the page.

## Options

### A. Cache data inside the current page (IndexedDB)

What it does: while the page is open, keep a copy of the data in IndexedDB, queue edits when a call fails, replay them when the connection returns.

- Works only if the page was already loaded when the signal dropped (a train tunnel, a lift, a dead spot). It does not help when you open the app with no signal.
- Needs no new hosting, no new auth, no rewrite. About 2 to 3 days.
- `localStorage` already works in the iframe (`ft.theme`), so IndexedDB should too. Storage is per browser and per iframe origin. It can be cleared by Chrome, so it is a cache, never the only copy.
- Worth building even if B happens, because the queue and conflict logic are the same.

### B. Host the front end on GitHub Pages as a PWA

What it does: the HTML, CSS and JS (`src/ui` and the module views) are served as static files from our own origin. That allows a service worker, a manifest and proper icons, so the app installs from Chrome as a real app, loads offline, and shows no Apps Script banner.

- **Cost:** free. GitHub Pages is free for public repositories (this repo is public). It is not free for private repos on a free account.
- **Data stays in Google Drive and Sheets.** Pages only holds code. It must not hold real IDs (AGENTS.md rule), so the spreadsheet and folder are found after sign-in and kept in the browser.
- The open question is how the page talks to Google data. Two ways:

**B1. Apps Script as the API (keep `server.js` as is).**
- The page calls the web app with `fetch`. This is where it gets awkward. A web app set to "Only myself" needs the Google login cookie. A page on `github.io` is cross-site, so Chrome blocks that cookie (third-party cookies), and the redirect to `googleusercontent.com` does not allow credentialed CORS.
- Making the web app "Anyone" and protecting it with a secret token in the request works technically, but it means anyone holding the token can read and write all the data, and the secret sits in the browser. I would not do this for a personal account holding work data.
- Passing a Google OAuth token to an "Anyone with a Google account" deployment is possible, but I have not verified it end to end.
- Verdict: possible, but fragile and the security story is weak.

**B2. Browser talks to Google directly (Sheets and Drive REST), no Apps Script.**
- Sign in with Google Identity Services in the page, then call the Sheets and Drive REST APIs from the browser. Free quota is generous for one user.
- The server code (`src/core`, `src/modules/*/server.js`) only uses `SpreadsheetApp`, `DriveApp`, `PropertiesService` and a few helpers, and the tests already run it against in-memory fakes of exactly those. A REST-backed version of the same three interfaces could let the same server code run in the browser unchanged. This keeps one code base for logic, and should be faster than an Apps Script round trip (about 1 s today).
- Risks:
  - **Scope.** `drive.file` only covers files the app itself created or opened, so it would not see the spreadsheets and folders Apps Script already made. We would need the full `drive` scope. That is a restricted scope: Google shows an "unverified app" warning, which is acceptable for a personal OAuth client in testing mode with Paddy as the only user. He needs to create a free Google Cloud project and OAuth client ID (a one-off manual step).
  - **Token lifetime.** The browser flow gives one-hour tokens and no refresh token. Silent renewal works while signed in to Google, but when offline we cannot renew. That is fine for editing (edits queue), but sync waits until we are online and signed in again. A popup may be needed on first use each day.
  - **Not tested.** Whether Apps Script-owned files behave normally through REST (formatting, tab names, the Undo tab, date cells) is unknown until tried.
  - **Apps Script triggers are lost** (none are used today: no morning email).
- Effort: about 1 to 2 weeks, mostly the REST adapters, sign-in, service worker and moving the build/deploy step to GitHub Pages.

### C. Do nothing offline-specific

Pomodoro, sessions and everything else keep needing a connection. Listed for completeness.

## Conflict design (agreed with Paddy)

Applies to both A and B.

- Every table gets an `updated_at` column (ISO time, set by whoever writes the row). Tables are read by header name and already tolerate extra columns, so the column can be added lazily on first write.
- The client remembers, for each row it has read, the `updated_at` it saw (the *base*).
- Offline edits go into a queue in IndexedDB: `{ op, table, id, fields, base, editedAt }`, in order. Cards and list items already update the screen first and save in the background, so the queue fits the existing "optimistic" path (`FT.store`, `FT.rpc(... render:false)`, `FT.newId()` for new rows).
- On reconnect the queue replays in order. For each op:
  1. Server row unchanged since `base`: apply it.
  2. Server row changed since `base`: **the newest edit wins** (compare `editedAt` with the server row's `updated_at`). The losing version is kept:
     - **Notes (markdown files):** the loser is saved as a new file `<name> (conflict <date time>).md` beside it, and the user is told.
     - **Other rows:** the loser's fields are written to the **Log tab** as a conflict entry (table, id, the losing values), so nothing is lost silently.
  3. Row deleted on the server while edited offline: the delete stands and the edit is logged the same way. Row deleted offline while edited on the server: the server edit wins and the row stays.
- Whiteboards are one JSON file per board, so they follow the notes rule (conflict copy file).
- Clock skew matters because `editedAt` comes from the phone. Record the difference between the phone's clock and the server's on each successful call and correct `editedAt` by it.
- Undo works on sheet rows only and stays online-only. Offline edits are not undoable until they have synced.
- Session and pomodoro state live on the server so devices share it. Offline, the client keeps its own timeline (start, pauses, finish) and sends it on reconnect, as timestamps, so minutes worked come out right.
- The header shows a small "Offline, N changes waiting" status and the Log shows any conflicts.

## Recommendation

1. **Spike first (about 1 day), because three things are unknown and decide everything:**
   - (a) A GitHub Pages page that signs in with Google Identity Services and reads and writes the existing Focus Tracker spreadsheet and a Drive note with the `drive` scope.
   - (b) What an Apps Script `/exec` URL does when embedded in a page on `github.io` (cookies, sign-in, banner).
   - (c) That a service worker and manifest give a proper Android install icon.
2. **Build A next (2 to 3 days)** with a storage and queue layer that does not care where data comes from. It improves the live app straight away, and the conflict code is reused.
3. **Move to B2 only if the spike passes (1 to 2 weeks).** Skip B1. B2 is the only path that is free, keeps data in Drive, fixes the banner and icon, and gives real offline start-up. If the spike fails, stay with A and say plainly that opening the app with no signal is not possible on Apps Script.

## What I could not check

I have not run any of the B options against Google. All numbers are estimates. The three unknowns above need a real Google sign-in, so they need Paddy to run the spike's sign-in once.
