/**
 * SPIKE, throwaway. One local HTTP server that plays two parts on the same origin:
 *   1. "GitHub Pages": serves spike/standalone/dist as static files.
 *   2. "Google": a tiny subset of the Sheets API v4, enough for the runtime:
 *        POST /v4/spreadsheets                          create (returns spreadsheetId, one "Sheet1" tab)
 *        GET  /v4/spreadsheets/:id                      tab list (sheets[].properties)
 *        GET  /v4/spreadsheets/:id/values:batchGet      ranges=<'Tab name'> ... (whole tabs only)
 *        POST /v4/spreadsheets/:id:batchUpdate          requests: addSheet, updateCells (stringValue), deleteDimension (ROWS)
 *      It refuses calls without "Authorization: Bearer ...". batchUpdate is all or nothing, like Google's.
 *   Test hooks: GET /__fake/state, POST /__fake/edit { id, tab, row, col, value } (another device's edit).
 * The real endpoints are on https://sheets.googleapis.com and take the same JSON; this fake was written from the
 * Sheets API reference and has NOT been compared against Google's answers.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function start(opts) {
  const dir = opts.dir;
  const books = opts.books || {}; // keep across restarts by passing the same object
  let n = Object.keys(books).length;
  const log = opts.log || [];

  function send(r, code, body) { r.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); r.end(JSON.stringify(body)); }
  function tabByTitle(b, t) { return b.sheets.find((s) => s.properties.title === t); }

  function batchUpdate(b, requests) {
    const copy = JSON.parse(JSON.stringify(b.sheets));
    const byId = (id) => { const s = copy.find((x) => x.properties.sheetId === id); if (!s) throw new Error('No sheet with id ' + id); return s; };
    for (const q of requests) {
      if (q.addSheet) {
        const p = q.addSheet.properties;
        if (copy.some((s) => s.properties.title === p.title)) throw new Error('A sheet with the name "' + p.title + '" already exists.');
        copy.push({ properties: { sheetId: p.sheetId, title: p.title, index: copy.length }, rows: [] });
      } else if (q.updateCells) {
        const u = q.updateCells, s = byId(u.start.sheetId);
        u.rows.forEach((row, i) => {
          const ri = u.start.rowIndex + i;
          while (s.rows.length <= ri) s.rows.push([]);
          row.values.forEach((v, j) => { s.rows[ri][u.start.columnIndex + j] = v.userEnteredValue.stringValue; });
        });
      } else if (q.deleteDimension) {
        const d = q.deleteDimension.range;
        byId(d.sheetId).rows.splice(d.startIndex, d.endIndex - d.startIndex);
      } else throw new Error('Unsupported request ' + Object.keys(q)[0]);
    }
    b.sheets = copy;
  }

  const srv = http.createServer((q, r) => {
    const url = new URL(q.url, 'http://x');
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => {
      try {
        if (url.pathname.startsWith('/__fake/')) {
          if (url.pathname === '/__fake/state') return send(r, 200, { books, log });
          if (url.pathname === '/__fake/edit') {
            const e = JSON.parse(body), s = tabByTitle(books[e.id], e.tab);
            s.rows[e.row][e.col] = e.value;
            return send(r, 200, { ok: true });
          }
        }
        if (url.pathname.startsWith('/v4/')) {
          if (!/^Bearer \S+/.test(q.headers.authorization || '')) return send(r, 401, { error: { code: 401, message: 'Request is missing required authentication credential.' } });
          log.push(q.method + ' ' + url.pathname);
          let m;
          if (q.method === 'POST' && url.pathname === '/v4/spreadsheets') {
            const id = 'fake-sheet-' + ++n;
            books[id] = { title: JSON.parse(body).properties.title, sheets: [{ properties: { sheetId: 0, title: 'Sheet1', index: 0 }, rows: [] }] };
            return send(r, 200, { spreadsheetId: id, properties: { title: books[id].title } });
          }
          if ((m = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(url.pathname)) && q.method === 'GET') {
            const b = books[m[1]]; if (!b) return send(r, 404, { error: { message: 'Requested entity was not found.' } });
            return send(r, 200, { spreadsheetId: m[1], properties: { title: b.title }, sheets: b.sheets.map((s) => ({ properties: s.properties })) });
          }
          if ((m = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/.exec(url.pathname))) {
            const b = books[m[1]];
            const ranges = url.searchParams.getAll('ranges').map((x) => x.replace(/^'|'$/g, '').replace(/''/g, "'"));
            return send(r, 200, { spreadsheetId: m[1], valueRanges: ranges.map((t) => {
              const s = tabByTitle(b, t);
              // Google leaves out trailing empty rows and cells; so does this fake.
              const rows = s.rows.map((row) => { const c = row.slice(); while (c.length && (c[c.length - 1] === '' || c[c.length - 1] == null)) c.pop(); return c.map((v) => (v == null ? '' : v)); });
              while (rows.length && !rows[rows.length - 1].length) rows.pop();
              return { range: "'" + t + "'", majorDimension: 'ROWS', values: rows.length ? rows : undefined };
            }) });
          }
          if ((m = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(url.pathname)) && q.method === 'POST') {
            const reqs = JSON.parse(body).requests;
            batchUpdate(books[m[1]], reqs);
            return send(r, 200, { spreadsheetId: m[1], replies: reqs.map(() => ({})) });
          }
          return send(r, 404, { error: { message: 'Not in the fake: ' + url.pathname } });
        }
        const file = path.join(dir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^\/+/, ''));
        if (!file.startsWith(dir) || !fs.existsSync(file)) { r.writeHead(404); r.end('not found'); return; }
        r.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        r.end(fs.readFileSync(file));
      } catch (e) { send(r, 400, { error: { code: 400, message: e.message } }); }
    });
  });
  return new Promise((resolve) => srv.listen(opts.port || 0, '127.0.0.1', () => resolve({
    books, log, url: 'http://127.0.0.1:' + srv.address().port + '/',
    close: () => new Promise((res) => { srv.closeAllConnections(); srv.close(res); })
  })));
}

module.exports = { start };
if (require.main === module) start({ dir: path.join(__dirname, 'dist'), port: Number(process.argv[2]) || 8765 }).then((s) => console.log('Serving', s.url));
