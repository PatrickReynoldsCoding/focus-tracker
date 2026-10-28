/** In-memory stand-ins for the Google services the server code uses, so the code can run under Node. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Counts calls into the fake Sheets service, which are the slow part of a request on Google.
const sheetCalls = { n: 0 };

function makeSheet(name) {
  const sh = { name, rows: [], maxRows: 1000 };
  const counted = (fn) => (...args) => { sheetCalls.n++; return fn(...args); };
  sh.getMaxRows = () => sh.maxRows;
  sh.getLastRow = counted(() => sh.rows.length);
  sh.getLastColumn = counted(() => sh.rows.reduce((m, r) => Math.max(m, r.length), 0));
  sh.setFrozenRows = () => sh;
  sh.deleteRow = counted((i) => { sh.rows.splice(i - 1, 1); });
  sh.getRange = counted((r, c, nr = 1, nc = 1) => {
    const range = {
      getValues: () => Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => { const v = (sh.rows[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
      setValues: (vals) => {
        vals.forEach((row, i) => {
          while (sh.rows.length < r + i) sh.rows.push([]);
          row.forEach((v, j) => { sh.rows[r - 1 + i][c - 1 + j] = String(v); });
        });
        return range;
      },
      setNumberFormat: () => range,
      setFontWeight: () => range
    };
    return range;
  });
  return sh;
}

function makeSpreadsheet(id = 'sheet-1', name = 'Focus Tracker') {
  const sheets = {};
  return {
    sheets, name,
    getId: () => id,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
    getSheetByName: (n) => { sheetCalls.n++; return sheets[n] || null; },
    insertSheet: (n) => (sheets[n] = makeSheet(n))
  };
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
      moveTo: (dest) => { place(file, dest); return file; } }, extra);
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
  return {
    files, folders, myDrive,
    /** Register a spreadsheet as a file in My Drive, like SpreadsheetApp.create does. */
    addSpreadsheetFile: (id, nm) => place(addFile(id, nm, {}), myDrive),
    pathOf: (node) => { const parts = []; for (let x = node; x && x !== myDrive; x = x.parent) parts.unshift(x.name); return parts.join('/'); },
    createFolder: (nm) => { const f = folder(nm); place(f, myDrive); return f; },
    getFoldersByName: (nm) => { const hit = Object.values(myDrive.children).filter((c) => c.name === nm && c.children); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
    getFolderById: (id) => folders[id],
    getFileById: (id) => files[id]
  };
}

function loadServer(opts = {}) {
  const ss = makeSpreadsheet();
  const spreadsheets = { [ss.getId()]: ss };
  const script = props(), user = props();
  const drive = makeDrive();
  drive.addSpreadsheetFile(ss.getId(), ss.name);
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
