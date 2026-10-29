# Spike: Focus Tracker as a standalone app

Written 2026-10-29 for the "Standalone app" and "Offline start" items in `docs/SPEC-2026-11.md`. Nothing under `src/` or `tests/` was changed. Facts are marked **tested** (I ran it), **documented** (Google, Apple or vendor docs say so; I did not try it against the real service) or **untested** (my expectation).

## Short answer

- **Yes, it can be done, and the current code mostly comes along.** A static PWA on GitHub Pages runs the real server code (`src/core`, `src/modules/*/server.js`) in the browser over small stand-ins for the Apps Script services. The real page (`src/ui`, `src/modules/*/view.html`) runs unchanged on top. **Tested** in real Chrome with a fake Google (prototype below).
- **Cold offline start works.** With the browser closed and reopened, the server stopped and the network off, the real app opened on Today with its data in about 340 ms, took edits, kept them over a reload, and synced them later without losing another device's edit or delete. **Tested** (fake Google, desktop Chrome, not a phone).
- **Only the `drive.file` scope is needed** if the app makes its own folder and spreadsheet. `drive.file` is non-sensitive, works with the Sheets API, and needs no Google verification. **Documented.** The full `spreadsheets` scope is sensitive and `drive` is restricted, so avoid both.
- **The cost of `drive.file`:** the app sees only files it made or files the user picks in the Google Picker. Paddy's existing sheet, notes and whiteboards need a one-time "pick and import". Files an assistant or Paddy makes by hand in the folder are also invisible to the app (rows in the sheet are fine). **Documented** for the scope; the import is **untested**.
- **Sign-in from a static page gives 1-hour tokens and no refresh token.** The app keeps working on its local copy when the token runs out; only syncing waits. Getting a new token may need one tap ("Sync now") because the token popup can be blocked when it is not started by a tap. **Documented / untested.**
- **Recommendation:** the PWA (section 5). No Electron, Tauri or Play Store needed. About 12 to 15 working days after Paddy says go. Details and phases at the end.

## The prototype (`spike/standalone/`, throwaway)

