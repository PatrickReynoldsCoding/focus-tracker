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
      // A phone-sized screen when a step sets w.__narrow (the page reads .matches each time it draws).
      w.matchMedia = (q) => ({ get matches() { return !!w.__narrow && /max-width: 760px/.test(q); }, addEventListener() {} });
      w.scrollTo = () => {}; w.scrollBy = () => {};
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
  // The Projects tab reopens the project last shown in it; "‹ All projects" then goes to the list.
  const showAllProjects = () => {
    click(tab('Projects'));
    const allProjects = $('[data-act="core.tab"][data-list]');
    if (allProjects) click(allProjects);
  };

  let passed = 0;
  async function step(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

  await step('loads and shows tabs and today\'s focus', async () => {
    await waitFor(() => $('.focus-name'), 'focus name');
    assert.deepStrictEqual($$('.tab').map((t) => t.textContent), ['Today', 'Projects', 'Notes', 'Whiteboards', 'Insights']);
    assert.strictEqual($('.focus-name').textContent, 'CV and portfolio', 'Wednesday leads with job, longest untouched first');
    assert.ok($('.timer') === null);
  });

  await step('next action is hidden by default (Today, the Projects table and its search, the project page, Finish session); Settings → Show turns it on for the mode', async () => {
    const savedDefault = () => (JSON.parse(JSON.stringify(server.run('bootstrap()').data.layout))['project.view'] || {}).nextAction;
    assert.ok(!$('#app .next'), 'not on Today\'s focus');
    click($('[data-act="today.start"]'));
    await waitFor(() => $('[data-act="today.finish"]'), 'a session');
    click($('[data-act="today.finish"]'));
    await waitFor(() => $('#dlg-where'), 'finish dialog');
    assert.ok(!$('#dlg-next'), 'Finish session asks only where you stopped');
    click($('#dlg-discard'));
    await waitFor(() => $('#dlg-submit') && $('#dlg-submit').textContent === 'Delete session', 'delete the session instead');
    click($('#dlg-submit'));
    await waitFor(() => !$('[data-act="today.finish"]') && !JSON.parse(JSON.stringify(server.run('bootstrap()').data.today)).session, 'no session left');
    showAllProjects();
    await waitFor(() => $$('tr.row').length, 'project rows');
    assert.ok($('table.ptable').classList.contains('nonext'), 'no Next action column');
    assert.ok($$('td.pnext').every((td) => td.textContent === ''));
    assert.strictEqual($('#pj-text').placeholder, 'Search projects');
    setVal($('#pj-text'), 'duct');
    assert.deepStrictEqual($$('tr.row'), [], 'search does not find a hidden next action');
    setVal($('#pj-text'), '');
    click($('.rowlink'));
    await waitFor(() => $('.phead'), 'project page');
    assert.ok(!$('.phead ~ .next'), 'not on the project page');

    click($('#settingsBtn'));
    await waitFor(() => $('input[name="dlg-nextaction"]'), 'Settings has the default');
    assert.deepStrictEqual($$('input[name="dlg-nextaction"]').map((r) => [r.value, r.checked]), [['shown', false], ['hidden', true]]);
    const show = $('input[name="dlg-nextaction"][value="shown"]');
    show.checked = true; show.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok($('.phead ~ .next'), 'the page behind shows it at once');
    await waitFor(() => savedDefault() === 'shown', 'saved for the mode');
    click($('#dlg-submit'));
    click(tab('Today'));
    await waitFor(() => $('#app .next'), 'Today\'s focus shows it too');
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

  const personalData = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data));

  await step('projects tab shows active projects first time; Clear shows every project, and the choice reaches the mode\'s Settings', async () => {
    showAllProjects();
    await waitFor(() => $$('tr.row').length === 6, '6 active rows');
    assert.strictEqual($('#pj-status').textContent.replace('▾', ''), 'active', 'Active is picked by default');
    assert.ok(!$$('tr.row').some((r) => r.textContent.includes('Garden fence repair')), 'the paused project is filtered out');
    click($('[data-act="projects.clear"]'));
    assert.strictEqual($$('tr.row').length, 7, 'every project at once');
    await waitFor(() => personalData().layout['projects.view'] && personalData().layout['projects.view'].status.length === 0, 'all statuses saved for the mode');
    assert.strictEqual(server.ss.sheets.Settings.rows.find((r) => r[0] === 'layout.projects.view')[1], '{"status":[]}', 'one readable Settings row');
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
    await waitFor(() => JSON.stringify(personalData().layout['projects.view'].status) === '["active","paused"]', 'remembered for this mode, on the server');
    assert.strictEqual(personalData().layout['projects.view'].status.join(), 'active,paused');
    assert.strictEqual(JSON.parse(JSON.stringify(server.run("bootstrap('work')").data.layout))['projects.view'], undefined, 'not for the other mode');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual($('#pj-status-pop'), null, 'Escape closes it');
    assert.strictEqual(d.activeElement, $('#pj-status'), 'and puts focus back on the button');
    click($('#pj-status'));
    click($('.tophead .label'));
    assert.strictEqual($('#pj-status-pop'), null, 'a click elsewhere closes it');
    assert.ok(!$('[data-act="projects.clear"]').disabled);
    click($('[data-act="projects.clear"]'));
    assert.strictEqual(projectNames().length, all);
    await waitFor(() => personalData().layout['projects.view'].status.length === 0, 'Clear shows every status, remembered too');
  });

  await step('opening a project shows header, kanban, notes and resources', async () => {
    click($$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan')));
    await waitFor(() => $('.board'), 'board');
    assert.strictEqual($$('.colname').map((i) => i.value).join('|'), 'To do|Doing|Done');
    assert.strictEqual($$('.kcard').length, 3);
    await waitFor(() => $('.notes-edit') && $('.notes-edit').getAttribute('contenteditable') === 'true' && $('.notes-edit').textContent.includes('100mm'), 'notes loaded');
    assert.ok($$('.lcell .label').some((l) => l.textContent === 'Resources: this project'));
    assert.ok(!$('.nt-link').hidden);
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

  await step('linked projects: a section of the top panel; + Link shows the link at once, the project waits, a click opens the other, Remove has Undo', async () => {
    const fan = w.FT.state.projectId, cv = w.FT.store.projects.find((p) => p.name === 'CV and portfolio').id;
    const serverLinks = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.links));
    const lines = () => $$('.lklist li').map((li) => li.querySelector('span').textContent.trim());
    const toggle = () => $('[data-panel="header"] .psectbtn[data-id="linked"]');
    assert.ok(!$$('.lcell .label').some((l) => l.textContent === 'Linked projects'), 'no Linked projects panel of its own');
    assert.ok(toggle(), 'a Linked projects section in the top panel');
    assert.strictEqual(toggle().getAttribute('aria-expanded'), 'false', 'closed at first');
    assert.ok($('#ps-linked').hidden);
    click(toggle());
    assert.strictEqual(toggle().getAttribute('aria-expanded'), 'true');
    assert.ok(!$('#ps-linked').hidden, 'opens in place');
    assert.ok($('.lklist') === null && $('#ps-linked .empty').textContent === 'No linked projects.');
    click($('[data-act="links.add"]'));
    await waitFor(() => $('.dialog'), 'link dialog');
    assert.deepStrictEqual(Array.from($('#dlg-relation').options).map((o) => o.textContent), ['blocks', 'is blocked by', 'relates to']);
    assert.ok(!Array.from($('#dlg-other').options).some((o) => o.value === fan), 'the project itself is not offered');
    setVal($('#dlg-relation'), 'blockedBy', 'change');
    setVal($('#dlg-other'), cv, 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'the dialog closes');
    assert.deepStrictEqual(lines(), ['Blocked by CV and portfolio (active)'], 'and the link shows');
    assert.strictEqual(toggle().querySelector('.pcount').textContent, '1', 'the button counts the links');
    assert.ok($('.waitbox') && $('.waitbox').textContent.includes('Waiting on CV and portfolio'), 'the header says what it waits on');
    await waitFor(() => serverLinks().some((l) => l.from_id === cv && l.to_id === fan && l.type === 'blocks'), 'saved on the server');
    assert.ok(JSON.parse(JSON.stringify(server.run('bootstrap()').data.today)).ranked.indexOf(fan) === -1, 'and it is out of the focus pick');
    click($('[data-act="links.add"]'));
    await waitFor(() => $('.dialog'), 'link dialog again');
    assert.ok(!Array.from($('#dlg-other').options).some((o) => o.value === cv), 'a project already linked is not offered again');
    click($('#dlg-cancel'));

    click($('[data-act="core.tab"][data-list]'));
    await waitFor(() => $$('tr.row').length, 'project rows');
    const row = $$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan'));
    assert.ok(row.querySelector('.waitmark') && row.querySelector('.waitmark').textContent === 'Waiting', 'the Projects tab marks it');
    assert.strictEqual($$('.waitmark').length, 1);
    click(row);
    await waitFor(() => $('.lklist') && !$('#ps-linked').hidden, 'back on the project, the section still open');
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
    click(toggle());
    assert.ok($('#ps-linked').hidden, 'and closes again');
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

  await step('notes autosave straight into their Google Doc, formatting and all, and can be copied as markdown', async () => {
    const ta = $('.notes-edit');
    assert.ok($$('.nt-bar [data-cmd="foreColor"]').length && $$('.nt-bar [data-cmd="hiliteColor"]').length && $('.nt-bar [data-cmd="underline"]'), 'colours, highlights and underline in the toolbar');
    ta.innerHTML = '<h1>Fan</h1><div>Replacement needs to be <b>100mm</b> <u>exactly</u>.</div><ul><li>Checked the duct: <font color="#d64545">98mm</font></li></ul>';
    ta.dispatchEvent(new w.Event('input', { bubbles: true }));
    ta.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => $('.nt-status').textContent === 'Saved', 'saved');
    const doc = server.docs.docs().find((f) => f.content && f.content.includes('98mm'));
    assert.ok(doc, 'the notes Doc holds the notes');
    assert.ok(doc.content.includes('<h1>Fan</h1>') && doc.content.includes('<b>100mm</b>') && doc.content.includes('<u>exactly</u>') && doc.content.includes('<span style="color: #d64545">98mm</span>'), 'with headings, bold, underline and colour');
    assert.ok(!Object.values(server.drive.files).some((f) => /\.(md|html)$/.test(f.name)), 'and no markdown file or formatted copy beside it');
    const got = JSON.parse(JSON.stringify(server.run('rpc')('notes', 'get', { projectId: w.FT.state.projectId }))).result;
    assert.ok(got.html.includes('<u>exactly</u>') && got.html.includes('<font color="#d64545">98mm</font>'), 'read back with its formatting');
    const file = { content: '# Fan\nReplacement needs to be **100mm** exactly.\n- Checked the duct: 98mm' };
    let copied = null;
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { copied = t; return Promise.resolve(); } } });
    click($('[data-act="notes.copy"]'));
    await waitFor(() => copied !== null, 'copied');
    assert.strictEqual(copied, file.content, 'Copy as markdown gives the file\'s text');
    delete w.navigator.clipboard;
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
    const playedTypes = w.__playedTypes = [];
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
    showAllProjects();
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

  await step('a log line can be edited from the Insights Logs sub-tab, and Today shows the edited text', async () => {
    click(tab('Insights'));
    click(await waitFor(() => subtab('Logs'), 'Logs sub-tab'));
    const row = await waitFor(() => $$('tbody tr').find((r) => r.textContent.includes('Rewrote the opening line')), 'log row');
    click(row.querySelector('[data-act="log.edit"]'));
    await waitFor(() => $('#dlg-where'), 'edit dialog');
    assert.strictEqual($('#dlg-where').value, 'Rewrote the opening line');
    assert.strictEqual($('#dlg-next').value, 'Send to a friend for feedback');
    setVal($('#dlg-where'), 'Rewrote the intro <b>twice</b> https://example.com/draft');
    setVal($('#dlg-next'), 'Send to two friends');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'dialog closed');
    const shown = $$('tbody tr').find((r) => r.textContent.includes('Rewrote the intro'));
    assert.ok(shown && shown.textContent.includes('Send to two friends'), 'new text shown at once');
    assert.ok(shown.textContent.includes('<b>twice</b>') && !shown.children[2].querySelector('b'), 'text is escaped');
    assert.ok(shown.querySelector('a[href="https://example.com/draft"]'), 'link still works');
    const saved = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.log)).some((l) => l.next_action === 'Send to two friends');
    await waitFor(saved, 'saved to the sheet', 4000);
    click($('[data-act="log.edit"]'));
    await waitFor(() => $('#dlg-where'), 'edit dialog again');
    setVal($('#dlg-where'), '');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('Say where'), 'empty text refused');
    click($('#dlg-cancel'));
    click(tab('Today'));
    await waitFor(() => $('.next') && $('.next').textContent.includes('Send to two friends') && $('.lastnote').textContent.includes('Rewrote the intro'), 'Today follows the edit');
  });

  await step('coming back to the Projects tab reopens the project left open there; ‹ All projects goes to the list, which the tab then keeps', async () => {
    const opened = w.FT.store.projects.find((p) => p.name === 'Bathroom extractor fan');
    showAllProjects();
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes(opened.name)), 'its row'));
    await waitFor(() => w.FT.state.view === 'project' && w.FT.state.projectId === opened.id, 'the project is open');
    click(tab('Today'));
    await waitFor(() => $('.focus-name'), 'Today');
    click(tab('Projects'));
    await waitFor(() => w.FT.state.view === 'project' && w.FT.state.projectId === opened.id && $('.phead h2').textContent === opened.name, 'the same project again, not the list');
    assert.strictEqual(tab('Projects').getAttribute('aria-current'), 'page');
    assert.strictEqual(w.localStorage.getItem('ft.projects.open.personal'), opened.id, 'kept on this device for this mode');
    click(tab('Projects'));
    await waitFor(() => w.FT.state.view === 'projects' && $$('tr.row').length, 'the tab pressed again on the project goes to the list');
    click(tab('Today'));
    click(tab('Projects'));
    await waitFor(() => w.FT.state.view === 'projects', 'the list was the last thing shown, so it stays the list');
    click($$('tr.row').find((r) => r.textContent.includes(opened.name)));
    await waitFor(() => w.FT.state.view === 'project', 'open again');
    click($('[data-act="core.tab"][data-list]'));
    await waitFor(() => w.FT.state.view === 'projects' && w.localStorage.getItem('ft.projects.open.personal') === '', '‹ All projects shows the list and forgets the project');
    click(tab('Today'));
    click(tab('Projects'));
    assert.strictEqual(w.FT.state.view, 'projects');
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
    showAllProjects();
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes(before)), 'row'));
    await waitFor(() => $('.phead') && $('.phead').textContent.includes('Skipped 1 time'), 'skip count on the project');
    assert.ok(skipped);
  });


  // ---------- notes on the Notes tab and on Today ----------
  const projectNamed = (name) => JSON.parse(JSON.stringify(server.run('bootstrap()').data.projects)).find((p) => p.name === name);
  const notesOf = (id) => JSON.parse(JSON.stringify(server.run('rpc')('notes', 'get', { projectId: id }))).result.text;
  const noteText = (id) => JSON.parse(JSON.stringify(server.run('rpc')('notes', 'get', { listId: id }))).result.text;
  const editorOf = (key) => $('#app .notes-edit[data-project="' + key + '"]');
  const typeInto = (key, html) => { const ed = editorOf(key); ed.innerHTML = html; ed.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const statusOf = (key) => $('#nt-status-' + key);
  const errandsDoc = () => server.docs.docs().find((f) => f.name === 'Errands');
  const errandsNote = () => (w.FT.store.lists || []).find((l) => l.kind === 'note' && l.name === 'Errands');
  const rowsOfTabNow = (name) => { const sh = server.ss.sheets[name]; return sh ? sh.rows.slice(1).map((r) => Object.fromEntries(sh.rows[0].map((h, i) => [h, r[i] === undefined ? '' : r[i]]))) : []; };

  await step('the Notes tab: + New note makes a note at once, and typing saves to its own Google Doc named after it', async () => {
    click(tab('Notes'));
    await waitFor(() => $('[data-act="lists.add"][data-kind="note"]'), 'Notes tab');
    assert.strictEqual($('.notes-intro .label').textContent, 'Notes', 'the tab is called Notes');
    click($('[data-act="lists.add"][data-kind="note"]'));
    await waitFor(() => $('#dlg-name'), 'name dialog');
    assert.strictEqual($('#dlg-heading').textContent, 'New note');
    setVal($('#dlg-name'), 'Errands');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && errandsNote(), 'made at once');
    const note = errandsNote();
    assert.ok(editorOf(note.id) && editorOf(note.id).getAttribute('contenteditable') === 'true', 'its editor is on the tab at once');
    assert.ok($('.lcell[data-panel="list-' + note.id + '"] .listname').value === 'Errands', 'with its name to edit in place');
    await waitFor(() => rowsOfTabNow('Lists').some((l) => l.id === note.id && l.kind === 'note'), 'saved as a row of Lists with kind note');
    typeInto(note.id, '<p>Call the plumber about the <b>stopcock</b></p>');
    editorOf(note.id).dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => statusOf(note.id).textContent === 'Saved', 'saved');
    assert.ok(errandsDoc() && errandsDoc().content.includes('<b>stopcock</b>'), 'the Doc "Errands" holds it, formatting and all');
    assert.strictEqual(server.drive.pathOf(errandsDoc()), 'Focus Tracker/Personal/Notes/Errands', 'in the Notes folder');
    assert.strictEqual(noteText(note.id), 'Call the plumber about the **stopcock**');
    assert.ok(!$('#nt-link-' + note.id).hidden && $('#nt-link-' + note.id).href === errandsDoc().getUrl(), '"Open in Docs" links its Doc');
  });

  await step('project notes show on the Notes tab after the notes, lists and to-do lists; the filter hides them, and the choice is kept for the mode', async () => {
    const fan = projectNamed('Bathroom extractor fan');
    await waitFor(() => $('.lcell[data-panel="pnote-' + fan.id + '"]'), 'the fan\'s notes on the Notes tab');
    assert.strictEqual($('.lcell[data-panel="pnote-' + fan.id + '"] .label').textContent, fan.name + ' notes');
    await waitFor(() => editorOf(fan.id) && editorOf(fan.id).textContent.includes('100mm'), 'the same notes as on its page');
    const ids = $$('#app .lcell').map((c) => c.dataset.panel);
    assert.ok(ids.indexOf('list-' + errandsNote().id) < ids.indexOf('pnote-' + fan.id), 'after the Notes tab\'s own');
    const filter = $('[data-change="lists.projectNotes"]');
    assert.ok(filter.checked, 'shown by default');
    filter.checked = false; filter.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok(!$('.lcell[data-panel^="pnote-"]') && editorOf(errandsNote().id), 'hidden at once; the note stays');
    await waitFor(() => (server.ss.sheets.Settings.rows.find((r) => r[0] === 'layout.lists.view') || [])[1] === '{"projectNotes":"off"}', 'kept in the mode\'s Settings');
    click(tab('Today'));
    click(tab('Notes'));
    assert.ok(!$('.lcell[data-panel^="pnote-"]') && !$('[data-change="lists.projectNotes"]').checked, 'still hidden');
    click($('[data-change="lists.projectNotes"]'));
    const again = $('[data-change="lists.projectNotes"]');
    again.checked = true; again.dispatchEvent(new w.Event('change', { bubbles: true }));
    await waitFor(() => $('.lcell[data-panel="pnote-' + fan.id + '"]'), 'shown again');
    await waitFor(() => !w.FT.pendingSaves(), 'saved');
  });

  await step('a note goes on Today through Add feature; typing there saves to the same Doc, apart from the focus project\'s notes', async () => {
    click(tab('Today'));
    const fan = projectNamed('Bathroom extractor fan'), note = errandsNote();
    await waitFor(() => $('.focus-name').textContent === fan.name, 'the fan is the focus');
    assert.ok(!editorOf(note.id), 'not on Today yet');
    click($('#layoutBtn'));
    click($('.editbar [data-act="core.addFeature"]'));
    const row = $$('#dlg-features li').find((li) => li.querySelector('b').textContent === 'Errands');
    assert.ok(row && /Note, shown on Today as its own panel/.test(row.textContent), 'Add feature offers the note');
    const fanRow = $$('#dlg-features li').find((li) => li.querySelector('b').textContent === fan.name + ' notes');
    assert.ok(fanRow && /project's notes/.test(fanRow.textContent), 'and a project\'s notes');
    click(row.querySelector('[data-act="core.addFeatureItem"]'));
    click($('#dlg-submit'));
    click($('#layoutBtn'));
    await waitFor(() => editorOf(note.id) && editorOf(note.id).textContent.includes('plumber'), 'the note on Today');
    assert.strictEqual($('.notelist-panel .label').textContent, 'Errands');
    assert.ok(!editorOf(fan.id), 'not the focus project\'s notes');
    await waitFor(() => rowsOfTabNow('Lists').find((l) => l.id === note.id).show_today === 'yes', 'show_today saved');
    typeInto(note.id, editorOf(note.id).innerHTML + '<p>Buy fuses</p>');
    editorOf(note.id).dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => noteText(note.id).endsWith('Buy fuses'), 'saved to the note\'s Doc');
    assert.ok(!notesOf(fan.id).includes('fuses'), 'the focus project\'s notes are untouched');
    w.FT.go('project', { id: fan.id });
    await waitFor(() => editorOf(fan.id) && editorOf(fan.id).textContent.includes('100mm'), 'the fan\'s page has its own notes');
    assert.ok(!editorOf(note.id));
    click(tab('Today'));
    await waitFor(() => editorOf(note.id) && editorOf(note.id).textContent.includes('fuses'), 'back on Today, the note');
  });

  await step('the notes paper can be Plain, Legal pad, Graph paper or Index card, kept on this device for every notes panel', async () => {
    const picker = $('.nt-paper');
    assert.deepStrictEqual(Array.from(picker.options).map((o) => o.textContent), ['Plain', 'Legal pad', 'Graph paper', 'Index card']);
    assert.strictEqual(picker.value, '', 'plain by default');
    assert.ok(!$('.notes-edit').classList.contains('paper'));
    setVal(picker, 'legal', 'change');
    assert.ok($('.notes-edit').classList.contains('paper') && $('.notes-edit').classList.contains('paper-legal'), 'the pad at once, no redraw');
    assert.strictEqual(w.localStorage.getItem('ft.notes.paper'), 'legal');
    assert.ok(d.getElementById('nt-hand-font'), 'its handwriting font is asked for only now');
    w.FT.go('project', { id: w.FT.store.today.focusId });
    await waitFor(() => w.FT.state.view === 'project' && $('.notes-edit'), 'project page');
    assert.ok($('.notes-edit').classList.contains('paper-legal') && $('.nt-paper').value === 'legal', 'the project page uses it too');
    setVal($('.nt-paper'), 'graph', 'change');
    assert.ok($('.notes-edit').classList.contains('paper-graph') && !$('.notes-edit').classList.contains('paper-legal'));
    setVal($('.nt-paper'), 'card', 'change');
    assert.ok($('.notes-edit').classList.contains('paper-card'));
    setVal($('.nt-paper'), '', 'change');
    assert.ok(!$('.notes-edit').classList.contains('paper') && !$('.notes-edit').className.includes('paper-'), 'Plain again');
    assert.strictEqual(w.localStorage.getItem('ft.notes.paper'), null);
    click(tab('Today'));
    await waitFor(() => $('.notes-edit'), 'Today');
  });

  await step('when Today\'s focus changes, a note on Today stays as it is, typing and all; with no focus it is still there', async () => {
    const fan = projectNamed('Bathroom extractor fan'), note = errandsNote();
    await waitFor(() => editorOf(note.id) && editorOf(note.id).getAttribute('contenteditable') === 'true', 'editable');
    typeInto(note.id, editorOf(note.id).innerHTML + '<p>Typed just before the swap</p>'); // no focusout, inside the save delay
    click($('[data-act="today.swap"]'));
    await waitFor(() => $('#dlg-to'), 'swap dialog');
    const to = $('#dlg-to').options[0];
    const toName = to.textContent.split(' (')[0];
    setVal($('#dlg-to'), to.value, 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $('.focus-name').textContent === toName, 'the new focus');
    assert.ok(editorOf(note.id).textContent.includes('Typed just before the swap'), 'the same note, with what was typed');
    await waitFor(() => noteText(note.id).endsWith('Typed just before the swap'), 'saved to the note\'s Doc');
    assert.ok(!notesOf(fan.id).includes('Typed just before the swap') && !notesOf(to.value).includes('Typed just before the swap'), 'not to either project');

    const today = w.FT.store.today, focusBefore = today.focusId;
    today.focusId = null;
    w.FT.render();
    assert.ok(editorOf(note.id), 'no focus: the note is still there');
    today.focusId = focusBefore;
    w.FT.render();
  });

  await step('a note on Today is cleared by hand and stays the same Doc; it can be removed and added back through Add feature', async () => {
    const doc = errandsDoc(), note = errandsNote();
    typeInto(note.id, '');
    editorOf(note.id).dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => noteText(note.id) === '', 'the cleared note is saved');
    assert.strictEqual(server.docs.docs().filter((f) => f.name === 'Errands').length, 1, 'still one Doc');
    assert.strictEqual(errandsDoc().id, doc.id, 'the same one');
    click($('#layoutBtn'));
    click($('.lcell[data-panel="list-' + note.id + '"] [data-act="core.removePanel"]'));
    assert.ok(!editorOf(note.id), 'removed from Today');
    click($('.editbar [data-act="core.addFeature"]'));
    const row = $$('#dlg-features li').find((li) => li.querySelector('b').textContent === 'Errands');
    assert.ok(row, 'Add feature offers it again');
    click(row.querySelector('[data-act="core.addFeatureItem"]'));
    click($('#dlg-submit'));
    click($('#layoutBtn'));
    await waitFor(() => editorOf(note.id), 'back on Today');
    await waitFor(() => !w.FT.pendingSaves(), 'the layout saved');
  });

  // ---------- habits, to-dos and Plan my week ----------
  const srv = (code) => { const v = server.run('(function () { tableCache_ = {}; return ' + code + '; })()'); return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
  const rowsOfTab = (name) => { const sh = server.ss.sheets[name]; return sh.rows.slice(1).map((r) => Object.fromEntries(sh.rows[0].map((h, i) => [h, r[i] === undefined ? '' : r[i]]))); };
  const habitsNow = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.habits));
  const todosNow = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.todos)).items;
  const TODAY = srv('todayIso_()'), MON = srv('isoMonday_(todayIso_())');
  const plus = (day, n) => srv("isoAddDays_('" + day + "', " + n + ')');
  const habitRow = (name) => $$('.habits-panel .habit').find((r) => r.querySelector('.hname').textContent === name);
  const enter = (el) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  await step('Habits and To-dos are two panels; a dot tap shows at once and reaches the sheet, taps past the dots are extra, − takes one off', async () => {
    click(tab('Today'));
    const row = await waitFor(() => habitRow('Job search'), 'the daily minimum is a habit on Today');
    assert.deepStrictEqual([$('.habits-panel .label').textContent, $('.todos-panel .label').textContent], ['Habits', 'To-dos'], 'two panels, each movable and hideable');
    assert.ok($('.todos-panel [data-act="habits.planWeek"]') && $('.habits-panel [data-act="habits.planWeek"]'), 'Plan my week from either');
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
    assert.ok(!item().querySelector('.when'), 'on Today a to-do for today needs no day under it');
    const box = item().querySelector('input[type="checkbox"]');
    box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok(item().classList.contains('done'), 'struck through at once');
    assert.ok(!item().querySelector('.when'), 'a ticked one shows no day either: the tick says it');
    await waitFor(() => todosNow().find((t) => t.title === 'Grocery shopping').done === TODAY, 'tick saved');
    const addBox = () => $('.todos-panel .todoadd input');
    setVal($('.todos-panel .todoadd select'), '', 'change');
    setVal(addBox(), 'Post parcel');
    enter(addBox());
    assert.ok($$('.todos li').some((li) => li.textContent.includes('Post parcel') && li.textContent.includes('Anytime')), 'shows at once');
    assert.strictEqual(d.activeElement, addBox(), 'the box keeps focus for the next one');
    await waitFor(() => todosNow().some((t) => t.title === 'Post parcel' && t.day === ''), 'added');
    setVal(addBox(), 'Wrong one'); click($('.todos-panel [data-act="todos.addBtn"]'));
    await waitFor(() => todosNow().some((t) => t.title === 'Wrong one'), 'added with the button');
    click($$('.todos li').find((li) => li.textContent.includes('Wrong one')).querySelector('[data-act="todos.remove"]'));
    assert.ok(!$$('.todos li').some((li) => li.textContent.includes('Wrong one')), 'gone at once');
    assert.ok(/To-do deleted/.test($('#toast').textContent) && $('#toast .toastbtn'), 'Undo offered at once');
    await waitFor(() => !todosNow().some((t) => t.title === 'Wrong one'), 'deleted');
    click($('#toast .toastbtn'));
    await waitFor(() => todosNow().some((t) => t.title === 'Wrong one'), 'Undo brings it back');
    await waitFor(() => $$('.todos li').some((li) => li.textContent.includes('Wrong one')), 'on screen too');
  });

  await step('a to-do opens the same card dialog as a list item: title, group, colour and a description, plus its day, project and done', async () => {
    const addBox = $('.todos-panel .todoadd input');
    setVal(addBox, 'Buy stamps'); enter(addBox);
    await waitFor(() => todosNow().some((t) => t.title === 'Buy stamps'), 'a to-do to open');
    const item = () => $$('.todos-panel .todos li').find((li) => li.textContent.includes('Buy stamps'));
    click(item().querySelector('[data-act="todos.open"]'));
    await waitFor(() => $('#dlg-cardtitle'), 'the card dialog');
    assert.strictEqual($('#dlg-heading').textContent, 'To-do');
    assert.ok($('#dlg-cardcolumn') && $('input[name="dlg-color"]') && $('#dlg-note') && $('#dialogRoot .rtbar'), 'title, group, colour and the note editor, as for a card');
    assert.ok($('#dlg-tdday') && $('#dlg-tdproject') && $('#dlg-tddone'), 'and the to-do\'s own fields');
    assert.deepStrictEqual(Array.from($('#dlg-tdday').options).slice(0, 3).map((o) => o.textContent), ['Anytime', 'Today', 'Tomorrow']);
    const fan = projectNamed('Bathroom extractor fan');
    setVal($('#dlg-cardtitle'), 'Buy the stamps');
    $('#dlg-note').innerHTML = '<p>The <b>blue</b> one, by Friday</p>';
    $('input[name="dlg-color"][value="4"]').checked = true;
    setVal($('#dlg-tdday'), TODAY, 'change');
    setVal($('#dlg-tdproject'), fan.id, 'change');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'closes at once');
    const now = $$('.todos-panel .todos li').find((li) => li.textContent.includes('Buy the stamps'));
    assert.ok(now && now.textContent.includes('Bathroom extractor fan') && now.textContent.includes('The blue one, by Friday') && now.classList.contains('coloured'), 'shown at once, with its project and the start of its description');
    await waitFor(() => todosNow().some((t) => t.title === 'Buy the stamps' && t.day === TODAY && t.project_id === fan.id && t.color === '4' && /<b>blue<\/b>/.test(t.note_html) && t.note === 'The blue one, by Friday'), 'saved, the description cleaned with a plain copy');
    click(now.querySelector('[data-act="todos.open"]'));
    await waitFor(() => $('#dlg-tddone'), 'opened again');
    assert.ok($('#dlg-note').innerHTML.includes('<b>blue</b>') && $('#dlg-tdproject').value === fan.id, 'it opens with what was saved');
    $('#dlg-tddone').checked = true;
    click($('#dlg-submit'));
    await waitFor(() => $$('.todos-panel .todos li.done').some((li) => li.textContent.includes('Buy the stamps')), 'ticked from the dialog');
    await waitFor(() => todosNow().find((t) => t.title === 'Buy the stamps').done === TODAY, 'saved as done');
  });

  await step('to-do lists: + New to-do list on the Notes tab makes another, with groups like a list\'s; Plan my week covers every list', async () => {
    click(tab('Notes'));
    click(await waitFor(() => $('[data-act="lists.add"][data-kind="todo"]'), 'Notes tab'));
    await waitFor(() => $('#dlg-name'), 'name dialog');
    setVal($('#dlg-name'), 'Packing');
    click($('#dlg-submit'));
    const packing = await waitFor(() => !$('.dialog') && w.FT.store.lists.find((l) => l.kind === 'todo' && l.name === 'Packing'), 'made at once');
    const panel = () => $('.lcell[data-panel="list-' + packing.id + '"]');
    assert.ok(panel() && panel().querySelector('.todos-panel .todoadd input'), 'its own panel, with an add box');
    assert.ok(!panel().querySelector('.colhead'), 'one group: no group header');
    const groupBox = () => panel().querySelector('.todoadd input');
    setVal(groupBox(), 'Passport'); enter(groupBox());
    click(panel().querySelector('[data-act="kanban.add-col"]'));
    await waitFor(() => panel().querySelectorAll('.colhead').length === 2, 'two groups: each has its header');
    const groups = () => w.FT.store.kanban.columns.filter((c) => c.owner === packing.id).sort((a, b) => a.order - b.order);
    const second = groups()[1];
    const name = panel().querySelector('.colname[data-id="' + second.id + '"]');
    setVal(name, 'Clothes', 'change');
    const clothesBox = () => panel().querySelector('.todoadd input[data-group="' + second.id + '"]');
    setVal(clothesBox(), 'Rain jacket'); enter(clothesBox());
    assert.ok(panel().querySelector('.todos[data-todo-group="' + second.id + '"]').textContent.includes('Rain jacket'), 'added to that group at once');
    await waitFor(() => todosNow().some((t) => t.title === 'Rain jacket' && t.list_id === packing.id && t.group_id === second.id), 'saved on the list, in the group');
    await waitFor(() => rowsOfTab('To-dos').some((t) => t.title === 'Rain jacket' && t.list === 'Packing' && t.group === 'Clothes'), 'the sheet shows the list and group by name');
    // drag the passport into Clothes
    const sortable = w.__sortables.find((s) => s.el.dataset.todoGroup === second.id);
    const passport = todosNow().find((t) => t.title === 'Passport');
    const li = panel().querySelector('li[data-id="' + passport.id + '"]');
    sortable.el.appendChild(li);
    sortable.opts.onEnd({ item: li, from: panel().querySelector('.todos[data-todo-group="' + groups()[0].id + '"]'), to: sortable.el, oldIndex: 0, newIndex: 1 });
    await waitFor(() => todosNow().find((t) => t.title === 'Passport').group_id === second.id, 'moved by drag and drop');
    // deleting the group moves its to-dos to the first one
    click(panel().querySelector('[data-act="kanban.del-col"][data-id="' + second.id + '"]'));
    await waitFor(() => $('.dialog'), 'confirm');
    assert.ok(/2 items move to "General"/.test($('.dialog').textContent), 'says how many to-dos move');
    click($('#dlg-submit'));
    await waitFor(() => !panel().querySelector('.colhead') && panel().textContent.includes('Rain jacket'), 'one group again, nothing lost');
    await waitFor(() => todosNow().filter((t) => t.list_id === packing.id).every((t) => t.group_id === groups()[0].id), 'moved on the server');
    // Plan my week sees to-dos of every list
    click(tab('Today'));
    click(await waitFor(() => $('.habits-panel [data-act="habits.planWeek"]'), 'Plan my week'));
    await waitFor(() => $('.dialog'), 'Plan my week');
    assert.ok($('.dialog').textContent.includes('Passport') && $('.dialog').textContent.includes('Rain jacket') && $('.dialog').textContent.includes('Grocery shopping'), 'to-dos of every list');
    w.FT.closeDialog();
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

  await step('"Want to go further?": Yes, adjust makes a level change that waits for Accept; Accept and Not now on it; three Not nows ask once to stop; I\'m at my goal stops the prompts', async () => {
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
    assert.ok($('#toast').textContent.includes('Cardio rides: 2 a week, 20 min is ready to accept on Monday. Nothing changes until you accept it.'));
    assert.ok(habitRow('Cardio rides').textContent.includes('2 a week, 20 min to accept on Monday'), 'the row says a change waits');
    const nextMonday = plus(MON, 7);
    await waitFor(() => rowsOfTab('Habit log').some((r) => r.habit_id === id && r.kind === 'pending' && r.day === nextMonday && r.value === '2 a week, 20 min'), 'a pending change for next Monday');
    const log = rowsOfTab('Habit log').filter((r) => r.habit_id === id);
    assert.ok(!log.some((r) => r.kind === 'level' && r.day > TODAY), 'no level row that would change it by itself');
    assert.ok(log.some((r) => r.kind === 'prompt' && r.value === 'yes'));
    assert.strictEqual(habitsNow().habits.find((h) => h.id === id).size, '15 min', 'the habit keeps its size');
    assert.strictEqual(habitsNow().habits.find((h) => h.id === id).next_prompt, plus(TODAY, 7));

    // the change is due (as on Monday): a card with Accept and Not now; nothing changes until Accept
    const due = () => srv("(function () { var t = new Table('Habit log', ['id']); var r = t.all().filter(function (x) { return x.habit_id === '" + id + "' && x.kind === 'pending'; })[0]; t.update(r.id, { day: todayIso_() }); return true; })()");
    due();
    await reload();
    await waitFor(() => $('.levelcard'), 'the Accept card shows');
    assert.ok($('.levelcard').textContent.includes('New level for Cardio rides') && $('.levelcard').textContent.includes('2 a week, 20 min, up from 2 a week, 15 min'));
    click($('.levelcard [data-act="habits.postponeLevel"]'));
    assert.ok(!$('.levelcard'), 'Not now: gone at once');
    await waitFor(() => rowsOfTab('Habit log').some((r) => r.habit_id === id && r.kind === 'pending' && r.day === nextMonday), 'put off to Monday');
    assert.strictEqual(habitsNow().habits.find((h) => h.id === id).size, '15 min', 'still unchanged');
    due();
    await reload();
    await waitFor(() => $('.levelcard'), 'due again');
    click($('.levelcard [data-act="habits.acceptLevel"]'));
    assert.ok(!$('.levelcard') && habitRow('Cardio rides').textContent.includes('20 min'), 'Accept shows the new level at once');
    assert.ok($('#toast').textContent.includes('Cardio rides is 2 a week, 20 min from this week.'));
    await waitFor(() => habitsNow().habits.find((h) => h.id === id).size === '20 min', 'accepted on the server');
    assert.ok(rowsOfTab('Habit log').some((r) => r.habit_id === id && r.kind === 'level' && r.day === MON && r.value === '2 a week, 20 min'), 'its level row, from this Monday');

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

  await step('All habits: active, paused and ended habits grouped with Edit; aspiring ones added with Enter, edited, deleted with Undo, and started', async () => {
    const group = (g) => $$(`.allhabits[data-group="${g}"] li b`).map((b) => b.textContent);
    const idea = (name) => $$('.allhabits[data-group="aspiring"] li').find((x) => x.querySelector('b') && x.querySelector('b').textContent === name);
    const openAll = async () => { click($('.habits-panel [data-act="habits.all"]')); await waitFor(() => $('#ah-body .allhabits'), 'the All habits dialog'); };
    click(tab('Today'));
    await waitFor(() => habitRow('Cardio rides'), 'Today');
    await openAll();
    assert.deepStrictEqual(group('active'), ['Job search', 'Cardio rides']);
    assert.strictEqual($$('.allhabits[data-group="active"] [data-act="habits.edit"]').length, 2, 'each with Edit');
    click($$('.allhabits[data-group="active"] li').find((x) => x.textContent.includes('Cardio rides')).querySelector('[data-act="habits.edit"]'));
    await waitFor(() => $('[data-act="habits.end"]'), 'its edit dialog');
    click($('[data-act="habits.end"]'));
    assert.ok(!habitRow('Cardio rides'), 'ended at once, off Today');
    await waitFor(() => habitsNow().habits.find((h) => h.name === 'Cardio rides').status === 'ended', 'ended on the server');
    await openAll();
    assert.deepStrictEqual([group('active'), group('ended')], [['Job search'], ['Cardio rides']], 'ended ones in their own group');
    assert.ok(!$('.allhabits[data-group="paused"]'), 'no empty Paused group');
    assert.ok(!$('.allhabits[data-group="aspiring"]'), 'no aspiring habits yet');

    setVal($('#ah-new'), 'Learn Spanish'); enter($('#ah-new'));
    assert.deepStrictEqual(group('aspiring'), ['Learn Spanish'], 'an aspiring habit shows at once');
    assert.strictEqual($('#ah-new').value, '', 'the box is emptied');
    assert.strictEqual(d.activeElement.id, 'ah-new', 'and keeps focus for the next one');
    assert.ok($('.dialog'), 'Enter does not close the dialog');
    await waitFor(() => habitsNow().habits.some((h) => h.name === 'Learn Spanish' && h.status === 'aspiring'), 'saved as aspiring');
    assert.ok(!habitRow('Learn Spanish'), 'not on Today');
    setVal($('#ah-new'), 'Juggling'); click($('.ideaadd [data-act="habits.aspire"]'));
    await waitFor(() => habitsNow().habits.some((h) => h.name === 'Juggling'), 'added with the button');

    click(idea('Learn Spanish').querySelector('[data-act="habits.ideaEdit"]'));
    setVal($('#ai-name'), 'Spanish'); setVal($('#ai-desc'), 'For the trip next summer');
    click($('[data-act="habits.ideaSave"]'));
    assert.ok(idea('Spanish') && idea('Spanish').textContent.includes('For the trip next summer'), 'the edit shows at once');
    await waitFor(() => habitsNow().habits.some((h) => h.name === 'Spanish' && h.description === 'For the trip next summer'), 'edit saved');

    click(idea('Juggling').querySelector('[data-act="habits.ideaRemove"]'));
    assert.ok(!idea('Juggling'), 'gone at once');
    assert.ok(/Habit idea deleted/.test($('#toast').textContent) && $('#toast .toastbtn'), 'with Undo');
    await waitFor(() => !habitsNow().habits.some((h) => h.name === 'Juggling'), 'deleted');
    click($('#toast .toastbtn'));
    await waitFor(() => habitsNow().habits.some((h) => h.name === 'Juggling'), 'Undo brings it back');
    await waitFor(() => idea('Juggling'), 'in the list too');

    click(idea('Spanish').querySelector('[data-act="habits.ideaStart"]'));
    await waitFor(() => $('#nh-name'), 'the new-habit steps');
    assert.deepStrictEqual([$('#nh-name').value, $('#nh-desc').value, $('#dlg-submit').textContent], ['Spanish', 'For the trip next summer', 'Start habit'], 'filled in from the idea');
    setVal($('#nh-sessions'), '1'); setVal($('#nh-per'), 'day', 'change'); setVal($('#nh-size'), '10 min');
    click($('#nh-next1')); click($('#nh-next2'));
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && habitRow('Spanish'), 'on Today once started');
    await waitFor(() => (habitsNow().habits.find((h) => h.name === 'Spanish') || {}).status === 'active' && w.FT.pendingSaves() === 0, 'started on the server'); // shown first, saved after
    const sp = habitsNow().habits.find((h) => h.name === 'Spanish');
    assert.deepStrictEqual([sp.status, sp.per, sp.sessions, sp.started, sp.description], ['active', 'day', 1, TODAY, 'For the trip next summer']);
    assert.strictEqual(habitsNow().habits.filter((h) => h.name === 'Spanish').length, 1, 'the same row, not a new one');
    assert.deepStrictEqual(rowsOfTab('Habit log').filter((r) => r.habit_id === sp.id).map((r) => [r.day, r.kind, r.value]), [[TODAY, 'level', '1 a day, 5 min']], 'started low (half the size), with its level row');
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
    showAllProjects();
    await waitFor(() => $$('tr.row').length === 7, 'rows');
    click($$('tr.row').find((r) => r.textContent.includes('Garden fence repair')));
    await waitFor(() => $('[data-act="projects.delete"]'), 'delete button');
    click($('[data-act="projects.delete"]'));
    await waitFor(() => $('.dialog'), 'confirm');
    click($('#dlg-submit'));
    await waitFor(() => $$('tr.row').length === 6, '6 rows');
  });

  await step('the Projects tab has no Categories panel at first; Edit layout → Add feature puts it there for the mode', async () => {
    const projectsLayout = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.layout)).projects || {};
    assert.strictEqual($$('.catrow').length, 0, 'not on the page by default');
    click($('#layoutBtn'));
    click($('.editbar [data-act="core.addFeature"]'));
    const offered = $$('#dlg-features li').find((li) => li.querySelector('b').textContent === 'Categories');
    assert.ok(offered && /rename, recolour/.test(offered.textContent), 'offered in Add feature, with its description');
    click(offered.querySelector('[data-act="core.addFeatureItem"]'));
    const listed = $$('#dlg-features li').find((li) => li.querySelector('b').textContent === 'Categories');
    assert.ok(listed.classList.contains('on') && !listed.querySelector('[data-act="core.addFeatureItem"]'), 'now ticked "On page" (Add feature is one list)');
    click($('#dlg-submit'));
    click($('.editbar [data-act="core.layout"]'));
    assert.deepStrictEqual($$('.catrow input').map((i) => i.value), ['Coding', 'Job search', 'House'], 'on the page at once');
    await waitFor(() => projectsLayout().categorylist && !projectsLayout().categorylist.removed, 'its place reached the server');
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

  const backlogNow = () => JSON.parse(JSON.stringify(server.run('bootstrap')(w.FT.state.mode))).data.backlog;
  const backlogTitles = () => $$('.btable tbody tr').map((r) => r.querySelector('.btitle').textContent);
  const backlogRow = (title) => $$('.btable tbody tr').find((r) => r.querySelector('.btitle').textContent === title);

  await step('Backlog on the Projects tab: add with Enter, edit a title in place, drag to reorder, delete with Undo, Start makes a project', async () => {
    assert.ok(/Nothing in the backlog/.test($('.backlog-panel').textContent), 'an empty Backlog panel on the Projects tab');
    setVal($('#bl-cat'), 'house', 'change');
    ['Shed roof', 'Learn Rust', 'Blog'].forEach((title) => { setVal($('#bl-new'), title); enter($('#bl-new')); });
    assert.deepStrictEqual(backlogTitles(), ['Shed roof', 'Learn Rust', 'Blog'], 'shown at once, in the order added');
    assert.strictEqual(d.activeElement.id, 'bl-new', 'the box keeps focus for the next one');
    assert.strictEqual($$('.backlog-panel .sortbtn').length, 0, 'no sorting by column: the order is dragged');
    await waitFor(() => backlogNow().length === 3, 'saved');
    assert.ok(backlogNow().every((b) => b.category === 'house'));

    click(backlogRow('Blog').querySelector('.btitle'));
    setVal($('#bl-edit'), 'Write a blog');
    enter($('#bl-edit'));
    assert.deepStrictEqual(backlogTitles(), ['Shed roof', 'Learn Rust', 'Write a blog'], 'renamed at once');
    await waitFor(() => backlogNow().some((b) => b.title === 'Write a blog'), 'title saved');

    const body = $('.btable tbody'), sortable = w.__sortables.find((x) => x.el === body);
    assert.ok(sortable, 'the rows can be dragged');
    assert.ok(sortable.opts.delay === 180 && sortable.opts.delayOnTouchOnly, 'a short press first on touch screens');
    const last = body.lastElementChild;
    sortable.opts.onStart({ item: last });
    body.insertBefore(last, body.firstChild);
    sortable.opts.onEnd({ item: last, from: body, to: body, oldIndex: 2, newIndex: 0 });
    assert.deepStrictEqual(backlogTitles(), ['Write a blog', 'Shed roof', 'Learn Rust'], 'moved at once');
    await waitFor(() => backlogNow().map((b) => b.title).join('|') === 'Write a blog|Shed roof|Learn Rust', 'order saved');

    click(backlogRow('Learn Rust').querySelector('[data-act="backlog.remove"]'));
    assert.ok(!backlogRow('Learn Rust'), 'gone at once');
    assert.ok(/Backlog item deleted/.test($('#toast').textContent) && $('#toast .toastbtn'), 'Undo offered at once');
    await waitFor(() => backlogNow().length === 2, 'deleted');
    click($('#toast .toastbtn'));
    await waitFor(() => backlogRow('Learn Rust'), 'Undo brings it back');

    click(backlogRow('Shed roof').querySelector('[data-act="backlog.start"]'));
    await waitFor(() => $('.dialog #dlg-name'), 'Start dialog');
    assert.strictEqual($('#dlg-name').value, 'Shed roof');
    assert.strictEqual($('#dlg-category').value, 'house', 'the item\'s category');
    setVal($('#dlg-next'), 'Measure the roof');
    click($('#dlg-submit'));
    await waitFor(() => w.FT.state.view === 'project' && w.FT.project(w.FT.state.projectId).name === 'Shed roof', 'the new project opens');
    assert.strictEqual(w.FT.project(w.FT.state.projectId).next_action, 'Measure the roof');
    assert.ok(!backlogNow().some((b) => b.title === 'Shed roof'), 'off the backlog');
    await w.FT.undo();
    assert.ok(backlogNow().some((b) => b.title === 'Shed roof') && !w.FT.store.projects.some((p) => p.name === 'Shed roof'), 'Undo puts it back on the backlog');
    click(tab('Projects'));
    await waitFor(() => backlogTitles().join('|') === 'Write a blog|Shed roof|Learn Rust', 'in its place again');
  });

  const serverProject = (id) => JSON.parse(JSON.stringify(server.run('bootstrap()').data.projects)).find((p) => p.id === id);
  const serverCategories = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.categories));
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

  await step('the category in the projects table opens a picker: arrow keys move, Escape closes, a pick changes it at once and on the server', async () => {
    showAllProjects();
    const fan = w.FT.store.projects.find((p) => p.name === 'Bathroom extractor fan');
    const pickerButton = () => $(`[data-act="projects.pickCategory"][data-id="${fan.id}"]`);
    assert.strictEqual(pickerButton().getAttribute('aria-haspopup'), 'menu');
    click(pickerButton());
    assert.strictEqual(pickerButton().getAttribute('aria-expanded'), 'true');
    const items = $$('#pj-menu [role^="menuitem"]');
    assert.deepStrictEqual(items.map((i) => i.textContent), w.FT.categories().map((c) => c.label).concat(['New category…']), 'every category, then New category…');
    assert.strictEqual(d.activeElement, $('#pj-menu [aria-checked="true"]'), 'focus on the current category');
    assert.strictEqual(d.activeElement.dataset.category, 'house');
    key(d.activeElement, 'End');
    assert.strictEqual(d.activeElement.textContent, 'New category…');
    key(d.activeElement, 'ArrowDown');
    assert.strictEqual(d.activeElement, items[0], 'wraps round');
    key(d.activeElement, 'Escape');
    assert.ok(!$('#pj-menu') && d.activeElement === pickerButton(), 'Escape closes it and focus goes back');
    assert.strictEqual(w.FT.state.view, 'projects', 'and the row did not open');
    click(pickerButton());
    click($('#pj-menu [data-category="coding"]'));
    assert.ok(!$('#pj-menu'), 'the menu closes');
    assert.strictEqual(w.FT.state.view, 'projects', 'the row does not open');
    assert.ok($$('tr.row').find((r) => r.textContent.includes(fan.name)).children[1].textContent.startsWith('Coding'), 'shown at once');
    await waitFor(() => serverProject(fan.id).category === 'coding', 'saved');
    click(pickerButton());
    click($('#pj-menu [data-category="house"]'));
    await waitFor(() => serverProject(fan.id).category === 'house' && w.FT.pendingSaves() === 0, 'and back');
    click(pickerButton());
    click($('.tophead .label'));
    assert.ok(!$('#pj-menu'), 'a click elsewhere closes it');
  });

  await step('New category… from the project\'s top panel: a name and a palette colour, made through the categories api and given to the project at once', async () => {
    click($$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan')));
    await waitFor(() => $('.phead'), 'project page');
    const id = w.FT.state.projectId;
    click($('.phead [data-act="projects.pickCategory"]'));
    click($('#pj-menu [data-act="projects.newCategory"]'));
    await waitFor(() => $('#dlg-catlabel'), 'new category dialog');
    assert.strictEqual($$('input[name="dlg-catcolor"]').length, 8, 'the eight palette colours');
    assert.ok($('input[name="dlg-catcolor"]:checked'), 'one picked to start with');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('needs a name'), 'a name is needed');
    setVal($('#dlg-catlabel'), 'Allotment');
    const purple = $('input[name="dlg-catcolor"][value="5"]');
    purple.checked = true;
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'closes');
    assert.ok($('.phead .pill').textContent === 'Allotment', 'the project shows it at once');
    const made = () => serverCategories().find((c) => c.label === 'Allotment');
    await waitFor(() => made() && serverProject(id).category === made().id, 'made and assigned on the server');
    assert.strictEqual(made().color, '5');
    assert.strictEqual(made().id, w.FT.categories().find((c) => c.label === 'Allotment').id, 'with the id the page gave it');
    click($('#toast .toastbtn'));
    await waitFor(() => !serverCategories().some((c) => c.label === 'Allotment') && serverProject(id).category === 'house', 'Undo takes both back');
    await waitFor(() => $('.phead .pill').textContent === 'House', 'and the page follows');
  });

  await step('the top panel: ⚙ Project settings holds this project\'s Next action (Use default, Show, Hide) and Lock, and the panel cannot be hidden', async () => {
    const more = () => $('.phead [data-act="projects.settings"]');
    const id = w.FT.state.projectId, other = w.FT.store.projects.find((p) => p.id !== id && p.status === 'active');
    const choiceOnServer = () => serverProject(id).show_next_action;
    const items = () => $$('#pj-menu [role^="menuitem"]');
    const pick = (label) => click(items().find((i) => i.textContent === label));
    const savedDefault = () => (JSON.parse(JSON.stringify(server.run('bootstrap()').data.layout))['project.view'] || {}).nextAction;
    assert.ok(more().getAttribute('aria-label').startsWith('Project settings for '));
    assert.ok(!$('#app [data-panel="header"] .actions [data-act="projects.lock"]') && !$('.grid-stack-item[gs-id="header"] .actions [data-act="projects.lock"]'), 'Lock is not a button of its own');
    click(more());
    assert.deepStrictEqual(items().map((i) => i.textContent), ['Use default (shown)', 'Show', 'Hide', 'Lock…']);
    assert.strictEqual(d.activeElement, $('#pj-menu [aria-checked="true"]'), 'focus starts on the current choice');
    assert.strictEqual(d.activeElement.textContent, 'Use default (shown)');
    key(d.activeElement, 'ArrowDown'); key(d.activeElement, 'ArrowDown');
    click(d.activeElement);
    assert.ok(!$('#pj-menu'), 'the menu closes');
    assert.ok(!$('.phead ~ .next'), 'the next action is hidden at once');
    assert.ok($('#toast').textContent.includes('Next action hidden on this project.'));
    await waitFor(() => choiceOnServer() === 'off', 'kept in the project\'s row');
    assert.strictEqual(savedDefault(), 'shown', 'the mode\'s default is unchanged');
    click($('#toast .toastbtn'));
    await waitFor(() => choiceOnServer() === '' && $('.phead ~ .next'), 'Undo: the default again');

    click(more()); pick('Show');
    await waitFor(() => choiceOnServer() === 'on', 'Show is kept for this project');
    click($('#settingsBtn'));
    await waitFor(() => $('input[name="dlg-nextaction"]'), 'Settings');
    const hide = $('input[name="dlg-nextaction"][value="hidden"]');
    hide.checked = true; hide.dispatchEvent(new w.Event('change', { bubbles: true }));
    click($('#dlg-submit'));
    await waitFor(() => savedDefault() === undefined, 'default back to hidden');
    assert.ok($('.phead ~ .next'), 'this project still shows it: its own choice wins');
    click(more());
    assert.deepStrictEqual(items().map((i) => [i.textContent, i.getAttribute('aria-checked')]).slice(0, 3), [['Use default (hidden)', 'false'], ['Show', 'true'], ['Hide', 'false']]);
    click(more());
    assert.ok(!$('#pj-menu'), 'a second press closes it');
    w.FT.go('project', { id: other.id });
    await waitFor(() => w.FT.state.projectId === other.id && $('.phead'), 'another project');
    assert.ok(!$('.phead ~ .next'), 'another project follows the default: hidden');
    showAllProjects();
    await waitFor(() => $$('tr.row').length, 'project rows');
    assert.ok(!$('table.ptable').classList.contains('nonext'), 'the column shows while one project shows its next action');
    const cellOf = (projectId) => $(`tr.row[data-id="${projectId}"] td.pnext`);
    assert.ok(cellOf(id).textContent && !cellOf(other.id).textContent, 'only that project has it');
    w.FT.go('project', { id });
    await waitFor(() => w.FT.state.projectId === id && $('.phead'), 'back on the project');
    click(more()); pick('Use default (hidden)');
    await waitFor(() => choiceOnServer() === '' && !$('.phead ~ .next'), 'Use default: hidden like the rest');
    click($('#settingsBtn'));
    await waitFor(() => $('input[name="dlg-nextaction"]'), 'Settings');
    const show = $('input[name="dlg-nextaction"][value="shown"]');
    show.checked = true; show.dispatchEvent(new w.Event('change', { bubbles: true }));
    click($('#dlg-submit'));
    await waitFor(() => savedDefault() === 'shown' && $('.phead ~ .next'), 'shown by default again for the steps after this one');
    click(more());
    click($('#pj-menu [data-act="projects.lock"]'));
    await waitFor(() => $('#lk-date'), 'the lock dialog');
    assert.ok(!$('#pj-menu'), 'the menu closed first');
    click($('#dlg-cancel'));
    click($('#layoutBtn'));
    assert.ok(!$('#app [data-panel="header"] [data-act="core.removePanel"]'), 'no Remove on the top panel');
    assert.ok($('#app [data-panel="kanban"] [data-act="core.removePanel"]'), 'other panels still have it');
    click($('.editbar [data-act="core.addFeature"]'));
    const featureTitles = $$('#dlg-features li b').map((b) => b.textContent);
    assert.ok(!featureTitles.includes('Linked projects'), 'Add feature does not offer the old Linked projects panel: ' + featureTitles);
    const headerRow = $$('#dlg-features li').find((li) => li.querySelector('b').textContent === 'Project');
    assert.ok(headerRow && headerRow.classList.contains('on') && !headerRow.querySelector('[data-act="core.addFeatureItem"]'), 'the top panel is listed as on the page');
    click($('#dlg-submit'));
    click($('.editbar [data-act="core.layout"]'));
    const layoutBefore = w.FT.store.layout.project;
    w.FT.store.layout.project = { header: { x: 0, y: 10000, w: 12, hidden: true } };
    w.FT.render();
    assert.ok($('#app [data-panel="header"] .phead'), 'a top panel hidden before this change shows again');
    w.FT.store.layout.project = layoutBefore;
    w.FT.render();
    await waitFor(() => w.FT.pendingSaves() === 0, 'saved');
  });

  await step('lists: create one, add groups and items like a vertical board, and show it on Today', async () => {
    click(tab('Notes'));
    await waitFor(() => $('[data-act="lists.add"][data-kind=""]'), 'lists tab');
    click($('[data-act="lists.add"][data-kind=""]'));
    await waitFor(() => $('#dlg-name'), 'new list dialog');
    setVal($('#dlg-name'), 'Keep in mind');
    click($('#dlg-submit'));
    await waitFor(() => $('.plainlist .board.vertical'), 'list board');
    const list = () => $('.plainlist');
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
    await waitFor(() => JSON.parse(JSON.stringify(server.run('bootstrap()').data.lists)).filter((l) => !l.kind)[0].show_today === 'yes', 'saved on the server');
    click(tab('Today'));
    await waitFor(() => $$('#app .plainlist .label').some((l) => l.textContent === 'Keep in mind'), 'list on Today');
    assert.ok($('#app .plainlist').textContent.includes('Tell a story with your commits'));
  });

  await step('a card opens a dialog to rename it, colour it and write a note', async () => {
    const card = $('#app .plainlist .kcard');
    click(card.querySelector('[data-act="kanban.open-card"]'));
    await waitFor(() => $('#dlg-note'), 'card dialog');
    assert.strictEqual($('#dlg-cardtitle').value, 'Tell a story with your commits');
    assert.strictEqual($$('.dialog .rtbar button').length, 15);
    $$('input[name="dlg-color"]').find((r) => r.value === '5').checked = true;
    $('#dlg-note').innerHTML = '<b>Why:</b> reviewers read history<script>alert(1)</script>';
    setVal($('#dlg-cardtitle'), 'Tell a story with commits');
    click($('#dlg-submit'));
    // The note shows at once as typed, then as the server cleaned it: wait for the cleaned one (a race before 2026-10-30).
    await waitFor(() => !$('.dialog') && $('#app .plainlist .kcard .knote') && !$('#app .plainlist .kcard .knote').textContent.includes('alert'), 'cleaned note preview');
    const saved = $('#app .plainlist .kcard');
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
    showAllProjects();
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
    showAllProjects();
    click(await waitFor(() => $('[data-act="projects.add"]'), 'add button'));
    await waitFor(() => $('#dlg-category'), 'project dialog');
    assert.ok($('#dlg-newcategory').hidden, 'name box hidden until asked for');
    setVal($('#dlg-name'), 'Shed roof');
    setVal($('#dlg-category'), '__new', 'change');
    assert.ok(!$('#dlg-newcategory').hidden);
    setVal($('#dlg-newcategory'), 'Outdoor');
    $('#dlg-newcategory').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => !$('.dialog') && $('.phead') && $('.phead').textContent.includes('Outdoor'), 'project with new category');
    showAllProjects();
    await waitFor(() => $$('.catrow input').some((i) => i.value === 'Outdoor'), 'category listed');
  });

  await step('a list can be given a colour, shown on the Lists tab and on Today', async () => {
    click(tab('Notes'));
    click(await waitFor(() => $('.plainlist [data-act="lists.settings"]'), 'settings button'));
    await waitFor(() => $('#dlg-listpreview'), 'settings dialog with preview');
    assert.ok(!$('#dlg-listpreview').classList.contains('tinted'), 'preview starts without colour');
    const green = $$('input[name="dlg-listcolor"]').find((r) => r.value === '6');
    green.checked = true; green.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok($('#dlg-listpreview').classList.contains('tinted') && $('#dlg-listpreview').style.getPropertyValue('--list-c').includes('--cat-6'), 'preview shows the colour');
    setVal($('#dlg-listname'), 'How I work');
    assert.strictEqual($('#dlg-previewname').textContent, 'How I work', 'preview shows the name');
    click($('#dlg-submit'));
    await waitFor(() => $('.plainlist.tinted'), 'tinted on Lists');
    assert.strictEqual($('.plainlist .listname').value, 'How I work');
    assert.ok($('.plainlist.tinted').getAttribute('style').includes('--cat-6'));
    click(tab('Today'));
    await waitFor(() => $('#app .plainlist.tinted'), 'tinted on Today');
    assert.ok($('#app .plainlist [data-act="lists.settings"]'), 'settings on Today too');
    await waitFor(() => { const l = JSON.parse(JSON.stringify(server.run('bootstrap()').data.lists)).filter((l) => !l.kind)[0]; return l.color === '6' && l.name === 'How I work'; }, 'saved');
  });

  await step('a list can show one item at a time on Today, as a quote with its full description', async () => {
    click(tab('Notes'));
    await waitFor(() => $('.plainlist .coladd input'), 'list');
    for (const t of ['Done is better than perfect', 'Sleep on big decisions']) {
      const input = $('.plainlist .coladd input');
      setVal(input, t); input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    const card = $$('.plainlist .kcard').find((c) => c.textContent.includes('Sleep on big decisions'));
    click(card.querySelector('[data-act="kanban.open-card"]'));
    await waitFor(() => $('#dlg-note'), 'card dialog');
    $('#dlg-note').innerHTML = 'Wait one night. <b>Then</b> decide, see https://example.com/sleep';
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'saved note');
    click($('.plainlist [data-act="lists.settings"]'));
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
    await waitFor(() => !$('.dialog') && $('.plainlist .modebadge'), 'badge on the Lists tab');
    assert.ok($('.plainlist .board'), 'the Lists tab still shows the full list for editing');
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
    showAllProjects();
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
    showAllProjects();
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

  const serverToday = () => JSON.parse(JSON.stringify(server.run('bootstrap()').data.today));
  /** Rewrite the saved session as if it started minutesAgo worked minutes ago, then load it in the page. */
  const sessionStartedAgo = async (minutesAgo) => {
    server.run(`(function () {
      var props = PropertiesService.getUserProperties(), s = JSON.parse(props.getProperty('today.state'));
      s.session.start = new Date(Date.now() - ${minutesAgo} * 60000).toISOString(); s.session.pausedMs = 0; s.session.pausedAt = '';
      props.setProperty('today.state', JSON.stringify(s)); })()`);
    await w.FT.reload();
  };

  await step('a session starts with a planned length (25, 50, 90, custom or no limit), counts down, and the choice is remembered', async () => {
    click(tab('Today'));
    const picker = await waitFor(() => $('select[data-change="today.length"]'), 'length picker beside Start session');
    assert.deepStrictEqual(Array.from(picker.options).map((o) => o.textContent), ['25 min', '50 min', '90 min', 'No limit', 'Custom…']);
    assert.strictEqual(picker.value, '25', 'the length used last');
    setVal(picker, 'custom', 'change');
    await waitFor(() => $('#dlg-minutes'), 'custom length dialog');
    setVal($('#dlg-minutes'), '2.5');
    click($('#dlg-submit'));
    await waitFor(() => /whole number/.test($('#dlg-err').textContent), 'a part minute is refused');
    setVal($('#dlg-minutes'), '40');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $('select[data-change="today.length"]').value === '40', 'custom length picked');
    assert.deepStrictEqual(Array.from($('select[data-change="today.length"]').options).map((o) => o.value), ['25', '40', '50', '90', 'none', 'custom']);
    click($('[data-act="today.start"]'));
    await waitFor(() => $('#plan') && /Planned 40 min/.test($('#plan').textContent), 'countdown shows at once');
    assert.ok(/(39|40):\d\d left/.test($('#plan').textContent), $('#plan').textContent);
    await waitFor(() => w.FT.pendingSaves() === 0 && serverToday().session, 'saved');
    assert.strictEqual(serverToday().session.plannedMin, 40);
    assert.strictEqual(serverToday().focusLength, 40, 'remembered for next time');
  });

  await step('the corner timer floats over every page, opens the focus project, drags to a corner, hides and comes back', async () => {
    const corner = await waitFor(() => $('#cornerTimer:not([hidden])'), 'corner timer while a session runs');
    const focusId = w.FT.store.today.session.projectId;
    assert.strictEqual(corner.dataset.corner, 'bottom-left', 'starts bottom left, away from the sticky note buttons');
    assert.strictEqual(corner.querySelector('.ct-name').textContent, w.FT.project(focusId).name);
    await waitFor(() => /^(39|40):\d\d$/.test(corner.querySelector('.ct-clock').textContent) && corner.querySelector('.ct-sub').textContent === 'left of 40 min', 'planned time left');
    click(tab('Notes'));
    await waitFor(() => tab('Notes').getAttribute('aria-current') === 'page', 'Lists');
    assert.ok(!$('#cornerTimer').hidden, 'still there on another tab');
    click(corner.querySelector('.ct-open'));
    await waitFor(() => w.FT.state.view === 'project' && w.FT.state.projectId === focusId, 'a click opens the focus project');
    assert.ok(!$('#cornerTimer').hidden, 'and on project pages');

    // Drag: jsdom does no layout, so the dropped position is given by hand.
    const pointer = (type, x, y) => corner.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    click(tab('Notes'));
    pointer('pointerdown', 20, 740);
    pointer('pointermove', 600, 300);
    assert.ok(corner.classList.contains('dragging') && corner.style.left, 'follows the pointer');
    corner.getBoundingClientRect = () => ({ left: 900, top: 40, width: 120, height: 50 });
    pointer('pointerup', 960, 60);
    click(corner.querySelector('.ct-open'));
    assert.strictEqual(w.FT.state.view, 'lists', 'the click that ends a drag does not open the project');
    assert.strictEqual(corner.dataset.corner, 'top-right', 'snaps to the nearest corner');
    assert.strictEqual(corner.style.left, '', 'no leftover position');
    assert.strictEqual(w.localStorage.getItem('ft.timer.corner'), 'top-right', 'remembered on this device');
    delete corner.getBoundingClientRect;

    click(corner.querySelector('.ct-hide'));
    assert.ok($('#cornerTimer').hidden, '✕ hides it');
    assert.strictEqual(w.localStorage.getItem('ft.timer.hidden'), '1');
    click(tab('Today'));
    click(await waitFor(() => $('[data-act="today.timerShow"]'), 'Show timer in the session panel'));
    await waitFor(() => !$('#cornerTimer').hidden && !$('[data-act="today.timerShow"]'), 'shown again');
    assert.strictEqual(w.localStorage.getItem('ft.timer.hidden'), null);
    click($('#settingsBtn'));
    const hideRadio = await waitFor(() => $('input[name="dlg-cornertimer"][value="hide"]'), 'Settings has the corner timer');
    assert.ok($('input[name="dlg-cornertimer"][value="show"]').checked);
    hideRadio.checked = true; hideRadio.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok($('#cornerTimer').hidden, 'hidden from Settings');
    const showRadio = $('input[name="dlg-cornertimer"][value="show"]');
    showRadio.checked = true; showRadio.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok(!$('#cornerTimer').hidden, 'shown from Settings');
    click($('#dlg-submit'));
  });

  await step('when the planned time is up: the sound, a blinking title, then Keep going (+10 min or no limit)', async () => {
    w.__playedTypes.length = 0;
    await sessionStartedAgo(44.5); // 45 worked minutes, as worked time is rounded up
    await waitFor(() => $('#plan.over') && /Time is up/.test($('#plan').textContent), 'time is up');
    assert.deepStrictEqual($$('#plan button').map((b) => b.textContent), ['Finish', '+10 min', '+25 min', 'No limit']);
    await waitFor(() => d.title.startsWith('⏰ Time is up'), 'alert title');
    assert.ok(w.__playedTypes.includes('sawtooth'), 'the end sound (the chicken) plays');
    assert.strictEqual($('#cornerTimer .ct-clock').textContent, 'Time is up');
    assert.ok($('#cornerTimer').classList.contains('over'));
    click($('[data-act="today.keepGoing"][data-min="10"]'));
    await waitFor(() => $('#plan') && !$('#plan.over') && /Planned 55 min/.test($('#plan').textContent), '10 more minutes from now: 45 worked + 10');
    await waitFor(() => w.FT.pendingSaves() === 0 && serverToday().session.plannedMin === 55, 'saved');
    await waitFor(() => d.title === 'Focus Tracker', 'the title stops blinking');
    await sessionStartedAgo(60);
    click(await waitFor(() => $('[data-act="today.keepGoing"][data-min=""]'), 'time is up again'));
    await waitFor(() => !$('#plan') && $('#cornerTimer .ct-sub').textContent === 'worked', 'no limit: the session just counts up');
    await waitFor(() => w.FT.pendingSaves() === 0 && serverToday().session.plannedMin === null, 'saved');
  });

  await step('Finish session can delete the session after a confirm: no log line, no minutes, next action unchanged', async () => {
    const focusId = w.FT.store.today.session.projectId;
    const nextBefore = w.FT.project(focusId).next_action;
    const logBefore = JSON.parse(JSON.stringify(server.run('bootstrap()').data.log)).length;
    click($('[data-act="today.finish"]'));
    click(await waitFor(() => $('#dlg-discard'), 'Delete this session in the finish dialog'));
    await waitFor(() => /Delete this session\?/.test($('#dlg-heading').textContent), 'asks first');
    click($('#dlg-cancel'));
    assert.strictEqual($('.dialog'), null);
    assert.ok(w.FT.store.today.session, 'Cancel keeps the session');
    click($('[data-act="today.finish"]'));
    click(await waitFor(() => $('#dlg-discard'), 'finish dialog'));
    await waitFor(() => $('#dlg-submit.danger'), 'confirm');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && !$('#timer') && $('#cornerTimer').hidden, 'gone at once');
    assert.ok(/Session deleted/.test($('#toast').textContent));
    await waitFor(() => w.FT.pendingSaves() === 0 && serverToday().session === null, 'gone on the server');
    assert.strictEqual(JSON.parse(JSON.stringify(server.run('bootstrap()').data.log)).length, logBefore, 'no log line');
    assert.strictEqual(w.FT.project(focusId).next_action, nextBefore);
    assert.strictEqual(d.title, 'Focus Tracker');
  });

  await step('sticky notes: add, type, recolour, hide with a count badge, show, delete with undo', async () => {
    showAllProjects();
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

  await step('Settings starts with Undo, Redo and Back; the app opens on Today, on the focus project during a session, or on the page you were on', async () => {
    click($('#settingsBtn'));
    await waitFor(() => $('.dialog'), 'settings');
    assert.deepStrictEqual($$('.dialog .settingsec').map((s) => s.dataset.section).slice(0, 2), ['history', 'data'], 'Undo, Redo and Back come first');
    assert.deepStrictEqual($$('.dialog .historyrow button').map((b) => b.id), ['undoBtn', 'redoBtn', 'backBtn']);
    assert.ok(!$('#backBtn').disabled, 'there is a page to go back to');
    assert.strictEqual($('input[name="dlg-openon"]:checked').value, '', 'Today by default');
    assert.ok(/focus project during a session/.test($('input[name="dlg-openon"][value=""]').parentElement.textContent));
    click($('#dlg-submit'));
    // A fresh start of the page (FT.ready false, as on a page load).
    const restart = async (label) => { w.FT.ready = false; w.FT.boot(); await waitFor(() => w.FT.ready && $('.tab[aria-current="page"]'), label); };
    const currentTab = () => $('.tab[aria-current="page"]') && $('.tab[aria-current="page"]').textContent;
    click(tab('Notes'));
    await restart('reopened');
    assert.strictEqual(currentTab(), 'Today', 'opens on Today');
    w.localStorage.setItem('ft.openOn', 'today'); // saved by the old Settings: the same as the default now
    click(tab('Notes'));
    await restart('reopened');
    assert.strictEqual(currentTab(), 'Today', 'an old "Today" choice still opens on Today');
    w.localStorage.removeItem('ft.openOn');

    click(await waitFor(() => $('[data-act="today.start"]'), 'start'));
    await waitFor(() => w.FT.pendingSaves() === 0 && JSON.parse(JSON.stringify(server.run('bootstrap()').data.today)).session, 'session on the server');
    const sessionProject = w.FT.store.today.session.projectId;
    click(tab('Notes'));
    w.FT.ready = false; w.FT.boot();
    await waitFor(() => w.FT.ready && w.FT.state.view === 'project' && w.FT.state.projectId === sessionProject && $('#timer'), 'opens on the focus project while a session runs');
    server.run('rpc')('today', 'discard', {});
    await w.FT.reload();

    click($('#settingsBtn'));
    await waitFor(() => $('input[name="dlg-openon"]'), 'settings');
    const last = $('input[name="dlg-openon"][value="last"]');
    last.checked = true; last.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.strictEqual(w.localStorage.getItem('ft.openOn'), 'last');
    click($('#dlg-submit'));
    click(tab('Notes'));
    await restart('reopened');
    assert.strictEqual(currentTab(), 'Notes', 'opens on the page it was on');
    click($('#settingsBtn'));
    await waitFor(() => $('#backBtn'), 'settings');
    click($('#backBtn'));
    assert.strictEqual($('.dialog'), null, 'Back closes Settings');
    await waitFor(() => $('.tab[aria-current="page"]').textContent !== 'Notes', 'went back');
  });

  await step('Settings has an AI assistant section: the paragraph to paste, Copy, and Open guide', async () => {
    click($('#settingsBtn'));
    const box = await waitFor(() => $('#dlg-assistant'), 'AI assistant section');
    const order = $$('.dialog .settingsec').map((s) => s.dataset.section);
    assert.ok(order.indexOf('assistant') > order.indexOf('wrapper'), 'after the wrapper site');
    assert.ok(box.readOnly, 'read-only');
    const guideUrl = w.FT.config.guideUrl;
    assert.ok(/^https:\/\/docs\.google\.com\/document\/d\/.+\/edit$/.test(guideUrl), 'the page knows the guide Doc');
    ['I use Focus Tracker', '"Focus Tracker – guide for AI assistants"', guideUrl, '"Personal" or "Work"', 'Never delete rows'].forEach((t) => assert.ok(box.value.includes(t), 'the paragraph says ' + t));
    assert.strictEqual($('#dlg-guide').getAttribute('href'), guideUrl);
    assert.strictEqual($('#dlg-guide').getAttribute('target'), '_blank');
    assert.strictEqual($('#dlg-guide').textContent, 'Open guide');
    let copied = null;
    w.document.execCommand = (cmd) => { if (cmd === 'copy') { const ta = w.document.querySelector('body > textarea'); copied = ta && ta.value; } return cmd === 'copy'; };
    click($('#dlg-assistantcopy'));
    assert.ok(!$('#dlg-assistantcopied').hidden && /^Copied\./.test($('#dlg-assistantcopied').textContent), 'says it copied, at once');
    assert.strictEqual(copied, box.value, 'the paragraph is what is copied');
    w.document.execCommand = () => false;
    click($('#dlg-assistantcopy'));
    assert.ok(/did not allow copying/.test($('#dlg-assistantcopied').textContent), 'a refused copy says what to do');
    delete w.document.execCommand;
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'closed');
  });

  await step('whiteboards: make two named boards, rename one, remove one with Undo', async () => {
    showAllProjects();
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
    click(tab('Notes'));
    click(await waitFor(() => $('.plainlist [data-act="lists.settings"]'), 'settings button'));
    const select = await waitFor(() => $('#dlg-listproject'), 'linked project field');
    assert.strictEqual(select.value, '', 'not linked yet');
    assert.strictEqual(select.options[0].textContent, 'No project');
    setVal(select, bathroom.id, 'change');
    click($('#dlg-submit'));
    const badge = await waitFor(() => !$('.dialog') && $('.plainlist [data-act="lists.openProject"]'), 'linked badge at once');
    assert.strictEqual(badge.textContent, 'Bathroom extractor fan');
    const listName = $('.plainlist .listname').value;
    await waitFor(() => JSON.parse(JSON.stringify(server.run('bootstrap()').data.lists)).some((l) => l.project_id === bathroom.id), 'link saved');
    click(badge);
    await waitFor(() => w.FT.state.view === 'project' && $$('#app .plainlist .label').some((l) => l.textContent === listName), 'list panel on the project page');
    assert.ok($('#app .plainlist .board[data-owner]'), 'with its items');
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
    showAllProjects();
    await waitFor(() => $('[data-act="projects.add"]'), 'work projects tab');
    assert.strictEqual($$('tr.row').length, 0);
    assert.strictEqual($$('.catrow').length, 0, 'the Categories panel was added in Personal only');
    assert.deepStrictEqual(w.FT.categories().map((c) => c.label), ['Delivery', 'Ops', 'Learning', 'Career', 'Admin']);
    click($('[data-act="projects.add"]'));
    await waitFor(() => $('#dlg-name'), 'add dialog');
    setVal($('#dlg-name'), 'Wiz tickets');
    click($('#dlg-submit'));
    await waitFor(() => $('.board'), 'work project page');
    click(tab('Today'));
    await waitFor(() => $('.focus-name') && $('.focus-name').textContent === 'Wiz tickets', 'work focus');
    assert.ok(!$('.habits-panel .habit'), 'work mode has no habits');
    setVal($('#modeSelect'), 'personal', 'change');
    await waitFor(() => d.body.dataset.mode === 'personal' && $('.focus-name') && $('.focus-name').textContent !== 'Wiz tickets', 'personal back');
    showAllProjects();
    await waitFor(() => $$('tr.row').length === 7, 'personal projects unchanged');

    // the status filter is kept per mode, in each mode's Settings
    pickStatus('paused', true);
    const paused = projectNames();
    assert.ok(paused.length < 7);
    await waitFor(() => w.FT.pendingSaves() === 0, 'saved');
    server.run('rpc')('layout', 'saveView', { page: 'projects', view: { status: ['done', 'nonsense'] } }, 'work');
    setVal($('#modeSelect'), 'work', 'change');
    await waitFor(() => d.body.dataset.mode === 'work' && $('.focus-name'), 'work again');
    showAllProjects();
    await waitFor(() => $('#pj-status'), 'work projects tab');
    assert.strictEqual($('#pj-status').textContent.replace('▾', ''), 'done', 'work has its own saved choice, unknown statuses dropped');
    assert.ok($('.panel .empty').textContent.includes('No projects match'), 'Wiz tickets is active, so hidden');
    click($('[data-act="projects.clear"]'));
    await waitFor(() => JSON.parse(JSON.stringify(server.run("bootstrap('work')").data.layout))['projects.view'].status.length === 0, 'cleared in work only');
    setVal($('#modeSelect'), 'personal', 'change');
    await waitFor(() => d.body.dataset.mode === 'personal' && $('.focus-name'), 'personal again');
    showAllProjects();
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
    showAllProjects();
    await waitFor(() => $('[data-act="projects.add"]'), 'its projects tab');
    assert.deepStrictEqual(w.FT.categories().map((c) => c.label), ['General'], 'starts with one category');
    assert.strictEqual($$('tr.row').length, 0);
    setVal($('#modeSelect'), 'personal', 'change');
    await waitFor(() => d.body.dataset.mode === 'personal' && !d.body.dataset.accent, 'back to personal');
  });

  await step('assistant rows: the guide\'s worked example, typed into the sheet, shows on the project page with no problems', async () => {
    // The example's blocker was deleted by an earlier step: the owner makes it in the app again.
    if (!w.FT.store.projects.some((p) => p.name === 'Garden fence repair')) server.run('rpc')('projects', 'create', { name: 'Garden fence repair', category: 'house' });
    const example = JSON.parse(JSON.stringify(server.run('GUIDE_EXAMPLE_')));
    const typed = example.rows.map(({ tab: t, row }) => {
      const sh = server.ss.sheets[t], line = sh.rows[0].map((h) => (row[h] === undefined ? '' : row[h]));
      sh.rows.push(line);
      return { t, line, h: sh.rows[0] };
    });
    w.FT.ready = false; w.FT.boot();
    await waitFor(() => w.FT.ready && w.FT.store.projects.some((p) => p.name === 'Garden irrigation'), 'reloaded with the new project');
    typed.forEach(({ t, line, h }) => {
      assert.strictEqual(line[h.indexOf('problem')] || '', '', t + ' row has no problem: ' + line.join('|'));
      assert.ok(/^[0-9a-f]{8}$/.test(line[h.indexOf('id')]), t + ' row has an id');
    });
    showAllProjects();
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes('Garden irrigation')), 'the project in the table'));
    await waitFor(() => $('.board') && $$('.kcard').length === 3, 'its board with three cards');
    const cards = {};
    $$('.col[data-colid]').forEach((c) => { cards[c.querySelector('.colname').value] = Array.from(c.querySelectorAll('.kcard')).map((k) => k.textContent.trim()).filter(Boolean); });
    assert.deepStrictEqual(Object.keys(cards), ['To do', 'Doing', 'Done']);
    assert.ok(cards['To do'].length === 2 && cards['To do'].some((t) => t.includes('Measure the beds')) && cards['To do'].some((t) => t.includes('Choose a drip kit')));
    assert.ok(cards.Doing.length === 1 && cards.Doing[0].includes('Sketch the layout'));
    const repo = await waitFor(() => $$('.reslist a').find((a) => a.textContent === 'garden-irrigation repo'), 'the repository in Resources');
    assert.strictEqual(repo.getAttribute('href'), 'https://github.com/example/garden-irrigation');
    assert.ok($$('.rgroup').some((g) => g.textContent === 'Code'), 'under the group Code');
    assert.ok($('.waitbox') && $('.waitbox').textContent.includes('Waiting on Garden fence repair'), 'blocked by the existing project');
    await waitFor(() => $('.notes-edit') && $('.notes-edit').getAttribute('contenteditable') === 'true' && $('.notes-edit').textContent.includes('Drip lines on the two back beds'), 'the notes typed in the notes cell are the project\'s notes');
    assert.ok($('.notes-edit').querySelector('h1') && $('.notes-edit').querySelector('li'), 'with their heading and list');
  });

  // ---------- Edit layout: Remove, Add feature, the phone's order, the phone's Today pager ----------
  const serverData = () => JSON.parse(JSON.stringify(server.run('bootstrap')(w.FT.state.mode))).data;
  const LONG_PRESS_WAIT = 450;
  const panelIds = () => $$('#app .lcell').map((c) => c.dataset.panel);
  const featureRow = (title) => $$('#dlg-features li').find((li) => li.querySelector('b').textContent === title);
  const addButton = (title) => featureRow(title).querySelector('[data-act="core.addFeatureItem"]');
  const onPage = (title) => featureRow(title).classList.contains('on') && !addButton(title) && /On page/.test(featureRow(title).textContent);
  /** A touch on el, as a phone sends it: touches for start and move, changedTouches for every kind. */
  const touch = (el, type, x, y) => {
    const e = new w.Event(type, { bubbles: true, cancelable: true });
    e.touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }];
    e.changedTouches = [{ clientX: x, clientY: y }];
    el.dispatchEvent(e);
    return e;
  };
  /** Makes one active project other than the focus a week untouched (on this page only), so "Not touched for a while" shows. */
  const makeOneStale = () => {
    const p = w.FT.store.projects.find((x) => x.status === 'active' && x.id !== w.FT.store.today.focusId);
    p.last_touched = new Date(Date.now() - 8 * 86400000).toISOString();
    w.FT.render();
    return p;
  };

  await step('Edit layout is a text button; Remove takes a panel off, and Add feature is one list that puts it back', async () => {
    click(tab('Today'));
    await waitFor(() => $('.focus-name'), 'Today');
    const btn = $('#layoutBtn');
    assert.ok(!btn.hidden, 'shown on a page with panels');
    assert.strictEqual(btn.textContent, 'Edit layout');
    assert.ok($('#menuLayoutBtn') && $('#menuLayoutBtn').textContent === 'Edit layout', 'the phone menu has it too');
    click(btn);
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'true');
    assert.ok($('.editbar [data-act="core.addFeature"]'), 'Add feature is in the bar');
    assert.ok(!$('[data-act="core.hidePanel"]') && !/Hide/.test($('.editbar').textContent), 'no Hide any more');
    assert.ok($('.lcell[data-panel="rotation"] .pedit [data-act="core.removePanel"]'), 'each panel has Remove');
    click($('.lcell[data-panel="rotation"] [data-act="core.removePanel"]'));
    assert.ok(!panelIds().includes('rotation'), 'gone at once');
    await waitFor(() => (serverData().layout.today || {}).rotation && serverData().layout.today.rotation.removed, 'the remove reached the server');
    click($('.editbar [data-act="core.addFeature"]'));
    assert.strictEqual($('#dlg-heading').textContent, 'Add feature');
    assert.strictEqual($$('#dlg-features .featlist').length, 1, 'one list');
    assert.strictEqual($$('#dlg-features .feathead').length, 0, 'with no headings splitting it');
    assert.ok(/Which category leads/.test(featureRow('Weekly rotation').textContent), 'a removed panel, with its description');
    assert.ok(onPage('Today\'s focus') && onPage('Habits'), 'panels on the page are in the list too, ticked and without Add');
    const rows = $$('#dlg-features li');
    assert.ok(rows.findIndex((li) => li.classList.contains('on')) > rows.indexOf(featureRow('Weekly rotation')), 'what can be added comes first');
    click(addButton('Weekly rotation'));
    assert.ok(panelIds().includes('rotation'), 'back on the page at once');
    assert.ok(onPage('Weekly rotation'), 'and ticked in the list');
    await waitFor(() => !serverData().layout.today.rotation.removed, 'the add reached the server');
    click($('#dlg-submit'));
  });

  await step('Add feature on Today offers every list and whiteboard not on Today, and Add shows it there', async () => {
    const list = await w.FT.rpc('lists', 'create', { name: 'Someday ideas' });
    const board = await w.FT.rpc('whiteboard', 'create', { name: 'Garden plan' });
    click($('.editbar [data-act="core.addFeature"]'));
    assert.ok(/shown on Today/.test(featureRow('Someday ideas').textContent), 'a list not on Today, described');
    assert.ok(featureRow('Whiteboard: Garden plan'), 'a whiteboard not on Today');
    click(addButton('Someday ideas'));
    assert.ok(panelIds().includes('list-' + list.id), 'the list is on Today at once');
    await waitFor(() => serverData().lists.find((l) => l.id === list.id).show_today === 'yes', 'show_today reached the server');
    click(addButton('Whiteboard: Garden plan'));
    assert.ok(panelIds().includes('whiteboard-' + board.id), 'the board is on Today at once');
    await waitFor(() => serverData().whiteboard.find((b) => b.id === board.id).show_today === 'yes', 'the board reached the server');
    assert.ok(onPage('Someday ideas') && onPage('Whiteboard: Garden plan'), 'both are now ticked as on the page');
    click($('#dlg-submit'));
  });

  await step('"Not touched for a while" is a panel: removed and added back like any other', async () => {
    const stale = makeOneStale();
    assert.ok(new RegExp('Not touched for a while:.*' + stale.name).test($('.lcell[data-panel="stale"]').textContent), 'it is a panel on Today');
    click($('.lcell[data-panel="stale"] [data-act="core.removePanel"]'));
    assert.ok(!$('[data-panel="stale"]') && !/Not touched for a while:/.test($('#app').textContent), 'gone at once');
    await waitFor(() => serverData().layout.today.stale && serverData().layout.today.stale.removed, 'the remove reached the server');
    click($('.editbar [data-act="core.addFeature"]'));
    assert.ok(/Shows only when there are some/.test(featureRow('Not touched for a while').textContent));
    click(addButton('Not touched for a while'));
    assert.ok($('.lcell[data-panel="stale"]'), 'back at once');
    await waitFor(() => !serverData().layout.today.stale.removed, 'the add reached the server');
    click($('#dlg-submit'));
  });

  await step('Add feature on a project page offers lists not linked to a project, and Add links one', async () => {
    const list = await w.FT.rpc('lists', 'create', { name: 'Loose ends' });
    const project = w.FT.store.projects.find((p) => p.status === 'active' && !w.FT.lockedUntil(p));
    w.FT.go('project', { id: project.id });
    await waitFor(() => $('.editbar'), 'still editing on the project page');
    click($('.editbar [data-act="core.addFeature"]'));
    assert.ok(/Adding links it to/.test(featureRow('Loose ends').textContent));
    click(addButton('Loose ends'));
    assert.ok(panelIds().includes('list-' + list.id), 'the list is on the project page at once');
    await waitFor(() => serverData().lists.find((l) => l.id === list.id).project_id === project.id, 'the link reached the server');
    click($('#dlg-submit'));
    click($('.editbar [data-act="core.layout"]'));
    assert.ok(!$('.editbar') && !$('.pedit'), 'Done leaves Edit layout');
  });

  await step('desktop: a panel is dragged by its title at any time; Edit layout drags by any part and resizes', async () => {
    const grids = [];
    w.GridStack = { init(opts, el) {
      const handlers = {};
      const grid = { opts, el, handlers, destroy() {}, update(item, place) { grid.updated.push([item.getAttribute('gs-id'), place]); }, updated: [], on(names, fn) { names.split(' ').forEach((n) => { handlers[n] = fn; }); },
        engine: { nodes: $$('#app .grid-stack-item').map((it, i) => ({ id: it.getAttribute('gs-id'), x: 0, y: i * 10, w: 12 })) } };
      grids.push(grid);
      return grid;
    } };
    try {
      click(tab('Today'));
      makeOneStale();
      const grid = grids[grids.length - 1];
      assert.strictEqual(grid.opts.handle, '.panel-handle', 'only the title starts a drag');
      assert.strictEqual(grid.opts.disableResize, true, 'no resizing outside Edit layout');
      assert.ok(!grid.opts.staticGrid, 'but the panels can move');
      const items = $$('#app .grid-stack-item');
      assert.ok(items.length >= 4 && items.every((it) => it.querySelectorAll('.panel-handle').length === 1), 'every panel has one handle');
      assert.strictEqual($('.grid-stack-item[gs-id="focus"] .panel-handle').textContent, 'Today\'s focus', 'the focus moves by its title');
      assert.strictEqual($('.grid-stack-item[gs-id="stale"] .panel-handle').textContent, 'Not touched for a while:', 'the stale banner by its words');
      assert.ok(!$('.grid-stack-item[gs-id="focus"] [data-act="today.start"]').classList.contains('panel-handle'), 'buttons are not handles');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(grid.updated)), [['stale', { x: 0, y: 0 }]], 'a new "Not touched" panel is moved above the rest');
      grid.engine.nodes.find((n) => n.id === 'rotation').y = 0;
      grid.engine.nodes.find((n) => n.id === 'focus').y = 40;
      grid.handlers.dragstart();
      grid.handlers.dragstop();
      await waitFor(() => serverData().layout.today.rotation.y === 0 && serverData().layout.today.focus.y === 40, 'the drag by the title is saved');
      click($('#layoutBtn'));
      const editGrid = grids[grids.length - 1];
      assert.strictEqual(editGrid.opts.handle, '.grid-stack-item-content', 'in Edit layout any part of a panel drags it');
      assert.ok(!editGrid.opts.disableResize, 'and its edges resize it');
      assert.ok($('.grid-stack-item[gs-id="rotation"] .removebtn'), 'with Remove on each panel');
      click($('#layoutBtn'));
    } finally {
      delete w.GridStack;
      w.FT.render();
    }
  });

  await step('phone: Edit layout on Today points to Today settings; ▲ ▼ and Remove order another page, apart from the desktop', async () => {
    const project = w.FT.store.projects.find((p) => p.status === 'active' && !w.FT.lockedUntil(p));
    w.FT.go('project', { id: project.id });
    const desktop = panelIds();
    w.__narrow = true;
    w.FT.go('today');
    click($('#menuLayoutBtn'));
    assert.strictEqual($('#menuLayoutBtn').textContent, 'Done editing layout');
    assert.ok($('.editbar [data-act="core.pagerSettings"]') && /Today settings/.test($('.editbar').textContent), 'Edit layout on a phone\'s Today points to Today settings');
    assert.ok(!$('[data-act="core.movePanel"]') && !$('.editbar [data-act="core.addFeature"]') && $('#app .ppager'), 'no ▲ ▼ for Today: the pills stay');
    w.FT.go('project', { id: project.id });
    const before = panelIds();
    assert.ok(before.length >= 3, 'panels to move: ' + before.join(','));
    assert.ok($('.lcell[data-panel="' + before[0] + '"] [data-act="core.movePanel"][data-d="-1"]').disabled, 'the first cannot go up');
    click($('.lcell[data-panel="' + before[0] + '"] [data-act="core.movePanel"][data-d="1"]'));
    const want = [before[1], before[0]].concat(before.slice(2));
    assert.deepStrictEqual(panelIds(), want, 'moved down at once');
    await waitFor(() => JSON.stringify((serverData().layout['project.phone'] || []).filter((id) => want.includes(id))) === JSON.stringify(want), 'the phone order reached the server');
    click($('#menuLayoutBtn'));
    assert.ok(!$('.pedit'), 'leaving Edit layout');
    w.__narrow = false;
    w.FT.render();
    assert.deepStrictEqual(panelIds(), desktop, 'the desktop keeps its own order');
    w.FT.go('today');
  });

  // The to-dos are the to-do list "To-dos" (made by the seed's first to-do), a panel like any list's.
  const TODOS = () => 'list-' + w.FT.store.lists.find((l) => l.kind === 'todo' && l.name === 'To-dos').id;
  const chips = () => $$('#app .pchip');
  const chipIds = () => chips().map((c) => c.dataset.id);
  const chosenChip = () => chips().find((c) => c.getAttribute('aria-selected') === 'true').dataset.id;
  const shownPanels = () => $$('#app .ppanel .pitem').map((p) => p.dataset.panel);
  const savedPills = () => serverData().layout['today.pills'];
  const pillCards = () => $$('#app .ts-pill').map((c) => c.dataset.id);
  const openTodaySettings = () => { click($('#app .pgear')); assert.ok($('#app .tsettings'), 'Today settings is open'); };
  const doneWithSettings = () => { click($('#app .ts-bar [data-act="layout.pillsDone"].btn')); assert.ok($('#app .ppager'), 'back to the pills'); };
  const swipe = (el, dx) => { touch(el, 'touchstart', 200, 300); touch(el, 'touchend', 200 + dx, 305); };
  const panelArea = () => $('#app .ppanels');
  let defaultIds = null;

  await step('phone Today: with no pills saved, each panel on Today is its own pill in the phone order, with counts; the focus is pinned and short', async () => {
    await w.FT.rpc('layout', 'saveOrder', { page: 'today', order: [TODOS(), 'habits'] });
    await w.FT.reload();
    w.__narrow = true;
    w.FT.render();
    assert.strictEqual(savedPills(), undefined, 'no pills saved yet');
    assert.ok($('.ppinned .fcompact .fc-name') && $('.ppinned [data-act="today.start"]'), 'the pinned focus: its name and Start');
    assert.ok(/Next/.test($('.ppinned .fc-next').textContent), 'and the next action');
    assert.ok(!$('.ppinned [data-act="today.swap"]'), 'the rest waits behind More');
    click($('.ppinned-more'));
    assert.ok($('.ppinned [data-act="today.swap"]') && $('.ppinned-more').getAttribute('aria-expanded') === 'true', 'More shows the whole focus');
    click($('.ppinned-more'));
    assert.ok($('.ppinned .fcompact'), 'Less goes back');
    assert.deepStrictEqual(chipIds().slice(0, 2), [TODOS(), 'habits'], 'pills follow the phone order');
    assert.ok(!chipIds().includes('focus'), 'the pinned focus has no pill');
    const someday = w.FT.store.lists.find((l) => l.name === 'Someday ideas');
    assert.ok(chipIds().includes('list-' + someday.id), 'a list on Today is a pill of its own');
    const openTodos = w.FT.store.todos.items.filter((t) => 'list-' + t.list_id === TODOS() && !t.done && (!t.day || t.day <= w.FT.store.todos.day)).length;
    assert.strictEqual($('.pchip[data-id="' + TODOS() + '"] .pcount').textContent, String(openTodos), 'To-dos shows how many are open');
    assert.ok(/^\d+\/\d+$/.test($('.pchip[data-id="habits"] .pcount').textContent), 'Habits shows done of how many');
    assert.strictEqual($('.pchip[data-id="rotation"]').textContent, 'Rotation', 'named after the panel');
    assert.ok($('#app .pchips > .pgear'), '⚙ at the end of the row');
    assert.strictEqual(shownPanels().length, 1, 'one panel in each pill');
    click($('.pchip[data-id="habits"]'));
    assert.deepStrictEqual(shownPanels(), ['habits'], 'a pill shows its panels');
    assert.strictEqual($('.pchip[data-id="habits"]').getAttribute('aria-selected'), 'true');
    assert.strictEqual(d.activeElement, $('.pchip[data-id="habits"]'), 'focus stays on the pill');
    w.FT.render();
    assert.strictEqual(chosenChip(), 'habits', 'the chosen pill is remembered');
    defaultIds = Array.from(w.FT.pills.list('today'), (p) => p.id);
    assert.ok(defaultIds.includes('stale') && !chipIds().includes('stale'), 'Not touched has its pill, left out of the row while nothing is stale');
  });

  await step('phone Today: a swipe on the panels changes pill and stops at the ends; a swipe on the focus changes tab', async () => {
    const ids = chipIds();
    click($('.pchip[data-id="' + ids[0] + '"]'));
    swipe(panelArea(), -120);
    assert.strictEqual(chosenChip(), ids[1], 'a swipe to the left shows the next pill');
    assert.strictEqual(w.FT.state.view, 'today', 'and stays on Today');
    swipe(panelArea(), 120);
    assert.strictEqual(chosenChip(), ids[0], 'a swipe to the right goes back');
    swipe(panelArea(), 120);
    assert.strictEqual(chosenChip(), ids[0], 'the first pill is the end: no tab change');
    assert.strictEqual(w.FT.state.view, 'today');
    click(chips()[chips().length - 1]);
    swipe(panelArea(), -120);
    assert.strictEqual(w.FT.state.view, 'today', 'nor past the last pill');
    $('.pchip[aria-selected="true"]').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.strictEqual(chosenChip(), ids[0], 'Home on the pills goes to the first');
    chips()[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.strictEqual(chosenChip(), ids[1], 'the arrow keys move along them');
    assert.strictEqual(d.activeElement, $('.pchip[data-id="' + ids[1] + '"]'), 'and focus follows');
    swipe($('.ppinned .fc-name'), -120);
    // the Projects tab, or the project it was left on (it reopens that one)
    await waitFor(() => ['projects', 'project'].includes(w.FT.state.view), 'a swipe on the pinned focus goes to the next tab');
    click(tab('Today'));
    await waitFor(() => $('.ppager'), 'back on Today');
  });

  await step('phone Today: the pinned focus has the session length, its countdown, Keep going and the corner timer; a desktop window does not take its place', async () => {
    assert.ok($('.ppinned [data-change="today.length"]'), 'the length box beside Start');
    click($('.ppinned [data-act="today.start"]'));
    await waitFor(() => $('.ppinned #plan-left') && $('.ppinned [data-act="today.finish"]'), 'the countdown in the pinned focus');
    await waitFor(() => !$('#cornerTimer').hidden, 'and the corner timer');
    await waitFor(() => serverData().today.session, 'the session on the server');
    const planned = w.FT.store.today.session.plannedMin;
    await sessionStartedAgo(planned + 0.5);
    await waitFor(() => $('.ppinned #plan.over'), 'time is up in the pinned focus');
    assert.ok($('.ppinned #plan [data-act="today.finish"]') && $('.ppinned [data-act="today.keepGoing"][data-min="10"]'), 'with Finish and Keep going');
    click($('.ppinned [data-act="today.keepGoing"][data-min="10"]'));
    await waitFor(() => $('.ppinned #plan-left') && !$('.ppinned #plan.over'), 'the countdown is back');
    const chipsBefore = chipIds();
    click($('.ppinned-more'));
    assert.ok(!$('#app .popbtn'), 'no Pop out button on a phone');
    click($('.ppinned-more'));
    w.__narrow = false;
    w.FT.render();
    click($('#app .popbtn[data-panel="focus"]'));
    await waitFor(() => $('#popRoot .popwin[data-key="today::focus"]'), 'the focus popped out on a desktop');
    w.__narrow = true;
    w.FT.render();
    assert.ok(!$('#popRoot .popwin') && !$('.ppinned .popslot'), 'back on a phone: no window and no placeholder');
    assert.ok($('.ppinned .fcompact #timer') && $$('#timer').length === 1, 'the pinned focus draws in place, one session clock');
    assert.deepStrictEqual(chipIds(), chipsBefore, 'the pills are unchanged');
    w.__narrow = false;
    w.FT.render();
    assert.ok($('#popRoot .popwin[data-key="today::focus"]') && $('#app .lcell[data-panel="focus"] .popslot'), 'wide again, the window is back');
    click($('#popRoot .popwin[data-key="today::focus"] [data-act="popout.close"]'));
    await waitFor(() => !$('#popRoot .popwin'), 'put back');
    w.__narrow = true;
    w.FT.render();
    assert.ok($('.ppinned .fcompact #timer'), 'short again, with its clock');
    click($('.ppinned [data-act="today.finish"]'));
    click(await waitFor(() => $('#dlg-discard'), 'the finish dialog'));
    click(await waitFor(() => $('#dlg-submit'), 'the delete confirm'));
    await waitFor(() => !w.FT.store.today.session && $('.ppinned [data-act="today.start"]'), 'the session deleted');
  });

  const placeInColumn = (els) => els.forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: 0, right: 390, width: 390, top: i * 200, bottom: i * 200 + 180, height: 180 });
  });

  await step('phone: holding a pill does nothing; a finger that moves before the hold is a scroll; press and hold a panel on another page moves it', async () => {
    const ids = chipIds();
    touch(chips()[0], 'touchstart', 40, 20);
    await sleep(LONG_PRESS_WAIT);
    assert.ok(!$('.lifted') && !d.body.classList.contains('reordering'), 'pills are ordered in Today settings, not by a long press');
    touch(chips()[0], 'touchend', 40, 20);
    assert.deepStrictEqual(chipIds(), ids, 'nothing moved');

    const project = w.FT.store.projects.find((p) => p.status === 'active' && !w.FT.lockedUntil(p));
    w.FT.go('project', { id: project.id });
    const cells = $$('#app .lflow > .lcell');
    const before = cells.map((c) => c.dataset.panel);
    placeInColumn(cells);
    const grab = cells[0].querySelector('.label, h2') || cells[0];
    touch(grab, 'touchstart', 100, 20);
    touch(grab, 'touchmove', 100, 60);
    await sleep(LONG_PRESS_WAIT);
    assert.ok(!$('.lifted'), 'moving first cancels the hold');
    touch(grab, 'touchend', 100, 60);
    const editor = cells.map((c) => c.querySelector('[contenteditable="true"], input, textarea, button')).find(Boolean);
    touch(editor, 'touchstart', 100, 100);
    await sleep(LONG_PRESS_WAIT);
    assert.ok(!$('.lifted'), 'a field, button or editor keeps its own long press');
    touch(editor, 'touchend', 100, 100);
    touch(grab, 'touchstart', 100, 20);
    touch(grab, 'touchmove', 104, 24);
    await sleep(LONG_PRESS_WAIT);
    assert.ok(cells[0].classList.contains('lifted') && d.body.classList.contains('reordering'), 'a short wobble does not stop the hold, and the panel lifts');
    const move = touch(grab, 'touchmove', 100, 330);
    assert.ok(move.defaultPrevented, 'the page does not scroll while a panel is dragged');
    touch(grab, 'touchend', 100, 330);
    const want = [before[1], before[0]].concat(before.slice(2));
    assert.deepStrictEqual(panelIds(), want, 'dropped below the next panel at once');
    await waitFor(() => JSON.stringify((serverData().layout['project.phone'] || []).filter((id) => want.includes(id))) === JSON.stringify(want), 'the project page\'s phone order reached the server');
    w.FT.go('today');
  });

  await step('Today settings: ⚙ and the ☰ item open it in the page\'s place; Done and the phone\'s back button leave it', async () => {
    openTodaySettings();
    assert.ok(!$('#app .ppager') && !$('#app .reminders'), 'in the page\'s place');
    assert.strictEqual($('#app .ts-bar h2').textContent, 'Today settings');
    assert.deepStrictEqual(pillCards(), defaultIds, 'it lists the pills, the ones made from the panels too');
    assert.ok($('#app .ts-pill[data-id="habits"] .ts-grip') && $('#app .ts-pill[data-id="habits"] [data-act="layout.pillEdit"]'), 'each with ⠿, ▲ ▼ and Edit');
    assert.ok($('#app .tsettings[data-noswipe]'), 'a swipe there does not change tab');
    assert.ok($('#menuLayoutBtn').hidden, 'Edit layout is not offered there');
    doneWithSettings();
    await sleep(50);
    w.FT.go('lists');
    assert.ok(!$('#menuPagerSettings').hidden && $('#menuPagerSettings').textContent === 'Today settings', 'the phone menu has Today settings');
    click($('#menuBtn'));
    click($('#menuPagerSettings'));
    assert.ok(w.FT.state.view === 'today' && $('#app .tsettings'), 'from another tab it opens on Today');
    assert.ok(!d.body.classList.contains('menuopen'), 'and the menu closes');
    w.history.back();
    await waitFor(() => !$('#app .tsettings') && $('#app .ppager'), 'the phone\'s back button leaves it');
    assert.strictEqual(w.FT.state.view, 'today');
    openTodaySettings();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!$('#app .tsettings') && $('#app .ppager'), 'so does Esc');
    await sleep(50);
  });

  let groceries = null, morningId = null;

  await step('Today settings: a new pill holds Habits and a list that is not on Today, in its order; it is saved for the mode and shows both, stacked', async () => {
    groceries = await w.FT.rpc('lists', 'create', { name: 'Groceries' });
    const listPanel = 'list-' + groceries.id;
    openTodaySettings();
    click($('#app [data-act="layout.pillNew"]'));
    assert.strictEqual($('#dlg-heading').textContent, 'New pill');
    assert.ok($('.dialog.sheet') && !$('[data-act="layout.sheetDelete"]'), 'a sheet, with no Delete for a new pill');
    assert.deepStrictEqual($$('#ps-add .ps-kind').map((k) => k.textContent), ['Panels', 'Lists', 'To-do lists', 'Notes', 'Whiteboards'], 'what can be added, grouped');
    assert.ok($('#ps-add [data-act="layout.sheetAdd"][data-id="' + listPanel + '"]'), 'every list is offered, also one not on Today');
    assert.ok(!$('#ps-add [data-id="focus"]'), 'but not the pinned focus');
    setVal($('#dlg-pname'), 'Morning');
    click($('#ps-icons [data-icon="☀️"]'));
    assert.strictEqual($('#ps-icons [data-icon="☀️"]').getAttribute('aria-pressed'), 'true', 'an icon');
    click($('#ps-add [data-id="habits"]'));
    click($('#ps-add [data-id="' + listPanel + '"]'));
    const inPill = () => $$('#ps-in [data-panel]').map((r) => r.dataset.panel);
    assert.deepStrictEqual(inPill(), ['habits', listPanel], 'added in the order tapped');
    assert.ok(!$('#ps-add [data-id="habits"]'), 'and no longer offered');
    assert.strictEqual($('#dlg-pname').value, 'Morning', 'the name stays while panels are added');
    click($('#ps-in [data-panel="' + listPanel + '"] [data-act="layout.sheetMove"][data-d="-1"]'));
    assert.deepStrictEqual(inPill(), [listPanel, 'habits'], '▲ moves a panel up');
    assert.strictEqual(d.activeElement, $('#ps-in [data-panel="' + listPanel + '"] [data-act="layout.sheetMove"][data-d="1"]'), 'at the top, focus moves to its ▼');
    click(d.activeElement);
    assert.deepStrictEqual(inPill(), ['habits', listPanel], '▼ moves it back');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'the sheet closes');
    assert.ok(/Pill “Morning” added/.test($('#toast').textContent), 'it says so');
    const card = $$('#app .ts-pill').find((c) => /Morning/.test(c.textContent));
    assert.ok(card && /☀️ Morning/.test(card.querySelector('.ts-name').textContent), 'the pill is in the list at once');
    assert.deepStrictEqual(Array.from(card.querySelectorAll('.ts-tag')).map((t) => t.textContent), ['Habits', 'Groceries'], 'with its panels as tags');
    await waitFor(() => (savedPills() || []).some((p) => p.name === 'Morning'), 'the pill reached the server');
    const morning = savedPills().find((p) => p.name === 'Morning');
    morningId = morning.id;
    assert.deepStrictEqual([morning.icon, morning.panels], ['☀️', ['habits', listPanel]]);
    assert.deepStrictEqual(savedPills().slice(0, -1).map((p) => p.id), defaultIds, 'the pills it had are saved as they were');
    assert.strictEqual(JSON.parse(JSON.stringify(server.run("bootstrap('work')"))).data.layout['today.pills'], undefined, 'Work keeps its own');
    doneWithSettings();
    click($('.pchip[data-id="' + morningId + '"]'));
    assert.deepStrictEqual(shownPanels(), ['habits', listPanel], 'the pill shows both panels, one under the other');
    assert.ok($('.pchip[data-id="' + morningId + '"] .picon').textContent === '☀️' && /Morning/.test($('.pchip[data-id="' + morningId + '"]').textContent), 'its icon and name');
    assert.ok($('#app .pitem[data-panel="' + listPanel + '"] .label') && /Groceries/.test($('#app .pitem[data-panel="' + listPanel + '"]').textContent), 'the list draws in the pill');
    assert.ok($('.pchip[data-id="habits"]'), 'Habits is still in its own pill too');
    w.__narrow = false;
    w.FT.render();
    assert.ok(!panelIds().includes(listPanel), 'the desktop\'s Today does not show the list');
    w.__narrow = true;
    w.FT.render();
  });

  await step('Today settings: ▲ ▼ and a drag by ⠿ reorder the pills, at once and on the server', async () => {
    openTodaySettings();
    const start = pillCards();
    click($('#app .ts-pill[data-id="' + start[0] + '"] [data-act="layout.pillMove"][data-d="1"]'));
    let want = [start[1], start[0]].concat(start.slice(2));
    assert.deepStrictEqual(pillCards(), want, '▼ moves it at once');
    assert.strictEqual(d.activeElement, $('#app .ts-pill[data-id="' + start[0] + '"] [data-act="layout.pillMove"][data-d="1"]'), 'the button keeps focus');
    await waitFor(() => JSON.stringify(savedPills().map((p) => p.id)) === JSON.stringify(want), '▼ reached the server');
    click($('#app .ts-pill[data-id="' + start[0] + '"] [data-act="layout.pillMove"][data-d="-1"]'));
    assert.deepStrictEqual(pillCards(), start, '▲ moves it back');
    await waitFor(() => JSON.stringify(savedPills().map((p) => p.id)) === JSON.stringify(start), '▲ reached the server');
    placeInColumn($$('#app .ts-pill'));
    const grip = $('#app .ts-pill[data-id="' + start[0] + '"] .ts-grip');
    const pointer = (el, type, y) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); e.clientX = 20; e.clientY = y; e.pointerId = 1; e.button = 0; el.dispatchEvent(e); return e; };
    const down = pointer(grip, 'pointerdown', 20);
    assert.ok(down.defaultPrevented && $('#app .ts-pill[data-id="' + start[0] + '"]').classList.contains('lifted'), 'held by ⠿, the card lifts');
    pointer(grip, 'pointermove', 500);
    pointer(grip, 'pointerup', 500);
    want = [start[1], start[2], start[0]].concat(start.slice(3));
    assert.deepStrictEqual(pillCards(), want, 'dropped below the third card at once');
    assert.ok(!$('.lifted') && !d.body.classList.contains('reordering'));
    await waitFor(() => JSON.stringify(savedPills().map((p) => p.id)) === JSON.stringify(want), 'the drag reached the server');
    doneWithSettings();
    assert.deepStrictEqual(chipIds(), want.filter((id) => chipIds().includes(id)), 'the row follows the new order');
  });

  await step('Today settings: Edit renames and takes a panel out (an empty name falls back to the first panel\'s); Delete shows Undo', async () => {
    openTodaySettings();
    click($('#app .ts-pill[data-id="' + morningId + '"] [data-act="layout.pillEdit"]'));
    assert.strictEqual($('#dlg-heading').textContent, 'Edit pill');
    assert.ok($('.dialog .dlg-head [data-act="layout.sheetDelete"]'), 'Delete sits beside the title');
    assert.strictEqual($('#dlg-pname').value, 'Morning');
    setVal($('#dlg-pname'), '   ');
    click($('#ps-in [data-panel="habits"] [data-act="layout.sheetRemove"]'));
    assert.ok($('#ps-add [data-id="habits"]'), 'taken out, it is offered again');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog'), 'the sheet closes');
    assert.strictEqual($('#app .ts-pill[data-id="' + morningId + '"] .ts-name').textContent, '☀️ Groceries', 'named after its first panel');
    await waitFor(() => { const p = savedPills().find((x) => x.id === morningId); return p.name === 'Groceries' && p.panels.join() === 'list-' + groceries.id; }, 'the edit reached the server');
    click($('#app .ts-pill[data-id="' + morningId + '"] [data-act="layout.pillEdit"]'));
    click($('[data-act="layout.sheetDelete"]'));
    assert.ok(!$('.dialog') && !$('#app .ts-pill[data-id="' + morningId + '"]'), 'gone at once');
    assert.ok(/Pill “Groceries” deleted/.test($('#toast').textContent) && $('#toast .toastbtn').textContent === 'Undo', 'with the Undo message');
    await waitFor(() => !savedPills().some((p) => p.id === morningId), 'the delete reached the server');
    click($('#toast .toastbtn'));
    await waitFor(() => $('#app .ts-pill[data-id="' + morningId + '"]'), 'Undo brings the pill back');
    assert.ok(/Undone: Pill change/.test($('#toast').textContent));
    assert.ok(savedPills().some((p) => p.id === morningId), 'on the server too');
  });

  const templateNames = () => $$('#app [data-act="layout.pillTemplate"]').map((b) => b.getAttribute('aria-label').replace('Add the pill ', ''));
  const switchMode = async (mode) => {
    setVal($('#modeSelect'), mode, 'change');
    await waitFor(() => d.body.dataset.mode === mode && w.FT.ready && w.FT.state.view === 'today' && $('#app .ppager'), mode + ' loaded on Today');
  };

  await step('Today settings: Quick add makes a pill in one tap, and offers only templates whose panels exist', async () => {
    assert.deepStrictEqual(templateNames(), ['Routine', 'Shopping', 'Thinking', 'Week']);
    click($$('#app [data-act="layout.pillTemplate"]').find((b) => /Shopping/.test(b.getAttribute('aria-label'))));
    assert.ok(/Pill “Shopping” added/.test($('#toast').textContent));
    const card = $$('#app .ts-pill .ts-name').find((n) => n.textContent === '🛒 Shopping');
    assert.ok(card, 'in the list at once');
    await waitFor(() => (savedPills() || []).some((p) => p.name === 'Shopping'), 'the pill reached the server');
    assert.deepStrictEqual(savedPills().find((p) => p.name === 'Shopping').panels, ['list-' + groceries.id, TODOS()], 'with the list that sounds like shopping, and the to-dos');
    doneWithSettings();
    await switchMode('work');
    openTodaySettings();
    assert.deepStrictEqual(templateNames(), ['Week'], 'a mode with no lists, to-do lists or notes has no Routine, Shopping or Thinking');
    doneWithSettings();
    await switchMode('personal');
  });

  await step('a pill whose list was deleted leaves it out quietly; a pill left with no panels offers Add panels', async () => {
    await w.FT.rpc('lists', 'remove', { id: groceries.id });
    const shopping = savedPills().find((p) => p.name === 'Shopping');
    click($('.pchip[data-id="' + shopping.id + '"]'));
    assert.deepStrictEqual(shownPanels(), [TODOS()], 'Shopping shows its to-dos, without the deleted list');
    click($('.pchip[data-id="' + morningId + '"]'));
    assert.ok(/has no panels yet/.test($('#app .ppanel').textContent), 'a pill whose only panel is gone says so');
    click($('#app .ppanel [data-act="core.pagerSettings"][data-edit="' + morningId + '"]'));
    assert.ok($('#app .tsettings') && $('#dlg-heading').textContent === 'Edit pill' && !$$('#ps-in [data-panel]').length, 'Add panels opens its sheet, with nothing in it');
    click($('#dlg-cancel'));
    assert.deepStrictEqual(Array.from($('#app .ts-pill[data-id="' + shopping.id + '"]').querySelectorAll('.ts-tag'), (t) => t.textContent), ['To-dos'], 'its card lists what is left');
    doneWithSettings();
    assert.strictEqual(errors.length, 0, 'and nothing breaks');
  });

  await step('Today settings: the pill sheet makes a new list, to-do list or note on the spot and puts it in the pill at once', async () => {
    openTodaySettings();
    click($('#app [data-act="layout.pillNew"]'));
    const inPill = () => $$('#ps-in [data-panel]').map((r) => r.dataset.panel);
    assert.deepStrictEqual($$('#ps-new [data-act="layout.sheetNew"]').map((b) => b.textContent.replace(/\s+/g, ' ').trim()), ['+ New list', '+ New to-do list', '+ New note']);
    setVal($('#dlg-pname'), 'Trip');
    const made = [];
    for (const [kind, name] of [['', 'Sights'], ['todo', 'Pack'], ['note', 'Trip ideas']]) {
      click($('#ps-new [data-act="layout.sheetNew"][data-kind="' + kind + '"]'));
      assert.strictEqual(d.activeElement, $('#ps-newname'), 'the name box takes focus');
      setVal($('#ps-newname'), name);
      if (kind === 'note') enter($('#ps-newname')); else click($('[data-act="layout.sheetCreate"]'));
      const list = w.FT.store.lists.find((l) => l.name === name);
      assert.ok(list && (list.kind || '') === kind, name + ' is made at once');
      made.push('list-' + list.id);
      assert.deepStrictEqual(inPill(), made, name + ' is in the pill at once');
      assert.ok($('.dialog.sheet') && !$('#ps-newname'), 'the sheet stays open, the name box goes');
    }
    assert.strictEqual($('#dlg-pname').value, 'Trip', 'the pill\'s name stays');
    click($('#dlg-submit'));
    await waitFor(() => (savedPills() || []).some((p) => p.name === 'Trip'), 'the pill saved');
    const trip = savedPills().find((p) => p.name === 'Trip');
    assert.deepStrictEqual(trip.panels, made);
    await waitFor(() => made.every((id) => serverData().lists.some((l) => 'list-' + l.id === id)), 'the three reached the server');
    const pack = serverData().lists.find((l) => l.name === 'Pack');
    assert.ok(serverData().kanban.columns.some((c) => c.list_id === pack.id), 'the to-do list has its first group');
    doneWithSettings();
    click($('.pchip[data-id="' + trip.id + '"]'));
    assert.deepStrictEqual(shownPanels(), made, 'the pill shows them');
    assert.ok($('#app .pitem .notes-edit') && $('#app .pitem .todoadd input') && $('#app .pitem .board .coladd input'), 'a note editor, a to-do list and a list, in the pill');
  });

  await step('Today settings: counts, swiping and the remembered pill can be switched off', async () => {
    openTodaySettings();
    const toggle = (name, on) => { const box = $('#ts-' + name); box.checked = on; box.dispatchEvent(new w.Event('change', { bubbles: true })); };
    assert.ok(['pillCounts', 'pillSwipe', 'pillLast'].every((name) => $('#ts-' + name).checked && $('#ts-' + name).getAttribute('role') === 'switch'), 'all on at first');
    toggle('pillCounts', false);
    assert.strictEqual(d.activeElement, $('#ts-pillCounts'), 'the switch keeps focus');
    await waitFor(() => (serverData().layout['today.view'] || {}).pillCounts === 'off', 'saved for the mode');
    doneWithSettings();
    assert.ok(!$('#app .pcount'), 'no counts on the pills');
    openTodaySettings();
    toggle('pillCounts', true);
    toggle('pillSwipe', false);
    doneWithSettings();
    assert.ok($('#app .pchip[data-id="' + TODOS() + '"] .pcount'), 'counts are back');
    assert.ok(panelArea().hasAttribute('data-noswipe') && !$('#app .pswipehint'), 'swiping is off');
    const before = chosenChip();
    swipe($('#app .ppanel'), -120);
    assert.strictEqual(chosenChip(), before, 'a swipe on the panels does not change pill');
    assert.strictEqual(w.FT.state.view, 'today', 'nor tab');
    openTodaySettings();
    toggle('pillSwipe', true);
    doneWithSettings();
    click(chips()[2]);
    const third = chipIds()[2];
    await waitFor(() => w.FT.pendingSaves() === 0, 'saved');
    await switchMode('work');
    await switchMode('personal');
    assert.strictEqual(chosenChip(), third, 'the app opens on the pill used last');
    openTodaySettings();
    toggle('pillLast', false);
    doneWithSettings();
    click(chips()[1]);
    await waitFor(() => (serverData().layout['today.view'] || {}).pillLast === 'off', 'saved');
    await switchMode('work');
    await switchMode('personal');
    assert.strictEqual(chosenChip(), chipIds()[0], 'switched off, it opens on the first pill');
    openTodaySettings();
    toggle('pillLast', true);
    doneWithSettings();
  });

  await step('Today settings: the focus card is compact, full or hidden; hidden, the corner timer still runs', async () => {
    const size = (value) => { openTodaySettings(); click($('#app [data-act="layout.pillView"][data-name="focusCard"][data-value="' + value + '"]')); assert.strictEqual($('#app [data-act="layout.pillView"][data-value="' + value + '"]').getAttribute('aria-pressed'), 'true'); doneWithSettings(); };
    size('full');
    assert.ok($('.ppinned .focus-name') && !$('.ppinned .fcompact') && !$('.ppinned-more'), 'full: the whole focus panel, no More');
    await waitFor(() => serverData().layout['today.view'].focusCard === 'full', 'saved for the mode');
    size('hidden');
    assert.ok(!$('#app .ppinned') && $('#app .pchips'), 'hidden: no focus card, the pills at the top');
    await w.FT.rpc('today', 'start', { projectId: w.FT.store.today.focusId, plannedMin: 25 });
    await waitFor(() => !$('#cornerTimer').hidden, 'the corner timer runs during a session');
    await w.FT.rpc('today', 'discard', {});
    size('compact');
    assert.ok($('.ppinned .fcompact') && $('.ppinned-more'), 'compact: the short focus with More');
    w.__narrow = false;
    w.FT.render();
    assert.ok(panelIds().includes('focus') && !$('#app .ppager'), 'the desktop\'s Today is unchanged');
  });

  await step('a page whose panels are all removed says so and how to bring them back', async () => {
    click(tab('Whiteboards'));
    click($('#layoutBtn'));
    click($('.lcell[data-panel="boards"] [data-act="core.removePanel"]'));
    assert.ok(/Every panel is removed from this page\. Edit layout → Add feature/.test($('#app').textContent), 'in Edit layout');
    click($('#layoutBtn'));
    assert.ok(/Every panel is removed/.test($('#app').textContent), 'and after it');
    click($('.allremoved [data-act="core.addFeature"]'));
    assert.ok(w.FT.state.editLayout, 'its Add feature turns Edit layout on');
    click(addButton('Whiteboards'));
    assert.ok(panelIds().includes('boards') && !/Every panel is removed/.test($('#app').textContent), 'the panel is back');
    await waitFor(() => !(serverData().layout.whiteboards || {}).boards.removed, 'saved');
    click($('#dlg-submit'));
    click($('#layoutBtn'));
  });

  // ---------- pop-out windows (src/ui/popout.html) ----------
  const popWin = (panel) => $$('#popRoot .popwin').find((el) => el.dataset.key.endsWith(':' + panel));
  const popSaved = () => JSON.parse(w.localStorage.getItem('ft.popout.personal') || '{"windows":[]}').windows;

  await step('pop out: a Today panel becomes a free window on top, live, with a placeholder on its page', async () => {
    click(tab('Today'));
    const btn = $('#app .lcell[data-panel="' + TODOS() + '"] .popbtn');
    assert.ok(btn, 'the To-dos panel has a Pop out button in its title');
    assert.strictEqual(btn.getAttribute('aria-label'), 'Pop out To-dos');
    assert.strictEqual($('#app .lcell[data-panel="' + TODOS() + '"] .label').textContent, 'To-dos', 'the title text is unchanged');
    click(btn);
    const win = popWin(TODOS());
    assert.ok(win && win.classList.contains('pop-free'), 'a free window');
    assert.strictEqual(d.activeElement, win, 'focused');
    assert.strictEqual(win.getAttribute('aria-label'), 'To-dos window');
    assert.ok(win.querySelector('.todoadd input'), 'the panel is inside it');
    assert.ok($('#app .lcell[data-panel="' + TODOS() + '"] .popslot'), 'its page shows a placeholder');
    assert.ok(!$('#app .todoadd input'), 'and only one copy of the panel exists');
    assert.deepStrictEqual(Array.from(win.querySelectorAll('.popbtns button')).map((b) => b.getAttribute('aria-label')),
      ['Free window', 'Side pane', 'Mini card', 'Minimise To-dos', 'Close To-dos and put it back on its page']);
    setVal(win.querySelector('.todoadd input'), 'Water the plants');
    click(win.querySelector('[data-act="todos.addBtn"]'));
    await waitFor(() => popWin(TODOS()).textContent.includes('Water the plants'), 'the new to-do shows in the window');
    await waitFor(() => serverData().todos.items.some((t) => t.title === 'Water the plants'), 'and reached the server');
    assert.deepStrictEqual(popSaved().map((x) => [x.page, x.panel, x.style, x.minimised]), [['today', TODOS(), 'free', false]], 'kept on this device');
  });

  await step('pop out: the window stays on other tabs and keeps working there', async () => {
    click(tab('Notes'));
    assert.ok($('#app .lists, #app .panel'), 'on the Lists tab');
    const win = popWin(TODOS());
    assert.ok(win && win.querySelector('.todoadd input'), 'the To-dos window is still there, drawn from Today off screen');
    const row = Array.from(win.querySelectorAll('li')).find((li) => li.textContent.includes('Water the plants'));
    click(row.querySelector('[data-act="todos.remove"]'));
    await waitFor(() => !popWin(TODOS()).textContent.includes('Water the plants'), 'gone from the window at once');
    await waitFor(() => !serverData().todos.items.some((t) => t.title === 'Water the plants'), 'and from the server');
  });

  await step('pop out: switch to the side pane (tabs, divider) and to a mini card', async () => {
    click(popWin(TODOS()).querySelector('[data-act="popout.style"][data-style="pane"]'));
    assert.ok(!popWin(TODOS()), 'no longer floating');
    assert.ok($('#popRoot .poppane .todoadd input'), 'docked in the side pane');
    assert.ok(d.body.classList.contains('pop-pane-on'), 'the page makes room beside it');
    assert.strictEqual(d.body.style.getPropertyValue('--pop-pane-w'), '400px');
    assert.ok(d.body.classList.contains('pop-pane-tight'), 'with the narrow desktop bar, as the page beside the pane is under 1000 px');
    click(tab('Today'));
    click($('#app .lcell[data-panel="rotation"] .popbtn'));
    click(popWin('rotation').querySelector('[data-act="popout.style"][data-style="pane"]'));
    assert.deepStrictEqual($$('.poppane .poptab').map((t) => t.textContent), ['To-dos', 'Weekly rotation'], 'two docked panels are tabs');
    assert.strictEqual($('.poppane .poptab[aria-selected="true"]').textContent, 'Weekly rotation', 'the newest is shown');
    assert.ok(!$('.poppane .todoadd input'), 'only the shown tab is drawn');
    click($$('.poppane .poptab')[0]);
    assert.ok($('.poppane .todoadd input'), 'the other tab');
    const divider = $('.poppane-divider');
    assert.strictEqual(divider.getAttribute('role'), 'separator');
    divider.focus(); key(divider, 'ArrowLeft');
    assert.strictEqual(d.body.style.getPropertyValue('--pop-pane-w'), '424px', 'the left arrow widens the pane');
    click($('.poppane [data-act="popout.style"][data-style="mini"]'));
    assert.ok(popWin(TODOS()).classList.contains('pop-mini') && popWin(TODOS()).classList.contains('pop-at-bl'), 'a mini card in the bottom left corner');
    assert.deepStrictEqual($$('.poppane .poptab').map((t) => t.textContent), ['Weekly rotation']);
    assert.deepStrictEqual(popSaved().map((x) => [x.panel, x.style]), [[TODOS(), 'mini'], ['rotation', 'pane']]);
    assert.strictEqual(JSON.parse(w.localStorage.getItem('ft.popout.personal')).paneWidth, 424, 'the pane width is kept');
    click($('.poppane [data-act="popout.close"]'));
    assert.ok(!$('.poppane') && !d.body.classList.contains('pop-pane-on'), 'closing the last docked panel removes the pane');
    assert.ok($('#app .lcell[data-panel="rotation"] .rot') && !$('#app .lcell[data-panel="rotation"] .popslot'), 'and the panel is back on its page');
  });

  await step('pop out: minimise to the dock, restore, and Esc minimises the focused window', async () => {
    click(popWin(TODOS()).querySelector('[data-act="popout.style"][data-style="free"]'));
    click(popWin(TODOS()).querySelector('[data-act="popout.minimise"]'));
    assert.ok(!popWin(TODOS()), 'the window goes');
    const chip = $('#popRoot .popdock .popchip');
    assert.strictEqual(chip.textContent, 'To-dos');
    assert.strictEqual(d.activeElement, chip, 'focus moves to its chip');
    assert.ok(/is in a minimised window/.test($('#app .lcell[data-panel="' + TODOS() + '"] .popslot').textContent), 'the placeholder says so');
    click(chip);
    assert.ok(popWin(TODOS()) && !$('#popRoot .popdock'), 'restored, and the dock is empty');
    assert.strictEqual(d.activeElement, popWin(TODOS()));
    key(popWin(TODOS()), 'Escape');
    assert.ok(!popWin(TODOS()) && $('#popRoot .popchip'), 'Esc minimised it');
    click($('#app .lcell[data-panel="' + TODOS() + '"] [data-act="popout.show"]'));
    assert.ok(popWin(TODOS()), 'Show window on the placeholder brings it back');
    assert.strictEqual(popSaved()[0].minimised, false);
  });

  await step('pop out: a project page panel keeps its project on other tabs; the notes stay that project\'s, and one notes editor is on screen', async () => {
    const live = w.FT.store.projects.filter((p) => p.status === 'active' && !w.FT.lockedUntil(p));
    const [project, other] = live;
    w.FT.go('project', { id: project.id });
    await waitFor(() => $('#app .lcell[data-panel="criteria"] .popbtn'), 'criteria with a Pop out button');
    click($('#app .lcell[data-panel="criteria"] .popbtn'));
    assert.strictEqual(popWin('criteria').dataset.key, 'project:' + project.id + ':criteria');
    assert.strictEqual(popWin('criteria').querySelector('.poptitle').textContent, 'Acceptance criteria · ' + project.name, 'the title names the project');
    click(tab('Today'));
    const input = popWin('criteria').querySelector('#crit-new');
    assert.strictEqual(input.dataset.project, project.id, 'still that project\'s criteria on Today');
    setVal(input, 'Works from a window');
    key(input, 'Enter');
    assert.ok(popWin('criteria').textContent.includes('Works from a window'), 'shown at once');
    await waitFor(() => serverData().criteria.some((c) => c.text === 'Works from a window' && c.project_id === project.id), 'saved on that project');

    w.FT.go('project', { id: project.id });
    click($('#app .lcell[data-panel="kanban"] .popbtn'));
    const inWindow = (s) => popWin('kanban').contains(s.el);
    assert.ok(w.__sortables.some(inWindow), 'cards in a popped-out board can be dragged');
    click(popWin('kanban').querySelector('[data-act="popout.close"]'));
    assert.ok($('#app .lcell[data-panel="kanban"] .board') && !w.__sortables.some((s) => !d.body.contains(s.el)), 'back on its page');
    await waitFor(() => $('#app .lcell[data-panel="notes"] .popbtn'), 'notes');
    click($('#app .lcell[data-panel="notes"] .popbtn'));
    await waitFor(() => popWin('notes').querySelector('.notes-edit[contenteditable="true"]'), 'the notes editor works in the window');
    click(tab('Notes'));
    assert.ok(popWin('notes').querySelector('.notes-edit'), 'and on another tab, while that project was the one opened last');
    w.FT.go('project', { id: other.id });
    await waitFor(() => editorOf(other.id), 'another project opened: its own notes are other notes, so they draw as usual');
    assert.strictEqual(popWin('notes').querySelector('.notes-edit').dataset.project, project.id, 'the window keeps its own project\'s notes (the editor saves to data-project)');
    assert.ok(!$('#app .lcell[data-panel="notes"] .popslot'), 'no placeholder for other notes');
    assert.strictEqual($$('.notes-edit').filter((e) => e.dataset.project === project.id).length, 1, 'one editor for the window\'s notes');
    const windowEditor = popWin('notes').querySelector('.notes-edit');
    windowEditor.innerHTML += '<p>Typed in the window</p>';
    windowEditor.dispatchEvent(new w.Event('input', { bubbles: true }));
    windowEditor.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => notesOf(project.id).endsWith('Typed in the window'), 'typed in the window, saved to the window\'s project');
    assert.ok(!notesOf(other.id).includes('Typed in the window'), 'not to the project open on the page');
    w.FT.go('project', { id: project.id });
    assert.ok(popWin('notes').querySelector('.notes-edit') && $('#app .lcell[data-panel="notes"] .popslot'), 'on its own page, the usual placeholder');
  });

  await step('pop out: the same notes are on screen once: while a project\'s or a note\'s notes are in a window, the Notes tab and Today show a placeholder for them', async () => {
    const project = w.FT.project(w.FT.state.projectId), noteId = errandsNote().id;
    click(tab('Notes'));
    await waitFor(() => $('#app .lcell[data-panel="pnote-' + project.id + '"] .popslot'), 'the Notes tab');
    assert.ok($('#app .lcell[data-panel="pnote-' + project.id + '"] .popslot').textContent.includes(project.name), 'naming the window');
    assert.strictEqual($$('.notes-edit').filter((e) => e.dataset.project === project.id).length, 1, 'one editor for these notes, the window\'s');
    assert.ok(editorOf(noteId), 'other notes draw as usual');
    click(popWin('notes').querySelector('[data-act="popout.close"]'));
    await waitFor(() => editorOf(project.id), 'the window closed: the Notes tab draws them again');
    click($('#app .lcell[data-panel="list-' + noteId + '"] .popbtn'));
    await waitFor(() => popWin('list-' + noteId) && popWin('list-' + noteId).querySelector('.notes-edit[data-project="' + noteId + '"][contenteditable="true"]'), 'the note in a window');
    assert.strictEqual(popWin('list-' + noteId).querySelector('.poptitle').textContent, 'Errands', 'the window says which note');
    click(tab('Today'));
    await waitFor(() => $('#app .lcell[data-panel="list-' + noteId + '"] .popslot'), 'Today: the usual placeholder');
    assert.strictEqual($$('.notes-edit').filter((e) => e.dataset.project === noteId).length, 1, 'one editor for the note');
    const windowEditor = popWin('list-' + noteId).querySelector('.notes-edit');
    windowEditor.innerHTML += '<p>Typed in the note\'s window</p>';
    windowEditor.dispatchEvent(new w.Event('input', { bubbles: true }));
    windowEditor.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => noteText(noteId).endsWith('Typed in the note\'s window'), 'saved to the note\'s Doc');
    w.FT.go('project', { id: project.id });
    await waitFor(() => editorOf(project.id), 'the project page');
    assert.ok(popWin('list-' + noteId).querySelector('.notes-edit') && $$('.notes-edit').length === 2, 'the note\'s window and the project\'s notes: two different notes on screen');
    click(tab('Today'));
  });

  await step('pop out: a phone has no windows, cards, sheets, dock, placeholders or Pop out buttons; every panel draws in place, and the desktop windows come back', async () => {
    const noteId = errandsNote().id;
    click(tab('Today'));
    click(popWin(TODOS()).querySelector('[data-act="popout.minimise"]'));
    assert.ok($('#popRoot .popdock'), 'one minimised, in the dock');
    const savedBefore = JSON.stringify(popSaved());
    w.__narrow = true;
    w.FT.render();
    assert.strictEqual($$('#popRoot > *').length, 0, 'no windows, pane, cards or dock');
    assert.ok(!$('#app .popslot') && !$('#app .popbtn'), 'no placeholders and no Pop out buttons');
    click($('.pchip[data-id="' + TODOS() + '"]'));
    assert.ok($('#app .todos-panel .todoadd input'), 'To-dos draws in place');
    click($('.pchip[data-id="list-' + noteId + '"]'));
    assert.ok(editorOf(noteId) && $$('.notes-edit').length === 1, 'the note draws in place, one editor');
    w.FT.go('project', { id: w.FT.store.projects.find((p) => p.status === 'active' && !w.FT.lockedUntil(p)).id });
    assert.ok($('#app .lcell[data-panel="criteria"] #crit-new') && !$('#app .popslot'), 'a project page draws its panels in place too');
    assert.strictEqual(JSON.stringify(popSaved()), savedBefore, 'the desktop windows stay saved');
    w.__narrow = false;
    w.FT.render();
    click(tab('Today'));
    await waitFor(() => w.FT.state.view === 'today', 'Today');
    assert.strictEqual($$('#popRoot .popwin').length, 2, 'wide again, the windows come back');
    assert.ok($('#popRoot .popdock .popchip') && popWin('list-' + noteId).classList.contains('pop-free'), 'with their own styles and the dock');
    assert.ok($('#app .lcell[data-panel="' + TODOS() + '"] .popslot') && $('#app .lcell[data-panel="list-' + noteId + '"] .popslot'), 'and their placeholders');
    click($('#popRoot .popdock .popchip'));
  });

  await step('pop out: ✕ puts each panel back on its page, and nothing stays behind', async () => {
    [TODOS(), 'criteria', 'list-' + errandsNote().id].forEach((panel) => click(popWin(panel).querySelector('[data-act="popout.close"]')));
    assert.strictEqual($$('#popRoot > *').length, 0, 'no windows, pane or dock');
    assert.deepStrictEqual(popSaved(), []);
    click(tab('Today'));
    assert.ok($('#app .todos-panel .todoadd input') && !$('#app .popslot'), 'To-dos is back on Today');
  });

  assert.deepStrictEqual(errors, [], 'no uncaught page errors');
  console.log('\n' + passed + ' browser steps passed');
  dom.window.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FAIL\n' + (e.stack || e)); process.exit(1); });
