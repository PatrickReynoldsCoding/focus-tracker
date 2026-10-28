/** In-memory stand-ins for the Google services the server code uses, so the code can run under Node. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function makeSheet(name) {
  const sh = { name, rows: [], maxRows: 1000 };
  sh.getMaxRows = () => sh.maxRows;
  sh.getLastRow = () => sh.rows.length;
  sh.getLastColumn = () => sh.rows.reduce((m, r) => Math.max(m, r.length), 0);
  sh.setFrozenRows = () => sh;
  sh.deleteRow = (i) => { sh.rows.splice(i - 1, 1); };
  sh.getRange = (r, c, nr = 1, nc = 1) => {
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
  };
  return sh;
}

function makeSpreadsheet() {
  const sheets = {};
  return {
    sheets,
    getId: () => 'sheet-1',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/sheet-1',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n))
  };
}

function props() {
  const m = {};
  return { getProperty: (k) => (k in m ? m[k] : null), setProperty: (k, v) => { m[k] = String(v); }, _m: m };
}

function makeDrive() {
  let n = 0;
  const files = {}, folders = {};
  function folder(name) {
    const id = 'folder-' + ++n;
    const f = {
      id, name, children: {},
      getId: () => id, getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      getFoldersByName: (nm) => { const hit = Object.values(f.children).filter((c) => c.name === nm && c.children); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
      createFolder: (nm) => { const c = folder(nm); f.children[c.id] = c; return c; },
      createFile: (nm, content, mime) => {
        const fid = 'file-' + ++n;
        const file = { id: fid, name: nm, content, mime, getId: () => fid, getUrl: () => 'https://docs.google.com/file/' + fid,
          setContent: (c) => { file.content = c; }, getBlob: () => ({ getDataAsString: () => file.content }) };
        files[fid] = file; f.children[fid] = file; return file;
      }
    };
    folders[id] = f;
    return f;
  }
  const root = { top: {} };
  return {
    files, folders,
    createFolder: (nm) => { const f = folder(nm); root.top[f.id] = f; return f; },
    getFoldersByName: (nm) => { const hit = Object.values(root.top).filter((c) => c.name === nm); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
    getFolderById: (id) => folders[id],
    getFileById: (id) => files[id]
  };
}

function loadServer(opts = {}) {
  const ss = makeSpreadsheet();
  const script = props(), user = props();
  const drive = makeDrive();
  const mock = { weekday: null, logs: [] };
  const sandbox = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
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
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }); })(root);
  files.forEach((f) => vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: path.relative(root, f) }));
  // Run helpers in the sandbox so results keep their own realm
  const run = (code) => vm.runInContext(code, sandbox);
  return { sandbox, ss, script, user, drive, mock, run };
}

module.exports = { loadServer };