Run: `node spike/standalone/test.js` (needs Chrome and `playwright-core`; it finds the main checkout's `node_modules`). It builds `spike/standalone/dist/` (git-ignored) and drives it in headless Chrome.

| File | What it is |
|---|---|
| `build.js` | Builds `dist/`: the real `index.html` assembled from `src/ui` and module views (same way as `tests/support/devserver.js`), every `.js` file in `src/` concatenated into one function `makeFTServer(globals)`, a manifest, icons, and a service worker with a version. |
| `gas-shim.js` | Browser stand-ins for `SpreadsheetApp`, `DriveApp`, `PropertiesService`, `LockService`, `Utilities`, `Session`, `ScriptApp`, `Logger`. Same calls as `tests/mocks.js`, over one plain JSON state. While recording, every sheet write is also written down as a Sheets API v4 `batchUpdate` request (`addSheet`, `updateCells`, `deleteDimension`). |
| `runtime.js` | Gives the page a `google.script.run` that calls the server code locally, saves the state to IndexedDB after every call, keeps a journal of calls that wrote, and syncs. Also registers the service worker and the update prompt. |
| `sw.template.js` | Service worker: precaches the app; caches GridStack, Sortable and fonts from jsDelivr and Google Fonts on first use; a new version waits until the page says "update". |
| `fake-google.js` | One local server that plays GitHub Pages (static files) and a small part of the Sheets API v4 (create, tab list, `values:batchGet`, `batchUpdate`). It refuses calls without a Bearer token. Written from the API reference; **not compared with Google's real answers.** |
| `test.js` | The scenario below. |

What `test.js` showed (**tested**, headless Chrome 1200 x 900, all on one machine):

1. First run online: the app made its spreadsheet, ran `setup()` and the starter data, and pushed 14 tabs to the fake Sheets API in one `batchUpdate`. First render about 360 ms.
2. Browser closed. Server stopped. Network set offline. Browser reopened: the page came from the service worker and the data from IndexedDB. Today rendered in about 340 ms. GridStack and Sortable came from the service worker's cache.
3. Offline: created a project and edited it. Both showed at once and stayed after an offline reload ("2 waiting").
4. Meanwhile "another device" changed a project's next action in the sheet and deleted the first project row (so every row number the browser knew was off by one). Back online: the sync pulled the sheet, replayed the two calls on the fresh copy and sent one `batchUpdate`. The sheet then had the offline project (with the id the browser gave it, and its 3 Kanban columns with the same ids), the other device's edit and the delete. The page showed the other device's edit.
5. A new build (v2) was found by the service worker, waited, and was applied when the page asked. The page reloaded on v2 with the data kept.
6. One local call (a fresh copy of the server code, reading every tab) took about 5 ms. Today an Apps Script call takes 1 to 3 seconds.

Fake Google calls for the whole run: 1 create, 3 tab lists, 3 `batchGet`, 2 `batchUpdate`.

Two things the prototype found:
- `src/core/registry.js` finds modules as `globalThis[id + 'Module']`. That is the only place the code relies on the Apps Script global scope. The build gives the bundle a local `globalThis` listing the module factories. A one-line change in `registry.js` would remove the need.
- The code expects fresh globals for every request, as Apps Script gives (`tableCache_`, `openSpreadsheets_`, the undo journal). Reusing one copy served stale tabs. The runtime makes a fresh copy of the server code for every call (about 5 ms).

What the prototype does **not** do: real Google sign-in or real Google APIs; Drive files (notes and whiteboards stay on the device only); properties (session, pomodoro, layout) stay on the device only; a second mode (making a spreadsheet for it needs an async call); two tabs open at once; a phone.

## 1. Sign-in and scopes from a static page

**How it works (documented):** Google Identity Services (GIS) "token model". The page loads `https://accounts.google.com/gsi/client`, calls `google.accounts.oauth2.initTokenClient({ client_id, scope, callback })`, then `requestAccessToken()`. It gets an access token and calls `https://sheets.googleapis.com/v4/...` and `https://www.googleapis.com/drive/v3/...` with `Authorization: Bearer <token>`. No server and no client secret. The OAuth client is a "Web application" client with `https://patrickreynoldscoding.github.io` as an authorised JavaScript origin.

**Scopes (documented, Google's Drive and Sheets scope pages):**

| Scope | Class | Use |
|---|---|---|
| `drive.file` | Non-sensitive | Files the app creates, and files the user picks in the Google Picker. Works with the Sheets API ("See, edit, create, and delete only the specific Google Drive files you use with this app"). |
| `drive.appdata` | Non-sensitive | A hidden per-app folder. Not visible to the user or to assistants, so not recommended for data. |
| `spreadsheets` | Sensitive | All the user's sheets. Not needed. |
| `drive` | Restricted | All Drive files. Not needed, and the costly one to verify. |

So the app asks for `drive.file` only (plus `openid email` to show who is signed in).

**What `drive.file` allows here (documented scope rules; untested against the real API):**
- Create the "Focus Tracker" folder, the mode subfolders, each mode's spreadsheet, notes `.md` files and `.excalidraw` files, and read and write all of them later. A spreadsheet the app created can be read and written with the Sheets API.
- Find them again on a new device: `files.list` only returns files the app can see. Tag files with `appProperties` (for example `ft=root`, `ft=sheet:personal`) and query `appProperties has { key='ft' and value='root' }`. So no ids need to live in the repo (AGENTS.md rule) or be typed in.
- It does **not** see: Paddy's existing Apps Script spreadsheet, notes and whiteboards; files Paddy or an assistant adds to the folder by hand. Access is per file, not per folder. **Untested:** whether picking a folder in the Picker gives access to the files inside it. I expect not.
- The Picker (`google.picker`) needs an API key and the Cloud project number. Picking a file grants `drive.file` access to it.

**Token lifetime and refresh (documented, GIS reference and token-model guide):**
- Access tokens are short-lived; `expires_in` is in seconds, normally 3599 (about 1 hour). The browser token model gives no refresh token.
- To get a new one, call `requestAccessToken({ prompt: '' , login_hint: <email> })`. `''` means "prompt only the first time"; `login_hint` skips the account chooser. Google's guide says to call it "from a user-driven event such as a button press".
- **Untested, my expectation:** if Paddy is still signed in to Google, the popup opens and closes by itself. Started without a tap (for example on a timer), Chrome may block it. So the app tries quietly when it opens and when the network comes back, and if that fails shows "Sign in to sync" in the header. Nothing is lost: changes wait in the journal.
- **What the user sees:** first open: Google's account chooser and a consent screen listing "See, edit, create and delete only the specific Google Drive files you use with this app". Later: nothing most days; sometimes a quick popup or one tap to sync.
- **To get rid of the hourly token entirely** you need a refresh token, which needs a server holding the client secret (GIS "code model" plus a small Cloudflare Worker that exchanges and refreshes). Free, but a server that holds every user's tokens, and more to explain in the privacy policy. Not recommended at first.

## 2. Google verification when other people use it

**Documented** (Google Cloud help: "Manage App Audience", "Verification requirements", "Unverified apps"; Sheets API limits page):

- **Publishing status.** "Testing": up to 100 named test users, and their authorisations expire 7 days after consent (so everyone re-consents weekly). "In production": "available to any user with a Google Account".
- **Non-sensitive scopes only (`drive.file`):** verification is "not mandatory". No unverified-app warning screen and no user cap (the 100-user cap is tied to the unverified-app screen, which is for sensitive and restricted scopes). Until "brand verification" is done, Google may not show the app's name and logo on the consent screen.
- **Brand verification (optional for us, recommended):** a homepage on a domain you own that says what the app does and links to the privacy policy; a privacy policy on the same domain saying how Google data is used, stored and shared; every authorised domain verified in Google Search Console. Google's Apps Script verification page says most requests get an answer in 24 to 72 hours. Free.
- **Sensitive scopes (`spreadsheets`):** full verification with a demo video of the consent flow and scope justification. Until then the unverified warning and a lifetime cap of 100 new users. Free, but slower.
- **Restricted scopes (`drive`):** all the above plus a yearly re-verification and, if data is stored on your servers, a third-party security assessment (CASA), which can cost money. Avoid.
- **github.io as the domain: untested.** You can verify `patrickreynoldscoding.github.io` in Search Console with an HTML file, but I found no clear statement that Google accepts a `github.io` subdomain for brand verification, and one unanswered forum report of a stuck `github.io` brand check. A cheap custom domain (about £10 a year) removes the doubt and also helps the cookie issues in `banner-and-hosting.md`. Not needed to start: unbranded production works.
- **Quotas:** Sheets API 300 reads and 300 writes a minute per project, 60 each per user. Free. Google says exceeding the quota "is planned to incur charges ... later in 2026", so never attach a billing account to the project; over-quota calls then just fail with 429 and the sync retries. A sync is 2 reads and 1 write, so one user cannot get near it with a short debounce.

## 3. Offline cold start

- **Service worker:** precaches every app file at install and serves them first from the cache. CDN libraries are cached on first use. **Tested.** On GitHub Pages the scope is `/focus-tracker/`, which works the same (`site/sw.js` already does this for the wrapper).
- **Data:** the whole data state (every tab's rows, properties, cached Drive files) is kept in IndexedDB. For one person this is a few hundred KB to a few MB. **Tested** for sheet data.
- **Writes:** every call that changed the sheet goes into a journal (module, function, arguments and the random ids it drew). Sync pulls the sheet, replays the journal through the server code on that fresh copy, and sends the writes in one atomic `batchUpdate`. **Tested** against the fake.
- **Why replay, not "send the row writes":** the Table layer writes by row number. Row numbers made offline are wrong once another device adds or deletes a row (the test deletes one). Replaying against the fresh sheet is what Apps Script does today under its lock. Reusing the ids drawn the first time keeps the ids the page already shows.
- **Reuse of today's offline work:**
  - `src/core/conflicts.js` runs unchanged during the replay. To use it, journaled edits must carry `_base` and `_editedAt`, as `src/ui/offline.html` already adds for queued calls. Then the "newest wins, the other is logged" rule from `docs/offline-design.md` applies.
  - `src/ui/offline.html` mostly becomes unnecessary: calls never fail for network reasons any more, because they run locally. Its saved copy, `SCHEMA` rule, "N waiting" badge and last-page memory stay useful. `QUEUEABLE` goes away: every call works offline, including creating projects and Today sessions.
  - `FT.optimistic` and the "update the screen first" pattern stay, but matter less: a local call takes about 5 ms.
- **Gaps to close (untested):**
  - No lock between sync's pull and push. Another device writing in that second can be overwritten for the rows both touched. Sheets has no "only if unchanged" write. Narrow it by checking the Drive `version` of the spreadsheet just before the push and pulling again if it moved. Rare for one person.
  - Two tabs of the app open at once each hold a copy. Use the Web Locks API so only one tab syncs, and BroadcastChannel to tell the others to reload.
  - Drive files (notes, whiteboards) are read synchronously by the server code. In the browser they come from the IndexedDB cache; a file not cached yet makes the call stop, the runtime fetches the file, and runs the call again. Writes go behind like sheet writes (Drive v3 upload).
  - A file or spreadsheet created offline has no Google id yet. Drive's `files.generateIds` can hand out ids in advance while online. **Untested** whether a spreadsheet can be created with a pre-made id; otherwise map a temporary id to the real one after creation.

## 4. Reusing the server code in the browser

**Survey (tested with grep):** 48 call sites of Apps Script services, in 12 of the 25 server files. The other 13 files (most modules) only use `Table` and helpers.

| Service | Calls | Where | Browser replacement |
|---|---|---|---|
| `PropertiesService` | 17 | sheetdb, drive, mode, main, import, layout, today | A plain key-value map. Synced as a hidden `_settings` tab (key, value, updated_at), so the Today session, pomodoro and layout still follow Paddy across devices as they do now. |
| `DriveApp` | 12 | drive.js, sheetdb, notes, whiteboard | Drive v3 REST, cached in IndexedDB (see gaps above). |
| `SpreadsheetApp` (and Sheet and Range calls) | 5 | sheetdb, main | The in-memory copy, loaded with `values:batchGet`, written with `batchUpdate`. Only `getSheetByName`, `insertSheet`, `getRange().getValues/setValues`, `getLastRow/Column`, `deleteRow` and formatting no-ops are used. |
| `Utilities` | 5 | util, today | `crypto.randomUUID`, and `Intl` for the two date patterns (`u`, `yyyy-MM-dd`). |
| `HtmlService` | 3 | main (`doGet`, `include`) | Not needed: the page is built at build time. |
| `Session` | 2 | today | The device's time zone. Behaviour change: today it is the script's time zone (Europe/London), so "today" would follow the phone when travelling. |
| `Logger` | 2 | main, seed | `console.log`. |
| `LockService` | 1 | sheetdb | A no-op (one thread); Web Locks between tabs. |
| `ScriptApp` | 1 | rpc (`webAppUrl_`) | The page address. |

**Shim design (as built in the prototype):** a browser `SpreadsheetApp` over a JSON copy of every tab, loaded by `batchGet` and written behind by `batchUpdate`, with `Table` (`sheetdb.js`) left unchanged. The server code runs in the page; the page talks to it through the same `google.script.run` shape, so `shell.html` and the views need no change.

**`tests/mocks.js` as the basis:** yes. The prototype's `gas-shim.js` has the same Sheet, Range, Drive and Properties calls as `tests/mocks.js`, rewritten without Node's `vm`, `fs` and `crypto`. For the real build, move the shared fake into one browser-safe file that both the tests and the app load, so the server tests also cover the browser runtime.

**Effort guess:** about 5 to 7 days for the runtime (real Sheets and Drive calls, tokens, properties tab, async files, modes, multi-tab, conflicts wired in), plus tests. The modules themselves need no changes.

## 5. Alternatives

| Option | Banner | Install | Auto-update | Sign-in | Cost | Verdict |
|---|---|---|---|---|---|---|
| **PWA on GitHub Pages** | Gone (no Apps Script) | Chrome on Android, Windows, Mac and ChromeOS install it from the page; iPhone via Share → Add to Home Screen | Service worker (tested) | GIS token, hourly renewals | Free | **Recommended** |
| Electron | Gone | An installer per OS | `electron-updater` from GitHub Releases, free. macOS needs a signed and notarised app (Apple Developer, $99 a year); unsigned Windows builds show a SmartScreen warning | Desktop OAuth client with loopback and PKCE: gets a refresh token, so no hourly renewals | Free unsigned; signing costs | Bigger (about 100 MB), still needs all the same offline work. Only worth it for the refresh token. |
| Tauri | Gone | Same as Electron, much smaller | Built-in updater with its own free signing key; same OS signing costs | As Electron | As Electron | As Electron, plus a Rust build. Not needed. |
| Android TWA (Bubblewrap) | Gone | Google Play listing | Updates with the PWA itself (the TWA only wraps the site) | As PWA | Play account (one-off fee); new personal accounts must run a closed test with 12 testers for 14 days first (documented) | Only if a Play Store listing matters. A Chrome-installed PWA is already a real Android app (WebAPK). |
| Stay on Apps Script + wrapper | Hidden only in the frame, not verified | As today | clasp deploy | Google cookies in a frame | Free | No cold offline start, no Safari, cannot be shared easily. |

**Documented or known, not re-checked today:** Electron and Tauri signing costs and updater behaviour; the Play account fee. **Documented:** the Play closed-test rule (Google Play Console help).

**iOS and Safari (documented in WebKit threads, untested):** Safari deletes script storage for sites not used for 7 days of Safari use. Home-screen web apps have their own counter and, per WebKit, first-party data should not be deleted, but a 2021 bug about lost storage was closed "won't fix". Treat the device copy as a cache: Google holds the truth, so the risk is only changes not synced yet. Call `navigator.storage.persist()` on start. Size limits are not a problem at a few MB.

## 6. Auto-update

- **PWA (tested in the prototype):** each build gets a version written into `sw.js`. The browser checks `sw.js` on each open (and `registration.update()` can check on demand). A new version downloads in the background and waits. The page shows "Update ready · Reload"; on tap it tells the worker to take over, and the page reloads on the new version. If Paddy never taps, the new version starts the next time every tab is closed. Data in IndexedDB is kept.
- Bump the saved-data `SCHEMA` (offline.html rule) and include a small migration when the shape of the data changes, so an old saved copy is never read by new code.
- Deploy becomes `git push` to `main` plus a GitHub Action that builds and publishes Pages. No clasp, no deployment ids. AGENTS.md's deploy section would change.
- Electron or Tauri: their updaters check GitHub Releases on start. Not needed with the PWA.

## 7. Donations

| | Fee on a donation | Notes |
|---|---|---|
| GitHub Sponsors | 0% from personal accounts, up to 6% from organisations (GitHub docs) | Fits a GitHub-hosted app. Paid out via Stripe Connect. Needs a sponsor profile approved by GitHub. |
| Ko-fi | Reported as 0% on one-off donations on the free plan (an older blog; a comparison site disagrees; not checked on Ko-fi's own pricing page); PayPal or Stripe fees apply | Easiest for non-developers, no GitHub account needed. 5% on memberships and shop sales on the free plan. |
| Buy Me a Coffee | 5% plus payment fees | Simplest page, highest fee. |

Suggestion: a Ko-fi link in Settings and on the homepage (friendliest for users who are not developers), plus a GitHub Sponsors button in the repo. Card processing fees (about 3%) apply to all of them.

## 8. Migrating Paddy's data and how assistants reach it

**Ownership:** the existing spreadsheet, folders and notes are owned by Paddy's Google account (Apps Script runs as him). Only the *app* access differs: a `drive.file` app cannot see them until he picks them.

**Proposed migration (untested):**
1. In the new app, Settings → "Import from the old Focus Tracker". The Picker opens; Paddy picks each mode's old spreadsheet and, in the Notes and Whiteboards folders, selects all files (the Picker allows many at once).
2. The app makes its own "Focus Tracker (app)" folder and sheets, copies every tab (one `batchGet`, one `batchUpdate` per mode), copies each notes and whiteboard file and rewrites the `file_id` and `file_url` columns.
3. Properties (session, pomodoro, layout, custom modes, rotation edits in user properties) are not in the sheet. A small Apps Script function writes them into a `_settings` tab of the old sheet before the import, so they come across. Paddy runs it once from the editor.
4. The old sheet gets "Backup <date>" in its name and stays untouched, as the spec asks for the schema migration. Both apps can run side by side for a while, each on its own data.

A shortcut: the new app could keep using the old spreadsheet once picked, with no copy. But its notes files and any new files made outside the app would each need picking, so a clean copy is simpler.

Order with the spec: do the schema redesign (spec step 5) on Apps Script first or straight in the new app, not both. If the standalone app is a go, it is cheaper to do the migration once, into the new schema.

**Assistants (Claude with the Google Sheets or Drive connector):** the connector has its own Google authorisation, separate from the app's, so it sees the app's spreadsheet and files like any of Paddy's files. **Untested**, and the connector may be signed in to a different account (see `future-github-native-spike.md`). Rows an assistant adds to the sheet reach the app on the next sync, and the spec's "complete rows without id" rule works the same. But a *new file* an assistant creates (for example a notes `.md`) is invisible to the app under `drive.file`. So the assistant guide must say: put notes in the sheet (or ask Paddy to attach the file in the app), never make new files for the app to find.

## 9. Recommendation and plan

Build the PWA with the browser runtime from this spike. Keep the Apps Script version running until the new one has been used for a couple of weeks. Effort numbers are guesses for focused days.

| Phase | Work | Guess |
|---|---|---|
| 0 | This spike. | done |
| 1 | Paddy: make a Google Cloud project, an OAuth "Web application" client with the github.io origin, an API key for the Picker, consent screen with `drive.file`, set to "In production" (30 minutes, a guided checklist). Then real GIS sign-in and real Sheets calls in the runtime; try the prototype on Paddy's account with a throwaway sheet. **This is the real go/no-go:** the fake API might differ from Google's. | 2 days |
| 2 | Runtime for real: `_settings` tab for properties, Drive files (cache, fetch-and-rerun, upload), several modes, new-device discovery via `appProperties`, Web Locks, `_base` on every journaled edit, version check before push. One shared fake for tests and app. | 5 to 7 days |
| 3 | Packaging: build into `site/` from a GitHub Action, update prompt, "Sign in to sync" state, simplify `offline.html`, homepage and privacy policy pages, donation links. | 2 days |
| 4 | Import from the old app (Picker, copy, properties export script), tried on a copy of Paddy's data first. | 2 days |
| 5 | Devices: Android install and offline start, iPhone if used, the e-ink Hisense; fix what turns up. | 1 to 2 days |
| Later | Brand verification (custom domain or github.io), only if the unbranded consent screen bothers people. | 1 hour of work, 1 to 3 days of waiting |

Total: about 12 to 15 days, close to the 1 to 2 weeks guessed in `offline-design.md`, with the biggest unknown (reusing the server code) now answered.

**Open questions for Paddy:**
1. Go or no-go after reading this, and whether it comes before or after the schema redesign (doing the redesign once, in the new app, saves work).
2. Domain: stay on `patrickreynoldscoding.github.io` (free, branding unverified) or buy a custom domain (about £10 a year)?
3. Is one tap to sync now and then acceptable, or is a small token server (Cloudflare Worker, free) worth it to make sign-in silent?
4. Import by copying into new app-made files (recommended), or keep using the old spreadsheet after picking it?
5. Time zone: should "today" follow the phone (travel) or stay on UK time as now?
6. Which devices: Android and the Hisense are known. iPhone?
7. Donations: Ko-fi, GitHub Sponsors, both, or none at first?
8. Should the Apps Script version keep running for other people, or is it retired after the move?

## Sources

- Drive scopes and sensitivity: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Sheets scopes (`drive.file` supported, `spreadsheets` sensitive): https://developers.google.com/workspace/sheets/api/scopes
- Sheets quotas and billing note: https://developers.google.com/workspace/sheets/api/limits
- GIS token model: https://developers.google.com/identity/oauth2/web/guides/use-token-model and reference https://developers.google.com/identity/oauth2/web/reference/js-reference
- Verification overview: https://support.google.com/cloud/answer/13463073 ; requirements: https://support.google.com/cloud/answer/13464321 ; audience, test users, 7-day expiry, 100-user cap: https://support.google.com/cloud/answer/15549945
- Verification timing (24 to 72 hours): https://developers.google.com/apps-script/guides/client-verification
- github.io brand verification report (unanswered): https://discuss.google.dev/t/oauth-consent-screen-branding-verification-not-reflecting-after-36-hours/383185
- Play closed testing rule: https://support.google.com/googleplay/android-developer/answer/14151465
- WebKit storage and home-screen apps: https://developer.apple.com/forums/thread/710157 , https://bugs.webkit.org/show_bug.cgi?id=232302
- GitHub Sponsors fees: https://docs.github.com/en/billing/concepts/third-party-payments/github-sponsors
