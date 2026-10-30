/** Loads the real page in jsdom, wires google.script.run to the real server code (with mocked Google services), and clicks through it. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadServer } = require('./mocks');

const SRC = path.join(__dirname, '..', 'src');
const read = (name, ext) => fs.readFileSync(path.join(SRC, name + ext), 'utf8');

function renderIndex(moduleIds) {
  let html = read('ui/index', '.html');
  html = html.replace(/<\? for[\s\S]*?\?>([\s\S]*?)<\? \} \?>/, (m, body) =>
    moduleIds.map((id) => body.replace(/<\?!= include\('modules\/' \+ moduleIds\[i\] \+ '\/view'\) \?>/, () => read('modules/' + id + '/view', '.html'))).join('\n'));
  html = html.replace(/<\?!= include\('([^']+)'\) \?>/g, (m, n) => read(n, '.html'));
  return html;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const modules = JSON.parse(JSON.stringify(server.run('MODULES')));

  const errors = [];
  const dom = new JSDOM(renderIndex(modules), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://script.google.com/macros/s/test/exec',
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.scrollTo = () => {};
      // jsdom does not load SortableJS from the CDN. This stand-in keeps each list's options, so a test can play the end of a drag.
      w.__sortables = [];
      w.Sortable = { create(el, opts) { const s = { el, opts, destroy() { w.__sortables.splice(w.__sortables.indexOf(s), 1); } }; w.__sortables.push(s); return s; } };
      w.addEventListener('error', (e) => errors.push(e.message));
      const call = (name, args, ok, fail) => setTimeout(() => {
        try { ok(JSON.parse(JSON.stringify(server.run(name)(...args.map((a) => JSON.parse(JSON.stringify(a))))))); }
        catch (e) { fail({ message: 'Error: ' + e.message }); }
      }, 0);
      w.google = { script: { run: {
        withSuccessHandler(ok) { return { withFailureHandler(fail) {
          return new Proxy({}, { get: (_, name) => (...args) => call(name, args, ok, fail) });
        } }; }
      } } };
    }
  });
  const w = dom.window, d = w.document;
  const $ = (sel) => d.querySelector(sel), $$ = (sel) => Array.from(d.querySelectorAll(sel));
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const setVal = (el, v, type = 'input') => { el.value = v; el.dispatchEvent(new w.Event(type, { bubbles: true })); };
  const tab = (name) => $$('.tab').find((t) => t.textContent === name);
  const subtab = (name) => $$('.subtab').find((t) => t.textContent === name);

  let passed = 0;
  async function step(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

  await step('loads and shows tabs and today\'s focus', async () => {
    await waitFor(() => $('.focus-name'), 'focus name');
    assert.deepStrictEqual($$('.tab').map((t) => t.textContent), ['Today', 'Projects', 'Lists', 'Whiteboards', 'Insights']);
    assert.strictEqual($('.focus-name').textContent, 'CV and portfolio', 'Wednesday leads with job, longest untouched first');
    assert.ok($('.timer') === null);
  });

  await step('full-width icon stretches the page and is remembered', async () => {
    assert.ok(!d.body.classList.contains('wide'));
    click($('#wideBtn'));
    assert.ok(d.body.classList.contains('wide'));
    assert.strictEqual($('#wideBtn').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(w.localStorage.getItem('ft.wide'), '1');
    click($('#wideBtn'));
    assert.ok(!d.body.classList.contains('wide'));
    assert.strictEqual(w.localStorage.getItem('ft.wide'), '0');
  });

  await step('projects tab lists every project, and no empty shared resource panels', async () => {
    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length === 7, '7 rows');
    assert.strictEqual($$('.cats .panel').length, 0, 'no category has shared resources yet');
    assert.strictEqual($$('[data-act="resources.add"][data-shared]').length, 1, 'one add control instead');
  });

  await step('a shared resource added from the Projects tab shows its category panel', async () => {
    click($('[data-act="resources.add"][data-shared]'));
    await waitFor(() => $('.dialog #dlg-category'), 'dialog with a category choice');
    const cat = w.FT.categories()[1];
    setVal($('#dlg-category'), cat.id, 'change');
    setVal($('#dlg-title'), 'Council'); setVal($('#dlg-type'), 'phone', 'change');
    assert.strictEqual($('#dlg-value').type, 'tel', 'a phone number gets the phone keyboard');
    setVal($('#dlg-value'), '0161 496 0000');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'closes at once', 200);
    assert.deepStrictEqual($$('.cats .panel .label').map((l) => l.textContent), ['Resources: ' + cat.label], 'only that category has a panel');
    assert.strictEqual($('.cats .reslist a[href^="tel:"]').getAttribute('href'), 'tel:01614960000');
    const onServer = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.resources)).find((r) => r.title === 'Council');
    await waitFor(() => onServer(), 'saved');
    assert.strictEqual(onServer().category, cat.id);
    assert.strictEqual(onServer().project_id, '');
    click($('.cats [data-act="resources.remove"]'));
    await waitFor(() => !onServer() && $$('.cats .panel').length === 0, 'removed, and the panel goes with it');
  });

  // The status filter: open its list, then tick or untick a status.
  const pickStatus = (status, on) => {
    if (!$('#pj-status-pop')) click($('#pj-status'));
    const box = $(`#pj-status-pop input[value="${status}"]`);
    if (box.checked !== on) { box.checked = on; box.dispatchEvent(new w.Event('change', { bubbles: true })); }
  };
  const projectNames = () => $$('tr.row').map((r) => r.querySelector('b').textContent);

  await step('projects table sorts by column and filters by category, status and text', async () => {
    const names = projectNames;
    const sortBy = (key) => click($(`[data-act="projects.sort"][data-key="${key}"]`));
    sortBy('name');
    assert.deepStrictEqual(names(), names().slice().sort((a, b) => a.localeCompare(b)));
    sortBy('name');
    assert.deepStrictEqual(names(), names().slice().sort((a, b) => b.localeCompare(a)));
    assert.ok($('th[aria-sort="descending"]').textContent.startsWith('Project'));
    sortBy('name');
    assert.strictEqual($$('th[aria-sort="none"]').length, 5, 'third click goes back to the default order');

    setVal($('#pj-category'), 'house', 'change');
    assert.deepStrictEqual(names().sort(), ['Bathroom extractor fan', 'Garden fence repair']);
    pickStatus('paused', true);
    assert.deepStrictEqual(names(), ['Garden fence repair']);
    pickStatus('paused', false);
    $('#pj-text').focus();
    setVal($('#pj-text'), 'duct');
    assert.deepStrictEqual(names(), ['Bathroom extractor fan'], 'text matches the next action too');
    assert.strictEqual(d.activeElement.id, 'pj-text', 'search box keeps focus while typing');
    setVal($('#pj-text'), 'nothing like this');
    assert.ok($('.panel .empty').textContent.includes('No projects match'));
    click($('[data-act="projects.clear"]'));
    assert.strictEqual($$('tr.row').length, 7);
  });

  await step('the status filter takes several statuses, stays open while ticking, and is remembered', async () => {
    const all = projectNames().length, statusOf = () => $$('tr.row').map((r) => r.children[2].textContent);
    assert.strictEqual($('#pj-status').textContent.replace('▾', ''), 'All statuses');
    assert.strictEqual($('#pj-status-pop'), null, 'closed at first');
    click($('#pj-status'));
    assert.strictEqual($('#pj-status').getAttribute('aria-expanded'), 'true');
    assert.strictEqual(d.activeElement, $('#pj-status-pop input'), 'focus goes to the first box');
    pickStatus('paused', true);
    assert.ok($('#pj-status-pop'), 'still open after a tick');
    assert.strictEqual(d.activeElement, $('#pj-status-pop input[value="paused"]'), 'and focus stays on that box');
    assert.deepStrictEqual([...new Set(statusOf())], ['paused']);
    pickStatus('active', true);
    assert.deepStrictEqual([...new Set(statusOf())].sort(), ['active', 'paused']);
    assert.ok(projectNames().length > 1 && projectNames().length <= all);
    assert.strictEqual($('#pj-status').textContent.replace('▾', ''), 'active, paused');
    assert.strictEqual(w.localStorage.getItem('ft.projects.status.personal'), '["active","paused"]', 'remembered for this mode');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual($('#pj-status-pop'), null, 'Escape closes it');
    assert.strictEqual(d.activeElement, $('#pj-status'), 'and puts focus back on the button');
    click($('#pj-status'));
    click($('.tophead .label'));
    assert.strictEqual($('#pj-status-pop'), null, 'a click elsewhere closes it');
    assert.ok(!$('[data-act="projects.clear"]').disabled);
    click($('[data-act="projects.clear"]'));
    assert.strictEqual(projectNames().length, all);
    assert.strictEqual(w.localStorage.getItem('ft.projects.status.personal'), null, 'Clear forgets it');
  });

  await step('opening a project shows header, kanban, notes and resources', async () => {
    click($$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan')));
    await waitFor(() => $('.board'), 'board');
    assert.strictEqual($$('.colname').map((i) => i.value).join('|'), 'To do|Doing|Done');
    assert.strictEqual($$('.kcard').length, 3);
    await waitFor(() => $('#nt-text') && $('#nt-text').getAttribute('contenteditable') === 'true' && $('#nt-text').textContent.includes('100mm'), 'notes loaded');
    assert.ok($$('.lcell .label').some((l) => l.textContent === 'Resources: this project'));
    assert.ok(!$('#nt-link').hidden);
    assert.ok($$('.lcell .label').some((l) => l.textContent === 'Whiteboards'), 'whiteboards panel');
    assert.strictEqual($('[data-act="whiteboard.new"]').textContent, '+ New whiteboard');
  });

  await step('each column has its own add-task control', async () => {
    assert.strictEqual($('#kb-new'), null, 'the single new-task bar is gone');
    assert.strictEqual($$('.col .coladd input').length, 3);
    setVal($$('.col .coladd input')[0], 'Buy duct tape');
    click($$('.col')[0].querySelector('[data-act="kanban.add-task"]'));
    await waitFor(() => $$('.kcard').length === 4, 'new card');
    assert.ok($$('.col')[0].textContent.includes('Buy duct tape'));
    const doneInput = $$('.col .coladd input')[2];
    setVal(doneInput, 'Old fan in the bin');
    doneInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => $$('.kcard').length === 5, 'card added with Enter');
    assert.ok($$('.col')[2].textContent.includes('Old fan in the bin'));
    assert.ok(!$$('.col')[0].textContent.includes('Old fan in the bin'));
  });

  await step('moving a card (from its dialog) updates the screen immediately and the sheet afterwards', async () => {
    assert.strictEqual($$('.kcard [data-d]').length, 0, 'no move arrows: cards are dragged');
    const card = $$('.kcard').find((c) => c.textContent.includes('Buy duct tape'));
    click(card.querySelector('[data-act="kanban.open-card"]'));
    await waitFor(() => $('#dlg-cardcolumn'), 'card dialog');
    setVal($('#dlg-cardcolumn'), $('#dlg-cardcolumn').options[1].value, 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $$('.col')[1].textContent.includes('Buy duct tape'), 'shown at once', 200);
    const serverTask = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.kanban)).tasks.find((t) => t.title === 'Buy duct tape');
    const cols = JSON.parse(JSON.stringify(server.run('bootstrap()').data.kanban.columns)).filter((c) => c.project_id === serverTask().project_id).sort((a, b) => a.order - b.order);
    await waitFor(() => serverTask().column_id === cols[1].id, 'saved');
  });

  await step('a new card shows at once, and a second Enter while saving cannot add it twice', async () => {
    const input = $$('.col .coladd input')[1];
    setVal(input, 'Check the fuse');
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok($$('.col')[1].textContent.includes('Check the fuse'), 'shown before the server answers');
    const again = $$('.col .coladd input')[1];
    assert.strictEqual(again.value, '', 'the box is cleared');
    again.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(100);
    const copies = JSON.parse(JSON.stringify(server.run('bootstrap()').data.kanban.tasks)).filter((t) => t.title === 'Check the fuse');
    assert.strictEqual(copies.length, 1);
  });

  await step('deleting a card is immediate and Undo brings it back', async () => {
    const card = $$('.kcard').find((c) => c.textContent.includes('Check the fuse'));
    click(card.querySelector('[data-act="kanban.del-task"]'));
    assert.ok(!$$('.kcard').some((c) => c.textContent.includes('Check the fuse')), 'gone at once');
    await waitFor(() => !$('#toast').hidden && $('#toast').textContent.includes('Card deleted'), 'undo message');
    click($('#toast .toastbtn'));
    await waitFor(() => $$('.kcard').some((c) => c.textContent.includes('Check the fuse')), 'back after undo');
    assert.ok($('#toast').textContent.includes('Undone: Card deleted'));
    click($('#settingsBtn'));
    await waitFor(() => $('.dialog #undoBtn'), 'Undo in Settings');
    click($('#undoBtn'));
    assert.strictEqual($('.dialog'), null, 'Settings closes so the page shows the undo');
    assert.ok($('#toast').textContent.includes('Undoing'), 'says it is working at once');
    await waitFor(() => $('#toast').textContent.includes('Undone: Card added'), 'the Settings button undoes the add before it');
    assert.ok(!$$('.kcard').some((c) => c.textContent.includes('Check the fuse')));
  });

  await step('renaming and adding columns, and the direction toggle', async () => {
    const first = $$('.colname')[0];
    setVal(first, 'Backlog', 'change');
    await sleep(30);
    assert.strictEqual($$('.colname')[0].value, 'Backlog');
    click($('[data-act="kanban.add-col"]'));
    await waitFor(() => $$('.colname').length === 4, '4 columns');
    assert.ok(!$('.board').classList.contains('vertical'), 'horizontal by default on desktop');
    click($('[data-act="kanban.dir"]'));
    assert.ok($('.board').classList.contains('vertical'));
  });

  await step('deleting a column asks first and moves its cards left', async () => {
    const doing = $$('.col').find((c) => c.querySelector('.colname') && c.querySelector('.colname').value === 'Doing');
    click(doing.querySelector('[data-act="kanban.del-col"]'));
    await waitFor(() => $('.dialog'), 'confirm dialog');
    assert.ok($('.dialog').textContent.includes('move to "Backlog"') || $('.dialog').textContent.includes('moves to "Backlog"') || $('.dialog').textContent.includes('Backlog'));
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $$('.colname').length === 3, 'column removed');
    assert.ok($$('.col')[0].textContent.includes('Buy duct tape'));
  });

  // Plays the end of a column drag: the stand-in Sortable for that board, the column put first, then its onEnd.
  const dragColumnFirst = (boardEl, colEl) => {
    const s = w.__sortables.find((x) => x.el === boardEl && x.opts.handle === '.colhead');
    assert.ok(s, 'the board\'s columns can be dragged');
    assert.strictEqual(s.opts.delay, 180, 'a short press first on touch screens, like cards');
    assert.ok(s.opts.group !== w.__sortables.find((x) => x.el.classList.contains('cards')).opts.group, 'cards and columns do not mix');
    s.opts.onStart({ item: colEl });
    boardEl.insertBefore(colEl, boardEl.firstChild);
    s.opts.onEnd({ item: colEl, from: boardEl, to: boardEl, oldIndex: 2, newIndex: 0 });
  };

  await step('dragging a column by its header moves it at once and saves it', async () => {
    const before = $$('.colname').map((i) => i.value);
    const last = $$('.board .col[data-colid]').pop();
    dragColumnFirst($('.board'), last);
    const after = [before[before.length - 1]].concat(before.slice(0, -1));
    assert.deepStrictEqual($$('.colname').map((i) => i.value), after, 'shown at once');
    assert.ok(!w.FT.state.dragging);
    const serverNames = () => { const k = JSON.parse(JSON.stringify(server.run('bootstrap()').data.kanban)); return k.columns.filter((c) => c.project_id === w.FT.state.projectId).sort((a, b) => a.order - b.order).map((c) => c.name); };
    await waitFor(() => serverNames().join('|') === after.join('|'), 'saved on the server');
    click($('#settingsBtn'));
    await waitFor(() => $('.dialog #undoBtn'), 'Undo in Settings');
    click($('#undoBtn'));
    await waitFor(() => $$('.colname').map((i) => i.value).join('|') === before.join('|'), 'undo puts it back');
  });

  await step('adding a resource rejects http and accepts https', async () => {
    click($$('[data-act="resources.add"]')[0]);
    await waitFor(() => $('.dialog'), 'resource dialog');
    setVal($('#dlg-title'), 'Fan spec'); setVal($('#dlg-value'), 'http://example.com');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('https'), 'https error');
    setVal($('#dlg-value'), 'https://example.com/fan');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $$('.reslist a').some((a) => a.textContent === 'Fan spec'), 'link listed');
  });

  await step('removing a resource link is immediate, says so with Undo at once, and Undo brings it back', async () => {
    const onServer = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.resources)).some((r) => r.title === 'Fan spec');
    click($$('.reslist li').find((li) => li.textContent.includes('Fan spec')).querySelector('[data-act="resources.remove"]'));
    assert.ok(!$$('.reslist a').some((a) => a.textContent === 'Fan spec'), 'gone at once');
    assert.ok(!$('#toast').hidden && $('#toast').textContent.includes('Resource deleted.') && $('#toast .toastbtn'), 'the Undo message shows at once');
    await waitFor(() => !onServer(), 'removed on the server');
    click($('#toast .toastbtn'));
    await waitFor(() => $$('.reslist a').some((a) => a.textContent === 'Fan spec'), 'back after undo');
    assert.ok(onServer());
  });

  await step('linked projects: + Link shows the link at once, the project waits, a click opens the other, Remove has Undo', async () => {
    const fan = w.FT.state.projectId, cv = w.FT.store.projects.find((p) => p.name === 'CV and portfolio').id;
    const serverLinks = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.links));
    const lines = () => $$('.lklist li').map((li) => li.querySelector('span').textContent.trim());
    assert.ok($$('.lcell .label').some((l) => l.textContent === 'Linked projects'), 'the panel is on the project page');
    assert.ok($('.lklist') === null && $$('.panel .empty').some((e) => e.textContent === 'No linked projects.'));
    click($('[data-act="links.add"]'));
    await waitFor(() => $('.dialog'), 'link dialog');
    assert.deepStrictEqual(Array.from($('#dlg-relation').options).map((o) => o.textContent), ['blocks', 'is blocked by', 'relates to']);
    assert.ok(!Array.from($('#dlg-other').options).some((o) => o.value === fan), 'the project itself is not offered');
    setVal($('#dlg-relation'), 'blockedBy', 'change');
    setVal($('#dlg-other'), cv, 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'the dialog closes');
    assert.deepStrictEqual(lines(), ['Blocked by CV and portfolio (active)'], 'and the link shows');
    assert.ok($('.waitbox') && $('.waitbox').textContent.includes('Waiting on CV and portfolio'), 'the header says what it waits on');
    await waitFor(() => serverLinks().some((l) => l.from_id === cv && l.to_id === fan && l.type === 'blocks'), 'saved on the server');
    assert.ok(JSON.parse(JSON.stringify(server.run('bootstrap()').data.today)).ranked.indexOf(fan) === -1, 'and it is out of the focus pick');
    click($('[data-act="links.add"]'));
    await waitFor(() => $('.dialog'), 'link dialog again');
    assert.ok(!Array.from($('#dlg-other').options).some((o) => o.value === cv), 'a project already linked is not offered again');
    click($('#dlg-cancel'));

    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length, 'project rows');
    const row = $$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan'));
    assert.ok(row.querySelector('.waitmark') && row.querySelector('.waitmark').textContent === 'Waiting', 'the Projects tab marks it');
    assert.strictEqual($$('.waitmark').length, 1);
    click(row);
    await waitFor(() => $('.lklist'), 'back on the project');
    click($('.lklist [data-act="links.open"]'));
    await waitFor(() => w.FT.state.projectId === cv && $('.lklist'), 'the blocker opens');
    assert.deepStrictEqual(lines(), ['Blocks Bathroom extractor fan']);
    assert.ok(!$('.waitbox'), 'the blocker waits for nothing');
    click($('.lklist [data-act="links.open"]'));
    await waitFor(() => w.FT.state.projectId === fan && $('.lklist'), 'and back');

    click($('.lklist [data-act="links.remove"]'));
    assert.ok(!$('.lklist') && !$('.waitbox'), 'gone at once, and the project no longer waits');
    assert.ok(!$('#toast').hidden && $('#toast').textContent.includes('Project link deleted.') && $('#toast .toastbtn'), 'the Undo message shows at once');
    await waitFor(() => !serverLinks().length, 'removed on the server');
    click($('#toast .toastbtn'));
    await waitFor(() => lines().length === 1 && serverLinks().length === 1, 'back after undo');
    click($('.lklist [data-act="links.remove"]'));
    await waitFor(() => !serverLinks().length && w.FT.pendingSaves() === 0, 'removed again');
  });

  // The project's own resources panel, and the resources in it as the server has them
  const projectPanel = () => $$('section.panel').find((p) => (p.querySelector('.label') || {}).textContent === 'Resources: this project');
  const serverResource = (title) => JSON.parse(JSON.stringify(server.run('bootstrap()').data.resources)).find((r) => r.title === title);
  const addResource = async (f) => {
    click(projectPanel().querySelector('[data-act="resources.add"]'));
    await waitFor(() => $('.dialog #dlg-type'), 'add dialog');
    setVal($('#dlg-title'), f.title); setVal($('#dlg-type'), f.type, 'change'); setVal($('#dlg-value'), f.value);
    if (f.group) setVal($('#dlg-group'), f.group);
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'closed', 200);
  };

  await step('a phone number, an email address and a text are added, each checked for its type', async () => {
    click(projectPanel().querySelector('[data-act="resources.add"]'));
    await waitFor(() => $('.dialog #dlg-type'), 'add dialog');
    assert.ok($('.dialog .hint').textContent.includes('bank or card details'), 'the sensitive-file warning shows');
    setVal($('#dlg-title'), 'Builder'); setVal($('#dlg-type'), 'email', 'change');
    assert.strictEqual($('label[for="dlg-value"]').textContent, 'Email address');
    setVal($('#dlg-value'), 'not an address');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('email address'), 'refused in the dialog');
    setVal($('#dlg-value'), 'builder@example.com');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'closes at once', 200);
    assert.strictEqual(projectPanel().querySelector('a[href="mailto:builder@example.com"]').textContent, 'builder@example.com');
    await addResource({ title: 'Plumber', type: 'phone', value: '+44 161 496 0000', group: 'Suppliers' });
    await addResource({ title: 'Gate code', type: 'text', value: 'Code 4512, see https://example.com/gate', group: 'Access' });
    await addResource({ title: 'Electrician', type: 'email', value: 'spark@example.com', group: 'suppliers' });
    await waitFor(() => serverResource('Builder') && serverResource('Plumber') && serverResource('Gate code') && serverResource('Electrician'), 'all saved');
    assert.deepStrictEqual(['Builder', 'Plumber', 'Gate code'].map((t) => serverResource(t).type), ['email', 'phone', 'text']);
    const gate = $$('.reslist li').find((li) => li.textContent.includes('Gate code'));
    assert.ok(gate.querySelector('.rtext a.textlink'), 'a web address in a text is a link');
    assert.ok(gate.querySelector('[data-act="resources.copy"]'), 'a text can be copied');
    assert.ok(!$$('.reslist li').find((li) => li.textContent.includes('Plumber')).querySelector('[data-act="resources.copy"]'), 'a phone number has no copy button');
  });

  await step('resources show under their group headings, ungrouped first, with groups suggested', async () => {
    const panel = projectPanel();
    assert.deepStrictEqual($$('.rgroup').filter((h) => panel.contains(h)).map((h) => h.textContent), ['Access', 'Suppliers', 'suppliers']);
    const first = panel.querySelector('.reslist');
    assert.ok(first.previousElementSibling.classList.contains('label'), 'the ungrouped list comes first, under no heading');
    assert.ok(first.textContent.includes('Builder') && first.textContent.includes('Fan spec'));
    click(panel.querySelector('[data-act="resources.add"]'));
    await waitFor(() => $('.dialog #dlg-group'), 'add dialog');
    assert.deepStrictEqual($$('#dlg-group-list option').map((o) => o.value), ['Access', 'Suppliers', 'suppliers']);
    click($('#dlg-cancel'));
  });

  await step('editing a resource shows at once, reaches the server and can be undone', async () => {
    click($$('.reslist li').find((li) => li.textContent.includes('Electrician')).querySelector('[data-act="resources.edit"]'));
    await waitFor(() => $('.dialog #dlg-type'), 'edit dialog');
    assert.strictEqual($('#dlg-title').value, 'Electrician');
    assert.strictEqual($('#dlg-type').value, 'email');
    assert.strictEqual($('#dlg-value').value, 'spark@example.com');
    setVal($('#dlg-type'), 'phone', 'change');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('phone number'), 'the old value is not a phone number');
    setVal($('#dlg-title'), 'Electrician (Sam)'); setVal($('#dlg-value'), '07700 900123'); setVal($('#dlg-group'), 'Suppliers');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'closes at once', 200);
    const li = $$('.reslist li').find((x) => x.textContent.includes('Electrician (Sam)'));
    assert.ok(li && li.querySelector('a[href="tel:07700900123"]'), 'shown at once as a phone number');
    assert.deepStrictEqual($$('.rgroup').filter((h) => projectPanel().contains(h)).map((h) => h.textContent), ['Access', 'Suppliers'], 'moved into Suppliers');
    await waitFor(() => serverResource('Electrician (Sam)'), 'saved');
    assert.deepStrictEqual(['type', 'value', 'group'].map((k) => serverResource('Electrician (Sam)')[k]), ['phone', '07700 900123', 'Suppliers']);
    assert.ok(!server.run('bootstrap()').data.resources.some((r) => r.title === 'Electrician'));
    await w.FT.undo();
    await waitFor(() => serverResource('Electrician') && $$('.reslist li').some((x) => x.textContent.includes('spark@example.com')), 'undo puts it back');
  });

  await step('Choose from Drive searches names only, and picking a file fills the title and link', async () => {
    server.drive.addDriveFile('Zephyr installation guide', { mime: 'application/pdf', content: 'never shown' });
    server.drive.addDriveFile('Zephyr receipt', { mime: 'application/vnd.google-apps.document' });
    click(projectPanel().querySelector('[data-act="resources.add"]'));
    await waitFor(() => $('#res-drive-open'), 'add dialog');
    click($('#res-drive-open'));
    assert.ok(!$('#res-drive').hidden);
    setVal($('#res-drive-q'), 'zephyr');
    $('#res-drive-q').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok($('.dialog'), 'Enter in the search does not submit the dialog');
    await waitFor(() => $$('#res-drive-list button').length === 2, 'two files found');
    assert.ok($('#res-drive-list').textContent.includes('PDF') && $('#res-drive-list').textContent.includes('Google Doc'));
    assert.ok(!$('.dialog').textContent.includes('never shown'), 'no contents shown');
    assert.ok($('.dialog .hint').textContent.includes('bank or card details'), 'the warning stays');
    click($$('#res-drive-list button').find((b) => b.textContent.includes('receipt')));
    assert.strictEqual($('#dlg-type').value, 'drive');
    assert.strictEqual($('#dlg-title').value, 'Zephyr receipt');
    const url = $('#dlg-value').value;
    assert.ok(/^https:\/\/docs\.google\.com\//.test(url));
    click($('#dlg-submit'));
    await waitFor(() => serverResource('Zephyr receipt'), 'saved');
    assert.deepStrictEqual([serverResource('Zephyr receipt').type, serverResource('Zephyr receipt').value], ['drive', url]);
    const a = $$('.reslist a').find((x) => x.textContent === 'Zephyr receipt');
    assert.strictEqual(a.getAttribute('target'), '_blank', 'a Drive file opens in a new tab');
    assert.strictEqual(server.drive.contentReads, 0, 'no file was read');
  });

  await step('notes autosave to a Drive file', async () => {
    const ta = $('#nt-text');
    ta.innerHTML = '<h1>Fan</h1><div>Replacement needs to be <b>100mm</b>.</div><ul><li>Checked the duct: 98mm</li></ul>';
    ta.dispatchEvent(new w.Event('input', { bubbles: true }));
    ta.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => $('#nt-status').textContent === 'Saved', 'saved');
    const file = Object.values(server.drive.files).find((f) => f.content && f.content.includes('98mm'));
    assert.ok(file, 'file content updated');
    assert.strictEqual(file.content, '# Fan\nReplacement needs to be **100mm**.\n- Checked the duct: 98mm', 'the rich text is stored as markdown');
  });

  await step('a session can be started and finished from Today, and lands in the log', async () => {
    click(tab('Today'));
    await waitFor(() => $('[data-act="today.start"]'), 'start button');
    click($('[data-act="today.start"]'));
    await waitFor(() => $('.timer'), 'timer');

    click($('[data-act="today.pause"]'));
    await waitFor(() => $('[data-act="today.resume"]') && $('.timer .state'), 'paused');
    click($('[data-act="today.resume"]'));
    await waitFor(() => $('[data-act="today.pause"]') && !$('.timer .state'), 'resumed');

    assert.strictEqual($('#pomo'), null, 'pomodoro is off by default');
    // jsdom has no Web Audio, so a fake records which oscillator types are played: chicken is sawtooth, steam whistle is triangle.
    const playedTypes = [];
    const fakeNode = () => new Proxy(function () {}, {
      get: (target, prop) => (prop === 'length' ? 0 : fakeNode()),
      set: (target, prop, value) => { if (prop === 'type') playedTypes.push(value); return true; },
      apply: () => fakeNode()
    });
    w.AudioContext = class {
      constructor() { this.currentTime = 0; this.sampleRate = 100; this.destination = fakeNode(); }
      resume() {}
      createOscillator() { return fakeNode(); }
      createGain() { return fakeNode(); }
      createBiquadFilter() { return fakeNode(); }
      createBufferSource() { return fakeNode(); }
      createBuffer() { return { getChannelData: () => new Float32Array(10) }; }
    };
    click($('[data-act="today.pomodoro"]'));
    await waitFor(() => $('#pomo'), 'pomodoro shown');
    assert.ok(/Work 2[45]:\d\d left/.test($('#pomo').textContent), $('#pomo').textContent);
    click($('[data-act="today.pomodoroSettings"]'));
    await waitFor(() => $('#dlg-test-chicken'), 'lengths dialog with the sound buttons');
    click($('#dlg-test-chicken'));
    assert.ok(playedTypes.includes('sawtooth') && !playedTypes.includes('triangle'), 'the chicken button plays the chicken');
    playedTypes.length = 0;
    click($('#dlg-test-whistle'));
    assert.ok(playedTypes.includes('triangle') && !playedTypes.includes('sawtooth'), 'the whistle button plays the steam whistle');
    playedTypes.length = 0;
    click($('#dlg-cancel'));
    // Pretend the work period ran out: the box switches to "take a break" and the tab title changes
    server.run(`(function () {
      var props = PropertiesService.getUserProperties(), s = JSON.parse(props.getProperty('today.state'));
      s.session.pomodoro.phaseStartMs -= 26 * 60000;
      props.setProperty('today.state', JSON.stringify(s)); })()`);
    await w.FT.reload();
    await waitFor(() => $('#pomo.over'), 'work period over');
    assert.ok($('#pomo').textContent.includes('Time for a break'));
    await waitFor(() => d.title.startsWith('⏰ Break time'), 'alert title');
    assert.ok(playedTypes.includes('sawtooth') && !playedTypes.includes('triangle'), 'the chicken plays when work ends');
    playedTypes.length = 0;
    click(tab('Projects'));
    await waitFor(() => d.title.startsWith('⏰ Break time'), 'alert title stays on other tabs', 2500);
    click(tab('Today'));
    await waitFor(() => $('#pomo.over'), 'back on Today');
    click($('[data-act="today.nextPhase"]'));
    await waitFor(() => $('#pomo') && !$('#pomo.over') && $('#pomo').textContent.includes('Break'), 'break started');
    assert.strictEqual(d.title, 'Focus Tracker');
    // Pretend the break ran out too
    server.run(`(function () {
      var props = PropertiesService.getUserProperties(), s = JSON.parse(props.getProperty('today.state'));
      s.session.pomodoro.phaseStartMs -= 6 * 60000;
      props.setProperty('today.state', JSON.stringify(s)); })()`);
    await w.FT.reload();
    await waitFor(() => d.title.startsWith('⏰ Back to work'), 'break over alert title');
    assert.ok(playedTypes.includes('triangle') && !playedTypes.includes('sawtooth'), 'the steam whistle plays when the break ends');

    click($('[data-act="today.finish"]'));
    await waitFor(() => $('.dialog'), 'finish dialog');
    setVal($('#dlg-where'), 'Rewrote the opening line'); setVal($('#dlg-next'), 'Send to a friend for feedback');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && !$('.timer'), 'session closed');
    assert.ok($('.next').textContent.includes('Send to a friend for feedback'));
    click(tab('Insights'));
    click(await waitFor(() => subtab('Logs'), 'Logs sub-tab'));
    await waitFor(() => $$('tbody tr').length >= 1 && $('tbody').textContent.includes('Rewrote the opening line'), 'log row');
  });

  await step('Insights: Week, Habits, Projects and Logs sub-tabs render, the Logs filter works, and the sub-tab is remembered', async () => {
    assert.deepStrictEqual($$('.subtab').map((b) => b.textContent), ['Week', 'Habits', 'Projects', 'Logs']);
    assert.strictEqual(w.localStorage.getItem('ft.insights.sub'), 'logs');
    const project = await waitFor(() => $('tr.logrow b') && $('tr.logrow b').textContent, 'project of the log row');
    const other = Array.from($('#log-filter').options).find((o) => o.value !== 'all' && o.textContent !== project);
    setVal($('#log-filter'), other.value, 'change');
    await waitFor(() => !$('tbody').textContent.includes('Rewrote the opening line'), 'filtered out');
    setVal($('#log-filter'), 'all', 'change');
    await waitFor(() => $('tbody').textContent.includes('Rewrote the opening line'), 'back with All projects');

    click(subtab('Week'));
    const summary = JSON.parse(JSON.stringify(server.run('rpc')('insights', 'summary', {}))).result;
    const sessions = summary.weeks.this.focus.sessions;
    assert.ok(sessions >= 1, 'the finished session counts this week');
    await waitFor(() => $('.insights h2') && /This week/.test($('.insights h2').textContent) && $('.stat').textContent.includes(sessions + 'focus session'), 'week at a glance');
    assert.ok(summary.habits.length >= 1 && $('.insights').textContent.includes(summary.habits[0].name), 'the seeded habit shows against its target');
    assert.ok($$('.insights tbody tr').some((r) => r.textContent.includes(project)), 'the session is on its day');
    click($('[data-act="insights.week"][data-week="last"]'));
    await waitFor(() => /Last week/.test($('.insights h2').textContent), 'last week');
    click($('[data-act="insights.week"][data-week="this"]'));

    click(subtab('Habits'));
    await waitFor(() => $('.insights').textContent.includes(summary.habits[0].name), 'a card per habit');
    click(subtab('Projects'));
    const row = await waitFor(() => $$('.insights tbody tr').find((r) => r.textContent.includes(project)), 'project row');
    assert.ok(/Share of time/.test($('.insights thead').textContent));
    const expected = summary.projects[4].rows.find((r) => r.name === project).sessions;
    assert.ok(expected >= 1);
    assert.strictEqual(row.querySelectorAll('td.num')[0].textContent, String(expected), 'its sessions in the last 4 weeks');
    assert.strictEqual(w.localStorage.getItem('ft.insights.sub'), 'projects');
    click(tab('Today'));
    click(tab('Insights'));
    await waitFor(() => subtab('Projects').getAttribute('aria-current') === 'page' && $$('.insights tbody tr').length, 'Projects again, from this device');
    click($$('[data-act="insights.project"]').find((b) => b.textContent === project));
    await waitFor(() => w.FT.state.view === 'project' && w.FT.project(w.FT.state.projectId).name === project, 'a project row opens the project');
  });

  await step('swap focus lets you pick the project and a reminder, and the skip shows on the project', async () => {
    click(tab('Today'));
    const before = await waitFor(() => $('.focus-name') && $('.focus-name').textContent, 'focus');
    click($('[data-act="today.swap"]'));
    await waitFor(() => $('#dlg-to'), 'swap dialog');
    const fan = Array.from($('#dlg-to').options).find((o) => o.textContent.startsWith('Bathroom extractor fan'));
    assert.ok(fan, 'other projects are offered');
    assert.ok(!Array.from($('#dlg-to').options).some((o) => o.textContent.startsWith(before)), 'not the current focus');
    setVal($('#dlg-to'), fan.value, 'change');
    setVal($('#dlg-remind'), '1', 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $('.focus-name').textContent === 'Bathroom extractor fan', 'picked project is the focus');
    const skipped = JSON.parse(JSON.stringify(server.run('bootstrap()').data.projects)).find((p) => p.name === before);
    click(tab('Projects'));
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes(before)), 'row'));
    await waitFor(() => $('.phead') && $('.phead').textContent.includes('Skipped 1 time'), 'skip count on the project');
    assert.ok(skipped);
  });


  // ---------- habits, to-dos and Plan my week ----------
  const srv = (code) => { const v = server.run('(function () { tableCache_ = {}; return ' + code + '; })()'); return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
  const rowsOfTab = (name) => { const sh = server.ss.sheets[name]; return sh.rows.slice(1).map((r) => Object.fromEntries(sh.rows[0].map((h, i) => [h, r[i] === undefined ? '' : r[i]]))); };
  const habitsNow = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.habits));
  const todosNow = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.todos)).items;
  const TODAY = srv('todayIso_()'), MON = srv('isoMonday_(todayIso_())');
  const plus = (day, n) => srv("isoAddDays_('" + day + "', " + n + ')');
  const habitRow = (name) => $$('.small-tasks .habit').find((r) => r.querySelector('.hname').textContent === name);
  const enter = (el) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  await step('Small tasks: a dot tap shows at once and reaches the sheet, taps past the dots are extra, − takes one off', async () => {
    click(tab('Today'));
    const row = await waitFor(() => habitRow('Job search'), 'the daily minimum is a habit on Today');
    assert.strictEqual($('.small-tasks .label').textContent, 'Small tasks');
    assert.ok(row.textContent.includes('Daily minimum'), 'its intention shows');
    assert.ok(row.querySelector('.hnext').textContent.startsWith('Job search · '), 'with the linked category\'s next action');
    assert.strictEqual(row.querySelectorAll('.dot').length, 1);
    assert.strictEqual(row.querySelector('.hcount').textContent, '0 of 1 today');
    click(row.querySelector('[data-act="habits.tap"]'));
    const now = habitRow('Job search');
    assert.ok(now.querySelector('.dot.on'), 'filled at once, before the server answers');
    assert.strictEqual(now.querySelector('.hcount').textContent, '1 of 1 today', 'and the count says so in words');
    assert.ok(/Nice\. Job search: 1 of 1 today/.test($('#toast').textContent) && $('#toast .toastbtn').textContent === 'Undo');
    assert.ok(/session 1 of 1, done/.test(now.querySelector('.dot.on').getAttribute('aria-label')));
    await waitFor(() => habitsNow().log.some((r) => r.kind === 'done' && r.day === TODAY && r.count === 1), 'tap saved');
    click(habitRow('Job search').querySelector('.dot.add'));
    await waitFor(() => habitRow('Job search').querySelector('.extra') && habitRow('Job search').querySelector('.extra').textContent === '+1 extra', 'extra chip');
    await waitFor(() => habitsNow().log.find((r) => r.kind === 'done' && r.day === TODAY).count === 2, 'two sessions');
    click(habitRow('Job search').querySelector('[data-act="habits.untap"]'));
    assert.ok(!habitRow('Job search').querySelector('.extra'), 'the extra goes at once');
    await waitFor(() => habitsNow().log.find((r) => r.kind === 'done' && r.day === TODAY).count === 1, 'back to one');
    assert.strictEqual(rowsOfTab('Habit log').filter((r) => r.kind === 'done').length, 1, 'one row per habit per day, its count updated');
  });

  await step('To-dos: tick, add for anytime with Enter, delete with Undo at once', async () => {
    const item = () => $$('.todos li').find((li) => li.textContent.includes('Grocery shopping'));
    assert.ok(item().textContent.includes('Today'));
    const box = item().querySelector('input[type="checkbox"]');
    box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok(item().classList.contains('done'), 'struck through at once');
    assert.ok(item().textContent.includes('Done · Today'));
    await waitFor(() => todosNow().find((t) => t.title === 'Grocery shopping').done === TODAY, 'tick saved');
    setVal($('#td-day'), '', 'change');
    setVal($('#td-new'), 'Post parcel');
    enter($('#td-new'));
    assert.ok($$('.todos li').some((li) => li.textContent.includes('Post parcel') && li.textContent.includes('Anytime')), 'shows at once');
    assert.strictEqual(d.activeElement.id, 'td-new', 'the box keeps focus for the next one');
    await waitFor(() => todosNow().some((t) => t.title === 'Post parcel' && t.day === ''), 'added');
    setVal($('#td-new'), 'Wrong one'); click($('[data-act="todos.addBtn"]'));
    await waitFor(() => todosNow().some((t) => t.title === 'Wrong one'), 'added with the button');
    click($$('.todos li').find((li) => li.textContent.includes('Wrong one')).querySelector('[data-act="todos.remove"]'));
    assert.ok(!$$('.todos li').some((li) => li.textContent.includes('Wrong one')), 'gone at once');
    assert.ok(/To-do deleted/.test($('#toast').textContent) && $('#toast .toastbtn'), 'Undo offered at once');
    await waitFor(() => !todosNow().some((t) => t.title === 'Wrong one'), 'deleted');
    click($('#toast .toastbtn'));
    await waitFor(() => todosNow().some((t) => t.title === 'Wrong one'), 'Undo brings it back');
    await waitFor(() => $$('.todos li').some((li) => li.textContent.includes('Wrong one')), 'on screen too');
  });

  await step('New habit: name and goal, start low (a third, half the size), a pace with the steps drawn, then edit, pause and resume', async () => {
    click($('[data-act="habits.new"]'));
    await waitFor(() => $('#nh-name'), 'new habit dialog');
    assert.ok(!$('#nh-step1').hidden && $('#nh-step2').hidden && $('#nh-step3').hidden);
    click($('#nh-next1'));
    assert.ok(/needs a name/.test($('#dlg-err').textContent));
    setVal($('#nh-name'), 'Cardio'); setVal($('#nh-intention'), '5 cardio sessions a week'); setVal($('#nh-sessions'), '5'); setVal($('#nh-size'), '30 min');
    click($('#nh-next1'));
    assert.ok(!$('#nh-step2').hidden, 'step 2');
    assert.ok($('#nh-goaltext').textContent.includes('5 a week, 30 min'));
    assert.deepStrictEqual($$('#nh-starts button').map((b) => b.textContent), ['2 a week15 min · suggested', '3 a week20 min', 'The goal now5 a week, 30 min']);
    assert.ok($('.advice').textContent.includes('Start lower than you think'));
    setVal($('#nh-small'), '5 min');
    click($('#nh-next2'));
    assert.ok(!$('#nh-step3').hidden, 'step 3');
    assert.strictEqual($('.hpace[aria-pressed="true"]').textContent, '2 weeks', 'two weeks by default');
    assert.ok($$('#nh-ramp .ramp div').length >= 5 && /About \d+ weeks to the goal/.test($('#nh-ramp').textContent));
    click($$('.hpace').find((b) => b.textContent === 'week'));
    assert.ok(/About \d+ weeks/.test($('#nh-ramp').textContent));
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && habitRow('Cardio'), 'created');
    const cardio = habitsNow().habits.find((h) => h.name === 'Cardio');
    assert.deepStrictEqual([cardio.sessions, cardio.per, cardio.size, cardio.goal, cardio.small_version, cardio.step_up_every, cardio.prompts, cardio.intention],
      [2, 'week', '15 min', '5 a week, 30 min', '5 min', '1 week', 'on', '5 cardio sessions a week']);
    assert.strictEqual(habitRow('Cardio').querySelectorAll('.dot').length, 2);
    assert.strictEqual(habitRow('Cardio').querySelector('.hcount').textContent, '0 of 2 this week');

    click(habitRow('Cardio').querySelector('.hname'));
    await waitFor(() => $('#eh-name'), 'edit dialog');
    assert.strictEqual($('.hpace[aria-pressed="true"]').textContent, 'week');
    setVal($('#eh-name'), 'Cardio rides');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && habitRow('Cardio rides'), 'renamed');
    await waitFor(() => rowsOfTab('Habit log').filter((r) => r.habit_id === cardio.id).every((r) => r.habit === 'Cardio rides'), 'the name next to the id follows');
    click(habitRow('Cardio rides').querySelector('.hname'));
    await waitFor(() => $('[data-act="habits.pause"]'), 'edit dialog');
    click($('[data-act="habits.pause"]'));
    assert.ok(!habitRow('Cardio rides') && $('.paused-list').textContent.includes('Cardio rides'), 'paused at once, off the list');
    await waitFor(() => habitsNow().habits.find((h) => h.id === cardio.id).status === 'paused', 'paused on the server');
    click($('[data-act="habits.resume"]'));
    assert.ok(habitRow('Cardio rides'), 'back at once');
    await waitFor(() => habitsNow().habits.find((h) => h.id === cardio.id).status === 'active', 'resumed');
    assert.deepStrictEqual(rowsOfTab('Habit log').filter((r) => r.habit_id === cardio.id).map((r) => r.kind), ['level', 'pause', 'resume']);
  });

  /** Make the step-up prompt for a habit due and earned: its level started two weeks before this Monday and was met in both weeks since. */
  const makeDue = (id, sessions) => {
    srv("new Table('Habit log', ['id']).removeWhere(function (r) { return r.habit_id === '" + id + "' && (r.kind === 'level' || r.day === todayIso_() && r.kind === 'prompt'); })");
    srv("new Table('Habits', ['id']).update('" + id + "', { next_prompt: isoAddDays_(todayIso_(), -1), started: isoAddDays_(isoMonday_(todayIso_()), -14) })");
    const h = habitsNow().habits.find((x) => x.id === id);
    srv("new Table('Habit log', ['id']).insert({ habit_id: '" + id + "', day: isoAddDays_(isoMonday_(todayIso_()), -14), kind: 'level', value: '" + h.sessions + ' a week, ' + h.size + "' })");
    [-13, -6].forEach((n) => srv("new Table('Habit log', ['id']).insert({ habit_id: '" + id + "', day: isoAddDays_(isoMonday_(todayIso_()), " + n + "), kind: 'done', count: " + sessions + ' })'));
  };
  const reload = () => w.FT.reload();

  await step('"Want to go further?": Yes, adjust changes the level from Monday; three Not nows ask once to stop; I\'m at my goal stops the prompts', async () => {
    const id = habitsNow().habits.find((h) => h.name === 'Cardio rides').id;
    makeDue(id, 2);
    await reload();
    await waitFor(() => $('.stepcard'), 'the card shows');
    assert.strictEqual($('.stepcard h3').textContent, 'Want to go further?');
    assert.ok($('.stepcard').textContent.includes('Cardio rides: 2 a week, 15 min done last week'));
    assert.deepStrictEqual($$('.stepcard .choice button').map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['3 a week15 min each · +1 session', 'true'], ['2 a week20 min each · +5 min', 'false']]);
    assert.ok($('.stepcard').textContent.includes('Goal: 5 a week, 30 min. Starts Monday'));
    click($$('.stepcard .choice button')[1]);
    assert.strictEqual($$('.stepcard .choice button')[1].getAttribute('aria-pressed'), 'true', 'the other step can be picked');
    click($('[data-act="habits.answer"][data-answer="yes"]'));
    assert.ok(!$('.stepcard'), 'the card goes at once');
    assert.ok($('#toast').textContent.includes('Cardio rides is 2 a week, 20 min from Monday. Next check in a week.'));
    await waitFor(() => habitsNow().habits.find((h) => h.id === id).size === '20 min', 'saved');
    const nextMonday = plus(MON, 7);
    const log = rowsOfTab('Habit log').filter((r) => r.habit_id === id);
    assert.ok(log.some((r) => r.kind === 'level' && r.day === nextMonday && r.value === '2 a week, 20 min'), 'a level row from next Monday');
    assert.ok(log.some((r) => r.kind === 'prompt' && r.value === 'yes'));
    assert.strictEqual(habitsNow().habits.find((h) => h.id === id).next_prompt, plus(TODAY, 7));
    assert.deepStrictEqual(habitsNow().habits.find((h) => h.id === id).level, { sessions: 2, size: '15 min' }, 'this week stays as it was');
    await waitFor(() => habitRow('Cardio rides').textContent.includes('2 a week, 20 min from Monday'), 'the row says what changes on Monday');

    // Not now, twice before and once now: then the card asks once whether to stop asking
    makeDue(id, 2);
    srv("new Table('Habit log', ['id']).insertMany([{ habit_id: '" + id + "', day: isoAddDays_(todayIso_(), -20), kind: 'prompt', value: 'not now' }, { habit_id: '" + id + "', day: isoAddDays_(todayIso_(), -10), kind: 'prompt', value: 'not now' }])");
    await reload();
    await waitFor(() => $('.stepcard h3') && $('.stepcard h3').textContent === 'Want to go further?', 'due again');
    click($('[data-act="habits.answer"][data-answer="not now"]'));
    assert.ok(!$('.stepcard') && $('#toast').textContent.includes('No change. We\'ll ask again in a week.'));
    await waitFor(() => $('.stepcard h3') && $('.stepcard h3').textContent === 'Stop asking about Cardio rides?', 'asks once whether to stop');
    click($('[data-act="habits.answer"][data-answer="stop asking"]'));
    assert.ok(!$('.stepcard'));
    await waitFor(() => habitsNow().habits.find((h) => h.id === id).prompts === 'off', 'prompts off');

    // prompts back on in the habit's settings, then "I'm at my goal"
    click(habitRow('Cardio rides').querySelector('.hname'));
    await waitFor(() => $('#eh-name'), 'edit');
    assert.strictEqual($('.hpace[aria-pressed="true"]').textContent, 'Don\'t ask', 'prompts are off');
    click($$('.hpace').find((b) => b.textContent === '2 weeks'));
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && habitsNow().habits.find((h) => h.id === id).prompts === 'on', 'on again');
    makeDue(id, 2);
    await reload();
    await waitFor(() => $('.stepcard h3') && $('.stepcard h3').textContent === 'Want to go further?', 'due again');
    click($('[data-act="habits.answer"][data-answer="at goal"]'));
    assert.ok(!$('.stepcard') && /at your goal: 2 a week, 20 min\. No more prompts\./.test($('#toast').textContent));
    await waitFor(() => habitsNow().habits.find((h) => h.id === id).prompts === 'at goal', 'at goal');
    assert.strictEqual(habitsNow().habits.find((h) => h.id === id).goal, '2 a week, 20 min', 'the goal is the level now');
  });

  await step('Plan my week: this week or next only; rings for planned sessions, to-dos onto days, the focus lead', async () => {
    click($('[data-act="habits.planWeek"]'));
    await waitFor(() => $('.plan'), 'plan dialog');
    assert.ok($('.plan .h.today').textContent.endsWith('· today'));
    assert.deepStrictEqual($$('.weektoggle button').map((b) => b.getAttribute('aria-pressed')), ['true', 'false']);
    assert.strictEqual($$('.weektoggle button').length, 2, 'no week after next');
    const jobId = habitsNow().habits.find((h) => h.name === 'Job search').id;
    const cell = (id, day) => $(`.plan [data-act="habits.planAdd"][data-id="${id}"][data-day="${day}"]`);
    const tomorrow = plus(TODAY, 1);
    if (tomorrow < plus(MON, 7) && cell(jobId, tomorrow)) {
      click(cell(jobId, tomorrow));
      assert.strictEqual(cell(jobId, tomorrow).querySelectorAll('[data-act="habits.planRemove"]').length, 1, 'a ring at once');
      await waitFor(() => habitsNow().log.some((r) => r.kind === 'plan' && r.day === tomorrow && r.count === 1), 'plan saved');
      click(cell(jobId, tomorrow).querySelector('[data-act="habits.planRemove"]'));
      assert.strictEqual(cell(jobId, tomorrow).querySelectorAll('[data-act="habits.planRemove"]').length, 0, 'and gone at once');
      await waitFor(() => !habitsNow().log.some((r) => r.kind === 'plan' && r.day === tomorrow), 'plan removed');
    }
    click($('[data-act="habits.planWhich"][data-week="1"]'));
    const nextMon = plus(MON, 7);
    assert.ok($$('.plan .h')[1].textContent.startsWith('Mon ' + Number(nextMon.slice(8))), 'next week\'s days');
    click(cell(jobId, nextMon)); click(cell(jobId, nextMon));
    assert.strictEqual(cell(jobId, nextMon).querySelectorAll('.pdot').length, 2);
    await waitFor(() => habitsNow().log.some((r) => r.kind === 'plan' && r.day === nextMon && r.count === 2), 'two planned next Monday');
    assert.ok($$('.plan .rl small').some((x) => x.textContent.includes('2 planned')), 'the tally counts them');

    click($$('.anytime [data-act="habits.planPick"]').find((b) => b.textContent === 'Post parcel'));
    assert.ok($('.plan .cell.picking'), 'days show they can take it');
    const wed = plus(nextMon, 2), thu = plus(nextMon, 3);
    click($(`.plan [data-act="habits.planTodoDay"][data-day="${wed}"]`));
    assert.ok($(`.plan [data-act="habits.planTodoDay"][data-day="${wed}"]`).textContent.includes('Post parcel'), 'on the day at once');
    await waitFor(() => todosNow().find((t) => t.title === 'Post parcel').day === wed, 'to-do day saved');
    click($(`.plan [data-act="habits.planTodoDay"][data-day="${thu}"]`));
    const box = await waitFor(() => $('#pw-todo'), 'an add box in the day');
    setVal(box, 'Dentist'); enter(box);
    await waitFor(() => todosNow().some((t) => t.title === 'Dentist' && t.day === thu), 'added on that day');

    const lead = $('.plan select[data-day="1"]');
    assert.ok(lead.options[0].textContent.endsWith('(usual)'));
    setVal(lead, 'away', 'change');
    await waitFor(() => !cell(jobId, nextMon) && $$('.plan .cell.away').length >= 2, 'habits are left off an Away day');
    const todayNow = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.today));
    await waitFor(() => todayNow().next[1] === 'away', 'next week\'s lead saved');
    assert.strictEqual(todayNow().week[1], undefined, 'this week untouched');
    setVal($('.plan select[data-day="1"]'), 'usual', 'change');
    await waitFor(() => todayNow().next[1] === undefined, 'back to usual');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'Done closes it');
  });

  await step('the weekly rotation can be edited, with a this-week change and an away day', async () => {
    click(tab('Today'));
    click(await waitFor(() => $('[data-act="today.rotation"]'), 'edit button'));
    await waitFor(() => $('#rot-usual-1'), 'rotation dialog');
    assert.strictEqual($('#rot-usual-1').value, 'coding');
    assert.strictEqual($('#rot-week-3').value, 'same');
    assert.strictEqual($('#dlg-minimum'), null, 'the daily minimum is a habit now, not a rotation setting');
    setVal($('#rot-usual-7'), 'house', 'change');
    setVal($('#rot-week-3'), 'away', 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $('.away-panel'), 'Wednesday is away this week');
    assert.ok($$('.rot tr')[2].textContent.includes('Away') && $$('.rot tr')[2].textContent.includes('this week'));
    assert.ok($$('.rot tr')[6].textContent.includes('House'));
    click($('[data-act="today.showAnyway"]'));
    await waitFor(() => $('.focus-name'), 'focus shown anyway');
    click($('[data-act="today.rotation"]'));
    await waitFor(() => $('#rot-week-3'), 'dialog again');
    setVal($('#rot-week-3'), 'same', 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && !$$('.rot .tag').length, 'back to usual');
  });

  await step('deleting a project from its page removes it everywhere', async () => {
    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length === 7, 'rows');
    click($$('tr.row').find((r) => r.textContent.includes('Garden fence repair')));
    await waitFor(() => $('[data-act="projects.delete"]'), 'delete button');
    click($('[data-act="projects.delete"]'));
    await waitFor(() => $('.dialog'), 'confirm');
    click($('#dlg-submit'));
    await waitFor(() => $$('tr.row').length === 6, '6 rows');
  });

  await step('categories can be added from the Projects tab and show in the project form', async () => {
    assert.deepStrictEqual($$('.catrow input').map((i) => i.value), ['Coding', 'Job search', 'House']);
    assert.ok($$('.catrow [data-act="categories.remove"]').every((b) => b.disabled), 'all in use');
    click($('[data-act="categories.add"]'));
    await waitFor(() => $('#dlg-label'), 'add dialog');
    setVal($('#dlg-label'), 'Garden');
    click($('#dlg-submit'));
    await waitFor(() => $$('.catrow input').length === 4, 'new category');
    const garden = $$('.catrow').find((r) => r.querySelector('input').value === 'Garden');
    assert.ok(!garden.querySelector('[data-act="categories.remove"]').disabled, 'unused category can be deleted');
    click($('[data-act="projects.add"]'));
    await waitFor(() => $('#dlg-category'), 'project dialog');
    assert.ok(Array.from($('#dlg-category').options).some((o) => o.textContent === 'Garden'));
    click($('#dlg-cancel'));
  });

  await step('lists: create one, add groups and items like a vertical board, and show it on Today', async () => {
    click(tab('Lists'));
    await waitFor(() => $('[data-act="lists.add"]'), 'lists tab');
    click($('[data-act="lists.add"]'));
    await waitFor(() => $('#dlg-name'), 'new list dialog');
    setVal($('#dlg-name'), 'Keep in mind');
    click($('#dlg-submit'));
    await waitFor(() => $('.listpanel .board.vertical'), 'list board');
    const list = () => $('.listpanel');
    assert.strictEqual(list().querySelector('.colname').value, 'Items');
    assert.strictEqual(list().querySelector('[data-act="kanban.add-col"]').textContent, '+ Add group');
    const input = list().querySelector('.coladd input');
    setVal(input, 'Tell a story with your commits');
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => list().querySelectorAll('.kcard').length === 1, 'item added');
    click(list().querySelector('[data-act="kanban.add-col"]'));
    await waitFor(() => list().querySelectorAll('.colname').length === 2, 'group added');
    assert.strictEqual(list().querySelectorAll('.colname')[1].value, 'New group');
    click(list().querySelector('.kcard [data-act="kanban.open-card"]'));
    await waitFor(() => $('#dlg-cardcolumn'), 'item dialog');
    assert.strictEqual($('label[for="dlg-cardcolumn"]').textContent, 'Group');
    setVal($('#dlg-cardcolumn'), $('#dlg-cardcolumn').options[1].value, 'change');
    click($('#dlg-submit'));
    await waitFor(() => list().querySelectorAll('.col')[1].querySelectorAll('.kcard').length === 1, 'moved to the second group', 200);
    dragColumnFirst(list().querySelector('.board'), list().querySelectorAll('.col[data-colid]')[1]);
    assert.deepStrictEqual(Array.from(list().querySelectorAll('.colname')).map((i) => i.value), ['New group', 'Items'], 'groups move like columns');
    assert.strictEqual(list().querySelectorAll('.col')[0].querySelectorAll('.kcard').length, 1, 'with their items');
    await sleep(450); // a click straight after a drag is taken as the end of the drag
    click(list().querySelector('[data-act="lists.settings"]'));
    await waitFor(() => $('#dlg-showtoday'), 'settings dialog');
    $('#dlg-showtoday').checked = true;
    click($('#dlg-submit'));
    await waitFor(() => JSON.parse(JSON.stringify(server.run('bootstrap()').data.lists))[0].show_today === 'yes', 'saved on the server');
    click(tab('Today'));
    await waitFor(() => $$('#app .listpanel .label').some((l) => l.textContent === 'Keep in mind'), 'list on Today');
    assert.ok($('#app .listpanel').textContent.includes('Tell a story with your commits'));
  });

  await step('a card opens a dialog to rename it, colour it and write a note', async () => {
    const card = $('#app .listpanel .kcard');
    click(card.querySelector('[data-act="kanban.open-card"]'));
    await waitFor(() => $('#dlg-note'), 'card dialog');
    assert.strictEqual($('#dlg-cardtitle').value, 'Tell a story with your commits');
    assert.strictEqual($$('.rtbar button').length, 15);
    $$('input[name="dlg-color"]').find((r) => r.value === '5').checked = true;
    $('#dlg-note').innerHTML = '<b>Why:</b> reviewers read history<script>alert(1)</script>';
    setVal($('#dlg-cardtitle'), 'Tell a story with commits');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $('#app .listpanel .kcard .knote'), 'note preview');
    const saved = $('#app .listpanel .kcard');
    assert.strictEqual(saved.querySelector('.kt').textContent, 'Tell a story with commits');
    assert.strictEqual(saved.querySelector('.knote').textContent, 'Why: reviewers read history');
    assert.ok(saved.getAttribute('style').includes('--cat-5'));
    click(saved.querySelector('[data-act="kanban.open-card"]'));
    await waitFor(() => $('#dlg-note'), 'reopened');
    assert.strictEqual($('#dlg-note').innerHTML, '<b>Why:</b> reviewers read history');
    assert.ok($$('input[name="dlg-color"]').find((r) => r.value === '5').checked);
    click($('#dlg-cancel'));
  });

  await step('deleting a category closes the dialog, says so with Undo at once, and Undo brings it back', async () => {
    const onServer = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.categories)).some((c) => c.label === 'Garden');
    const garden = () => $$('.catrow').find((r) => r.querySelector('input').value === 'Garden');
    click(tab('Projects'));
    click((await waitFor(() => garden(), 'Garden row')).querySelector('[data-act="categories.remove"]'));
    await waitFor(() => $('.dialog'), 'confirm');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'dialog closed');
    assert.ok(!garden(), 'gone at once');
    assert.ok($('#toast').textContent.includes('Category deleted.') && $('#toast .toastbtn'), 'the Undo message shows at once');
    await waitFor(() => !onServer(), 'removed on the server');
    click($('#toast .toastbtn'));
    await waitFor(() => garden(), 'back after undo');
    assert.ok(onServer());
  });

  await step('the Add project form can make a new category, and Enter submits it', async () => {
    click(tab('Projects'));
    click(await waitFor(() => $('[data-act="projects.add"]'), 'add button'));
    await waitFor(() => $('#dlg-category'), 'project dialog');
    assert.ok($('#dlg-newcategory').hidden, 'name box hidden until asked for');
    setVal($('#dlg-name'), 'Shed roof');
    setVal($('#dlg-category'), '__new', 'change');
    assert.ok(!$('#dlg-newcategory').hidden);
    setVal($('#dlg-newcategory'), 'Outdoor');
    $('#dlg-newcategory').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => !$('.dialog') && $('.phead') && $('.phead').textContent.includes('Outdoor'), 'project with new category');
    click(tab('Projects'));
    await waitFor(() => $$('.catrow input').some((i) => i.value === 'Outdoor'), 'category listed');
  });

  await step('a list can be given a colour, shown on the Lists tab and on Today', async () => {
    click(tab('Lists'));
    click(await waitFor(() => $('.listpanel [data-act="lists.settings"]'), 'settings button'));
    await waitFor(() => $('#dlg-listpreview'), 'settings dialog with preview');
    assert.ok(!$('#dlg-listpreview').classList.contains('tinted'), 'preview starts without colour');
    const green = $$('input[name="dlg-listcolor"]').find((r) => r.value === '6');
    green.checked = true; green.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok($('#dlg-listpreview').classList.contains('tinted') && $('#dlg-listpreview').style.getPropertyValue('--list-c').includes('--cat-6'), 'preview shows the colour');
    setVal($('#dlg-listname'), 'How I work');
    assert.strictEqual($('#dlg-previewname').textContent, 'How I work', 'preview shows the name');
    click($('#dlg-submit'));
    await waitFor(() => $('.listpanel.tinted'), 'tinted on Lists');
    assert.strictEqual($('.listpanel .listname').value, 'How I work');
    assert.ok($('.listpanel.tinted').getAttribute('style').includes('--cat-6'));
    click(tab('Today'));
    await waitFor(() => $('#app .listpanel.tinted'), 'tinted on Today');
    assert.ok($('#app .listpanel [data-act="lists.settings"]'), 'settings on Today too');
    await waitFor(() => { const l = JSON.parse(JSON.stringify(server.run('bootstrap()').data.lists))[0]; return l.color === '6' && l.name === 'How I work'; }, 'saved');
  });

  await step('a list can show one item at a time on Today, as a quote with its full description', async () => {
    click(tab('Lists'));
    await waitFor(() => $('.listpanel .coladd input'), 'list');
    for (const t of ['Done is better than perfect', 'Sleep on big decisions']) {
      const input = $('.listpanel .coladd input');
      setVal(input, t); input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    const card = $$('.listpanel .kcard').find((c) => c.textContent.includes('Sleep on big decisions'));
    click(card.querySelector('[data-act="kanban.open-card"]'));
    await waitFor(() => $('#dlg-note'), 'card dialog');
    $('#dlg-note').innerHTML = 'Wait one night. <b>Then</b> decide, see https://example.com/sleep';
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'saved note');
    click($('.listpanel [data-act="lists.settings"]'));
    await waitFor(() => $('#dlg-secsrow'), 'settings');
    assert.ok($('#dlg-secsrow').hidden, 'seconds only for one at a time');
    const one = $('input[name="dlg-display"][value="one"]');
    one.checked = true; one.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok(!$('#dlg-secsrow').hidden);
    setVal($('#dlg-seconds'), '2');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('5 to 3600'), 'too short refused');
    setVal($('#dlg-seconds'), '20');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $('.listpanel .modebadge'), 'badge on the Lists tab');
    assert.ok($('.listpanel .board'), 'the Lists tab still shows the full list for editing');
    click(tab('Today'));
    const quote = await waitFor(() => $('#app .rotq'), 'quote card on Today');
    assert.strictEqual(quote.querySelector('.rotbar'), null, 'no progress bar');
    const items = JSON.parse(JSON.stringify(server.run('bootstrap()').data.kanban.tasks)).filter((t) => t.list_id === quote.dataset.rotate).length;
    assert.strictEqual(quote.querySelector('[data-pos]').textContent, '1 / ' + items);
    const first = quote.querySelector('.rq').textContent;
    click(quote.querySelector('[data-act="lists.rotate"][data-d="1"]'));
    await waitFor(() => $('#app .rotq .rq') && $('#app .rotq .rq').textContent !== first, 'next item', 1500);
    assert.strictEqual($('#app .rotq [data-pos]').textContent, '2 / ' + items);
    while (!$('#app .rotq .rq').textContent.includes('Sleep on big decisions')) {
      // Compare the position, not the text: when a full round ends the order is reshuffled, and the same item can come up again.
      const before = $('#app .rotq [data-pos]').textContent;
      click($('#app .rotq [data-act="lists.rotate"][data-d="1"]'));
      await waitFor(() => $('#app .rotq [data-pos]').textContent !== before, 'rotating', 1500);
    }
    const desc = $('#app .rotq .rotdesc');
    assert.ok(desc.textContent.includes('Wait one night. Then decide'), 'the whole description shows');
    assert.strictEqual($('#app .rotq .more'), null, 'no More / Less');
    assert.strictEqual(desc.querySelector('a').getAttribute('href'), 'https://example.com/sleep');
    click($('#app .rotq .rq'));
    await waitFor(() => $('#dlg-cardtitle') && $('#dlg-cardtitle').value === 'Sleep on big decisions', 'clicking the quote opens the item');
    assert.strictEqual($('label[for="dlg-cardcolumn"]').textContent, 'Group');
    click($('#dlg-cancel'));
  });

  await step('acceptance criteria sit above the Kanban: add with Enter, tick, hide checked, edit', async () => {
    click(tab('Projects'));
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan')), 'row'));
    await waitFor(() => $('#crit-new'), 'criteria panel');
    const labels = $$('.lcell .label').map((l) => l.textContent);
    assert.ok(labels.indexOf('Acceptance criteria') < labels.indexOf('Kanban'), 'above the Kanban');
    for (const text of ['Fan is quiet', 'Spec: https://example.com/fan']) {
      setVal($('#crit-new'), text);
      $('#crit-new').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    assert.deepStrictEqual($$('.crit li .ctext').map((t) => t.textContent), ['Fan is quiet', 'Spec: https://example.com/fan']);
    const link = $('.crit li .ctext a');
    assert.strictEqual(link.getAttribute('href'), 'https://example.com/fan');
    assert.strictEqual(link.getAttribute('target'), '_blank');
    const box = $$('.crit li input[type="checkbox"]')[0];
    box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok($('.crithead').textContent.includes('1 of 2 done'));
    click($('[data-act="criteria.toggleDone"]'));
    assert.deepStrictEqual($$('.crit li .ctext').map((t) => t.textContent), ['Spec: https://example.com/fan'], 'checked items hidden');
    assert.ok($('[data-act="criteria.toggleDone"]').textContent.includes('Show checked (1)'));
    click($('.crit li .ctext'));
    const edit = await waitFor(() => $('#crit-edit'), 'edit box');
    setVal(edit, 'Spec sheet: https://example.com/fan');
    edit.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => !$('#crit-edit') && $('.crit li .ctext').textContent === 'Spec sheet: https://example.com/fan', 'edited');
    await waitFor(() => JSON.parse(JSON.stringify(server.run('bootstrap()').data.criteria)).some((c) => c.text.startsWith('Spec sheet') ), 'saved');
  });

  await step('a link in a card title opens the link, not the card', async () => {
    const input = $$('.col .coladd input')[0];
    setVal(input, 'Read https://example.com/manual');
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const card = $$('.kcard').find((c) => c.textContent.includes('example.com/manual'));
    const link = card.querySelector('a.textlink');
    assert.strictEqual(link.getAttribute('href'), 'https://example.com/manual');
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    click(link);
    await sleep(30);
    assert.strictEqual($('.dialog'), null, 'no card dialog');
    click(card.querySelector('.kt'));
    await waitFor(() => $('#dlg-cardtitle'), 'clicking the text still opens the card');
    click($('#dlg-cancel'));
  });

  await step('the focused project page shows the session and pomodoro at the top; other projects do not', async () => {
    click(tab('Today'));
    const focusName = await waitFor(() => $('.focus-name') && $('.focus-name').textContent, 'focus');
    click($('[data-act="today.open"]'));
    await waitFor(() => $('.focusbar'), 'start bar on the focus project');
    assert.strictEqual($$('.lcell .label')[0].textContent, "Today's focus", 'it is the first panel');
    click($('.focusbar [data-act="today.start"]'));
    await waitFor(() => $('#timer') && $('[data-act="today.pomodoro"]'), 'session on the project page');
    click($('[data-act="today.pomodoro"]'));
    await waitFor(() => $('#pomo') && /Work 2[45]:\d\d left/.test($('#pomo').textContent), 'pomodoro on the project page');
    click(tab('Projects'));
    click(await waitFor(() => $$('tr.row').find((r) => !r.textContent.includes(focusName)), 'another project'));
    await waitFor(() => $('.phead'), 'other project page');
    assert.strictEqual($('#timer'), null, 'no session on other projects');
    assert.strictEqual($('.focusbar'), null);
    click(tab('Today'));
    click(await waitFor(() => $('[data-act="today.finish"]'), 'finish'));
    await waitFor(() => $('#dlg-where'), 'finish dialog');
    setVal($('#dlg-where'), 'Tried the project page timer');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && !$('#timer'), 'session finished');
  });

  await step('sticky notes: add, type, recolour, hide with a count badge, show, delete with undo', async () => {
    click(tab('Projects'));
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan')), 'row'));
    await waitFor(() => $('[data-act="stickies.add"]'), 'note button on the project page');
    click($('[data-act="stickies.add"]'));
    const area = await waitFor(() => $('#stickylayer [data-sticky] textarea'), 'note shown at once');
    assert.strictEqual(d.activeElement, area, 'ready to type');
    setVal(area, 'Check the fuse first');
    const id = area.closest('[data-sticky]').dataset.sticky;
    const serverNote = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.stickies)).find((n) => n.id === id);
    await waitFor(() => serverNote() && serverNote().text === 'Check the fuse first', 'text saved', 4000);
    assert.strictEqual($('#stickylayer [data-sticky] .grip').querySelectorAll('button').length, 2, 'only options and delete on the strip');
    assert.strictEqual($('#stickymenu'), null);
    click($('#stickylayer [data-act="stickies.menu"]'));
    await waitFor(() => $('#stickymenu'), 'options menu');
    assert.strictEqual($$('#stickymenu [data-act="stickies.color"]').length, 15, '15 colours');
    click($('#stickymenu [data-act="stickies.color"][data-color="pink"]'));
    assert.strictEqual($('#stickylayer [data-sticky]').dataset.color, 'pink');
    assert.ok($('#stickymenu'), 'the menu stays open while choosing');
    const range = $('#stickymenu input[type="range"]');
    assert.strictEqual(range.min, '0.4', 'can never be fully see-through');
    setVal(range, '0.6');
    assert.strictEqual($('#stickylayer [data-sticky]').style.getPropertyValue('--paper-a'), '0.6');
    await waitFor(() => serverNote().color === 'pink' && serverNote().opacity === 0.6, 'colour and paper saved', 4000);
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual($('#stickymenu'), null, 'Esc closes the menu');
    click($('#stickylayer [data-act="stickies.menu"]'));
    click($('h2'));
    assert.strictEqual($('#stickymenu'), null, 'a click outside closes it');
    click($('[data-act="stickies.toggle"]'));
    assert.strictEqual($('#stickylayer'), null, 'hidden');
    assert.strictEqual($('[data-act="stickies.toggle"] .badge').textContent, '1', 'badge counts hidden notes');
    click($('[data-act="stickies.toggle"]'));
    await waitFor(() => $('#stickylayer [data-sticky]'), 'shown again');
    click($('#stickylayer [data-act="stickies.remove"]'));
    assert.strictEqual($('#stickylayer [data-sticky]'), null);
    assert.ok($('#toast').textContent.includes('Sticky note deleted.') && $('#toast .toastbtn'), 'the Undo message shows at once');
    await sleep(50); // Undo waits for the delete to be saved anyway
    click($('#toast .toastbtn'));
    await waitFor(() => $('#stickylayer [data-sticky][data-color="pink"]'), 'back after undo');
    click(tab('Today'));
    await waitFor(() => !$('#stickyfab'), 'no note buttons outside project pages');
  });

  await step('Esc leaves Edit layout mode', async () => {
    w.FT.state.editLayout = true;
    w.FT.render();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(w.FT.state.editLayout, false);
  });

  /** The Drive link in Settings, then close the dialog. */
  async function driveLinkInSettings() {
    click($('#settingsBtn'));
    const link = await waitFor(() => $('#dlg-drive'), 'settings dialog');
    const found = { href: link.href, text: link.textContent };
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'settings closed');
    return found;
  }

  await step('Settings holds the Drive folder link and a light / dark / computer theme choice', async () => {
    assert.strictEqual($('#driveLink'), null, 'no folder icon in the header any more');
    click($('#settingsBtn'));
    await waitFor(() => $('#dlg-drive'), 'settings');
    assert.ok($('#dlg-drive').textContent.includes('Personal folder'));
    assert.strictEqual($('#dlg-drive').getAttribute('target'), '_blank');
    assert.strictEqual($('input[name="dlg-theme"]:checked').value, '', 'same as computer by default');
    const dark = $('input[name="dlg-theme"][value="dark"]');
    dark.checked = true; dark.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.strictEqual(d.documentElement.dataset.theme, 'dark', 'applies at once');
    assert.strictEqual(w.localStorage.getItem('ft.theme'), 'dark');
    const light = $('input[name="dlg-theme"][value="light"]');
    light.checked = true; light.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.strictEqual(d.documentElement.dataset.theme, 'light');
    const system = $('input[name="dlg-theme"][value=""]');
    system.checked = true; system.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.strictEqual(d.documentElement.dataset.theme, undefined);
    assert.strictEqual(w.localStorage.getItem('ft.theme'), null);
    click($('#dlg-submit'));
  });

  await step('Settings keeps a favourite whiteboard tool on this device', async () => {
    click($('#settingsBtn'));
    const select = await waitFor(() => $('#dlg-wbtool'), 'whiteboard tool setting');
    assert.strictEqual(select.value, '', 'none by default');
    assert.ok(Array.from(select.options).some((o) => o.value === 'freedraw' && o.textContent === 'Draw'));
    setVal(select, 'rectangle', 'change');
    assert.strictEqual(w.localStorage.getItem('ft.whiteboard.tool'), 'rectangle');
    click($('#dlg-submit'));
    click($('#settingsBtn'));
    assert.strictEqual((await waitFor(() => $('#dlg-wbtool'), 'reopened')).value, 'rectangle', 'shown again next time');
    setVal($('#dlg-wbtool'), '', 'change');
    assert.strictEqual(w.localStorage.getItem('ft.whiteboard.tool'), null);
    click($('#dlg-submit'));
  });

  await step('Settings starts with Undo, Redo and Back, and "When the app opens" picks Today or the page you were on', async () => {
    click($('#settingsBtn'));
    await waitFor(() => $('.dialog'), 'settings');
    assert.deepStrictEqual($$('.dialog .settingsec').map((s) => s.dataset.section).slice(0, 2), ['history', 'data'], 'Undo, Redo and Back come first');
    assert.deepStrictEqual($$('.dialog .historyrow button').map((b) => b.id), ['undoBtn', 'redoBtn', 'backBtn']);
    assert.ok(!$('#backBtn').disabled, 'there is a page to go back to');
    assert.strictEqual($('input[name="dlg-openon"]:checked').value, '', 'the page I was on by default');
    const today = $('input[name="dlg-openon"][value="today"]');
    today.checked = true; today.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.strictEqual(w.localStorage.getItem('ft.openOn'), 'today');
    click($('#dlg-submit'));
    // A fresh start of the page (FT.ready false, as on a page load).
    const restart = async (label) => { w.FT.ready = false; w.FT.boot(); await waitFor(() => w.FT.ready && $('.tab[aria-current="page"]'), label); };
    click(tab('Lists'));
    await restart('reopened');
    assert.strictEqual($('.tab[aria-current="page"]').textContent, 'Today', 'opens on Today');
    click($('#settingsBtn'));
    await waitFor(() => $('input[name="dlg-openon"]'), 'settings');
    const last = $('input[name="dlg-openon"][value=""]');
    last.checked = true; last.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.strictEqual(w.localStorage.getItem('ft.openOn'), null);
    click($('#dlg-submit'));
    click(tab('Lists'));
    await restart('reopened');
    assert.strictEqual($('.tab[aria-current="page"]').textContent, 'Lists', 'opens on the page it was on');
    click($('#settingsBtn'));
    await waitFor(() => $('#backBtn'), 'settings');
    click($('#backBtn'));
    assert.strictEqual($('.dialog'), null, 'Back closes Settings');
    await waitFor(() => $('.tab[aria-current="page"]').textContent !== 'Lists', 'went back');
  });

  await step('whiteboards: make two named boards, rename one, remove one with Undo', async () => {
    click(tab('Projects'));
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan')), 'row'));
    for (const name of ['Duct route', 'Wiring']) {
      click(await waitFor(() => $('[data-act="whiteboard.new"]'), 'new button'));
      await waitFor(() => $('#dlg-boardname'), 'name dialog');
      setVal($('#dlg-boardname'), name);
      $('#dlg-boardname').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitFor(() => !$('.dialog') && $$('.wblist .wbname').some((b) => b.textContent === name), name + ' listed');
      // Creating a board opens it from a setTimeout(0) once the server replies, so wait for the shell instead of checking once.
      const shell = await waitFor(() => $('#wb-shell'), 'whiteboard opened');
      // Nothing was drawn, so "Close without saving" closes without asking; "Save and close" for the other one.
      click(shell.querySelector('[data-act="' + (name === 'Wiring' ? 'whiteboard.discard' : 'whiteboard.close') + '"]'));
      await waitFor(() => !$('#wb-shell') && !$('.dialog'), 'whiteboard closed');
    }
    click($$('.wblist li').find((li) => li.textContent.includes('Wiring')).querySelector('[data-act="whiteboard.rename"]'));
    await waitFor(() => $('#dlg-boardname'), 'rename dialog');
    setVal($('#dlg-boardname'), 'Wiring diagram');
    click($('#dlg-submit'));
    await waitFor(() => $$('.wblist .wbname').some((b) => b.textContent === 'Wiring diagram'), 'renamed');
    click($$('.wblist li').find((li) => li.textContent.includes('Duct route')).querySelector('[data-act="whiteboard.remove"]'));
    assert.ok(!$$('.wblist .wbname').some((b) => b.textContent === 'Duct route'), 'gone at once');
    await waitFor(() => $('#toast .toastbtn'), 'undo offer');
    click($('#toast .toastbtn'));
    await waitFor(() => $$('.wblist .wbname').map((b) => b.textContent).join('|') === 'Duct route|Wiring diagram', 'back after undo');
  });

  await step('a list linked to a project shows on that project\'s page, and the Lists tab says so', async () => {
    const bathroom = w.FT.store.projects.find((p) => p.name === 'Bathroom extractor fan');
    click(tab('Lists'));
    click(await waitFor(() => $('.listpanel [data-act="lists.settings"]'), 'settings button'));
    const select = await waitFor(() => $('#dlg-listproject'), 'linked project field');
    assert.strictEqual(select.value, '', 'not linked yet');
    assert.strictEqual(select.options[0].textContent, 'No project');
    setVal(select, bathroom.id, 'change');
    click($('#dlg-submit'));
    const badge = await waitFor(() => !$('.dialog') && $('.listpanel [data-act="lists.openProject"]'), 'linked badge at once');
    assert.strictEqual(badge.textContent, 'Bathroom extractor fan');
    const listName = $('.listpanel .listname').value;
    await waitFor(() => JSON.parse(JSON.stringify(server.run('bootstrap()').data.lists)).some((l) => l.project_id === bathroom.id), 'link saved');
    click(badge);
    await waitFor(() => w.FT.state.view === 'project' && $$('#app .listpanel .label').some((l) => l.textContent === listName), 'list panel on the project page');
    assert.ok($('#app .listpanel .board[data-owner]'), 'with its items');
    assert.ok($$('#app .lcell .label').some((l) => l.textContent === 'Whiteboards'), 'next to the project\'s own panels');
  });

  await step('Whiteboards tab: every board, filter by project, a board without a project, shown on Today with its thumbnail', async () => {
    click(tab('Whiteboards'));
    await waitFor(() => $('[data-act="whiteboard.new"][data-pick]'), 'whiteboards tab');
    const names = () => $$('.wblist .wbname').map((b) => b.textContent).sort();
    assert.deepStrictEqual(names(), ['Duct route', 'Wiring diagram'], 'the boards made on the project page');
    assert.ok($$('.wblist .wbmeta').some((m) => m.textContent === 'Bathroom extractor fan'), 'each says its project');
    assert.ok($$('.wblist .wbthumb .wbph').length === 2, 'boards without a thumbnail show a placeholder');
    click($('[data-act="whiteboard.new"][data-pick]'));
    const project = await waitFor(() => $('#dlg-boardproject'), 'project field');
    assert.strictEqual(project.value, '', 'no project by default');
    setVal($('#dlg-boardname'), 'Ideas');
    click($('#dlg-submit'));
    const shell = await waitFor(() => $('#wb-shell'), 'opened');
    assert.ok(shell.querySelector('h2').textContent === 'Ideas', 'no project in the title');
    click(shell.querySelector('[data-act="whiteboard.discard"]'));
    await waitFor(() => !$('#wb-shell'), 'closed');
    const boards = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.whiteboard));
    const ideas = boards().find((b) => b.name === 'Ideas');
    assert.strictEqual(ideas.project_id, '');
    assert.deepStrictEqual(names(), ['Duct route', 'Ideas', 'Wiring diagram']);
    assert.ok($$('.wblist li').find((li) => li.textContent.includes('Ideas')).textContent.includes('No project'));

    setVal($('#wb-filter'), 'none', 'change');
    assert.deepStrictEqual(names(), ['Ideas']);
    const bathroom = w.FT.store.projects.find((p) => p.name === 'Bathroom extractor fan');
    setVal($('#wb-filter'), bathroom.id, 'change');
    assert.deepStrictEqual(names(), ['Duct route', 'Wiring diagram']);
    assert.strictEqual($('[data-act="whiteboard.new"][data-pick]').dataset.project, bathroom.id, 'a new board starts on the filtered project');
    setVal($('#wb-filter'), '', 'change');
    assert.strictEqual(names().length, 3);

    const chip = () => $$('.wblist li').find((li) => li.textContent.includes('Ideas')).querySelector('[data-act="whiteboard.today"]');
    assert.strictEqual(chip().getAttribute('aria-pressed'), 'false');
    click(chip());
    assert.strictEqual(chip().getAttribute('aria-pressed'), 'true', 'shown at once');
    await waitFor(() => boards().find((b) => b.id === ideas.id).show_today === 'yes', 'saved');

    click(tab('Today'));
    const panel = await waitFor(() => $$('#app .wbtodaypanel').find((p) => p.textContent.includes('Whiteboard: Ideas')), 'Today panel');
    assert.ok(panel.querySelector('.wbthumb .wbph'), 'a placeholder while it has no thumbnail');
    click(panel.querySelector('.wbthumb'));
    await waitFor(() => $('#wb-shell'), 'a click opens the board');
    click($('#wb-shell [data-act="whiteboard.discard"]'));
    await waitFor(() => !$('#wb-shell'), 'closed');

    // A thumbnail saved elsewhere (another device) comes in after the page is drawn, through its own call.
    const thumb = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAEX/I/of';
    const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r1', type: 'rectangle' }], appState: {}, files: {} });
    server.run('rpc')('whiteboard', 'save', { id: ideas.id, json: scene, thumb }, 'personal');
    await w.FT.reload();
    const img = await waitFor(() => $('#app .wbtodaypanel .wbthumb img'), 'thumbnail on Today');
    assert.strictEqual(img.getAttribute('src'), thumb);
    click(tab('Whiteboards'));
    await waitFor(() => $$('.wblist li').find((li) => li.textContent.includes('Ideas')).querySelector('.wbthumb img'), 'and on the Whiteboards tab, from memory');
    click(chip());
    click(tab('Today'));
    assert.ok(!$$('#app .wbtodaypanel').some((p) => p.textContent.includes('Ideas')), 'off Today at once');
    await waitFor(() => boards().find((b) => b.id === ideas.id).show_today === '', 'saved');
  });

  await step('switching to Work shows separate data, a blue accent and its own Drive folder', async () => {
    const personalFolder = (await driveLinkInSettings()).href;
    assert.strictEqual(d.body.dataset.mode, 'personal');
    assert.deepStrictEqual(Array.from($('#modeSelect').options).filter((o) => !o.disabled).map((o) => o.textContent), ['Personal', 'Work', '+ New mode…']);
    setVal($('#modeSelect'), 'work', 'change');
    await waitFor(() => d.body.dataset.mode === 'work' && $('.panel .empty'), 'work loaded');
    assert.strictEqual(w.localStorage.getItem('ft.mode'), 'work');
    const workFolder = await driveLinkInSettings();
    assert.notStrictEqual(workFolder.href, personalFolder);
    assert.ok(workFolder.text.includes('Work folder'));
    click(tab('Projects'));
    await waitFor(() => $('[data-act="projects.add"]'), 'work projects tab');
    assert.strictEqual($$('tr.row').length, 0);
    assert.deepStrictEqual($$('.catrow input').map((i) => i.value), ['Delivery', 'Ops', 'Learning', 'Career', 'Admin']);
    click($('[data-act="projects.add"]'));
    await waitFor(() => $('#dlg-name'), 'add dialog');
    setVal($('#dlg-name'), 'Wiz tickets');
    click($('#dlg-submit'));
    await waitFor(() => $('.board'), 'work project page');
    click(tab('Today'));
    await waitFor(() => $('.focus-name') && $('.focus-name').textContent === 'Wiz tickets', 'work focus');
    assert.ok(!$('.small-tasks .habit'), 'work mode has no habits');
    setVal($('#modeSelect'), 'personal', 'change');
    await waitFor(() => d.body.dataset.mode === 'personal' && $('.focus-name') && $('.focus-name').textContent !== 'Wiz tickets', 'personal back');
    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length === 7, 'personal projects unchanged');

    // the status filter is kept per mode
    pickStatus('paused', true);
    const paused = projectNames();
    assert.ok(paused.length < 7);
    w.localStorage.setItem('ft.projects.status.work', '["done","nonsense"]');
    setVal($('#modeSelect'), 'work', 'change');
    await waitFor(() => d.body.dataset.mode === 'work' && $('.focus-name'), 'work again');
    click(tab('Projects'));
    await waitFor(() => $('#pj-status'), 'work projects tab');
    assert.strictEqual($('#pj-status').textContent.replace('▾', ''), 'done', 'work has its own saved choice, unknown statuses dropped');
    assert.ok($('.panel .empty').textContent.includes('No projects match'), 'Wiz tickets is active, so hidden');
    click($('[data-act="projects.clear"]'));
    assert.strictEqual(w.localStorage.getItem('ft.projects.status.work'), null);
    setVal($('#modeSelect'), 'personal', 'change');
    await waitFor(() => d.body.dataset.mode === 'personal' && $('.focus-name'), 'personal again');
    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length === paused.length, 'personal choice read back');
    assert.deepStrictEqual(projectNames(), paused);
    click($('[data-act="projects.clear"]'));
    await waitFor(() => $$('tr.row').length === 7, 'all again');
  });

  await step('a new mode can be made from the mode menu and opens with its own data and accent', async () => {
    setVal($('#modeSelect'), '__new', 'change');
    await waitFor(() => $('#dlg-modename'), 'new mode dialog');
    assert.strictEqual($('#modeSelect').value, 'personal', 'the menu goes back to the current mode');
    setVal($('#dlg-modename'), 'Work');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('already a mode called Work'), 'duplicate refused');
    setVal($('#dlg-modename'), 'Side projects');
    click($('#dlg-submit'));
    await waitFor(() => d.body.dataset.mode === 'side-projects' && $('#app .panel'), 'new mode open');
    assert.strictEqual(d.body.dataset.accent, '5');
    assert.strictEqual($('#modeSelect').value, 'side-projects');
    assert.ok((await driveLinkInSettings()).text.includes('Side projects folder'));
    click(tab('Projects'));
    await waitFor(() => $$('.catrow input').length === 1, 'starts with one category');
    assert.strictEqual($$('.catrow input')[0].value, 'General');
    assert.strictEqual($$('tr.row').length, 0);
    setVal($('#modeSelect'), 'personal', 'change');
    await waitFor(() => d.body.dataset.mode === 'personal' && !d.body.dataset.accent, 'back to personal');
  });

  assert.deepStrictEqual(errors, [], 'no uncaught page errors');
  console.log('\n' + passed + ' browser steps passed');
  dom.window.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FAIL\n' + (e.stack || e)); process.exit(1); });
