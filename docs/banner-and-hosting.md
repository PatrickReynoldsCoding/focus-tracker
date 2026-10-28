# The Apps Script banner, the app icon and free hosting

Written 2026-10-28. Facts are marked **tested** (I ran it), **documented** (known Apps Script / browser behaviour I did not re-test) or **untested**.

## Short answer

- The "This application was created by a Google Apps Script user" banner is added by Google's outer page. The app's code cannot switch it off.
- It is not shown when the web app runs inside an iframe on another page. So the way to lose it is to show the app inside a small wrapper page on your own host. **Documented, not tested by me**: the banner needs a signed-in session to appear at all, and I have no Google session in this sandbox.
- GitHub Pages is free for public repos. Your data stays in Google Sheets and Drive, because the wrapper only frames the existing web app. Nothing moves.
- The catch is signing in. The framed web app needs your Google cookies, and browsers increasingly block cookies in a frame on another site.
- The wrapper also gives a real fix for the Android icon (below), because GitHub Pages can serve a web manifest and Apps Script cannot.

## What I tested

Script: `scripts/banner-iframe-test.js` (needs `npm i --no-save playwright-core` and Chrome at `/usr/bin/google-chrome`). It serves a one-line local wrapper that iframes the exec URL and logs what the frame does.

**Tested, clean Chrome profile (not signed in), exec URL in an iframe on `http://localhost`:**
- `script.google.com/.../exec` answers `302` to `accounts.google.com/ServiceLogin`. It also sends `X-Frame-Options: SAMEORIGIN` on that redirect response.
- The frame ends up at the Google sign-in address and then shows Google's error image, so no app loads.
- So an unauthenticated framed app does not work. Opening the exec URL once at top level and signing in is not enough on its own: the frame needs the session cookie to be sent in a third-party context.

**Not tested (needs your signed-in Chrome):** whether the banner disappears and whether the app works in the frame. To test it yourself, run the script with a profile that is signed in to Google (pass `--user-data-dir` in the `launch` call), or just open the wrapper below in your own browser. I did not touch your profile or any credentials.

## What I could not do

- See the banner at all. It needs a signed-in session.
- Test the Android shortcut icon. That needs a real device or the emulator.
- Confirm the exact condition that shows the banner. I believe it shows for web apps owned by a consumer (gmail.com) account and not for Workspace-owned apps, but I did not verify that.

## Wrapper plan (free)

1. A static page `index.html` in a public repo (this one under `docs/site/`, or a new repo), published with GitHub Pages. Cost: nothing. Private repos need a paid plan for Pages, so it has to be public.
2. The page is one full-window iframe whose `src` is your exec URL, plus a manifest and the icons from `assets/icons`.
3. **Keep the exec URL out of the repo.** AGENTS.md says deployment IDs stay out of it. So the page asks for the URL once (or reads `#u=...` on first open), stores it in `localStorage`, and uses that from then on.
4. The web app already sets `XFrameOptionsMode.ALLOWALL`, so Google allows the framing.
5. `index.html` has `<base target="_top">`. Inside a wrapper, a plain link without its own `target` would replace the wrapper. Most links in the app use `target="_blank"`; check the rest.

Sketch:

```html
<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="manifest.webmanifest"><title>Focus Tracker</title>
<style>html,body,iframe{margin:0;height:100%;width:100%;border:0}</style>
<iframe id="app" allow="autoplay; clipboard-write"></iframe>
<script>
  var u = new URLSearchParams(location.hash.slice(1)).get('u') || localStorage.getItem('execUrl');
  if (!u) u = prompt('Paste your Focus Tracker web app URL');
  if (u) { localStorage.setItem('execUrl', u); history.replaceState(null, '', location.pathname); document.getElementById('app').src = u; }
</script>
```

## Cookie risks

- **Documented:** the framed app is third-party content on `github.io`. Chrome currently still allows third-party cookies by default (Google paused removing them), so it should work in desktop Chrome and Chrome on Android. Incognito, Safari and Firefox block them, so a sign-in there will fail.
- **Documented:** if the Google session has expired, the frame shows the sign-in page, and Google will not let sign-in run inside a frame. You would have to open the exec URL at top level to sign in again, then reload the wrapper.
- **Documented:** Chrome's "Block third-party cookies" setting, or a per-site exception missing for `github.io`, breaks it. The fix is to allow third-party cookies for `[*.]github.io` or, better, use a custom domain.
- A more robust design is Google sign-in on the wrapper plus Sheets and Drive API calls from the browser, with Apps Script dropped. It is free and removes the banner and the cookie problem, but it is a rewrite of the whole server side. **Untested, not recommended as a first step.**
- This is also the route to offline use: a wrapper that is a PWA can have a service worker, which a page served by Apps Script can never have.

## Icons

**What is wired now (committed, not deployed):**
- `assets/icons/`: `icon.svg` (source), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (artwork inside the safe zone), `favicon-32.png`, `apple-touch-icon.png`. A target mark in the app's teal. Regenerate with `node scripts/make-icons.js` (uses the `sharp` dev dependency).
- `setFaviconUrl` in `src/core/main.js` points at `https://raw.githubusercontent.com/PatrickReynoldsCoding/focus-tracker/main/assets/icons/icon-192.png`.
- **It needs `assets/icons/` pushed to `main` on GitHub first.** Until then the URL returns 404 and the tab shows the default icon. The repo is public (checked with `gh repo view`). After pushing, check with `curl -I <url>` that it returns 200 with `content-type: image/png`.
- `<link rel="icon">` and `apple-touch-icon` tags are in `src/ui/index.html`.

**Honest expectation for "Add to Home screen" on Android:**
- Apps Script serves the page inside a sandboxed iframe and cannot serve a web manifest, so the page is never an installable PWA.
- Chrome builds the shortcut icon from the **outer** page. Apps Script only writes the favicon you give `setFaviconUrl` into the outer page; the link tags in `index.html` sit inside the inner frame and Chrome probably ignores them. So the icon we gave `setFaviconUrl` is what we are relying on. **Untested on a device.**
- If Chrome decides the favicon is too small or unusable, it falls back to the grey letter tile you see now. A 192 px PNG gives it the best chance, which is why the favicon URL uses the 192 px file and not the 32 px one.
- The reliable fix is the wrapper: GitHub Pages serves `manifest.webmanifest` with the 192, 512 and maskable icons, so Chrome offers a real install with the proper icon and a standalone window. That is what you want for the Android and Mac "apps".

## Recommendation

1. Push `assets/icons/` and deploy; check the tab icon and try the Android shortcut. If the letter tile remains, move to the wrapper.
2. Build the wrapper (free, small), test it in your own signed-in Chrome and on the phone, and see whether the banner is gone and sign-in holds.
3. Decide on offline and the Sheets-API rewrite only after the wrapper works.
