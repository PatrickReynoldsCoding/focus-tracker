/**
 * Real-browser tests: the real page in Chrome (desktop and phone sized) over the real server code, with a deliberately
 * slow server, because the app's worst failure is a button that looks dead while it waits for Google.
 *   1. Every button gives feedback before the server answers.
 *   2. The change really ends up on the server, and the screen agrees with it.
 *   3. A save the server refuses puts the screen back and says why.
 *   4. A call that hangs does not stop buttons responding.
 *   5. Nothing sits on top of the main controls.
 * Needs Chrome: set CHROME_PATH, or have google-chrome / chromium on the machine. Without it the test is skipped.
 * Run on its own with: node tests/browser.test.js   (BROWSER_LATENCY=ms changes the server delay, default 900)
 */
const assert = require('assert');
const fs = require('fs');
const { start } = require('./support/devserver');

function findChrome() {
  const list = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  return list.filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

const LATENCY = Number(process.env.BROWSER_LATENCY || 900);
const FEEDBACK_MS = 300; // a button must show something within this, whatever the server is doing
const SAVE_WAIT_MS = 2500; // longer than the whiteboard's 2 s autosave delay
const SIZES = [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, mobile: false },
  { name: 'phone', viewport: { width: 393, height: 851 }, mobile: true }
];

