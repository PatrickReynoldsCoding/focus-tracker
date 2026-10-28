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

  let passed = 0;
  async function step(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

  await step('loads and shows tabs and today\'s focus', async () => {
    await waitFor(() => $('.focus-name'), 'focus name');
    assert.deepStrictEqual($$('.tab').map((t) => t.textContent), ['Today', 'Projects', 'Lists', 'Log']);
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

  await step('projects tab lists every project and category resources', async () => {
    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length === 7, '7 rows');
    assert.strictEqual($$('.cats .panel').length, 3);
  });

  await step('projects table sorts by column and filters by category, status and text', async () => {
    const names = () => $$('tr.row').map((r) => r.querySelector('b').textContent);
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
    setVal($('#pj-status'), 'paused', 'change');
    assert.deepStrictEqual(names(), ['Garden fence repair']);
    setVal($('#pj-status'), '', 'change');
    $('#pj-text').focus();
    setVal($('#pj-text'), 'duct');
    assert.deepStrictEqual(names(), ['Bathroom extractor fan'], 'text matches the next action too');
    assert.strictEqual(d.activeElement.id, 'pj-text', 'search box keeps focus while typing');
    setVal($('#pj-text'), 'nothing like this');
    assert.ok($('.panel .empty').textContent.includes('No projects match'));
    click($('[data-act="projects.clear"]'));
    assert.strictEqual($$('tr.row').length, 7);
  });

  await step('opening a project shows header, kanban, notes and resources', async () => {
    click($$('tr.row').find((r) => r.textContent.includes('Bathroom extractor fan')));
    await waitFor(() => $('.board'), 'board');
    assert.strictEqual($$('.colname').map((i) => i.value).join('|'), 'To do|Doing|Done');
    assert.strictEqual($$('.kcard').length, 3);
    await waitFor(() => $('#nt-text') && !$('#nt-text').disabled && $('#nt-text').value.includes('100mm'), 'notes loaded');
    assert.ok($$('.lcell .label').some((l) => l.textContent === 'Resources: this project'));
    assert.ok(!$('#nt-link').hidden);
    assert.ok($$('.lcell .label').some((l) => l.textContent === 'Whiteboard'), 'whiteboard panel');
    assert.strictEqual($('[data-act="whiteboard.open"]').textContent, 'Start a whiteboard');
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
    click($('#undoBtn'));
    await waitFor(() => $('#toast').textContent.includes('Undone: Card added'), 'the header button undoes the add before it');
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

  await step('adding a resource rejects http and accepts https', async () => {
    click($$('[data-act="resources.add"]')[0]);
    await waitFor(() => $('.dialog'), 'resource dialog');
    setVal($('#dlg-title'), 'Fan spec'); setVal($('#dlg-url'), 'http://example.com');
    click($('#dlg-submit'));
    await waitFor(() => $('#dlg-err').textContent.includes('https'), 'https error');
    setVal($('#dlg-url'), 'https://example.com/fan');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && $$('.reslist a').some((a) => a.textContent === 'Fan spec'), 'link listed');
  });

  await step('notes autosave to a Drive file', async () => {
    const ta = $('#nt-text');
    setVal(ta, 'Replacement needs to be 100mm.\nChecked the duct: 98mm.');
    ta.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await waitFor(() => $('#nt-status').textContent === 'Saved', 'saved');
    const file = Object.values(server.drive.files).find((f) => f.content && f.content.includes('98mm'));
    assert.ok(file, 'file content updated');
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
    click($('[data-act="today.pomodoro"]'));
    await waitFor(() => $('#pomo'), 'pomodoro shown');
    assert.ok(/Work 2[45]:\d\d left/.test($('#pomo').textContent), $('#pomo').textContent);
    // Pretend the work period ran out: the box switches to "take a break" and the tab title changes
    server.run(`(function () {
      var props = PropertiesService.getUserProperties(), s = JSON.parse(props.getProperty('today.state'));
      s.session.pomodoro.phaseStartMs -= 26 * 60000;
      props.setProperty('today.state', JSON.stringify(s)); })()`);
    await w.FT.reload();
    await waitFor(() => $('#pomo.over'), 'work period over');
    assert.ok($('#pomo').textContent.includes('Time for a break'));
    await waitFor(() => d.title.startsWith('⏰ Break time'), 'alert title');
    click(tab('Projects'));
    await waitFor(() => d.title.startsWith('⏰ Break time'), 'alert title stays on other tabs', 2500);
    click(tab('Today'));
    await waitFor(() => $('#pomo.over'), 'back on Today');
    click($('[data-act="today.nextPhase"]'));
    await waitFor(() => $('#pomo') && !$('#pomo.over') && $('#pomo').textContent.includes('Break'), 'break started');
    assert.strictEqual(d.title, 'Focus Tracker');

    click($('[data-act="today.finish"]'));
    await waitFor(() => $('.dialog'), 'finish dialog');
    setVal($('#dlg-where'), 'Rewrote the opening line'); setVal($('#dlg-next'), 'Send to a friend for feedback');
    click($('#dlg-submit'));
    await waitFor(() => !$('.dialog') && !$('.timer'), 'session closed');
    assert.ok($('.next').textContent.includes('Send to a friend for feedback'));
    click(tab('Log'));
    await waitFor(() => $$('tbody tr').length >= 1 && $('tbody').textContent.includes('Rewrote the opening line'), 'log row');
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
    click($('[data-act="today.job"]'));
    await waitFor(() => $('[data-act="today.job"]').textContent === 'Done for today', 'job done');
    const skipped = JSON.parse(JSON.stringify(server.run('bootstrap()').data.projects)).find((p) => p.name === before);
    click(tab('Projects'));
    click(await waitFor(() => $$('tr.row').find((r) => r.textContent.includes(before)), 'row'));
    await waitFor(() => $('.phead') && $('.phead').textContent.includes('Skipped 1 time'), 'skip count on the project');
    assert.ok(skipped);
  });

  await step('the weekly rotation can be edited, with a this-week change and an away day', async () => {
    click(tab('Today'));
    click(await waitFor(() => $('[data-act="today.rotation"]'), 'edit button'));
    await waitFor(() => $('#rot-usual-1'), 'rotation dialog');
    assert.strictEqual($('#rot-usual-1').value, 'coding');
    assert.strictEqual($('#rot-week-3').value, 'same');
    assert.strictEqual($('#dlg-minimum').value, 'job');
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
    assert.strictEqual($$('.rtbar button').length, 13);
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
    const items = JSON.parse(JSON.stringify(server.run('bootstrap()').data.kanban.tasks)).filter((t) => t.project_id === quote.dataset.rotate).length;
    assert.strictEqual(quote.querySelector('[data-pos]').textContent, '1 / ' + items);
    const first = quote.querySelector('.rq').textContent;
    click(quote.querySelector('[data-act="lists.rotate"][data-d="1"]'));
    await waitFor(() => $('#app .rotq .rq') && $('#app .rotq .rq').textContent !== first, 'next item', 1500);
    assert.strictEqual($('#app .rotq [data-pos]').textContent, '2 / ' + items);
    while (!$('#app .rotq .rq').textContent.includes('Sleep on big decisions')) {
      const before = $('#app .rotq .rq').textContent;
      click($('#app .rotq [data-act="lists.rotate"][data-d="1"]'));
      await waitFor(() => $('#app .rotq .rq').textContent !== before, 'rotating', 1500);
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

  await step('Esc leaves Edit layout mode', async () => {
    w.FT.state.editLayout = true;
    w.FT.render();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(w.FT.state.editLayout, false);
  });

  await step('switching to Work shows separate data, a blue accent and its own Drive folder', async () => {
    const personalFolder = $('#driveLink').href;
    assert.strictEqual(d.body.dataset.mode, 'personal');
    assert.deepStrictEqual(Array.from($('#modeSelect').options).filter((o) => !o.disabled).map((o) => o.textContent), ['Personal', 'Work', '+ New mode…']);
    setVal($('#modeSelect'), 'work', 'change');
    await waitFor(() => d.body.dataset.mode === 'work' && $('.panel .empty'), 'work loaded');
    assert.strictEqual(w.localStorage.getItem('ft.mode'), 'work');
    assert.notStrictEqual($('#driveLink').href, personalFolder);
    assert.ok($('#driveLink').title.includes('Work folder'));
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
    assert.ok(!$('#app').textContent.includes('Daily minimum'), 'work mode has no daily minimum');
    setVal($('#modeSelect'), 'personal', 'change');
    await waitFor(() => d.body.dataset.mode === 'personal' && $('.focus-name') && $('.focus-name').textContent !== 'Wiz tickets', 'personal back');
    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length === 7, 'personal projects unchanged');
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
    assert.ok($('#driveLink').title.includes('Side projects folder'));
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
