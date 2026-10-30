/** In-memory stand-ins for the Google services the server code uses, so the code can run under Node. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Counts calls into the fake Sheets service, which are the slow part of a request on Google.
const sheetCalls = { n: 0 };

// Formatting (tab colour, header colours, wrap, widths, filter, notes) is recorded in sh.style, not drawn.
// sh.failWrites = true makes every setValues on the tab fail, like a Sheets service error.
function makeSheet(name, ss) {
  const sh = { name, rows: [], maxRows: 1000, maxCols: 26, style: { backgrounds: [], wraps: [], widths: {}, notes: {} } };
  const counted = (fn) => (...args) => { sheetCalls.n++; return fn(...args); };
  sh.getName = () => sh.name;
  sh.setName = (n) => { ss._rename(sh, n); return sh; };
  sh.getMaxRows = () => sh.maxRows;
  sh.getMaxColumns = () => sh.maxCols;
  sh.insertRowsAfter = (after, n) => { sh.maxRows += n; return sh; };
  sh.insertColumnsAfter = (after, n) => { sh.maxCols += n; return sh; };
  sh.getLastRow = counted(() => sh.rows.length);
  sh.getLastColumn = counted(() => sh.rows.reduce((m, r) => Math.max(m, r.length), 0));
  sh.setFrozenRows = (n) => { sh.style.frozen = n; return sh; };
  sh.setTabColor = (color) => { sh.style.tabColor = color; return sh; };
  sh.setColumnWidth = (c, w) => { sh.style.widths[c] = w; return sh; };
  sh.getFilter = () => sh.style.filter || null;
  sh.deleteRow = counted((i) => { sh.rows.splice(i - 1, 1); });
  sh.getRange = counted((r, c, nr = 1, nc = 1) => {
    const area = { r, c, nr, nc };
    const range = {
      getValues: () => Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => { const v = (sh.rows[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
      setValues: (vals) => {
        if (sh.failWrites) throw new Error('Service error: Spreadsheets (fake failure)');
        if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error('The number of rows or columns in the data does not match the range.');
        if (r - 1 + nr > sh.maxRows || c - 1 + nc > sh.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
        vals.forEach((row, i) => {
          while (sh.rows.length < r + i) sh.rows.push([]);
          row.forEach((v, j) => { sh.rows[r - 1 + i][c - 1 + j] = String(v); });
        });
        return range;
      },
      clearContent: () => {
        for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i]; if (row) for (let j = 0; j < nc; j++) if (row[c - 1 + j] !== undefined) row[c - 1 + j] = ''; }
        while (sh.rows.length && sh.rows[sh.rows.length - 1].every((v) => v === '')) sh.rows.pop();
        return range;
      },
      setNumberFormat: () => range,
      setFontWeight: () => range,
      setFontColor: () => range,
      setBackground: (color) => { sh.style.backgrounds.push(Object.assign({ color }, area)); return range; },
      setWrap: (on) => { sh.style.wraps.push(Object.assign({ on }, area)); return range; },
      setNote: (text) => { sh.style.notes[r + ',' + c] = text; return range; },
      createFilter: () => {
        if (sh.style.filter) throw new Error('You can\'t create a filter in a sheet that already has a filter.');
        sh.style.filter = Object.assign({ remove: () => { delete sh.style.filter; } }, area);
        return sh.style.filter;
      }
    };
    return range;
  });
  return sh;
}

/**
 * A spreadsheet with its tabs in order. ss.sheets maps a name to its tab; ss.order() lists the names in tab order.
 * ss.failInsert = (name) => true makes inserting that tab fail, like a Sheets service error.
 */
