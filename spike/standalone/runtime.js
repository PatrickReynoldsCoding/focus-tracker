/**
 * SPIKE, throwaway. Runs the real server code (bundled by build.js as makeFTServer) inside the page and gives the
 * unchanged front end a `google.script.run` that calls it locally. So every button works with no network at all.
 *
 * - The data lives in memory (GAS.state) and is saved to IndexedDB after every call, so a cold start offline has it.
 * - Every call that wrote to the sheet is kept in a journal (name, args, the uuids it drew) until it reaches "Google".
 * - Sync = pull the sheet fresh (Sheets API values:batchGet), replay the journal through the same server code on
 *   that fresh copy, and send the writes the replay produced as ONE spreadsheets:batchUpdate. Replaying (instead of
 *   sending the row writes made offline) means row numbers and conflicts are worked out against the sheet as it is
 *   now, which is what Apps Script does today under its lock; conflicts.js runs unchanged during the replay.
 * - "Google" here is spike/standalone/fake-google.js on the same origin; API_BASE would be https://sheets.googleapis.com.
 */
(function () {
  var API_BASE = location.origin;
  var TOKEN = 'fake-token'; // real app: an access token from Google Identity Services (see the spike doc)
  var SERVER_FNS = { bootstrap: 1, rpc: 1, undo: 1, redo: 1, ping: 1, createMode: 1, setup: 1, seedStarterData: 1 };

  // ---------- IndexedDB, one store, two keys: 'live' (the data) and 'journal' ----------
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('ft-standalone-spike', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function kvGet(k) { return idb().then(function (db) { return new Promise(function (res, rej) { var q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }); }
  function kvSetMany(pairs) {
    return idb().then(function (db) { return new Promise(function (res, rej) {
      var tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv');
      Object.keys(pairs).forEach(function (k) { st.put(pairs[k], k); });
      tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
    }); });
  }

  var journal = [];
  var spike = window.__spike = { ready: false, journal: function () { return journal.length; }, lastSync: null, lastError: null, syncs: 0, replayErrors: [], build: window.FT_BUILD };
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function persist() { return kvSetMany({ live: GAS.state, journal: journal }); }

  // ---------- the fake (or real) Google APIs ----------
  function api(path, opts) {
    opts = opts || {};
    return fetch(API_BASE + path, { method: opts.method || 'GET', headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path); return r.json(); });
  }
  function createSpreadsheet(title) { return api('/v4/spreadsheets', { method: 'POST', body: { properties: { title: title } } }).then(function (r) { return r.spreadsheetId; }); }
  function pullBook(id) {
    return api('/v4/spreadsheets/' + id + '?fields=properties.title,sheets.properties').then(function (meta) {
      var titles = meta.sheets.map(function (s) { return s.properties.title; });
      var q = titles.map(function (t) { return 'ranges=' + encodeURIComponent("'" + t.replace(/'/g, "''") + "'"); }).join('&');
      return api('/v4/spreadsheets/' + id + '/values:batchGet?valueRenderOption=FORMATTED_VALUE&' + q).then(function (vr) {
        var tabs = {};
        meta.sheets.forEach(function (s, i) { tabs[s.properties.title] = { sheetId: s.properties.sheetId, rows: (vr.valueRanges[i].values || []).map(function (r) { return r.map(String); }) }; });
        return { title: meta.properties.title, tabs: tabs };
      });
    });
  }
  function pushBatch(id, requests) { return api('/v4/spreadsheets/' + id + ':batchUpdate', { method: 'POST', body: { requests: requests } }); }

  // ---------- running a server function locally ----------
  /** Runs fn on the current GAS.state. Returns { value, error, requests, uuids }. replayUuids: reuse the ids drawn the first time. */
  function runServer(name, args, replayUuids) {
    GAS.recording = []; GAS.uuidLog = []; GAS.uuidQueue = replayUuids ? replayUuids.slice() : null;
    try {
      // A fresh copy of the server code for every call, as Apps Script gives every request fresh globals
      // (tableCache_, openSpreadsheets_, the change journal ...). Reusing one copy served stale cached tabs.
      var value = makeFTServer(GAS_GLOBALS)[name].apply(null, clone(args));
      return { value: value === undefined ? null : clone(value), requests: GAS.recording, uuids: GAS.uuidLog };
    } catch (e) {
      return { error: e, requests: GAS.recording, uuids: GAS.uuidLog };
    } finally { GAS.recording = null; GAS.uuidLog = null; GAS.uuidQueue = null; }
  }

  /** A call from the page. Calls that wrote to the sheet go in the journal. */
  function callLocal(name, args) {
    var r = runServer(name, args);
    if (r.requests.length) journal.push({ fn: name, args: clone(args), uuids: r.uuids, at: new Date().toISOString() });
    persist();
    if (r.requests.length) scheduleSync();
    showStatus();
    return r;
  }

  // ---------- sync ----------
  var syncing = false, syncTimer = null;
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms === undefined ? 800 : ms); }

  function sync() {
    if (syncing || !spike.ready) return Promise.resolve();
    syncing = true; showStatus();
    var id = GAS.state.primary, pending = journal.slice();
    return pullBook(id).then(function (remote) {
      // Replay on a fresh copy, synchronously, so no page call can run in between.
      var live = GAS.state;
      var fresh = { primary: id, books: {}, props: clone(live.props), drive: clone(live.drive) };
      fresh.books[id] = remote;
      GAS.state = fresh;
      var requests = [];
      pending.forEach(function (e) {
        var r = runServer(e.fn, e.args, e.uuids);
        if (r.error) spike.replayErrors.push(e.fn + ': ' + r.error.message);
        requests = requests.concat(r.requests.map(function (x) { return x.request; }));
      });
      GAS.state = live;
      return (requests.length ? pushBatch(id, requests) : Promise.resolve()).then(function () {
        // Sent. The fresh copy is the truth now; calls made while we waited are run again on top of it.
        var later = journal.slice(pending.length);
        GAS.state = fresh;
        later.forEach(function (e) { runServer(e.fn, e.args, e.uuids); });
        journal = later;
        spike.lastSync = new Date().toISOString(); spike.lastError = null; spike.syncs++; spike.lastRequests = requests.length;
        return persist().then(function () {
          if (window.FT && FT.ready && FT.reload) FT.reload(); // show what other devices changed
          if (journal.length) scheduleSync();
        });
      });
    }).catch(function (e) {
      spike.lastError = e.message;
      scheduleSync(5000);
    }).then(function () { syncing = false; showStatus(); });
  }
  window.addEventListener('online', function () { scheduleSync(0); });

  // ---------- a small status badge (the real app would reuse #offstat from offline.html) ----------
  function showStatus() {
    var el = document.getElementById('spikeSync');
    if (!el) { if (!document.body) return; el = document.createElement('div'); el.id = 'spikeSync'; el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;font:12px sans-serif;background:#222;color:#fff;padding:3px 8px;border-radius:9px;opacity:.85'; document.body.appendChild(el); }
    el.textContent = 'Spike ' + (window.FT_BUILD || '') + ' · ' + (syncing ? 'syncing…' : journal.length ? journal.length + ' waiting' + (spike.lastError ? ' (offline)' : '') : 'synced');
  }

  // ---------- start: load the saved copy, or make the spreadsheet on first run ----------
  var ready = Promise.all([kvGet('live'), kvGet('journal')]).then(function (v) {
    if (v[0]) { GAS.state = v[0]; journal = v[1] || []; return 'saved'; }
    // First run needs a connection (the real app would also need sign-in here).
    return createSpreadsheet('Focus Tracker - Personal').then(function (id) {
      GAS.state = { primary: id, books: {}, props: { script: { SHEET_ID: id }, user: {} }, drive: { files: {}, folders: {} } };
      GAS.state.books[id] = { title: 'Focus Tracker - Personal', tabs: {} };
      return pullBook(id).then(function (b) {
        GAS.state.books[id] = b;
        callLocal('setup', []);
        callLocal('seedStarterData', []); // spike only: starter projects so there is something to see
        return 'new';
      });
    });
  }).then(function (how) {
    spike.ready = true; spike.start = how;
    showStatus();
    scheduleSync(how === 'saved' ? 300 : 0);
  }).catch(function (e) { spike.fatal = e.message; console.error(e); });

  // ---------- google.script.run, as the page expects it ----------
  function runner(ok, fail) {
    return new Proxy({}, { get: function (_, name) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        ready.then(function () {
          setTimeout(function () {
            if (!SERVER_FNS[name]) { fail && fail({ message: 'Error: unknown server function ' + name }); return; }
            var r = callLocal(name, args);
            if (r.error) { if (fail) fail({ message: 'Error: ' + r.error.message }); } else if (ok) ok(r.value);
          }, 0);
        });
      };
    } });
  }
  window.google = { script: { run: {
    withSuccessHandler: function (ok) { return { withFailureHandler: function (fail) { return runner(ok, fail); } }; },
    withFailureHandler: function (fail) { return { withSuccessHandler: function (ok) { return runner(ok, fail); } }; }
  } } };

  // ---------- the service worker, and the update prompt ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      spike.swRegistered = true;
      function offer(w) { spike.updateWaiting = true; window.dispatchEvent(new Event('spike-update')); }
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
      // A real app would show "Update ready · Reload". The spike lets the test press it.
      spike.applyUpdate = function () { if (reg.waiting) reg.waiting.postMessage('skipWaiting'); };
      spike.checkUpdate = function () { return reg.update(); };
    });
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (spike.updateWaiting && !reloaded) { reloaded = true; location.reload(); } });
  }
})();