async function run(browser, size) {
  const env = await start({ latency: 0 });
  const ctx = await browser.newContext({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  const out = [];
  const log = (s) => out.push('  ok  [' + size.name + '] ' + s);
  const sleep = (ms) => pg.waitForTimeout(ms);

  await pg.goto(env.url);
  await pg.waitForSelector('.focus-name');

  // Anything on screen that a click could change: the page, the dialog, the message, the page address.
  const signature = () => pg.evaluate(() => [document.getElementById('app').innerText, document.getElementById('dialogRoot').innerHTML.length,
    document.getElementById('toast').hidden ? '' : document.getElementById('toast').innerText, location.href].join('|'));
  const quick = async (label, locator, expectChange = true) => {
    await locator.scrollIntoViewIfNeeded();
    const before = await signature(), t0 = Date.now();
    await locator.click({ timeout: 4000 });
    let took = null;
    while (Date.now() - t0 < FEEDBACK_MS + 200) { await sleep(20); if ((await signature()) !== before) { took = Date.now() - t0; break; } }
    assert.ok(!expectChange || (took !== null && took <= FEEDBACK_MS + 100), '[' + size.name + '] "' + label + '" gave no feedback within ' + FEEDBACK_MS + ' ms while the server took ' + LATENCY + ' ms');
    return took;
  };
  const settle = async () => { await pg.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 15000 }); await sleep(120); };
  const closeDialog = async () => { if (await pg.isVisible('.dialog')) { await pg.keyboard.press('Escape'); await sleep(150); } };
  const quickly = async (fn) => { env.latency = 0; try { return await fn(); } finally { env.latency = LATENCY; } }; // set up without waiting for the slow server
  const openMenuIfPhone = async () => { if (size.mobile) await pg.click('#menuBtn'); };
  const gotoTab = (name) => quickly(async () => { await openMenuIfPhone(); await pg.click('.tab:text("' + name + '")'); await sleep(250); });
  const openFirstProject = () => quickly(async () => { await gotoTab('Projects'); await pg.click('.rowlink >> nth=0'); await sleep(400); });
  const todayState = () => env.server.run('bootstrap()').data.today;
  const projectRow = (id) => env.server.run('bootstrap()').data.projects.find((p) => p.id === id);
  const status = () => pg.evaluate(() => FT.project(FT.state.projectId).status);
  const projectId = () => pg.evaluate(() => FT.state.projectId);

  env.latency = LATENCY;

  // ---------- 1 and 2: Today ----------
  await quick('Today: Start session', pg.locator('[data-act="today.start"]'));
  assert.ok(await pg.isVisible('.timer'), 'the timer shows straight away');
  await settle();
  assert.ok(todayState().session, 'the session reached the server');
  await quick('Today: Pause', pg.locator('[data-act="today.pause"]'));
  assert.ok(await pg.isVisible('[data-act="today.resume"]'), 'it shows Resume straight away');
  await settle();
  assert.ok(todayState().session.pausedAt, 'the pause reached the server');
  await quick('Today: Resume', pg.locator('[data-act="today.resume"]'));
  await settle();
  assert.ok(!todayState().session.pausedAt, 'the resume reached the server');
  await quick('Today: Pomodoro lengths dialog', pg.locator('[data-act="today.pomodoroSettings"]')); await closeDialog();
  await quick('Today: Finish dialog', pg.locator('[data-act="today.finish"]')); await closeDialog();
  log('Today: session buttons answer at once and the server catches up');

  await quickly(async () => { await pg.locator('[data-act="today.finish"]').click(); await pg.fill('#dlg-where', 'testing'); await pg.click('#dlg-submit'); await sleep(500); });
  await settle();
  await quick('Today: Swap focus dialog', pg.locator('[data-act="today.swap"]')); await closeDialog();
  // ---------- 1 and 2: the Habits and To-dos panels ----------
  const srv = (code) => { const v = env.server.run('(function () { tableCache_ = {}; return ' + code + '; })()'); return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
  const habitsNow = () => env.server.run('bootstrap()').data.habits;
  const todosNow = () => env.server.run('bootstrap()').data.todos.items;
  const today = srv('todayIso_()');
  const doneToday = (id) => { const r = habitsNow().log.find((x) => x.habit_id === id && x.kind === 'done' && x.day === today); return r ? r.count : 0; };
  const jobId = habitsNow().habits.find((h) => h.name === 'Job search').id;
  const dot = () => pg.locator(`.habits-panel .habit[data-id="${jobId}"] [data-act="habits.tap"]`).first();
  await quick('Habits: tap a dot', dot());
  assert.ok(await pg.isVisible(`.habits-panel .habit[data-id="${jobId}"] .dot.on`), 'the dot fills at once');
  assert.strictEqual(doneToday(jobId), 0, 'before the slow server has it');
  await settle();
  assert.strictEqual(doneToday(jobId), 1, 'the tap reached the server');
  await quick('Habits: − takes a session off', pg.locator(`.habits-panel .habit[data-id="${jobId}"] [data-act="habits.untap"]`));
  await settle();
  assert.strictEqual(doneToday(jobId), 0, 'the − reached the server');
  const unfailTap = env.failWhere((name, args) => name === 'rpc' && args[0] === 'habits' && args[1] === 'tap');
  await quick('Habits: tap a dot (server will refuse)', dot());
  assert.ok(await pg.isVisible(`.habits-panel .habit[data-id="${jobId}"] .dot.on`), 'filled while the save is on its way');
  await pg.waitForFunction((id) => !document.querySelector(`.habits-panel .habit[data-id="${id}"] .dot.on`), jobId, { timeout: 8000 });
  assert.ok(/refused/i.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'the dot goes back and the reason is shown');
  unfailTap();
  assert.strictEqual(doneToday(jobId), 0, 'the server never changed');
  log('Habits: a dot tap and − answer at once and reach the server; a refused tap is put back');

  const grocery = () => todosNow().find((t) => t.title === 'Grocery shopping');
  await quick('To-dos: tick', pg.locator('.todos li:has-text("Grocery shopping") input[type="checkbox"]'));
  assert.ok(await pg.isVisible('.todos li.done:has-text("Grocery shopping")'), 'struck through at once');
  await settle();
  assert.strictEqual(grocery().done, today, 'the tick reached the server');
  await quickly(async () => { await pg.fill('#td-new', 'Post parcel'); });
  await quick('To-dos: add', pg.locator('[data-act="todos.addBtn"]'));
  assert.ok(await pg.isVisible('.todos li:has-text("Post parcel")'), 'shows at once');
  await settle();
  assert.ok(todosNow().some((t) => t.title === 'Post parcel'), 'the new to-do reached the server');
  await quick('To-dos: delete', pg.locator('.todos li:has-text("Post parcel") [data-act="todos.remove"]'));
  assert.ok(/To-do deleted/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'with the Undo message at once');
  await settle();
  assert.ok(!todosNow().some((t) => t.title === 'Post parcel'), 'the delete reached the server');
  log('To-dos: tick, add and delete answer at once and reach the server');

  // "Want to go further?": a weekly habit whose level was met in the two full weeks before this one
  const habit = JSON.parse(JSON.stringify(env.server.run('rpc')('habits', 'create', { name: 'Cardio', sessions: 2, per: 'week', size: '15 min', goal: '5 a week, 30 min', step_up_every: '2 weeks' }))).result;
  const makeDue = () => {
    srv(`new Table('Habit log', ['id']).removeWhere(function (r) { return r.habit_id === '${habit.id}' && (r.kind === 'level' || r.kind === 'done' || r.kind === 'prompt' && r.day === todayIso_()); })`);
    const h = habitsNow().habits.find((x) => x.id === habit.id);
    srv(`new Table('Habits', ['id']).update('${habit.id}', { next_prompt: isoAddDays_(todayIso_(), -1), prompts: 'on' })`);
    srv(`new Table('Habit log', ['id']).insertMany([{ habit_id: '${habit.id}', day: isoAddDays_(isoMonday_(todayIso_()), -14), kind: 'level', value: '${h.sessions} a week, ${h.size}' },
      { habit_id: '${habit.id}', day: isoAddDays_(isoMonday_(todayIso_()), -13), kind: 'done', count: 5 }, { habit_id: '${habit.id}', day: isoAddDays_(isoMonday_(todayIso_()), -6), kind: 'done', count: 5 }])`);
  };
  const lastAnswer = () => srv(`new Table('Habit log', ['id']).all().filter(function (r) { return r.kind === 'prompt'; }).map(function (r) { return r.value; }).pop()`);
  for (const [label, answer] of [['Not now', 'not now'], ['Yes, adjust', 'yes'], ['I\'m at my goal', 'at goal']]) {
    makeDue();
    await quickly(async () => { await pg.evaluate(() => FT.reload()); await pg.waitForSelector('.stepcard'); });
    await quick('Want to go further?: ' + label, pg.locator(`.stepcard [data-act="habits.answer"][data-answer="${answer}"]`));
    assert.ok(!(await pg.isVisible('.stepcard')), 'the card goes at once');
    assert.ok(/Undo/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'and the message offers Undo');
    await settle();
    assert.strictEqual(lastAnswer(), answer, label + ' reached the server');
  }
  assert.strictEqual(habitsNow().habits.find((x) => x.id === habit.id).prompts, 'at goal');
  log('Want to go further?: Not now, Yes, adjust and I\'m at my goal answer at once and reach the server');

  await quick('Habits: Plan my week', pg.locator('.habits-panel [data-act="habits.planWeek"]'));
  const tomorrowCell = pg.locator(`.plan [data-act="habits.planAdd"][data-id="${jobId}"]`).last();
  const planDay = await tomorrowCell.getAttribute('data-day');
  await quick('Plan my week: place a session', tomorrowCell);
  assert.ok(await pg.isVisible(`.plan [data-act="habits.planRemove"][data-day="${planDay}"]`), 'a ring at once');
  await settle();
  assert.ok(habitsNow().log.some((r) => r.kind === 'plan' && r.day === planDay && r.habit_id === jobId), 'the plan reached the server');
  await closeDialog();
  await quick('Habits: + Habit dialog', pg.locator('[data-act="habits.new"]')); await closeDialog();
  log('Plan my week and + Habit answer at once');

  const idea = () => habitsNow().habits.find((h) => h.name === 'Learn Spanish');
  await quick('Habits: All habits dialog', pg.locator('.habits-panel [data-act="habits.all"]'));
  await quickly(async () => { await pg.fill('#ah-new', 'Learn Spanish'); });
  await quick('All habits: quick-add an aspiring habit', pg.locator('.ideaadd [data-act="habits.aspire"]'));
  assert.ok(await pg.isVisible('.allhabits[data-group="aspiring"] li:has-text("Learn Spanish")'), 'the aspiring habit shows at once');
  assert.ok(!idea(), 'before the slow server has it');
  await settle();
  assert.strictEqual(idea().status, 'aspiring', 'the aspiring habit reached the server');
  await quick('All habits: Start', pg.locator('.allhabits li:has-text("Learn Spanish") [data-act="habits.ideaStart"]'));
  assert.strictEqual(await pg.inputValue('#nh-name'), 'Learn Spanish', 'the new-habit steps start filled in');
  // The step-up answer's message may still show over the dialog's button; a person would wait for it to go.
  await quickly(async () => { await pg.click('#nh-next1'); await pg.click('#nh-next2'); await pg.evaluate(() => { document.getElementById('toast').hidden = true; }); });
  await quick('Start habit: submit', pg.locator('#dlg-submit'));
  assert.ok(!(await pg.isVisible('.dialog')), 'the dialog closes at once');
  assert.ok(await pg.isVisible('.habits-panel .habit:has-text("Learn Spanish")'), 'and the habit is on Today at once');
  assert.strictEqual(idea().status, 'aspiring', 'before the slow server has it');
  await settle();
  assert.strictEqual(idea().status, 'active', 'Start reached the server');
  assert.ok(await pg.isVisible('.habits-panel .habit:has-text("Learn Spanish")'), 'and the screen agrees');
  log('All habits, quick-add an aspiring habit and Start answer at once and reach the server');

  await quick('Today: Rotation Edit dialog', pg.locator('[data-act="today.rotationEdit"], [data-act="today.editRotation"], [data-act="today.rotation"]').first()); await closeDialog();

  // ---------- 1 and 2: a project page ----------
  await openFirstProject();
  const id = await projectId();
  assert.strictEqual(await status(), 'active');
  await quick('Project: Mark done', pg.locator('[data-act="projects.status"][data-status="done"]'));
  assert.strictEqual(await status(), 'done', 'the project shows done straight away');
  assert.ok(await pg.isVisible('[data-act="projects.status"]:has-text("Reopen")'), 'and offers Reopen');
  await settle();
  assert.strictEqual(projectRow(id).status, 'done', 'done reached the server');
  await quick('Project: Reopen', pg.locator('[data-act="projects.status"]:has-text("Reopen")'));
  await settle();
  assert.strictEqual(projectRow(id).status, 'active', 'reopen reached the server');
  await quick('Project: Pause', pg.locator('[data-act="projects.status"][data-status="paused"]'));
  await settle();
  assert.strictEqual(projectRow(id).status, 'paused');
  await quick('Project: Resume', pg.locator('[data-act="projects.status"]:has-text("Resume")'));
  await settle();
  assert.strictEqual(projectRow(id).status, 'active');
  log('Project: Mark done, Reopen, Pause and Resume answer at once and reach the server');

  await quick('Project: Edit dialog', pg.locator('[data-act="projects.edit"]')); await closeDialog();
  await quick('Project: Lock dialog', pg.locator('[data-act="projects.lock"]')); await closeDialog();
  await quick('Project: Delete asks first', pg.locator('[data-act="projects.delete"]')); await closeDialog();
  await quick('Kanban: open a card', pg.locator('[data-act="kanban.open-card"]').first()); await closeDialog();
  await quick('Kanban: add a column dialog or field', pg.locator('[data-act="kanban.add-col"]')); await closeDialog();
  // a column dragged by its header shows in its new place before the server answers, then reaches the server
  if (await pg.evaluate(() => !!window.Sortable)) {
    const names = () => pg.evaluate(() => [...document.querySelectorAll('#app .board .colname')].map((i) => i.value));
    const serverNames = () => { const k = env.server.run('bootstrap()').data.kanban; return k.columns.filter((c) => c.project_id === id).sort((a, b) => a.order - b.order).map((c) => c.name); };
    const before = await names();
    const from = pg.locator('#app .board .col[data-colid] .colgrip').nth(1), to = pg.locator('#app .board .col[data-colid] .colhead').first();
    await to.evaluate((el) => { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -150); }); // both headers on screen, below the sticky header
    await sleep(100);
    const a = await from.boundingBox(), b = await to.boundingBox();
    await pg.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await pg.mouse.down();
    for (let i = 1; i <= 10; i++) { await pg.mouse.move(a.x + (b.x + 4 - a.x) * i / 10, a.y + (b.y + 4 - a.y) * i / 10); await sleep(30); }
    const t0 = Date.now();
    await pg.mouse.up();
    const want = [before[1], before[0]].concat(before.slice(2)).join('|');
    // Sortable moves the element itself while dragging, so check the page's own data, drawn again from it, not just the elements
    await pg.waitForFunction((w) => !FT.state.dragging && FT.store.kanban.columns.filter((c) => c.owner === FT.state.projectId).sort((x, y) => x.order - y.order).map((c) => c.name).join('|') === w &&
      [...document.querySelectorAll('#app .board .colname')].map((i) => i.value).join('|') === w, want, { timeout: FEEDBACK_MS + 100 });
    assert.ok(Date.now() - t0 <= FEEDBACK_MS + 100, 'the column shows in its new place at once');
    assert.notStrictEqual(serverNames().join('|'), want, 'before the slow server has saved it');
    await settle();
    assert.strictEqual(serverNames().join('|'), want, 'the column move reached the server');
    assert.strictEqual((await names()).join('|'), want, 'and the screen agrees with it');
    log('Kanban: a column dragged by its header moves at once and reaches the server');
  } else {
    log('Kanban: column drag not tried, SortableJS did not load from the CDN');
  }
  // linked projects: + Link opens its dialog at once, the new link shows before the slow server has it, and Remove goes at once
  const projectLinks = () => env.server.run('bootstrap()').data.links.filter((l) => l.from_id === id || l.to_id === id);
  await quick('Links: + Link dialog', pg.locator('[data-act="links.add"]'));
  await quick('Links: Link (save)', pg.locator('#dlg-submit'));
  assert.ok(!(await pg.isVisible('.dialog')), 'the dialog closes at once');
  assert.strictEqual(await pg.locator('.lklist li').count(), 1, 'the link shows at once');
  assert.strictEqual(projectLinks().length, 0, 'before the slow server has saved it');
  await settle();
  assert.strictEqual(projectLinks().length, 1, 'the link reached the server');
  await quick('Links: Remove', pg.locator('.lklist [data-act="links.remove"]'));
  assert.strictEqual(await pg.locator('.lklist li').count(), 0, 'the link goes at once');
  assert.ok(/Project link deleted/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'and the Undo message shows at once');
  await settle();
  assert.strictEqual(projectLinks().length, 0, 'the remove reached the server');
  log('Links: + Link and Remove answer at once and reach the server');
  await quick('Resources: add a link dialog', pg.locator('[data-act="resources.add"]').first()); await closeDialog();
  await quick('Sticky: + Note', pg.locator('[data-act="stickies.add"]'));
  await settle();
  // adding and editing a resource close the dialog and show the change before the slow server answers
  const spec = () => env.server.run('bootstrap()').data.resources.find((r) => r.title === 'Spec sheet');
  await quickly(async () => {
    await pg.locator('[data-act="resources.add"]').first().click();
    await pg.fill('#dlg-title', 'Spec sheet'); await pg.fill('#dlg-value', 'https://example.com/spec');
  });
  await quick('Resources: Add', pg.locator('#dlg-submit'));
  assert.ok(await pg.isVisible('.reslist a:text("Spec sheet")'), 'the new resource shows at once');
  assert.ok(!spec(), 'before the slow server has saved it');
  await settle();
  assert.strictEqual(spec().value, 'https://example.com/spec', 'the add reached the server');
  await quickly(async () => {
    await pg.click('.reslist li:has-text("Spec sheet") [data-act="resources.edit"]');
    await pg.fill('#dlg-group', 'Docs'); await pg.fill('#dlg-value', 'https://example.com/spec-v2');
  });
  await quick('Resources: Save an edit', pg.locator('#dlg-submit'));
  assert.ok(await pg.isVisible('.rgroup:text("Docs")'), 'the edit shows at once, under its new group');
  await settle();
  assert.deepStrictEqual([spec().group, spec().value], ['Docs', 'https://example.com/spec-v2'], 'the edit reached the server');
  log('Resources: Add and an edit show at once and reach the server');
  const links = () => env.server.run('bootstrap()').data.resources.filter((r) => r.title === 'Spec sheet').length;
  await quick('Resources: remove a link', pg.locator('.reslist li:has-text("Spec sheet") [data-act="resources.remove"]'));
  assert.ok(!(await pg.isVisible('.reslist a:text("Spec sheet")')), 'the link goes at once');
  assert.ok(/Resource deleted/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'and the Undo message shows at once');
  await settle();
  assert.strictEqual(links(), 0, 'the remove reached the server');
  log('Project: dialogs and panels open at once, and a removed link goes at once with an Undo message');

  // ---------- Insights: sub-tabs switch on the page, without waiting for the server ----------
  await gotoTab('Insights');
  await quickly(async () => { await pg.waitForSelector('.insights h2, .insights .stat, .ltable', { timeout: 8000 }); });
  for (const name of ['Habits', 'Projects', 'Logs', 'Week']) await quick('Insights: ' + name + ' sub-tab', pg.locator('.subtab:text-is("' + name + '")'));
  assert.ok(await pg.isVisible('.insights h2'), 'the week shows');
  if (size.mobile) {
    const pager = await pg.evaluate(() => document.getElementById('pager').innerText);
    assert.ok(/Insights/.test(pager) && /Whiteboards/.test(pager), 'the phone pager (and swipe) includes Insights: ' + pager);
  }
  log('Insights: sub-tabs answer at once');
  await openFirstProject();

  // ---------- header: Settings (⚙), which holds Undo, Redo and Back ----------
  await settle();
  await quick('Header: Settings', pg.locator('#settingsBtn')); await closeDialog();
  const inSettings = async (label, id) => { await quickly(async () => { await pg.click('#settingsBtn'); await pg.waitForSelector('.dialog #' + id); }); await quick(label, pg.locator('#' + id)); };
  await inSettings('Settings: Undo says it is working', 'undoBtn');
  assert.ok(/Undoing/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'Undo shows a message at once');
  assert.ok(!(await pg.isVisible('.dialog')), 'and Settings closes');
  await settle();
  assert.strictEqual(links(), 1, 'Undo brought the link back on the server');
  await inSettings('Settings: Redo says it is working', 'redoBtn');
  assert.ok(/Redoing/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'Redo shows a message at once');
  await settle();
  await inSettings('Settings: Back', 'backBtn');
  await settle();
  log('Header: Settings, and Undo, Redo and Back in it, answer at once');

  // ---------- lists linked to a project, the Whiteboards tab, a board on Today ----------
  const call = (m, fn, args) => JSON.parse(JSON.stringify(env.server.run('rpc')(m, fn, args))).result;
  const listId = call('lists', 'create', { name: 'Shopping' }).id;
  const boardId = call('whiteboard', 'create', { name: 'Loose sketch' }).id;
  await quickly(() => pg.evaluate(() => FT.reload()));
  await gotoTab('Lists');
  await quick('Lists: Settings dialog', pg.locator('.listpanel [data-act="lists.settings"]').first());
  await pg.selectOption('#dlg-listproject', id);
  await quick('Lists: save a linked project', pg.locator('#dlg-submit'));
  assert.ok(await pg.isVisible('.listpanel [data-act="lists.openProject"]'), 'the link shows at once');
  await settle();
  assert.strictEqual(env.server.run('bootstrap()').data.lists.find((l) => l.id === listId).project_id, id, 'the link reached the server');
  await quick('Lists: open the linked project', pg.locator('.listpanel [data-act="lists.openProject"]').first());
  assert.ok(await pg.isVisible('#app .listpanel .label:text("Shopping")'), 'the list is on the project page');
  log('Lists: Settings links a list to a project at once, and the list shows on that project\'s page');

  await gotoTab('Whiteboards');
  await quick('Whiteboards: + New whiteboard dialog', pg.locator('[data-act="whiteboard.new"][data-pick]')); await closeDialog();
  const chip = pg.locator('.wblist li:has-text("Loose sketch") [data-act="whiteboard.today"]');
  await quick('Whiteboards: + Today', chip);
  assert.strictEqual(await chip.getAttribute('aria-pressed'), 'true', 'On Today shows at once');
  await settle();
  assert.strictEqual(env.server.run('bootstrap()').data.whiteboard.find((b) => b.id === boardId).show_today, 'yes', 'On Today reached the server');
  await gotoTab('Today');
  const todayThumb = pg.locator('#app .wbtodaypanel .wbthumb').first();
  await todayThumb.scrollIntoViewIfNeeded();
  const t0 = Date.now();
  await todayThumb.click();
  await pg.waitForSelector('#wb-shell', { timeout: FEEDBACK_MS + 100 });
  assert.ok(Date.now() - t0 <= FEEDBACK_MS + 100, 'the board opens at once from Today');
  await pg.click('[data-act="whiteboard.discard"]');
  await pg.waitForSelector('#wb-shell', { state: 'detached', timeout: 10000 });
  await settle();
  log('Whiteboards: the tab\'s buttons and "+ Today" answer at once, and a board on Today opens from its thumbnail');

  // ---------- Edit layout: the header button (desktop) or menu item (phone), ▲ ▼ on a phone, Hide and Add feature ----------
  await gotoTab('Today');
  const layoutNow = () => JSON.parse(JSON.stringify(env.server.run('bootstrap()').data.layout));
  const panelOnPage = (id) => `#app .grid-stack-item[gs-id="${id}"], #app .lcell[data-panel="${id}"]`;
  if (size.mobile) {
    await quickly(() => pg.click('#menuBtn'));
    assert.strictEqual(await pg.innerText('#menuLayoutBtn'), 'Edit layout', 'the phone menu has Edit layout');
    await quick('Menu: Edit layout', pg.locator('#menuLayoutBtn'));
  } else {
    assert.strictEqual(await pg.innerText('#layoutBtn'), 'Edit layout', 'the header has a text button');
    await quick('Header: Edit layout', pg.locator('#layoutBtn'));
  }
  assert.ok(await pg.isVisible('.editbar [data-act="core.addFeature"]'), 'Edit layout shows Add feature');
  if (size.mobile) {
    const order = () => pg.evaluate(() => [...document.querySelectorAll('#app .lcell')].map((c) => c.dataset.panel));
    const start = await order(), swapped = [start[1], start[0]].concat(start.slice(2));
    await quick('Edit layout: ▼', pg.locator(`.lcell[data-panel="${start[0]}"] [data-act="core.movePanel"][data-d="1"]`));
    assert.deepStrictEqual(await order(), swapped, 'moved down at once');
    await settle();
    assert.deepStrictEqual((layoutNow()['today.phone'] || []).slice(0, 2), swapped.slice(0, 2), 'the phone order reached the server');
    await quick('Edit layout: ▲', pg.locator(`.lcell[data-panel="${start[0]}"] [data-act="core.movePanel"][data-d="-1"]`));
    assert.deepStrictEqual(await order(), start, 'moved back up at once');
    await settle();
    assert.deepStrictEqual((layoutNow()['today.phone'] || []).slice(0, 2), start.slice(0, 2), 'and that reached the server');
    log('Edit layout: ▲ ▼ move a panel at once and the phone order reaches the server');
  }
  await quick('Edit layout: Hide', pg.locator('#app [data-act="core.hidePanel"][data-id="rotation"]'));
  assert.ok(!(await pg.isVisible(panelOnPage('rotation'))), 'the panel goes at once');
  await settle();
  assert.ok(layoutNow().today.rotation.hidden, 'the hide reached the server');
  await quick('Edit layout: Add feature', pg.locator('.editbar [data-act="core.addFeature"]'));
  assert.ok(await pg.isVisible('#dlg-features li:has-text("Weekly rotation")'), 'the hidden panel is offered');
  await quick('Add feature: Add a hidden panel', pg.locator('#dlg-features [aria-label="Add Weekly rotation"]'));
  assert.ok(await pg.isVisible(panelOnPage('rotation')), 'it is back at once');
  await settle();
  assert.ok(!layoutNow().today.rotation.hidden, 'the show reached the server');
  await quick('Add feature: Add a list to Today', pg.locator('#dlg-features [aria-label="Add Shopping"]'));
  assert.ok(await pg.isVisible(panelOnPage('list-' + listId)), 'the list is on Today at once');
  await settle();
  assert.strictEqual(env.server.run('bootstrap()').data.lists.find((l) => l.id === listId).show_today, 'yes', 'show_today reached the server');
  await quickly(async () => { await pg.click('#dlg-submit'); await pg.click('.editbar [data-act="core.layout"]'); });
  assert.ok(!(await pg.isVisible('.editbar')), 'Done leaves Edit layout');
  log('Edit layout: the button, Hide, Add feature and its Add answer at once and reach the server');


  // ---------- 3: a save the server refuses ----------
  await openFirstProject();
  const unfail = env.failWhere((name, args) => name === 'rpc' && args[0] === 'projects' && args[1] === 'update');
  await quick('Project: Mark done (server will refuse)', pg.locator('[data-act="projects.status"][data-status="done"]'));
  assert.strictEqual(await status(), 'done', 'it shows done while the save is on its way');
  await pg.waitForFunction(() => FT.project(FT.state.projectId).status === 'active', null, { timeout: 8000 });
  assert.ok(await pg.isVisible('[data-act="projects.status"][data-status="done"]'), 'the button goes back to Mark done');
  const message = await pg.evaluate(() => document.getElementById('toast').innerText);
  assert.ok(/refused/i.test(message), 'and the reason is shown: ' + message);
  unfail();
  assert.strictEqual(projectRow(await projectId()).status, 'active', 'the server never changed');
  log('A refused save puts the screen back and says why');

  // ---------- 4: a call that hangs ----------
  const release = env.holdWhere((name, args) => name === 'rpc' && args[0] === 'notes' || args[0] === 'kanban' && args[1] === 'addColumn');
  const stuck = pg.evaluate(() => FT.rpc('notes', 'get', { projectId: FT.state.projectId }, { quiet: true }).catch(() => null));
  await sleep(150);
  await quick('Project: Mark done while another call hangs', pg.locator('[data-act="projects.status"][data-status="done"]'));
  assert.strictEqual(await status(), 'done');
  await quick('Project: Edit dialog while another call hangs', pg.locator('[data-act="projects.edit"]')); await closeDialog();
  release();
  await stuck.catch(() => {});
  await settle();
  assert.strictEqual(projectRow(await projectId()).status, 'done', 'the change was sent after the hung call finished');
  log('A hung call does not stop buttons responding');
  await quickly(async () => { await pg.locator('[data-act="projects.status"]:has-text("Reopen")').click(); await sleep(300); });
  await settle();

  // ---------- 5: nothing covers the controls ----------
  env.latency = 0;
  await pg.evaluate(() => window.scrollTo(0, 0)); await sleep(100);
  const covered = await pg.evaluate(() => {
    const bad = [];
    document.querySelectorAll('#app [data-act], #app select, #app input').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || el.closest('[hidden]')) return;
      const top = document.elementFromPoint(Math.min(innerWidth - 1, r.left + r.width / 2), Math.min(innerHeight - 1, r.top + r.height / 2));
      if (top && !(el === top || el.contains(top) || top.contains(el))) {
        const what = top.closest('.sticky, .stickyfab') ? 'a sticky note' : top.closest('#toast') ? 'the message' : (top.className || top.tagName);
        bad.push((el.dataset.act || el.id || el.tagName) + ' is under ' + what);
      }
    });
    return bad;
  });
  const notes = covered.filter((c) => !/a sticky note|the message/.test(c)); // notes float by design, and a message goes away
  assert.deepStrictEqual(notes, [], 'controls covered by something: ' + notes.join('; '));
  log('Nothing covers the visible controls (' + (covered.length ? covered.length + ' only under sticky notes, which float by design' : 'sticky notes aside') + ')');

  // a new sticky note must not land on top of the project's action buttons
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.evaluate(() => { const b = document.querySelector('[data-act="projects.edit"]'); b && b.scrollIntoView({ block: 'start' }); window.scrollBy(0, -130); }); // buttons just below the sticky header
  await sleep(150);
  await pg.click('[data-act="stickies.add"]'); await sleep(300);
  const hidden = await pg.evaluate(() => [...document.querySelectorAll('.board, #app .phead ~ .actions button, #app [data-act^="projects."]')].filter((el) => {
    const r = el.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > innerHeight || !el.dataset.act) return false;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && top.closest('.sticky') && !(el === top || el.contains(top)); // only a sticky note counts as covering
  }).map((el) => el.dataset.act));
  assert.deepStrictEqual(hidden, [], 'a new sticky note landed on top of: ' + hidden.join(', '));
  log('A new sticky note does not land on the project buttons');

  // ---------- 6: things only a real browser can do (desktop only: keyboard shortcuts and drawing) ----------
  if (!size.mobile) {
    const serverCall = (m, fn, args) => JSON.parse(JSON.stringify(env.server.run('rpc')(m, fn, args))).result;
    await pg.evaluate(() => document.querySelectorAll('.sticky').forEach((n) => n.remove())); // the new note from above may float over the editor
    const pid = await projectId();
    // Typing makes the notes taller: the panels around them must move, never sit on top of them (GridStack heights follow content).
    const gridLoaded = await pg.evaluate(() => !!window.GridStack && !!document.querySelector('#app .grid-stack-item[gs-id="notes"]'));
    if (!gridLoaded) {
      out.push('  skip [' + size.name + '] Panel overlap: GridStack did not load from the CDN');
    } else {
      const overlaps = () => pg.evaluate(() => {
        const boxes = [...document.querySelectorAll('#app .grid-stack-item > .grid-stack-item-content > :first-child')]
          .map((el) => ({ id: el.closest('.grid-stack-item').getAttribute('gs-id'), r: el.getBoundingClientRect() }));
        const bad = [];
        boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
          if (a.r.left < b.r.right - 1 && b.r.left < a.r.right - 1 && a.r.top < b.r.bottom - 1 && b.r.top < a.r.bottom - 1) bad.push(a.id + ' and ' + b.id);
        }));
        return bad;
      });
      const notesHeight = () => pg.evaluate(() => document.getElementById('nt-panel').getBoundingClientRect().height);
      assert.deepStrictEqual(await overlaps(), [], 'panels overlap before typing');
      const h0 = await notesHeight();
      await pg.click('#nt-text');
      await pg.keyboard.press('Control+End');
      for (let i = 1; i <= 25; i++) { await pg.keyboard.press('Enter'); await pg.keyboard.type('Line ' + i); }
      await sleep(300);
      assert.ok((await notesHeight()) > h0 + 150, 'the notes grew while typing');
      assert.deepStrictEqual(await overlaps(), [], 'panels overlap after typing in the notes');
      for (let i = 1; i <= 25; i++) { await pg.keyboard.press('Shift+ArrowUp'); }
      await pg.keyboard.press('Shift+Home');
      await pg.keyboard.press('Backspace');
      await sleep(300);
      assert.deepStrictEqual(await overlaps(), [], 'panels overlap after deleting the lines');
      const gaps = await pg.evaluate(() => {
        const n = document.querySelector('#app .grid-stack-item[gs-id="notes"]');
        return n.getBoundingClientRect().height - n.querySelector('.grid-stack-item-content > :first-child').getBoundingClientRect().height;
      });
      assert.ok(gaps < 40, 'and the notes cell shrank back with them (' + Math.round(gaps) + ' px spare)');
      await pg.waitForFunction(() => document.getElementById('nt-status').textContent === 'Saved', null, { timeout: 10000 });
      log('Notes: typing many lines and deleting them moves the panels around the notes; none overlap');
    }
    await pg.waitForSelector('#nt-text[contenteditable="true"]');
    await pg.click('#nt-text');
    await pg.keyboard.press('Control+End');
    await pg.keyboard.press('Enter');
    await pg.keyboard.type('Wiring plan');
    await pg.keyboard.press('Control+Alt+2');
    assert.ok(await pg.isVisible('#nt-text h2:text("Wiring plan")'), 'Ctrl+Alt+2 makes the line a heading 2');
    await pg.waitForFunction(() => document.getElementById('nt-status').textContent === 'Saved', null, { timeout: 10000 });
    assert.ok(serverCall('notes', 'get', { projectId: pid }).text.split('\n').some((l) => l === '## Wiring plan'), 'saved as a markdown heading');
    await pg.keyboard.press('Control+Alt+0');
    assert.ok(!(await pg.isVisible('#nt-text h2')) && await pg.isVisible('#nt-text p:text("Wiring plan")'), 'Ctrl+Alt+0 makes it normal text again');
    await pg.waitForFunction(() => document.getElementById('nt-status').textContent === 'Saved', null, { timeout: 10000 });
    assert.ok(!/^## Wiring plan$/m.test(serverCall('notes', 'get', { projectId: pid }).text), 'and that is saved too');
    await pg.click('[data-act="notes.done"]').catch(() => {});
    log('Notes: Ctrl+Alt+2 makes a heading 2 and Ctrl+Alt+0 normal text, and both are saved');

    await quickly(async () => { await pg.locator('[data-act="kanban.open-card"]').first().click(); await pg.waitForSelector('#dlg-note'); });
    await pg.click('#dlg-note'); await pg.keyboard.press('Control+End'); await pg.keyboard.press('Enter');
    await pg.keyboard.type('Parts'); await pg.keyboard.press('Control+Alt+3');
    assert.ok(await pg.isVisible('#dlg-note h3:text("Parts")'), 'Ctrl+Alt+3 makes a heading 3 in a card note');
    await pg.click('#dlg-cancel'); // Esc would first warn about the unsaved note; Cancel throws it away on purpose
    log('Card note: Ctrl+Alt+3 makes a heading 3');

    // Excalidraw loads from jsDelivr, so without a network this part is skipped.
    env.latency = 0;
    await pg.evaluate(() => localStorage.setItem('ft.whiteboard.tool', 'rectangle'));
    await pg.click('[data-act="whiteboard.new"]'); await pg.fill('#dlg-boardname', 'Browser test'); await pg.keyboard.press('Enter');
    const loaded = await pg.waitForFunction(() => /New drawing|Saved/.test((document.getElementById('wb-status') || {}).textContent || ''), null, { timeout: 30000 })
      .then(() => true, () => false);
    if (!loaded) {
      out.push('  skip [' + size.name + '] Whiteboard: Excalidraw did not load (no network?), so favourite tool and Close without saving were not tried');
      await pg.evaluate(() => { const b = document.querySelector('[data-act="whiteboard.discard"]'); if (b) b.click(); });
    } else {
      await sleep(300);
      assert.ok(await pg.isChecked('[data-testid="toolbar-rectangle"]'), 'the favourite tool from Settings is selected');
      const board = env.server.run('bootstrap()').data.whiteboard.find((x) => x.name === 'Browser test');
      const elements = () => JSON.parse(serverCall('whiteboard', 'get', { id: board.id }).json).elements.length;
      const box = await pg.locator('.excalidraw__canvas.interactive').boundingBox();
      await pg.mouse.move(box.x + 300, box.y + 250); await pg.mouse.down(); await pg.mouse.move(box.x + 450, box.y + 350, { steps: 5 }); await pg.mouse.up();
      await pg.waitForFunction(() => document.getElementById('wb-status').textContent === 'Saved', null, { timeout: 10000 });
      assert.strictEqual(elements(), 1, 'the rectangle was autosaved');
      const thumbOf = () => serverCall('whiteboard', 'thumbs', { ids: [board.id] })[0];
      const thumb = thumbOf();
      assert.ok(thumb && /^data:image\/(webp|jpeg);base64,/.test(thumb.image) && thumb.image.length <= 45000, 'with a small thumbnail: ' + (thumb ? thumb.image.slice(0, 30) + '… ' + thumb.image.length : 'none'));
      await pg.click('[data-act="whiteboard.discard"]');
      await pg.waitForSelector('.dialog #dlg-submit.danger');
      await pg.click('#dlg-submit');
      await pg.waitForSelector('#wb-shell', { state: 'detached', timeout: 10000 });
      assert.strictEqual(elements(), 0, 'Close without saving put back the empty board');
      await sleep(SAVE_WAIT_MS);
      assert.strictEqual(elements(), 0, 'and no autosave wrote the thrown-away drawing afterwards');
      assert.strictEqual(thumbOf(), undefined, 'the empty board it went back to has no thumbnail');
      log('Whiteboard: favourite tool is selected on open, and Close without saving puts back the opening version');

      await pg.click('.wblist .wbname:text("Browser test")');
      await pg.waitForFunction(() => /New drawing/.test((document.getElementById('wb-status') || {}).textContent || ''), null, { timeout: 30000 });
      await sleep(300);
      const box2 = await pg.locator('.excalidraw__canvas.interactive').boundingBox();
      await pg.mouse.move(box2.x + 250, box2.y + 200); await pg.mouse.down(); await pg.mouse.move(box2.x + 500, box2.y + 380, { steps: 5 }); await pg.mouse.up();
      await pg.click('[data-act="whiteboard.close"]');
      await pg.waitForSelector('#wb-shell', { state: 'detached', timeout: 10000 });
      const img = pg.locator('.wblist li:has-text("Browser test") .wbthumb img');
      await img.waitFor({ timeout: 2000 });
      assert.strictEqual(await img.getAttribute('src'), thumbOf().image, 'the project panel shows the thumbnail it just saved');
      log('Whiteboard: a drawn board gets a small thumbnail (' + thumbOf().image.length + ' characters), shown in the board list');
    }
    await pg.evaluate(() => localStorage.removeItem('ft.whiteboard.tool'));
    env.latency = LATENCY;
  }
  // ---------- 6: typed notes are never lost ----------
  // Type, make a heading inside a list item (the converter used to drop that text), press Done or move on, and reload
  // before any save could reach the server (they are refused meanwhile). The text must come back and reach the server.
  await pg.evaluate(() => document.querySelectorAll('.sticky').forEach((n) => n.remove())); // the notes float over the editor
  const notesId = await projectId();
  const unfailNotes = env.failWhere((name, args) => name === 'rpc' && args[0] === 'notes' && args[1] === 'save');
  env.latency = LATENCY;
  await pg.click('#nt-text');
  await pg.keyboard.press('Control+End');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('Kept after a quick reload');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('- a list item that becomes a heading');
  await pg.click('#nt-bar button[data-val="h2"]');
  if (size.mobile) await pg.click('.notes-done');
  await pg.reload();
  unfailNotes();
  await pg.waitForSelector('#nt-text[contenteditable="true"]', { timeout: 15000 });
  const notesText = () => env.server.run('rpc')('notes', 'get', { projectId: notesId }, null).result.text;
  for (let t0 = Date.now(); !/Kept after a quick reload[\s\S]*a list item that becomes a heading/.test(notesText()); await sleep(100)) {
    assert.ok(Date.now() - t0 < 15000, '[' + size.name + '] the notes typed before the reload never reached the server: ' + JSON.stringify(notesText()));
  }
  assert.ok((await pg.innerText('#nt-text')).includes('a list item that becomes a heading'), 'and they are in the editor');
  log('Notes typed just before a reload come back and are saved, including a heading inside a list item');

  // ---------- 7: the notes' Google Doc ----------
  // Opening a project with notes makes their Doc in the background; then "Open in Docs" shows and links it.
  await pg.waitForSelector('#nt-link:not([hidden])', { timeout: 15000 });
  const docLink = await pg.evaluate(() => { const a = document.getElementById('nt-link'); return { text: a.textContent, href: a.href, visible: a.offsetParent !== null }; });
  const docRow = env.server.run('bootstrap()').data.notes.find((n) => n.project_id === notesId);
  assert.strictEqual(docLink.text, 'Open in Docs');
  assert.ok(docLink.visible, '[' + size.name + '] "Open in Docs" is on screen');
  assert.ok(/^https:\/\/docs\.google\.com\/document\/d\//.test(docLink.href) && docLink.href === docRow.doc, '[' + size.name + '] and links the Doc: ' + docLink.href);
  log('"Open in Docs" shows once the notes Doc exists');

  await ctx.close();
  await env.close();
  assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | '));
  return out;
}

(async () => {
  if (process.env.SKIP_BROWSER) { console.log('  skipped (SKIP_BROWSER is set)'); return; }
  const chrome = findChrome();
  if (!chrome) { console.log('  skipped: no Chrome found (set CHROME_PATH to run the real-browser tests)'); return; }
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: chrome });
  try {
    const results = await Promise.all(SIZES.map((size) => run(browser, size)));
    results.forEach((lines) => lines.forEach((l) => console.log(l)));
    console.log(SIZES.length + ' browser sizes passed');
  } finally { await browser.close(); }
})().catch((e) => { console.error('FAIL\n' + (e.stack || e.message)); process.exit(1); });