function makeSpreadsheet(id = 'sheet-1', name = 'Focus Tracker') {
  const sheets = {};
  let list = [], active = null;
  const ss = {
    sheets, name,
    getId: () => id,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
    getSheetByName: (n) => { sheetCalls.n++; return sheets[n] || null; },
    getSheets: () => list.slice(),
    insertSheet: (n) => {
      if (sheets[n]) throw new Error('A sheet with the name "' + n + '" already exists. Please enter another name.');
      if (ss.failInsert && ss.failInsert(n)) throw new Error('Service error: Spreadsheets (fake failure inserting ' + n + ')');
      const sh = makeSheet(n, ss);
      sheets[n] = sh;
      list.push(sh);
      return sh;
    },
    deleteSheet: (sh) => {
      if (list.length === 1) throw new Error('You can\'t remove all the sheets in a document.');
      list = list.filter((x) => x !== sh);
      delete sheets[sh.name];
    },
    setActiveSheet: (sh) => { active = sh; return sh; },
    moveActiveSheet: (pos) => {
      if (!active || pos < 1 || pos > list.length) throw new Error('Bad sheet position: ' + pos);
      list = list.filter((x) => x !== active);
      list.splice(pos - 1, 0, active);
    },
    order: () => list.map((sh) => sh.name),
    _rename: (sh, n) => {
      if (sheets[n] && sheets[n] !== sh) throw new Error('A sheet with the name "' + n + '" already exists. Please enter another name.');
      delete sheets[sh.name];
      sh.name = n;
      sheets[n] = sh;
    }
  };
  return ss;
}

/** A deep copy of a spreadsheet's tabs and values, for DriveApp makeCopy. */
function copySpreadsheet(src, id, name) {
  const copy = makeSpreadsheet(id, name);
  src.getSheets().forEach((sh) => { copy.insertSheet(sh.name).rows = sh.rows.map((r) => r.slice()); });
  return copy;
}

function props() {
  const m = {};
  return { getProperty: (k) => (k in m ? m[k] : null), setProperty: (k, v) => { m[k] = String(v); }, _m: m };
}

/** Drive with parent tracking, so tests can check where files and folders end up. The top level is My Drive. */
function makeDrive() {
  let n = 0;
  const files = {}, folders = {};
  const myDrive = { name: 'My Drive', children: {} };
  function place(node, parent) {
    if (node.parent) delete node.parent.children[node.id];
    parent.children[node.id] = node;
    node.parent = parent;
  }
  function addFile(fid, nm, extra) {
    const file = Object.assign({ id: fid, name: nm, getId: () => fid, getUrl: () => 'https://docs.google.com/file/' + fid,
      getName: () => file.name,
      getMimeType: () => file.mime || 'application/octet-stream',
      getLastUpdated: () => file.updated || new Date('2026-10-01T09:00:00Z'),
      moveTo: (dest) => { place(file, dest); return file; },
      // drive.failCopy = true makes copies fail, like a Drive quota or service error
      makeCopy: (copyName, dest) => {
        if (api.failCopy) throw new Error('Service error: Drive (fake failure)');
        const copy = addFile('file-' + ++n, copyName, { copyOf: fid });
        place(copy, dest || file.parent);
        if (api.onCopy) api.onCopy(file, copy);
        return copy;
      } }, extra);
    files[fid] = file;
    return file;
  }
  function folder(name) {
    const id = 'folder-' + ++n;
    const f = {
      id, name, children: {},
      getId: () => id, getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      getFoldersByName: (nm) => { const hit = Object.values(f.children).filter((c) => c.name === nm && c.children); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
      createFolder: (nm) => { const c = folder(nm); place(c, f); return c; },
      createFile: (nm, content, mime) => {
        const file = addFile('file-' + ++n, nm, { content, mime,
          setContent: (c) => { file.content = c; }, setName: (nm2) => { file.name = nm2; return file; }, getBlob: () => ({ getDataAsString: () => file.content }) });
        place(file, f);
        return file;
      },
      moveTo: (dest) => { place(f, dest); return f; }
    };
    folders[id] = f;
    return f;
  }
  const api = {
    files, folders, myDrive,
    /** Register a spreadsheet as a file in My Drive, like SpreadsheetApp.create does. */
    addSpreadsheetFile: (id, nm) => place(addFile(id, nm, {}), myDrive),
    pathOf: (node) => { const parts = []; for (let x = node; x && x !== myDrive; x = x.parent) parts.unshift(x.name); return parts.join('/'); },
    createFolder: (nm) => { const f = folder(nm); place(f, myDrive); return f; },
    getFoldersByName: (nm) => { const hit = Object.values(myDrive.children).filter((c) => c.name === nm && c.children); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
    getFolderById: (id) => folders[id],
    getFileById: (id) => { if (!files[id]) throw new Error('No item with the given ID could be found: ' + id); return files[id]; },
    /**
     * A file in My Drive for search tests: { mime, updated, trashed, content }. Reading its contents (getBlob, getAs)
     * counts in drive.contentReads, so a test can prove a search never opens a file.
     */
    addDriveFile: (nm, extra = {}) => {
      const file = addFile('file-' + ++n, nm, extra);
      file.getBlob = file.getAs = () => { api.contentReads++; return { getDataAsString: () => file.content || '' }; };
      place(file, myDrive);
      return file;
    },
    contentReads: 0,
    queries: [],
    // Understands the query the resources module sends: title contains '<words>' and trashed = false. Case-insensitive, like Drive.
    searchFiles: (q) => {
      api.queries.push(q);
      const m = /^title contains '((?:[^'\\]|\\.)*)' and trashed = false$/.exec(q);
      if (!m) throw new Error('Invalid argument: q');
      const words = m[1].replace(/\\(.)/g, '$1').toLowerCase();
      const hit = Object.values(files).filter((f) => !f.trashed && String(f.name).toLowerCase().includes(words));
      let i = 0;
      return { hasNext: () => i < hit.length, next: () => hit[i++] };
    }
  };
  return api;
}

