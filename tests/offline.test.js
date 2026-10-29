/**
 * The saved copy and the offline queue, in the real page (jsdom) over the real server code. jsdom has no IndexedDB, so this
 * exercises the localStorage fallback, which is also what runs when IndexedDB is unavailable in a real browser.
 * "net" stands for the connection to Google: net.down makes every call fail like a lost connection, net.hold delays bootstrap.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadServer } = require('./mocks');

const SRC = path.join(__dirname, '..', 'src');
const read = (name, ext) => fs.readFileSync(path.join(SRC, name + ext), 'utf8');
const json = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderIndex(moduleIds) {
  let html = read('ui/index', '.html');
  html = html.replace(/<\? for[\s\S]*?\?>([\s\S]*?)<\? \} \?>/, (m, body) =>
    moduleIds.map((id) => body.replace(/<\?!= include\('modules\/' \+ moduleIds\[i\] \+ '\/view'\) \?>/, () => read('modules/' + id + '/view', '.html'))).join('\n'));
  return html.replace(/<\?!= include\('([^']+)'\) \?>/g, (m, n) => read(n, '.html'));
}

async function waitFor(fn, label, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for: ' + label);
    await sleep(15);
  }
}

(async () => {
  const server = loadServer();
  server.run('setup()');
  server.run('seedStarterData()');
  server.mock.weekday = 3;
  const modules = json(server.run('MODULES'));
  const html = renderIndex(modules);
  const rpc = (m, fn, args) => json(server.run('rpc')(m, fn, json(args || {}), null));
  const data = () => json(server.run('bootstrap()').data);
  const net = { down: false, hold: null };
  const errors = [];
  const open = [];

  /** A page load. storage: what this device already had in localStorage (a reload keeps it; another device has none). */
  function page(storage = {}, opts = {}) {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://script.google.com/macros/s/test/exec',
      beforeParse(w) {
        if (opts.blockedStorage) Object.defineProperty(w, 'localStorage', { get() { throw new Error('storage is blocked'); } });
        else Object.keys(storage).forEach((k) => w.localStorage.setItem(k, storage[k]));
        w.matchMedia = () => ({ matches: false, addEventListener() {} });
        w.scrollTo = () => {};
        w.addEventListener('error', (e) => errors.push(e.message));
        const call = (name, args, ok, fail) => setTimeout(async () => {
          if (!w.document) return; // the page was closed (a reload) before this call ran
          if (net.down) { fail({ message: 'NetworkError: Failed to fetch' }); return; }
          if (name === 'bootstrap' && net.hold) await net.hold;
          if (!w.document) return;
          if (net.down) { fail({ message: 'NetworkError: Failed to fetch' }); return; }
          try { ok(json(server.run(name)(...args.map(json)))); } catch (e) { fail({ message: 'Error: ' + e.message }); }
        }, 0);
        w.google = { script: { run: { withSuccessHandler(ok) { return { withFailureHandler(fail) {
          return new Proxy({}, { get: (_, name) => (...args) => call(name, args, ok, fail) });
        } }; } } } };
      }
    });
    open.push(dom);
    const w = dom.window, d = w.document;
    return {
      w, d, dom,
      $: (sel) => d.querySelector(sel),
      $$: (sel) => Array.from(d.querySelectorAll(sel)),
      click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
      storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
      close: () => w.close()
    };
  }

  let passed = 0;
  async function step(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }
  const tabOf = (p, name) => p.$$('.tab').find((t) => t.textContent === name);
  const status = (p) => p.$('#offstat').textContent;

  // Page 1: a first visit. It opens a project, which is saved as the page this device was on.
  let p1 = page();
  let projectId, projectName;
  await step('a first visit shows Today, and the page you move to is remembered for this device', async () => {
    await waitFor(() => p1.$('.focus-name'), 'today');
    assert.strictEqual(p1.w.FT.state.view, 'today');
    p1.click(tabOf(p1, 'Projects'));
    await waitFor(() => p1.$$('tr.row').length, 'projects');
    p1.click(p1.$$('tr.row')[2]);
    await waitFor(() => p1.$('.phead'), 'project page');
    projectId = p1.w.FT.state.projectId;
    projectName = p1.$('.phead h2').textContent;
    assert.deepStrictEqual(JSON.parse(p1.w.localStorage.getItem('ft.last.personal')), { view: 'project', projectId });
    assert.ok(p1.w.localStorage.getItem('ft.kv.snap:personal'), 'a saved copy of the data is kept for the mode');
  });

  await step('reloading on the same device returns to that project, not to Today', async () => {
    const saved = p1.storage();
    p1.close();
    const p2 = page(saved);
    await waitFor(() => p2.$('.phead') && p2.w.FT.state.view === 'project', 'project page after reload');
    assert.strictEqual(p2.$('.phead h2').textContent, projectName);
    await waitFor(() => status(p2) === '', 'fresh data arrived');
    assert.strictEqual(p2.w.FT.state.projectId, projectId, 'still on the project after the fresh data replaced the copy');
    // Another device has its own memory: nothing stored there, so it starts on Today
    const other = page();
    await waitFor(() => other.$('.focus-name'), 'today on another device');
    assert.strictEqual(other.w.FT.state.view, 'today');
    p2.close(); other.close();
    p1 = page(saved);
    await waitFor(() => p1.$('.phead'), 'back on the project');
  });

  await step('a remembered project that is gone, or locked, falls back to Today', async () => {
    const saved = p1.storage();
    p1.close();
    // Locked since the last visit: the saved copy still shows the project for a moment, then Today
    net.hold = new Promise((r) => { net.release = r; });
    rpc('projects', 'setLock', { id: projectId, until: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
    const p2 = page(saved);
    await waitFor(() => p2.$('.phead'), 'the saved copy is shown while loading');
    net.hold = null; net.release();
    await waitFor(() => p2.$('.focus-name') && p2.w.FT.state.view === 'today', 'today once the fresh data says it is locked');
    p2.close();
    rpc('projects', 'setLock', { id: projectId, until: '', early: true });
    // Deleted since the last visit
    rpc('projects', 'remove', { id: projectId });
    const p3 = page(saved);
    await waitFor(() => p3.$('.focus-name') && p3.w.FT.state.view === 'today', 'today for a deleted project');
    p3.close();
    // A fresh project for the rest of the tests
    projectId = rpc('projects', 'create', { name: 'Offline tests', category: 'coding' }).result.id;
  });

  await step('the saved copy shows at once with "Updating…", then the fresh data replaces it', async () => {
    const warm = page();
    await waitFor(() => warm.$('.focus-name'), 'warm up');
    const saved = warm.storage(); warm.close();
    rpc('projects', 'update', { id: projectId, next_action: 'Changed on the server since' });
    net.hold = new Promise((r) => { net.release = r; });
    const p = page(saved);
    await waitFor(() => p.w.FT.ready && p.$('.focus-name'), 'the saved copy is drawn before Google answers');
    assert.strictEqual(status(p), 'Updating…');
    assert.ok(!p.w.FT.store.projects.some((x) => x.next_action === 'Changed on the server since'), 'it is the older copy');
    net.hold = null; net.release();
    await waitFor(() => p.w.FT.store.projects.some((x) => x.next_action === 'Changed on the server since') && status(p) === '', 'fresh data replaces it');
    p.close();
  });

  await step('a saved copy from another version is ignored, and storage that is blocked does not stop the app', async () => {
    const warm = page();
    await waitFor(() => warm.$('.focus-name'), 'warm up');
    const saved = warm.storage(); warm.close();
    const snap = JSON.parse(saved['ft.kv.snap:personal']);
    snap.v = 999;
    saved['ft.kv.snap:personal'] = JSON.stringify(snap);
    net.hold = new Promise((r) => { net.release = r; });
    const p = page(saved);
    await sleep(60);
    assert.strictEqual(p.w.FT.ready, false, 'nothing is drawn from a copy with a different version');
    net.hold = null; net.release();
    await waitFor(() => p.$('.focus-name'), 'loads normally');
    await waitFor(() => JSON.parse(p.w.localStorage.getItem('ft.kv.snap:personal')).v === 2, 'and writes a fresh copy');
    p.close();
    const blocked = page({}, { blockedStorage: true });
    await waitFor(() => blocked.$('.focus-name'), 'loads with storage blocked');
    blocked.click(tabOf(blocked, 'Projects'));
    await waitFor(() => blocked.$$('tr.row').length, 'and works');
    blocked.close();
  });

  // The offline tests: a page on the new project, with the connection then cut.
  const open2 = async (storage) => {
    const p = page(storage);
    await waitFor(() => p.$('.focus-name'), 'today');
    p.click(tabOf(p, 'Projects'));
    await waitFor(() => p.$$('tr.row').length, 'projects');
    p.click(p.$$('tr.row').find((r) => r.textContent.includes('Offline tests')));
    await waitFor(() => p.$('.board'), 'project board');
    return p;
  };
  const addCard = (p, title) => {
    const input = p.$$('.col .coladd input')[0];
    input.value = title;
    input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const serverTitles = () => data().kanban.tasks.map((t) => t.title);
  let p;

  await step('with no connection, cards are kept on this device, shown as waiting, and sent in order when it returns', async () => {
    p = await open2();
    net.down = true;
    addCard(p, 'Offline A');
    await waitFor(() => p.$('.col').textContent.includes('Offline A'), 'shown at once');
    addCard(p, 'Offline B');
    await waitFor(() => p.w.FT.offline.waiting() === 2, 'two changes waiting');
    assert.ok(/^Offline · 2 waiting$/.test(status(p)), status(p));
    assert.ok(!serverTitles().includes('Offline A'), 'the server has not seen them');
    assert.strictEqual(JSON.parse(p.w.localStorage.getItem('ft.kv.queue:personal')).list.length, 2, 'the queue is kept on the device');
    net.down = false;
    await p.w.FT.offline.retryNow();
    await waitFor(() => serverTitles().includes('Offline A') && serverTitles().includes('Offline B'), 'sent');
    const titles = data().kanban.tasks.filter((t) => /^Offline [AB]$/.test(t.title)).sort((a, b) => a.order - b.order).map((t) => t.title);
    assert.deepStrictEqual(titles, ['Offline A', 'Offline B'], 'in the order they were made');
    await waitFor(() => p.w.FT.offline.waiting() === 0 && status(p) === '', 'queue cleared');
    assert.ok(/Back online: 2 changes saved/.test(p.$('#toast').textContent), p.$('#toast').textContent);
    assert.ok(p.$('.col').textContent.includes('Offline A'), 'still on screen after the server state was loaded');
  });

  await step('changes waiting survive a reload and are sent when the page opens again', async () => {
    net.down = true;
    addCard(p, 'Kept across reload');
    await waitFor(() => p.w.FT.offline.waiting() === 1, 'waiting');
    const saved = p.storage();
    p.close();
    net.down = false;
    const p2 = page(saved);
    await waitFor(() => serverTitles().includes('Kept across reload'), 'sent after the reload');
    await waitFor(() => p2.w.FT.offline.waiting() === 0, 'queue cleared');
    p2.close();
    p = await open2();
  });

  await step('a server refusal is not queued: the error is shown and the queue stays empty', async () => {
    const err = await p.w.FT.rpc('projects', 'update', { id: projectId, name: '   ' }, { quiet: true }).then(() => null, (e) => e);
    assert.ok(/needs a name/.test(err.message), err && err.message);
    assert.strictEqual(p.w.FT.offline.waiting(), 0);
    assert.ok(!p.w.FT.offline.isDown(), 'and the server answered, so we are not offline');
  });

  await step('a change that needs the server is refused plainly while offline, not queued', async () => {
    net.down = true;
    const err = await p.w.FT.rpc('today', 'start', { projectId }, { quiet: true }).then(() => null, (e) => e);
    assert.ok(/offline/i.test(err.message), err && err.message);
    assert.strictEqual(p.w.FT.offline.waiting(), 0);
    // A project edit is kept, and shows on the page at once
    await p.w.FT.rpc('projects', 'update', { id: projectId, next_action: 'Typed offline' }, { quiet: true });
    assert.strictEqual(p.w.FT.offline.waiting(), 1);
    assert.strictEqual(p.w.FT.project(projectId).next_action, 'Typed offline');
    net.down = false;
    await p.w.FT.offline.retryNow();
    await waitFor(() => data().projects.find((x) => x.id === projectId).next_action === 'Typed offline', 'saved');
    await waitFor(() => p.w.FT.offline.waiting() === 0, 'queue cleared');
  });

  await step('an offline edit that finds the row changed elsewhere keeps the newest version and logs the other', async () => {
    const task = data().kanban.tasks.find((t) => t.title === 'Offline A');
    net.down = true;
    p.w.FT.store.kanban.tasks.find((t) => t.id === task.id).title = 'Mine, offline';
    await p.w.FT.rpc('kanban', 'updateTask', { id: task.id, title: 'Mine, offline' }, { render: false, quiet: true });
    assert.strictEqual(p.w.FT.offline.waiting(), 1);
    // Another device edits the same card later
    server.run(`new Table('Tasks',['id']).update('${task.id}', { title: 'Theirs', updated_at: '${new Date(Date.now() + 60000).toISOString()}' })`);
    net.down = false;
    await p.w.FT.offline.retryNow();
    await waitFor(() => p.w.FT.offline.waiting() === 0, 'queue cleared');
    assert.strictEqual(data().kanban.tasks.find((t) => t.id === task.id).title, 'Theirs', 'the newer stored version stays');
    assert.ok(data().log.some((l) => /newer version was kept/.test(l.where_stopped) && /Mine, offline/.test(l.where_stopped)), 'your version is kept in the Log');
    await waitFor(() => /clashed with newer edits/.test(p.$('#toast').textContent), 'and you are told');
    await waitFor(() => p.w.FT.store.kanban.tasks.find((t) => t.id === task.id).title === 'Theirs', 'the screen shows the stored version');
  });

  await step('the page never threw while any of this happened', async () => {
    open.forEach((dom) => { try { dom.window.close(); } catch (e) {} });
    assert.deepStrictEqual(errors, []);
  });

  console.log('\n' + passed + ' offline and cache steps passed');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FAIL\n' + (e.stack || e)); process.exit(1); });
