# Future spike: a GitHub-native Focus Tracker with git-file data

Status: an idea for later, not started. Written 2026-10-28 after the wrapper site went live. Nothing here has been tried. All effort numbers are guesses.

## Why consider it

The app runs on Apps Script with data in a Google Sheet. That works, and the wrapper page (`site/`) hides the Google banner and gives a proper install icon. Moving the whole app off Apps Script would give:

- True offline: the app itself loads with no signal (a service worker), with a local copy of the data.
- No Google banner, no iframe cookie risk, and it works in Safari, where the wrapper probably does not.
- Faster use: edits apply on screen at once and sync in the background. Today every action is about a 1.5 s Apps Script round trip.
- Claude can edit the data as plain files, on the laptop and from a phone (see "How Claude reaches the data").
- Deploying is a `git push`. No clasp, no deployment ids.

Paddy's requirements, in his words: data that is easy for a human to read, not necessarily Google Drive; Claude can change the app; Claude can change the data in the running app, for example set up a project with notes and todos while ideas are being discussed; free to run.

## Proposed design

- **App:** the existing front end (`src/ui`, `src/modules/*/view.html`) served as a static site from GitHub Pages (free, public repo, no secrets or ids in it).
- **Data:** a separate **private** GitHub repo of readable files, for example:
  - `projects/<slug>.md`: a small header (category, status, next action, locked_until, last_touched) and the notes as markdown. The Kanban cards and acceptance criteria as sections or a sibling file.
  - `lists/<slug>.md`, `log/<year>.md`, `settings.json` (modes, categories, rotation, layouts, session and pomodoro state, which today live in Apps Script user properties), `whiteboards/<id>.excalidraw`.
  - One folder per mode (Personal, Work).
- **Access:** a fine-grained personal access token limited to the data repo (Contents: read and write), pasted once per device and kept in that browser. It lasts up to a year, so there are no hourly sign-in prompts.
- **Local first:** the page keeps a copy in IndexedDB, shows changes at once, and writes batches back as commits after a short delay. A write is rejected if the file changed on the server since it was read; the newest edit wins and the losing version is kept (a "conflict copy" for notes, a line in the Log for other rows), as agreed in `docs/offline-design.md`.
- **Reuse:** the server code is plain JavaScript over a small `Table` layer, and the tests already run it against in-memory fakes of Sheets, Drive and Properties. The idea is to run that same code in the browser against an in-memory store, with a background writer to git, instead of rewriting every module. This is the biggest unknown.
- **No Google needed:** no Drive folders, no Todoist import (already imported into Work), no Google sign-in or OAuth client.

## Alternatives considered

| Option | For | Against |
|---|---|---|
| Google sign-in plus Sheets and Drive REST from the browser | Keeps the Sheet and Drive | Google Cloud project and OAuth client, "unverified app" warning, 1-hour tokens with sign-in prompts, `drive.file` scope only reaches files the app created or picked |
| Supabase or Firebase | Real database, fast | Data is rows, not files you read; Claude needs extra setup to reach it; Supabase free projects pause when idle |
| Stay on Apps Script with the wrapper | Works today | No offline start-up; Safari problems with the wrapper; banner and cookie risks |

## How Claude reaches the data

- **Laptop, Claude Code:** edits the files with `git` and `gh`, commits and pushes. The app picks the change up on its next sync. The app does not need to be open.
- **Phone:** Claude Code on the web (claude.ai/code) can clone the data repo, edit, commit and push. Not confirmed from the phone app. The Claude mobile app itself cannot run `git`, and its GitHub connector may not write files.
- **Most reliable for a phone chat, later:** a small free service (for example a Cloudflare Worker) in front of the data, registered as a connector, with calls such as "create project", "add note", "add todo". It is a few more days and one more thing to maintain, so only build it if chatting on the phone matters.
- **Today's Sheet:** this account has a Google Sheets connector, so Claude could add rows now. A project spans several tabs with matching ids, so it is clumsy. The connector may also be signed in to a different Google account from the one that owns the Sheet. Not checked.

## The spike (about one day)

Goal: decide yes or no with evidence.

1. Make a private data repo with three sample projects in the file layout above, and a token limited to it.
2. Make a test page (not the real app) that, with the token: reads all files, shows them, edits a note, and writes it back as a commit. Measure the time for a read and a write on the laptop and on the phone.
3. Run a slice of the existing server code (projects, kanban, today) in the browser against an in-memory store loaded from those files. See how much needs to change (the code is synchronous; the browser's calls are not, so the store must be preloaded and written behind).
4. Edit a file from outside with `git` while the page is open, and check the page picks it up and handles a conflict as designed.
5. Add the service worker and IndexedDB copy; check it opens and edits with no signal, then syncs.
6. Try Claude Code on the web from the phone: add a project to the data repo and see it appear in the page.

Pass if: a write round trip feels fine (a second or less to confirm, instant on screen), the existing logic runs with modest changes, conflicts are handled without data loss, and the phone route (step 6) works.

Fail or pause if: the server code needs a near-total rewrite, the GitHub API limits or latency get in the way, or the phone route does not work and the callable-tool route is not wanted.

## If it passes

Rough guess: 3 to 5 working days to move every module, plus one script to move existing data out of the Sheet into files (including the Work mode data that came from Todoist). Then keep the Apps Script app running until the new one has been used for a while. Remember to move session, pomodoro and layout state, which are not in the Sheet.

## Risks and open questions

- GitHub API limits: authenticated requests are rate limited (thousands an hour), fine for one user if writes are batched. Files over about 1 MB (large whiteboards) need the blobs API.
- A token on each device can read and write the data repo. Limit it to that one repo, set an expiry, and revoke it if a device is lost.
- Safari or iOS can clear unused site data after about a week unless the app is installed to the home screen. The local copy is a cache, so this only matters for edits not yet synced. Sync promptly.
- Project locks would only be enforced in the page. Anyone with the data can edit the files, as they can the Sheet today, so this is not a real change.
- No locking between two devices writing at once. The version check and conflict rules replace it.
- There are no scheduled jobs in the app today (checked 2026-10-28), so nothing is lost there.
- Which devices will use it? Android and the e-ink Hisense are known. iPhone is not confirmed.