function loadServer(opts = {}) {
  const ss = makeSpreadsheet();
  const spreadsheets = { [ss.getId()]: ss };
  const script = props(), user = props();
  const drive = makeDrive();
  drive.addSpreadsheetFile(ss.getId(), ss.name);
  // Copying a spreadsheet's file copies its tabs too, so a test can open the backup
  drive.onCopy = (file, copy) => { if (spreadsheets[file.id]) spreadsheets[copy.id] = copySpreadsheet(spreadsheets[file.id], copy.id, copy.name); };
  const mock = { weekday: null, logs: [] };
  // One script lock. Waiting for it while this execution already holds it would hang on Google, so it throws here.
  let lockHeld = false;
  const lock = {
    waitLock() { if (lockHeld) throw new Error('Deadlock: script lock already held'); lockHeld = true; },
    releaseLock() { lockHeld = false; }
  };
  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: (id) => spreadsheets[id],
      create: (name) => {
        const created = makeSpreadsheet('sheet-' + (Object.keys(spreadsheets).length + 1), name);
        spreadsheets[created.getId()] = created;
        drive.addSpreadsheetFile(created.getId(), name);
        return created;
      }
    },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user },
    LockService: { getScriptLock: () => lock },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        if (fmt === 'u') return String(mock.weekday || ((d.getUTCDay() + 6) % 7 + 1));
        return d.toISOString().slice(0, 10);
      }
    },
    Session: { getScriptTimeZone: () => 'Europe/London' },
    DriveApp: drive,
    Logger: { log: (m) => mock.logs.push(m) }
  };
  vm.createContext(sandbox);
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    // src/private holds git-ignored local data (one-time imports); tests never load it unless asked to
    if (e.isDirectory()) { if (e.name !== 'private' || opts.includePrivate) walk(p); } else if (p.endsWith('.js')) files.push(p);
  }); })(root);
  files.forEach((f) => vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: path.relative(root, f) }));
  // Run helpers in the sandbox so results keep their own realm
  const run = (code) => vm.runInContext(code, sandbox);
  return { sandbox, ss, spreadsheets, script, user, drive, mock, run };
}

module.exports = { loadServer, sheetCalls };
