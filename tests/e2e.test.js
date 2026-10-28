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
    assert.deepStrictEqual($$('.tab').map((t) => t.textContent), ['Today', 'Projects', 'Log']);
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
    assert.ok($$('.pcell .label').some((l) => l.textContent === 'Resources: this project'));
    assert.ok(!$('#nt-link').hidden);
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

  await step('moving a card updates the screen immediately and the sheet afterwards', async () => {
    const card = $$('.kcard').find((c) => c.textContent.includes('Buy duct tape'));
    click(card.querySelector('[data-d="1"]'));
    assert.ok($$('.col')[1].textContent.includes('Buy duct tape'), 'optimistic move');
    await sleep(50);
    const tasks = JSON.parse(JSON.stringify(server.run('rpc')('kanban', 'addColumn', { projectId: 'none' }).slices.kanban.tasks));
    const saved = tasks.find((t) => t.title === 'Buy duct tape');
    const cols = JSON.parse(JSON.stringify(server.run('bootstrap()').data.kanban.columns)).filter((c) => c.project_id === saved.project_id);
    assert.strictEqual(saved.column_id, cols[1].id);
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

  await step('swap focus moves to another project, and the job minimum toggles', async () => {
    click(tab('Today'));
    const before = await waitFor(() => $('.focus-name') && $('.focus-name').textContent, 'focus');
    click($('[data-act="today.swap"]'));
    await waitFor(() => $('.focus-name').textContent !== before, 'focus changed');
    click($('[data-act="today.job"]'));
    await waitFor(() => $('[data-act="today.job"]').textContent === 'Done for today', 'job done');
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

  await step('switching to Work shows separate data, a blue accent and its own Drive folder', async () => {
    const personalFolder = $('#driveLink').href;
    assert.strictEqual(d.body.dataset.mode, 'personal');
    assert.deepStrictEqual($$('.modebtn').map((b) => b.textContent), ['Personal', 'Work']);
    click($$('.modebtn')[1]);
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
    click($$('.modebtn')[0]);
    await waitFor(() => d.body.dataset.mode === 'personal' && $('.focus-name') && $('.focus-name').textContent !== 'Wiz tickets', 'personal back');
    click(tab('Projects'));
    await waitFor(() => $$('tr.row').length === 6, 'personal projects unchanged');
  });

  assert.deepStrictEqual(errors, [], 'no uncaught page errors');
  console.log('\n' + passed + ' browser steps passed');
  dom.window.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FAIL\n' + (e.stack || e)); process.exit(1); });
