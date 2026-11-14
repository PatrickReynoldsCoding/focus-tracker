/**
 * Serves the real page over HTTP with google.script.run wired to the real server code (on in-memory fakes of Sheets,
 * Drive and Properties), so a real browser can click through the app. Used by tests/browser.test.js.
 * start({ latency }): every call waits `latency` ms first, like a slow Apps Script. server.latency can be changed later.
 * holdWhere(match): calls where match(name, args) is true wait until the returned release() is called (a call that hangs).
 * failWhere(match): calls where match(name, args) is true get an error reply (a save the server refuses).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadServer } = require('../mocks');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (n, e) => fs.readFileSync(path.join(SRC, n + e), 'utf8');

function renderIndex(ids) {
  let html = read('ui/index', '.html');
  html = html.replace(/<\? for[\s\S]*?\?>([\s\S]*?)<\? \} \?>/, (m, body) =>
    ids.map((id) => body.replace(/<\?!= include\('modules\/' \+ moduleIds\[i\] \+ '\/view'\) \?>/, () => read('modules/' + id + '/view', '.html'))).join('\n'));
  return html.replace(/<\?!= include\('([^']+)'\) \?>/g, (m, n) => read(n, '.html'));
}

const SHIM = `<script>
function rpcCall(name, args, ok, fail) {
  fetch('/rpc', { method: 'POST', body: JSON.stringify({ name: name, args: args }) }).then(function (r) { return r.json(); })
    .then(function (r) { if (r.error) fail({ message: 'Error: ' + r.error }); else ok(r.value); }, function (e) { fail({ message: 'Failed to fetch' }); });
}
window.google = { script: { run: { withSuccessHandler: function (ok) { return { withFailureHandler: function (fail) {
  return new Proxy({}, { get: function (_, name) { return function () { rpcCall(name, Array.prototype.slice.call(arguments), ok, fail); }; } });
} }; } } } };
</script>`;

exports.start = function (opts) {
  opts = opts || {};
  const fake = loadServer();
  fake.run('setup()'); fake.run('seedStarterData()'); fake.mock.weekday = 3;
  const ids = JSON.parse(JSON.stringify(fake.run('MODULES')));
  const page = renderIndex(ids).replace('<head>', '<head>' + SHIM);
  const holds = [], fails = [];
  const control = {
    latency: opts.latency || 0, calls: [],
    holdWhere(match) { const h = { match, waiting: [] }; holds.push(h); return () => { holds.splice(holds.indexOf(h), 1); h.waiting.splice(0).forEach((f) => f()); }; },
    failWhere(match) { const f = { match }; fails.push(f); return () => fails.splice(fails.indexOf(f), 1); }
  };
  const srv = http.createServer((q, r) => {
    if (q.method !== 'POST') { r.setHeader('content-type', 'text/html'); r.end(page); return; }
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const { name, args } = JSON.parse(b);
      control.calls.push({ name, args, at: Date.now() });
      const run = () => {
        r.setHeader('content-type', 'application/json');
        if (fails.some((f) => f.match(name, args))) { r.end(JSON.stringify({ error: 'The server refused that change.' })); return; }
        try { r.end(JSON.stringify({ value: JSON.parse(JSON.stringify(fake.run(name)(...args)) || 'null') })); } catch (e) { r.end(JSON.stringify({ error: e.message })); }
      };
      const go = () => setTimeout(run, control.latency);
      const hold = holds.find((h) => h.match(name, args));
      if (hold) hold.waiting.push(go); else go();
    });
  });
  return new Promise((resolve) => srv.listen(0, () => resolve(Object.assign(control, {
    server: fake, url: 'http://127.0.0.1:' + srv.address().port + '/', close: () => new Promise((res) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(res); })
  }))));
};
