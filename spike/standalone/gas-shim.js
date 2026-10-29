/**
 * SPIKE, throwaway. Browser stand-ins for the Apps Script globals the server code uses
 * (SpreadsheetApp, DriveApp, PropertiesService, LockService, Utilities, Session, ScriptApp, Logger).
 * The model follows tests/mocks.js (same Sheet and Range calls), but it is plain browser JS over a plain JSON
 * state object, so the whole state can be saved to IndexedDB and rebuilt from a Sheets API batchGet.
 *
 * State shape: { primary: <spreadsheet id>, books: { <id>: { title, tabs: { <name>: { sheetId, rows: [[...]] } } } },
 *                props: { script: {}, user: {} }, drive: { files: {}, folders: {} } }
 * While `GAS.recording` is an array, every sheet write is also pushed to it as a Sheets API v4 batchUpdate request
 * (addSheet, updateCells, deleteDimension), so the same calls can be sent to Google.
 */
(function (root) {
  var GAS = { state: null, recording: null, uuidQueue: null, uuidLog: null };

  function rec(bookId, request) { if (GAS.recording) GAS.recording.push({ book: bookId, request: request }); }

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  function sheetApi(bookId, name) {
    var tab = function () { return GAS.state.books[bookId].tabs[name]; };
    var sh = {
      getName: function () { return name; },
      getMaxRows: function () { return Math.max(1000, tab().rows.length); },
      getLastRow: function () { return tab().rows.length; },
      getLastColumn: function () { return tab().rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0); },
      setFrozenRows: function () { return sh; },
      deleteRow: function (i) {
        tab().rows.splice(i - 1, 1);
        rec(bookId, { deleteDimension: { range: { sheetId: tab().sheetId, dimension: 'ROWS', startIndex: i - 1, endIndex: i } } });
      },
      getRange: function (r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        var range = {
          getValues: function () {
            var rows = tab().rows, out = [];
            for (var i = 0; i < nr; i++) {
              var row = [];
              for (var j = 0; j < nc; j++) { var v = (rows[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); }
              out.push(row);
            }
            return out;
          },
          setValues: function (vals) {
            var rows = tab().rows;
            vals.forEach(function (row, i) {
              while (rows.length < r + i) rows.push([]);
              row.forEach(function (v, j) { rows[r - 1 + i][c - 1 + j] = str(v); });
            });
            // Strings stay strings in Sheets when sent as stringValue, so no '@' number format is needed.
            rec(bookId, { updateCells: {
              start: { sheetId: tab().sheetId, rowIndex: r - 1, columnIndex: c - 1 },
              rows: vals.map(function (row) { return { values: row.map(function (v) { return { userEnteredValue: { stringValue: str(v) } }; }) }; }),
              fields: 'userEnteredValue'
            } });
            return range;
          },
          setNumberFormat: function () { return range; },
          setFontWeight: function () { return range; }
        };
        return range;
      }
    };
    return sh;
  }

  function bookApi(id) {
    return {
      getId: function () { return id; },
      getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + id; },
      getSheetByName: function (n) { return GAS.state.books[id].tabs[n] ? sheetApi(id, n) : null; },
      insertSheet: function (n) {
        var sheetId = Math.floor(Math.random() * 2e9);
        GAS.state.books[id].tabs[n] = { sheetId: sheetId, rows: [] };
        rec(id, { addSheet: { properties: { sheetId: sheetId, title: n } } });
        return sheetApi(id, n);
      }
    };
  }

  function propsApi(kind) {
    return {
      getProperty: function (k) { var m = GAS.state.props[kind]; return k in m ? m[k] : null; },
      setProperty: function (k, v) { GAS.state.props[kind][k] = String(v); return this; },
      deleteProperty: function (k) { delete GAS.state.props[kind][k]; return this; }
    };
  }

  // ---------- Drive: local only in this spike (not synced), modelled on makeDrive() in tests/mocks.js ----------
  function iter(list) { var i = 0; return { hasNext: function () { return i < list.length; }, next: function () { return list[i++]; } }; }
  function newDriveId() { return 'local-' + Math.random().toString(36).slice(2, 10); }
  function fileApi(id) {
    var f = function () { return GAS.state.drive.files[id]; };
    var api = {
      getId: function () { return id; },
      getUrl: function () { return 'https://drive.google.com/file/d/' + id; },
      getName: function () { return f().name; },
      setName: function (n) { f().name = n; return api; },
      setContent: function (c) { f().content = String(c); return api; },
      getBlob: function () { return { getDataAsString: function () { return f().content; } }; },
      moveTo: function (folder) { f().parent = folder.getId(); return api; }
    };
    return api;
  }
  function folderApi(id) {
    var api = {
      getId: function () { return id; },
      getUrl: function () { return 'https://drive.google.com/drive/folders/' + id; },
      getName: function () { return GAS.state.drive.folders[id].name; },
      getFoldersByName: function (n) { return iter(childFolders(id, n)); },
      createFolder: function (n) { return makeFolder(n, id); },
      createFile: function (n, content, mime) {
        var fid = newDriveId();
        GAS.state.drive.files[fid] = { name: n, content: String(content), mime: mime || 'text/plain', parent: id };
        return fileApi(fid);
      },
      moveTo: function (dest) { GAS.state.drive.folders[id].parent = dest.getId(); return api; }
    };
    return api;
  }
  function childFolders(parent, n) {
    var fs = GAS.state.drive.folders;
    return Object.keys(fs).filter(function (k) { return fs[k].parent === parent && fs[k].name === n; }).map(folderApi);
  }
  function makeFolder(n, parent) {
    var id = newDriveId();
    GAS.state.drive.folders[id] = { name: n, parent: parent };
    return folderApi(id);
  }

  // ---------- Utilities.formatDate for the two patterns the code uses ----------
  function parts(d, tz) {
    var o = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  var WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  function uuid() {
    var u;
    if (GAS.uuidQueue && GAS.uuidQueue.length) u = GAS.uuidQueue.shift();
    else u = crypto.randomUUID();
    if (GAS.uuidLog) GAS.uuidLog.push(u);
    return u;
  }

  root.GAS = GAS;
  root.GAS_GLOBALS = {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return GAS.state.primary ? bookApi(GAS.state.primary) : null; },
      openById: function (id) { if (!GAS.state.books[id]) throw new Error('No spreadsheet ' + id); return bookApi(id); },
      create: function () { throw new Error('Spike: making a spreadsheet for a second mode is not wired (needs the async Sheets create call).'); }
    },
    DriveApp: {
      getFileById: function (id) { if (GAS.state.drive.files[id]) return fileApi(id); return { getId: function () { return id; }, moveTo: function () {} }; },
      getFolderById: function (id) { return folderApi(id); },
      getFoldersByName: function (n) { return iter(childFolders(null, n)); },
      createFolder: function (n) { return makeFolder(n, null); }
    },
    PropertiesService: { getScriptProperties: function () { return propsApi('script'); }, getUserProperties: function () { return propsApi('user'); } },
    // One page, one thread: nothing else can write the in-memory copy while a call runs. (Two tabs: see the spike doc.)
    LockService: { getScriptLock: function () { return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {} }; } },
    Utilities: {
      getUuid: uuid,
      formatDate: function (d, tz, fmt) {
        var p = parts(d, tz);
        if (fmt === 'u') return String(WEEKDAY[p.weekday]);
        if (fmt === 'yyyy-MM-dd') return p.year + '-' + p.month + '-' + p.day;
        throw new Error('Spike: formatDate pattern not shimmed: ' + fmt);
      }
    },
    Session: { getScriptTimeZone: function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; } },
    ScriptApp: { getService: function () { return { getUrl: function () { return location.href.split('#')[0]; } }; } },
    HtmlService: null, // only doGet() and include() use it, and the browser build never calls them
    Logger: { log: function (m) { console.log('[server]', m); } }
  };
})(this);
