/**
 * Typed text must never be lost. The real page (jsdom) over the real server code, reproducing the ways project notes went missing:
 * the page closed before the save timer fired, a save that failed in silence, a page left open on another device writing old
 * notes over newer ones, a late load replacing what was typed, a mode switch inside the timer, and the markdown converter
 * dropping text inside list items. Each step failed before the fix.
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

async function waitFor(fn, label, ms = 4000) {
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
  const rpc = (m, fn, args, mode) => json(server.run('rpc')(m, fn, json(args || {}), mode || null));
  const errors = [];
  // hold: { 'notes.get': promise } delays that call; fail: { 'notes.save': n } fails it n times with a server error.
  const net = { hold: {}, fail: {} };

  function page(storage = {}) {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://script.google.com/macros/s/test/exec',
      beforeParse(w) {
        Object.keys(storage).forEach((k) => w.localStorage.setItem(k, storage[k]));
        w.matchMedia = () => ({ matches: false, addEventListener() {} });
        w.scrollTo = () => {};
        w.addEventListener('error', (e) => errors.push(e.message));
        const call = (name, args, ok, fail) => setTimeout(async () => {
          if (!w.document) return;
          const key = name === 'rpc' ? args[0] + '.' + args[1] : name;
          if (net.hold[key]) await net.hold[key];
          if (!w.document) return;
          if (net.fail[key]) { net.fail[key]--; fail({ message: 'We\'re sorry, a server error occurred. Please wait a bit and try again.' }); return; }
          try { ok(json(server.run(name)(...args.map(json)))); } catch (e) { fail({ message: 'Error: ' + e.message }); }
        }, 0);
        w.google = { script: { run: { withSuccessHandler(ok) { return { withFailureHandler(fail) {
          return new Proxy({}, { get: (_, name) => (...args) => call(name, args, ok, fail) });
        } }; } } } };
      }
    });
    const w = dom.window, d = w.document;
    return {
      w, d,
      $: (sel) => d.querySelector(sel),
      $$: (sel) => Array.from(d.querySelectorAll(sel)),
      click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
      storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
      close: () => w.close()
    };
  }

  let passed = 0;
  async function step(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

  const projectId = rpc('projects', 'create', { name: 'Saving tests', category: 'coding' }).result.id;
  const otherId = rpc('projects', 'create', { name: 'Saving other', category: 'house' }).result.id;
  const serverNotes = (id, mode) => rpc('notes', 'get', { projectId: id || projectId }, mode).result.text;
  const conflictCopies = () => Object.values(server.drive.files).filter((f) => /-conflict-/.test(f.name || ''));

  async function openProject(p, id) {
    await waitFor(() => p.w.FT.ready && p.$('#app'), 'app');
    p.w.FT.go('project', { id: id || projectId });
    await waitFor(() => p.$('#nt-text') && p.$('#nt-text').getAttribute('contenteditable') === 'true', 'notes editable');
  }
  /** Type into the notes like a person would: the content changes and an input event fires. No focusout. */
  function type(p, html) {
    const el = p.$('#nt-text');
    el.innerHTML = html;
    el.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  }

  await step('text inside list items survives the markdown conversion (headings, paragraphs, wrappers)', async () => {
    const p = page();
    await waitFor(() => p.w.FT.ready, 'ready');
    const md = (h) => { const div = p.d.createElement('div'); div.innerHTML = h; return p.w.FT.htmlToMd(div); };
    assert.strictEqual(md('<ul><li><h2>Plan</h2></li><li><p>Buy paint</p></li></ul>'), '- Plan\n- Buy paint');
    assert.strictEqual(md('<ol><li><div>One</div><div>more</div></li></ol>'), '1. One more');
    assert.strictEqual(md('<div><span><div>wrapped</div></span></div>'), 'wrapped');
    assert.strictEqual(md('<blockquote><ul><li><p>quoted item</p></li></ul></blockquote>'), '> - quoted item');
    p.close();
  });

  await step('closing the page within the save delay loses nothing: the draft is kept on the device and saved on the next visit', async () => {
    let p = page();
    await openProject(p);
    type(p, '<p>Typed then closed at once</p>');
    const saved = p.storage();
    p.close(); // before the 1.2 s timer, with no focusout
    assert.strictEqual(serverNotes(), '', 'nothing reached the server before the close');
    p = page(saved);
    await openProject(p);
    await waitFor(() => serverNotes() === 'Typed then closed at once', 'the draft was saved on the next visit');
    assert.ok(p.$('#nt-text').textContent.includes('Typed then closed at once'), 'and is in the editor');
    await waitFor(() => !Object.keys(p.storage()).some((k) => k.indexOf('ft.draft.') === 0), 'the draft is cleared once saved');
    p.close();
  });

  await step('hiding the page (switching app, locking the phone) saves straight away', async () => {
    const p = page();
    await openProject(p);
    type(p, '<p>Saved on hide</p>');
    Object.defineProperty(p.d, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(p.d, 'hidden', { value: true, configurable: true });
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    await sleep(300); // well inside the 1.2 s timer
    assert.strictEqual(serverNotes(), 'Saved on hide');
    p.close();
  });

  await step('a failed save is shown, not silent, and is tried again', async () => {
    const p = page();
    await openProject(p);
    net.fail['notes.save'] = 1;
    type(p, '<p>Survives a server error</p>');
    p.$('#nt-text').dispatchEvent(new p.w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => /not saved/i.test(p.$('#toast').textContent), 'an error message the user can see');
    await waitFor(() => serverNotes() === 'Survives a server error', 'saved by the retry', 9000);
    await waitFor(() => p.$('#nt-status').textContent === 'Saved', 'and says so');
    p.close();
  });

  await step('a page left open elsewhere does not write old notes over newer ones', async () => {
    const stale = page();
    await openProject(stale); // holds "Survives a server error"
    const fresh = page();
    await openProject(fresh);
    type(fresh, '<p>Newer notes from the phone</p>');
    fresh.$('#nt-text').dispatchEvent(new fresh.w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => serverNotes() === 'Newer notes from the phone', 'the phone saved');
    fresh.close();
    const before = conflictCopies().length;
    type(stale, '<p>Survives a server error</p><p>typed on the old laptop tab</p>');
    stale.$('#nt-text').dispatchEvent(new stale.w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => conflictCopies().length === before + 1, 'the other text is kept as a conflict copy');
    const texts = [serverNotes()].concat(conflictCopies().slice(before).map((f) => f.content));
    assert.ok(texts.some((t) => t === 'Newer notes from the phone'), 'the phone\'s notes still exist');
    assert.ok(texts.some((t) => /typed on the old laptop tab/.test(t)), 'and so does the laptop\'s');
    await waitFor(() => /another device/i.test(stale.$('#toast').textContent), 'the user is told');
    stale.close();
  });

  await step('a page that never had these notes does not replace the whole file', async () => {
    const id = rpc('projects', 'create', { name: 'Saving fresh copy', category: 'coding' }).result.id;
    const p = page();
    await waitFor(() => p.w.FT.ready, 'ready'); // its data has no notes row for the new project
    rpc('notes', 'save', { projectId: id, text: 'Written on another device' });
    p.w.FT.go('project', { id: id });
    await waitFor(() => p.$('#nt-text') && p.$('#nt-text').getAttribute('contenteditable') === 'true', 'editable');
    await waitFor(() => p.$('#nt-text').textContent.includes('Written on another device'), 'the existing notes are loaded first');
    p.close();
  });

  await step('a late load does not replace text typed meanwhile', async () => {
    const p = page();
    await openProject(p);
    p.w.FT.go('project', { id: otherId });
    await waitFor(() => p.$('#nt-text'), 'other project');
    rpc('notes', 'save', { projectId, text: 'Changed on the server' });
    let release; net.hold['notes.get'] = new Promise((r) => { release = r; });
    await p.w.FT.reload(); // fresh data says the notes changed, so the page loads them again when the project opens
    p.w.FT.go('project', { id: projectId });
    await waitFor(() => p.$('#nt-text'), 'project again');
    type(p, '<p>Typed while the load was slow</p>');
    delete net.hold['notes.get']; release();
    await sleep(100);
    assert.ok(p.$('#nt-text').textContent.includes('Typed while the load was slow'), 'the typed text stays on screen');
    p.$('#nt-text').dispatchEvent(new p.w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => serverNotes() === 'Typed while the load was slow' || conflictCopies().some((f) => f.content === 'Typed while the load was slow'), 'and is saved');
    p.close();
  });

  await step('switching mode inside the save delay saves into the mode the notes belong to', async () => {
    const p = page();
    await openProject(p);
    type(p, '<p>Before the mode switch</p>');
    p.w.FT.switchMode('work');
    await waitFor(() => serverNotes() === 'Before the mode switch', 'saved in Personal', 4000);
    p.close();
  });

  await step('a sticky note keeps what was typed when the reply to an earlier save arrives with older text', async () => {
    const p = page();
    await openProject(p);
    p.click(p.$('[data-act="stickies.add"]'));
    await waitFor(() => p.$('.sticky textarea'), 'a sticky note');
    const id = p.$('.sticky').dataset.sticky;
    const area = () => p.$('.sticky[data-sticky="' + id + '"] textarea');
    const typeSticky = (t) => { area().value = t; area().dispatchEvent(new p.w.Event('input', { bubbles: true })); };
    let release; net.hold['stickies.update'] = new Promise((r) => { release = r; });
    typeSticky('one');
    await sleep(900); // its save is on the way, held
    typeSticky('one two'); // the next save waits for its delay
    delete net.hold['stickies.update']; release();
    await sleep(100);
    p.w.FT.render();
    assert.strictEqual(area().value, 'one two', 'the redraw kept the newer text');
    await waitFor(() => p.w.FT.pendingSaves() === 0 && json(server.run('bootstrap()').data).stickies.some((s) => s.id === id && s.text === 'one two'), 'and it was saved');
    p.close();
  });

  await step('a card dialog with changes asks before a tap outside throws them away', async () => {
    const p = page();
    await openProject(p);
    const input = p.$$('.col .coladd input')[0];
    input.value = 'Dialog card';
    input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => p.$$('.kcard').some((c) => c.textContent.includes('Dialog card')), 'card');
    p.click(p.$$('[data-act="kanban.open-card"]').find((c) => c.textContent.includes('Dialog card')));
    await waitFor(() => p.$('#dlg-note'), 'dialog');
    p.click(p.$('#dlg-scrim'));
    assert.ok(!p.$('.dialog'), 'with no changes a tap outside just closes');
    p.click(p.$$('[data-act="kanban.open-card"]').find((c) => c.textContent.includes('Dialog card')));
    await waitFor(() => p.$('#dlg-note'), 'dialog again');
    p.$('#dlg-note').innerHTML = 'Important detail';
    p.click(p.$('#dlg-scrim'));
    assert.ok(p.$('.dialog') && /unsaved changes/.test(p.$('#dlg-err').textContent), 'it warns instead of closing');
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!p.$('.dialog'), 'a second try discards');
    p.close();
  });

  await step('no script errors', async () => {
    assert.deepStrictEqual(errors, []);
  });

  console.log(passed + ' saving checks passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL\n' + (e.stack || e)); process.exit(1); });
