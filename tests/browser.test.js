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
  await pg.waitForSelector(size.mobile ? '.fc-name' : '.focus-name');

  // Anything on screen that a click could change: the page, the dialog, the message, the page address.
  const signature = () => pg.evaluate(() => [document.getElementById('app').innerText, document.getElementById('dialogRoot').innerHTML.length,
    document.getElementById('toast').hidden ? '' : document.getElementById('toast').innerText, location.href, document.querySelectorAll('#app .done').length].join('|'));
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
  // The Projects tab reopens the project last shown in it; "‹ All projects" goes to the list.
  const openFirstProject = () => quickly(async () => {
    await gotoTab('Projects');
    if (await pg.isVisible('#app [data-act="core.tab"][data-list]')) { await pg.click('#app [data-act="core.tab"][data-list]'); await sleep(250); }
    await pg.click('.rowlink >> nth=0'); await sleep(400);
  });
  const todayState = () => env.server.run('bootstrap()').data.today;
  const projectRow = (id) => env.server.run('bootstrap()').data.projects.find((p) => p.id === id);
  const status = () => pg.evaluate(() => FT.project(FT.state.projectId).status);
  const projectId = () => pg.evaluate(() => FT.state.projectId);
  // The to-dos are a to-do list (the seed's first to-do made "To-dos"), a panel like any list's.
  const todosPanel = () => 'list-' + env.server.run('bootstrap()').data.lists.find((l) => l.kind === 'todo').id;
  // On a phone Today shows one panel at a time: tap its chip first (the pager's own checks are further down).
  const showPanel = (id) => quickly(async () => {
    const chip = '#app .pchip[data-id="' + id + '"]';
    if (size.mobile && await pg.isVisible(chip)) await pg.click(chip);
  });

  env.latency = LATENCY;

  // ---------- 1 and 2: Today ----------
  await quick('Today: Start session', pg.locator('[data-act="today.start"]'));
  assert.ok(await pg.isVisible('#timer'), 'the timer shows straight away');
  await settle();
  assert.ok(todayState().session, 'the session reached the server');
  await quick('Today: Pause', pg.locator('[data-act="today.pause"]'));
  assert.ok(await pg.isVisible('[data-act="today.resume"]'), 'it shows Resume straight away');
  await settle();
  assert.ok(todayState().session.pausedAt, 'the pause reached the server');
  await quick('Today: Resume', pg.locator('[data-act="today.resume"]'));
  await settle();
  assert.ok(!todayState().session.pausedAt, 'the resume reached the server');
  if (size.mobile) await quick('Today: More on the pinned focus', pg.locator('.ppinned-more'));
  await quick('Today: Pomodoro lengths dialog', pg.locator('[data-act="today.pomodoroSettings"]')); await closeDialog();
  await quick('Today: Finish dialog', pg.locator('[data-act="today.finish"]')); await closeDialog();
  log('Today: session buttons answer at once and the server catches up');

  // ---------- the corner timer: a drag (mouse, or a finger on the phone) snaps to the nearest corner ----------
  const vp = size.viewport;
  const cornerBox = () => pg.locator('#cornerTimer').boundingBox();
  await pg.waitForSelector('#cornerTimer:not([hidden])');
  let timerBox = await cornerBox();
  assert.ok(timerBox.x < vp.width / 2 && timerBox.y > vp.height / 2, '[' + size.name + '] the corner timer starts bottom left: ' + JSON.stringify(timerBox));
  const dragFrom = { x: timerBox.x + 30, y: timerBox.y + timerBox.height / 2 }, dragTo = { x: vp.width - 40, y: 160 };
  if (size.mobile) {
    const cdp = await ctx.newCDPSession(pg);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [dragFrom] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: dragFrom.x + (dragTo.x - dragFrom.x) * i / 8, y: dragFrom.y + (dragTo.y - dragFrom.y) * i / 8 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await pg.mouse.move(dragFrom.x, dragFrom.y); await pg.mouse.down(); await pg.mouse.move(dragTo.x, dragTo.y, { steps: 8 }); await pg.mouse.up();
  }
  await sleep(100);
  timerBox = await cornerBox();
  assert.ok(timerBox.x + timerBox.width > vp.width - 30 && timerBox.y < 130, '[' + size.name + '] the corner timer snapped to the top right: ' + JSON.stringify(timerBox));
  assert.strictEqual(await pg.evaluate(() => FT.state.view), 'today', 'a drag is not a click');
  assert.strictEqual(await pg.evaluate(() => localStorage.getItem('ft.timer.corner')), 'top-right');
  const einkBorder = await pg.evaluate(() => {
    document.documentElement.dataset.theme = 'eink';
    const style = getComputedStyle(document.getElementById('cornerTimer'));
    const border = style.borderTopWidth + ' ' + style.transitionDuration;
    delete document.documentElement.dataset.theme;
    return border;
  });
  assert.strictEqual(einkBorder, '3px 0s', 'E-ink: a thick border and no motion');
  await quick('Corner timer: opens the focus project', pg.locator('#cornerTimer .ct-open'));
  assert.strictEqual(await pg.evaluate(() => FT.state.view), 'project');
  await pg.evaluate(() => { localStorage.removeItem('ft.timer.corner'); document.getElementById('cornerTimer').dataset.corner = 'bottom-left'; });
  await gotoTab('Today');
  log('Corner timer: a ' + (size.mobile ? 'finger' : 'mouse') + ' drag snaps to the nearest corner, E-ink gets a thick border, and a tap opens the focus project');

  // ---------- Keep going once the planned time is up ----------
  await quickly(async () => {
    env.server.run(`(function () { var props = PropertiesService.getUserProperties(), s = JSON.parse(props.getProperty('today.state'));
      s.session.start = new Date(Date.now() - 29.5 * 60000).toISOString(); s.session.pausedMs = 0; s.session.pausedAt = '';
      props.setProperty('today.state', JSON.stringify(s)); })()`);
    await pg.evaluate(() => FT.reload());
  });
  await pg.waitForSelector('#plan.over');
  await quick('Today: Keep going +10 min', pg.locator('[data-act="today.keepGoing"][data-min="10"]'));
  assert.ok(!(await pg.isVisible('#plan.over')), 'the countdown is back straight away');
  await settle();
  assert.ok([40, 41].includes(todayState().session.plannedMin), 'the new length reached the server: ' + todayState().session.plannedMin);
  log('Today: Keep going answers at once and the server catches up');

  await quickly(async () => { await pg.locator('[data-act="today.finish"]').click(); await pg.fill('#dlg-where', 'testing'); await pg.click('#dlg-submit'); await sleep(500); });
  await settle();

  // ---------- Delete a session ----------
  await quickly(async () => { await pg.locator('[data-act="today.start"]').click(); await sleep(300); });
  await settle();
  await quickly(async () => { await pg.locator('[data-act="today.finish"]').click(); await pg.click('#dlg-discard'); await sleep(100); });
  await quick('Today: Delete session (after the confirm)', pg.locator('#dlg-submit'));
  assert.ok(!(await pg.isVisible('.timer')), 'the session goes at once');
  await settle();
  assert.strictEqual(todayState().session, null, 'deleted on the server');
  log('Today: Delete session answers at once and the server catches up');
  await quick('Today: Swap focus dialog', pg.locator('[data-act="today.swap"]')); await closeDialog();
  // ---------- 1 and 2: the Habits and To-dos panels ----------
  const srv = (code) => { const v = env.server.run('(function () { tableCache_ = {}; return ' + code + '; })()'); return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
  const habitsNow = () => env.server.run('bootstrap()').data.habits;
  const todosNow = () => env.server.run('bootstrap()').data.todos.items;
  const today = srv('todayIso_()');
  const doneToday = (id) => { const r = habitsNow().log.find((x) => x.habit_id === id && x.kind === 'done' && x.day === today); return r ? r.count : 0; };
  const jobId = habitsNow().habits.find((h) => h.name === 'Job search').id;
  await showPanel('habits');
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

  await showPanel(todosPanel());
  const grocery = () => todosNow().find((t) => t.title === 'Grocery shopping');
  await quick('To-dos: tick', pg.locator('.todos li:has-text("Grocery shopping") input[type="checkbox"]'));
  assert.ok(await pg.isVisible('.todos li.done:has-text("Grocery shopping")'), 'struck through at once');
  await settle();
  assert.strictEqual(grocery().done, today, 'the tick reached the server');
  await quickly(async () => { await pg.fill('.todos-panel .todoadd input >> nth=0', 'Post parcel'); });
  await quick('To-dos: add', pg.locator('.todos-panel [data-act="todos.addBtn"]').first());
  assert.ok(await pg.isVisible('.todos li:has-text("Post parcel")'), 'shows at once');
  await settle();
  assert.ok(todosNow().some((t) => t.title === 'Post parcel'), 'the new to-do reached the server');
  await quick('To-dos: delete', pg.locator('.todos li:has-text("Post parcel") [data-act="todos.remove"]'));
  assert.ok(/To-do deleted/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'with the Undo message at once');
  await settle();
  assert.ok(!todosNow().some((t) => t.title === 'Post parcel'), 'the delete reached the server');
  log('To-dos: tick, add and delete answer at once and reach the server');

  if (size.mobile) {
    const todoListId = todosPanel().slice('list-'.length);
    const serverRpc = (module, fn, args) => srv('rpc(' + [module, fn, args].map((value) => JSON.stringify(value)).join(', ') + ').result');
    const { longTodo, extraGroups } = await quickly(async () => {
      const added = serverRpc('todos', 'add', { title: 'Supercalifragilisticexpialidociousantidisestablishmentarianism-without-a-break', day: today, listId: todoListId, note: 'A description long enough to need cutting short on a phone screen' });
      const groups = ['Waiting on others', 'Someday'].map((name) => serverRpc('kanban', 'addColumn', { projectId: todoListId, name }));
      await pg.evaluate(() => FT.reload()); await sleep(400);
      return { longTodo: added, extraGroups: groups };
    });
    await showPanel(todosPanel());
    const todoLayout = () => pg.evaluate(() => {
      const panel = document.querySelector('#app .todos-panel'), screenWidth = document.documentElement.clientWidth;
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const shown = (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      return {
        pageWidth: document.documentElement.scrollWidth, screenWidth,
        pastTheScreen: Array.from(panel.querySelectorAll('*')).filter((el) => shown(el) && (box(el).right > screenWidth + 1 || box(el).left < -1)).map((el) => el.className || el.tagName),
        groups: Array.from(panel.querySelectorAll('.todogroup')).map(box),
        ticks: Array.from(panel.querySelectorAll('.todos .tick')).map(box),
        deletes: Array.from(panel.querySelectorAll('.todos .rm')).map(box),
        addRow: Array.from(panel.querySelector('.todoadd').children).map((el) => Object.assign(box(el), { shown: shown(el) })),
        panel: box(panel)
      };
    });
    let layout = await todoLayout();
    assert.ok(layout.pageWidth <= layout.screenWidth, '[' + size.name + '] the to-do panel makes no sideways scroll: ' + layout.pageWidth + ' > ' + layout.screenWidth);
    assert.deepStrictEqual(layout.pastTheScreen, [], '[' + size.name + '] nothing in the to-do panel reaches past the screen');
    assert.strictEqual(layout.groups.length, 3, 'three groups');
    layout.groups.slice(1).forEach((group, i) => {
      assert.ok(group.top >= layout.groups[i].bottom - 1 && Math.abs(group.left - layout.groups[i].left) < 1, '[' + size.name + '] groups stack on a phone, one under the other: ' + JSON.stringify(layout.groups));
    });
    layout.ticks.concat(layout.deletes).forEach((target) => {
      assert.ok(target.width >= 44 && target.height >= 44, '[' + size.name + '] a tick box and a delete button are at least 44 px to tap: ' + JSON.stringify(target));
    });
    const [addBox, daySelect, addButton] = layout.addRow;
    assert.ok(addBox.shown && !daySelect.shown && !addButton.shown, '[' + size.name + '] before typing, the add row is one box: ' + JSON.stringify(layout.addRow));
    assert.ok(addBox.width > layout.panel.width * 0.7, '[' + size.name + '] and the box has room to type in: ' + addBox.width);
    await quickly(() => pg.fill('#app .todos-panel .todoadd input >> nth=0', 'Book the van'));
    layout = await todoLayout();
    const [typedBox, shownSelect, shownButton] = layout.addRow;
    assert.ok(shownSelect.shown && shownButton.shown, '[' + size.name + '] while typing, the day and Add show');
    assert.ok(shownSelect.top >= typedBox.bottom && Math.abs(shownSelect.top - shownButton.top) < 1 && Math.abs(shownSelect.left - typedBox.left) < 1 && Math.abs(shownButton.right - typedBox.right) < 1,
      '[' + size.name + '] on a line of their own under the box, lined up with it: ' + JSON.stringify(layout.addRow));
    assert.deepStrictEqual(layout.pastTheScreen, [], '[' + size.name + '] still nothing past the screen');
    await quickly(async () => {
      await pg.fill('#app .todos-panel .todoadd input >> nth=0', '');
      extraGroups.forEach((group) => serverRpc('kanban', 'deleteColumn', { id: group.id }));
      serverRpc('todos', 'remove', { id: longTodo.id });
      await pg.evaluate(() => FT.reload()); await sleep(400);
    });
    log('To-dos: on a phone the panel fits the screen, groups stack, ticks are 44 px and the add row opens under its box');
  }

  // "Want to go further?": a weekly habit whose level was met in the two full weeks before this one
  const habit = JSON.parse(JSON.stringify(env.server.run('rpc')('habits', 'create', { name: 'Cardio', sessions: 2, per: 'week', size: '15 min', goal: '5 a week, 30 min', step_up_every: '2 weeks' }))).result;
  const makeDue = () => {
    srv(`new Table('Habit log', ['id']).removeWhere(function (r) { return r.habit_id === '${habit.id}' && (r.kind === 'level' || r.kind === 'done' || r.kind === 'pending' || r.kind === 'prompt' && r.day === todayIso_()); })`);
    const h = habitsNow().habits.find((x) => x.id === habit.id);
    srv(`new Table('Habits', ['id']).update('${habit.id}', { next_prompt: isoAddDays_(todayIso_(), -1), prompts: 'on' })`);
    srv(`new Table('Habit log', ['id']).insertMany([{ habit_id: '${habit.id}', day: isoAddDays_(isoMonday_(todayIso_()), -14), kind: 'level', value: '${h.sessions} a week, ${h.size}' },
      { habit_id: '${habit.id}', day: isoAddDays_(isoMonday_(todayIso_()), -13), kind: 'done', count: 5 }, { habit_id: '${habit.id}', day: isoAddDays_(isoMonday_(todayIso_()), -6), kind: 'done', count: 5 }])`);
  };
  const lastAnswer = () => srv(`new Table('Habit log', ['id']).all().filter(function (r) { return r.kind === 'prompt'; }).map(function (r) { return r.value; }).pop()`);
  for (const [label, answer] of [['Not now', 'not now'], ['Yes, adjust', 'yes'], ['I\'m at my goal', 'at goal']]) {
    makeDue();
    await quickly(async () => { await pg.evaluate(() => FT.reload()); });
    await showPanel('habits');
    await pg.waitForSelector('.stepcard');
    await quick('Want to go further?: ' + label, pg.locator(`.stepcard [data-act="habits.answer"][data-answer="${answer}"]`));
    assert.ok(!(await pg.isVisible('.stepcard')), 'the card goes at once');
    assert.ok(/Undo/.test(await pg.evaluate(() => document.getElementById('toast').innerText)), 'and the message offers Undo');
    await settle();
    assert.strictEqual(lastAnswer(), answer, label + ' reached the server');
  }
  assert.strictEqual(habitsNow().habits.find((x) => x.id === habit.id).prompts, 'at goal');
  log('Want to go further?: Not now, Yes, adjust and I\'m at my goal answer at once and reach the server');

  // a level change that is due: Not now and Accept answer at once and reach the server
  const pendingNow = () => srv(`new Table('Habit log', ['id']).all().filter(function (r) { return r.habit_id === '${habit.id}' && r.kind === 'pending'; }).map(function (r) { return r.day; })`);
  const makeLevelDue = () => srv(`(function () { var t = new Table('Habit log', ['id']); t.removeWhere(function (r) { return r.habit_id === '${habit.id}' && r.kind === 'pending'; }); t.insert({ habit_id: '${habit.id}', day: todayIso_(), kind: 'pending', value: '3 a week, 15 min' }); return true; })()`);
  makeLevelDue();
  await quickly(async () => { await pg.evaluate(() => FT.reload()); await pg.waitForSelector('.levelcard'); });
  await quick('New level: Not now', pg.locator('.levelcard [data-act="habits.postponeLevel"]'));
  assert.ok(!(await pg.isVisible('.levelcard')), 'the card goes at once');
  await settle();
  assert.ok(pendingNow()[0] > srv('todayIso_()'), 'Not now reached the server');
  makeLevelDue();
  await quickly(async () => { await pg.evaluate(() => FT.reload()); await pg.waitForSelector('.levelcard'); });
  await quick('New level: Accept', pg.locator('.levelcard [data-act="habits.acceptLevel"]'));
  assert.ok(!(await pg.isVisible('.levelcard')), 'the card goes at once');
  await settle();
  assert.strictEqual(habitsNow().habits.find((x) => x.id === habit.id).sessions, 3, 'Accept reached the server');
  log('New level: Not now and Accept answer at once and reach the server');

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

  await showPanel('rotation');
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
  await quick('Project: ⚙ Project settings menu', pg.locator('.phead [data-act="projects.settings"]'));
  await quick('Project: Lock dialog (from Project settings)', pg.locator('#pj-menu [data-act="projects.lock"]')); await closeDialog();
  // Next action: hidden by default; Show (Project settings) shows at once and reaches the project's row; Use default hides it again
  const projectView = () => env.server.run('bootstrap()').data.layout['project.view'] || {};
  assert.ok(!(await pg.isVisible('#app .phead ~ .next')) && !projectView().nextAction, 'hidden by default');
  await quick('Project: Project settings', pg.locator('.phead [data-act="projects.settings"]'));
  await quick('Project: Show next action', pg.locator('#pj-menu [data-act="projects.nextAction"][data-choice="on"]'));
  assert.ok(await pg.isVisible('#app .phead ~ .next'), 'the next action shows at once');
  await settle();
  assert.strictEqual(projectRow(id).show_next_action, 'on', 'and that reached the server');
  await quickly(async () => { await pg.click('.phead [data-act="projects.settings"]'); await pg.click('#pj-menu [data-act="projects.nextAction"][data-choice=""]'); await sleep(150); });
  await settle();
  assert.ok(!(await pg.isVisible('#app .phead ~ .next')) && projectRow(id).show_next_action === '', 'back to the default: hidden');
  // Settings → Show next action on projects: the mode's default, shown on the page behind at once and saved for the mode
  await quickly(async () => { await pg.click('#settingsBtn'); await pg.waitForSelector('input[name="dlg-nextaction"]'); });
  await quick('Settings: Show next action on projects', pg.locator('label:has(input[name="dlg-nextaction"][value="shown"])'));
  assert.ok(await pg.isVisible('#app .phead ~ .next'), 'the page behind shows it at once');
  await settle();
  assert.strictEqual(projectView().nextAction, 'shown', 'the default reached the mode\'s Settings');
  await quickly(async () => { await pg.click('label:has(input[name="dlg-nextaction"][value="hidden"])'); await sleep(150); });
  await settle();
  assert.ok(!projectView().nextAction, 'and back to hidden');
  await closeDialog();
  log('Project: ⚙ Project settings opens at once; Lock, Show next action and the Settings default answer at once and reach the server');

  // The top panel fits the window, with the next action hidden or shown, a long name, and at every width up to a wide desktop
  const headerOverflow = () => pg.evaluate(() => {
    const panel = document.querySelector('#app .phead').closest('.panel'), box = panel.getBoundingClientRect(), width = document.documentElement.clientWidth;
    const outside = [...panel.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5); });
    return { panelRight: Math.round(box.right), width, pageWidth: document.documentElement.scrollWidth, outside: outside.map((el) => el.dataset.act || el.className || el.tagName) };
  });
  const assertHeaderFits = async (label) => {
    const fit = await headerOverflow();
    assert.ok(fit.panelRight <= fit.width && fit.pageWidth <= fit.width && !fit.outside.length, '[' + size.name + '] the project top panel runs past the window (' + label + '): ' + JSON.stringify(fit));
  };
  const nameBefore = await pg.evaluate(() => FT.project(FT.state.projectId).name);
  for (const shown of [false, true]) {
    await pg.evaluate((on) => { FT.store.layout['project.view'] = on ? { nextAction: 'shown' } : {}; FT.render(); }, shown);
    await sleep(100);
    await assertHeaderFits('next action ' + (shown ? 'shown' : 'hidden'));
  }
  await pg.evaluate(() => { FT.project(FT.state.projectId).name = 'Rewire the garage workshop lights and sockets Supercalifragilisticexpialidociouslylongunbrokenword'; FT.render(); });
  await sleep(100);
  await assertHeaderFits('a long name');
  if (!size.mobile) {
    for (const width of [800, 1000, 1440]) {
      await pg.setViewportSize({ width, height: size.viewport.height }); await sleep(250);
      await assertHeaderFits(width + ' px wide');
    }
    await pg.setViewportSize(size.viewport); await sleep(250);
  }
  await pg.evaluate((name) => { FT.project(FT.state.projectId).name = name; FT.store.layout['project.view'] = {}; FT.render(); }, nameBefore);
  log('Project: the top panel fits the window with the next action hidden or shown and a long name' + (size.mobile ? '' : ', at 800 to 1440 px'));
  // the category picker: a pick shows at once and reaches the server; New category… is made and given at once
  const categoryOnServer = () => projectRow(id).category;
  const startCategory = await pg.evaluate(() => FT.project(FT.state.projectId).category);
  const otherCategory = await pg.evaluate((c) => FT.categories().find((x) => x.id !== c).id, startCategory);
  await quick('Project: category picker', pg.locator('.phead [data-act="projects.pickCategory"]'));
  await quick('Project: pick a category', pg.locator('#pj-menu [data-category="' + otherCategory + '"]'));
  assert.strictEqual(await pg.evaluate(() => FT.project(FT.state.projectId).category), otherCategory, 'shown at once');
  assert.strictEqual(categoryOnServer(), startCategory, 'before the slow server has it');
  await settle();
  assert.strictEqual(categoryOnServer(), otherCategory, 'the pick reached the server');
  await quickly(async () => { await pg.click('.phead [data-act="projects.pickCategory"]'); await pg.click('#pj-menu [data-act="projects.newCategory"]'); await pg.fill('#dlg-catlabel', 'Allotment'); });
  await quick('Project: New category (save)', pg.locator('#dlg-submit'));
  assert.ok(!(await pg.isVisible('.dialog')), 'the dialog closes at once');
  assert.strictEqual(await pg.locator('.phead .pill').innerText(), 'Allotment', 'and the project shows it at once');
  await settle();
  const allotment = env.server.run('bootstrap()').data.categories.find((c) => c.label === 'Allotment');
  assert.ok(allotment && categoryOnServer() === allotment.id, 'made and given on the server');
  await quickly(async () => { await pg.click('.phead [data-act="projects.pickCategory"]'); await pg.click('#pj-menu [data-category="' + startCategory + '"]'); await sleep(150); });
  await settle();
  assert.strictEqual(categoryOnServer(), startCategory);
  log('Category picker: a pick and New category… show at once and reach the server');
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
  await quick('Links: open the Linked projects section', pg.locator('.psectbtn[data-id="linked"]'));
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
  await quickly(async () => { await pg.locator('.sticky [data-act="stickies.remove"]').last().click(); await settle(); }); // it floats where the resources are tested next
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
  await gotoTab('Notes');
  await quick('Notes tab: open the list\'s card', pg.locator(`#app .nx-card[data-id="${listId}"] .nx-open`));
  await quick('Lists: Settings dialog', pg.locator('#nx-sheet [data-act="lists.settings"]'));
  await pg.selectOption('#dlg-listproject', id);
  await quick('Lists: save a linked project', pg.locator('#dlg-submit'));
  assert.ok(await pg.isVisible('#nx-sheet .nx-meta [data-act="lists.openProject"]'), 'the link shows at once');
  await settle();
  assert.strictEqual(env.server.run('bootstrap()').data.lists.find((l) => l.id === listId).project_id, id, 'the link reached the server');
  await quick('Lists: open the linked project', pg.locator('#nx-sheet .nx-meta [data-act="lists.openProject"]'));
  assert.ok(!(await pg.isVisible('#nx-sheet')), 'leaving the pop-up');
  assert.ok(await pg.isVisible('#app .plainlist .label:text("Shopping")'), 'the list is on the project page');
  log('Lists: Settings links a list to a project at once, and the list shows on that project\'s page');

  await gotoTab('Whiteboards');
  await quick('Whiteboards: + New whiteboard dialog', pg.locator('[data-act="whiteboard.new"][data-pick]')); await closeDialog();
  const chip = pg.locator('.wblist li:has-text("Loose sketch") [data-act="whiteboard.today"]');
  await quick('Whiteboards: + Today', chip);
  assert.strictEqual(await chip.getAttribute('aria-pressed'), 'true', 'On Today shows at once');
  await settle();
  assert.strictEqual(env.server.run('bootstrap()').data.whiteboard.find((b) => b.id === boardId).show_today, 'yes', 'On Today reached the server');
  await gotoTab('Today');
  await showPanel('whiteboard-' + boardId);
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
  // ---------- Moving panels by the title (desktop); Today's pills and Today settings (phone) ----------
  await gotoTab('Today');
  const layoutNow = () => JSON.parse(JSON.stringify(env.server.run('bootstrap()').data.layout));
  const panelOnPage = (id) => `#app .grid-stack-item[gs-id="${id}"], #app .lcell[data-panel="${id}"]`;
  const box = (selector) => pg.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, selector);
  if (!size.mobile) {
    const gridLoaded = await pg.evaluate(() => !!window.GridStack && !!document.querySelector('#app .grid-stack-item[gs-id="rotation"]'));
    if (!gridLoaded) {
      out.push('  skip [' + size.name + '] Drag by the title: GridStack did not load from the CDN');
    } else {
      await pg.evaluate(() => window.scrollTo(0, 0));
      const focusBefore = await box('#app .grid-stack-item[gs-id="focus"]');
      const next = await box('#app .grid-stack-item[gs-id="focus"] .lastnote');
      await pg.mouse.move(next.x + 10, next.y + next.h / 2);
      await pg.mouse.down();
      await pg.mouse.move(next.x + 200, next.y + next.h / 2 + 120, { steps: 8 });
      await pg.mouse.up();
      assert.deepStrictEqual(await box('#app .grid-stack-item[gs-id="focus"]'), focusBefore, 'dragging inside a panel does not move it');
      assert.ok((await pg.evaluate(() => String(window.getSelection()))).length > 0, 'it selects text instead');
      const rotationBefore = await box('#app .grid-stack-item[gs-id="rotation"]');
      const handle = await box('#app .grid-stack-item[gs-id="rotation"] .panel-handle');
      const savedBefore = JSON.stringify(layoutNow().today || {});
      await pg.mouse.move(handle.x + 10, handle.y + handle.h / 2);
      await pg.mouse.down();
      await pg.mouse.move(focusBefore.x + 30, focusBefore.y + 10, { steps: 12 });
      await pg.mouse.up();
      await sleep(300);
      const rotationAfter = await box('#app .grid-stack-item[gs-id="rotation"]');
      assert.ok(rotationAfter.y < rotationBefore.y || rotationAfter.x < rotationBefore.x, 'dragged by its title, the panel moved without Edit layout');
      assert.ok(!(await pg.isVisible('.editbar')), 'and Edit layout stayed off');
      await settle();
      assert.notStrictEqual(JSON.stringify(layoutNow().today || {}), savedBefore, 'the new place reached the server');
      log('Drag by the title: a panel moves at any time and is saved; dragging inside it selects text');
      const tops = await pg.evaluate(() => {
        const p = FT.store.projects.find((x) => x.status === 'active' && x.id !== FT.store.today.focusId);
        p.last_touched = new Date(Date.now() - 8 * 86400000).toISOString();
        FT.render();
        return [...document.querySelectorAll('#app .grid-stack-item')].map((el) => ({ id: el.getAttribute('gs-id'), top: el.getBoundingClientRect().top }));
      });
      const stale = tops.find((t) => t.id === 'stale');
      assert.ok(stale && tops.every((t) => t.top >= stale.top), '"Not touched for a while" shows above the saved panels: ' + JSON.stringify(tops));
      log('"Not touched for a while" is a panel, placed above a saved layout');
    }
  } else {
    const cdp = await ctx.newCDPSession(pg);
    const finger = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const chipIds = () => pg.evaluate(() => [...document.querySelectorAll('#app .pchip')].map((c) => c.dataset.id));
    const chosen = () => pg.evaluate(() => document.querySelector('#app .pchip[aria-selected="true"]').dataset.id);
    assert.ok(await pg.isVisible('#app .ppager > .ppinned:first-child + .pchips'), 'the focus is pinned at the top, above the pills');
    assert.ok(await pg.isVisible('#app .pchips > .pgear'), '⚙ at the end of the pills');
    const gear = await box('#app .pgear');
    assert.ok(gear.x + gear.w <= size.viewport.width, 'however many pills there are, ⚙ stays on screen (the pills scroll): ' + JSON.stringify(gear));
    const ids = await chipIds();
    assert.ok(ids.length >= 3 && !ids.includes('focus'), 'a pill for each other panel: ' + ids.join(','));
    await quick('Today pills: tap a pill', pg.locator(`#app .pchip[data-id="${ids[0]}"]`));
    assert.strictEqual(await chosen(), ids[0]);
    await pg.evaluate(() => window.scrollTo(0, 0));
    const area = await box('#app .ppanel');
    const swipeY = area.y + Math.min(area.h / 2, 120);
    await finger('touchStart', 330, swipeY);
    for (const x of [300, 250, 200, 150, 100]) await finger('touchMove', x, swipeY + 2);
    await finger('touchEnd', 100, swipeY + 2);
    await sleep(300);
    assert.strictEqual(await chosen(), ids[1], 'a swipe on the panels shows the next pill');
    assert.strictEqual(await pg.evaluate(() => FT.state.view), 'today', 'and stays on Today');
    log('Today pills: the pinned focus, a pill answers at once, a swipe changes the pill and not the tab');

    assert.strictEqual(await pg.evaluate(() => window.scrollX), 0, 'changing pill never moves the page sideways');
    await quick('Today pills: ⚙ opens Today settings', pg.locator('#app .pgear'));
    assert.ok(await pg.isVisible('#app .tsettings'), 'Today settings shows in the page\'s place');
    const cards = () => pg.evaluate(() => [...document.querySelectorAll('#app .ts-pill')].map((c) => c.dataset.id));
    const start = await cards();
    const grip = await box(`#app .ts-pill[data-id="${start[0]}"] .ts-grip`), second = await box(`#app .ts-pill[data-id="${start[1]}"]`);
    const from = { x: grip.x + grip.w / 2, y: grip.y + grip.h / 2 }, to = second.y + second.h - 4;
    await finger('touchStart', from.x, from.y);
    for (const step of [0.3, 0.6, 1]) await finger('touchMove', from.x, from.y + (to - from.y) * step);
    await finger('touchEnd', from.x, to);
    await sleep(100);
    const reordered = [start[1], start[0]].concat(start.slice(2));
    assert.deepStrictEqual(await cards(), reordered, 'dragged by ⠿ with a finger, the pill moves at once');
    await settle();
    assert.deepStrictEqual((layoutNow()['today.pills'] || []).map((p) => p.id), reordered, 'the new order reached the server');
    log('Today settings: a pill dragged by ⠿ with a finger moves at once and the order reaches the server');

    await quick('Today settings: + New pill', pg.locator('#app [data-act="layout.pillNew"]'));
    assert.ok(await pg.isVisible('.dialog.sheet'), 'the pill opens in a sheet');
    await quickly(() => pg.fill('#dlg-pname', 'Errands'));
    await quick('Pill sheet: add Habits', pg.locator('#ps-add [data-id="habits"]'));
    await quick('Pill sheet: add a list not on Today', pg.locator(`#ps-add [data-id="list-${listId}"]`));
    await quick('Pill sheet: Add pill', pg.locator('#dlg-submit'));
    assert.ok(await pg.isVisible('#app .ts-pill:has-text("Errands")'), 'the new pill is in the list at once');
    await settle();
    const errands = (layoutNow()['today.pills'] || []).find((p) => p.name === 'Errands');
    assert.ok(errands && errands.panels.join() === 'habits,list-' + listId, 'the pill reached the server: ' + JSON.stringify(errands));
    await quick('Today settings: Done', pg.locator('#app .ts-bar .btn[data-act="layout.pillsDone"]'));
    await quick('Today pills: the new pill', pg.locator(`#app .pchip[data-id="${errands.id}"]`));
    const stacked = await pg.evaluate(() => [...document.querySelectorAll('#app .ppanel .pitem')].map((el) => ({ id: el.dataset.panel, top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height })));
    assert.deepStrictEqual(stacked.map((p) => p.id), ['habits', 'list-' + listId], 'the pill shows both panels');
    assert.ok(stacked[1].top >= stacked[0].top + stacked[0].height && stacked.every((p) => p.height > 40), 'one under the other: ' + JSON.stringify(stacked));
    log('Today settings: a new pill is added in a sheet at once, reaches the server, and shows its panels stacked');

    await quick('Today pills: ⚙ again', pg.locator('#app .pgear'));
    await quick('Today settings: Edit a pill', pg.locator(`#app [data-act="layout.pillEdit"][data-id="${errands.id}"]`));
    await quick('Pill sheet: + New note', pg.locator('#ps-new [data-act="layout.sheetNew"][data-kind="note"]'));
    await quickly(() => pg.fill('#ps-newname', 'Sheet note'));
    await quick('Pill sheet: Create', pg.locator('[data-act="layout.sheetCreate"]'));
    assert.ok(await pg.isVisible('#ps-in .ts-row:has-text("Sheet note")'), 'the new note is in the pill at once');
    await quick('Pill sheet: + New to-do list', pg.locator('#ps-new [data-act="layout.sheetNew"][data-kind="todo"]'));
    await quickly(() => pg.fill('#ps-newname', 'Sheet to-dos'));
    await quick('Pill sheet: Create a to-do list', pg.locator('[data-act="layout.sheetCreate"]'));
    await quick('Pill sheet: Save', pg.locator('#dlg-submit'));
    await settle();
    const madeInSheet = env.server.run('bootstrap()').data.lists.filter((l) => l.name === 'Sheet note' || l.name === 'Sheet to-dos');
    assert.deepStrictEqual(madeInSheet.map((l) => l.kind).sort(), ['note', 'todo'], 'the note and the to-do list reached the server');
    const edited = (layoutNow()['today.pills'] || []).find((p) => p.id === errands.id);
    assert.ok(madeInSheet.every((l) => edited.panels.includes('list-' + l.id)), 'and are in the pill: ' + JSON.stringify(edited));
    await quick('Today settings: Done again', pg.locator('#app .ts-bar .btn[data-act="layout.pillsDone"]'));
    log('Pill sheet: + New note and + New to-do list make one at once, put it in the pill, and both reach the server');
    const panelsPastTheScreen = () => pg.evaluate(() => {
      const screenWidth = document.documentElement.clientWidth;
      return [...document.querySelectorAll('#app .ppinned, #app .ppanel .pitem, #app .ppanel .pitem > *')]
        .map((el) => ({ panel: el.closest('[data-panel]').dataset.panel, right: Math.round(el.getBoundingClientRect().right) }))
        .filter((panel) => panel.right > screenWidth)
        .concat(document.documentElement.scrollWidth > screenWidth ? [{ page: 'scrolls sideways', scrollWidth: document.documentElement.scrollWidth }] : []);
    });
    const pillIds = await chipIds();
    for (const phoneWidth of [360, size.viewport.width]) {
      await pg.setViewportSize({ width: phoneWidth, height: size.viewport.height });
      for (const pillId of pillIds) {
        await quickly(() => pg.click(`#app .pchip[data-id="${pillId}"]`));
        assert.strictEqual(await pg.evaluate(() => window.innerWidth), phoneWidth, `[${phoneWidth} px] pill ${pillId}: the phone does not zoom out to fit a wide or sliding panel`);
        await pg.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => 'cancelled'))));
        assert.deepStrictEqual(await panelsPastTheScreen(), [], `[${phoneWidth} px] pill ${pillId}: every panel fits the screen`);
      }
    }
    log('Today pills: every panel of every pill fits a phone 360 px wide and ' + size.viewport.width + ' px wide');
  }

  // ---------- Edit layout: the header button (desktop) or menu item (phone), ▲ ▼ on a phone, Remove and Add feature ----------
  if (size.mobile) {
    await quickly(() => pg.click('#menuBtn'));
    assert.strictEqual(await pg.innerText('#menuLayoutBtn'), 'Edit layout', 'the phone menu has Edit layout');
    await quick('Menu: Edit layout', pg.locator('#menuLayoutBtn'));
    assert.ok(await pg.isVisible('.editbar [data-act="core.pagerSettings"]') && !(await pg.isVisible('.editbar [data-act="core.addFeature"]')), 'on a phone\'s Today it points to Today settings');
    await quickly(() => pg.click('.editbar [data-act="core.layout"]'));
    await openFirstProject();
    await quickly(async () => { await pg.click('#menuBtn'); await pg.click('#menuLayoutBtn'); });
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
    const savedPair = () => (layoutNow()['project.phone'] || []).filter((id) => id === start[0] || id === start[1]);
    assert.deepStrictEqual(savedPair(), [start[1], start[0]], 'the phone order reached the server');
    await quick('Edit layout: ▲', pg.locator(`.lcell[data-panel="${start[0]}"] [data-act="core.movePanel"][data-d="-1"]`));
    assert.deepStrictEqual(await order(), start, 'moved back up at once');
    await settle();
    assert.deepStrictEqual(savedPair(), [start[0], start[1]], 'and that reached the server');
    const removable = start.find((id) => id !== 'header');
    await quick('Edit layout: Remove', pg.locator(`#app [data-act="core.removePanel"][data-id="${removable}"]`));
    assert.ok(!(await pg.isVisible(panelOnPage(removable))), 'the panel goes at once');
    await settle();
    assert.ok(layoutNow().project[removable].removed, 'the remove reached the server');
    await quick('Edit layout: Add feature', pg.locator('.editbar [data-act="core.addFeature"]'));
    await quick('Add feature: Add a removed panel', pg.locator('#dlg-features [data-act="core.addFeatureItem"] >> nth=0'));
    assert.ok(await pg.isVisible(panelOnPage(removable)), 'it is back at once');
    await settle();
    assert.ok(!layoutNow().project[removable].removed, 'the add reached the server');
    await quickly(async () => { await pg.click('#dlg-submit'); await pg.click('.editbar [data-act="core.layout"]'); });
    await gotoTab('Today');
    log('Edit layout: on a phone\'s Today it points to Today settings; on a project page ▲ ▼, Remove and Add feature answer at once and reach the server');
  } else {
    await quick('Edit layout: Remove', pg.locator('#app [data-act="core.removePanel"][data-id="rotation"]'));
    assert.ok(!(await pg.isVisible(panelOnPage('rotation'))), 'the panel goes at once');
    await settle();
    assert.ok(layoutNow().today.rotation.removed, 'the remove reached the server');
    await quick('Edit layout: Add feature', pg.locator('.editbar [data-act="core.addFeature"]'));
    assert.ok(await pg.isVisible('#dlg-features li:has-text("Weekly rotation")'), 'the removed panel is offered');
    assert.ok(await pg.isVisible('#dlg-features li.on:has-text("Habits")'), 'in one list with the panels already on the page');
    await quick('Add feature: Add a removed panel', pg.locator('#dlg-features [aria-label="Add Weekly rotation"]'));
    assert.ok(await pg.isVisible(panelOnPage('rotation')), 'it is back at once');
    await settle();
    assert.ok(!layoutNow().today.rotation.removed, 'the add reached the server');
    await quick('Add feature: Add a list to Today', pg.locator('#dlg-features [aria-label="Add Shopping"]'));
    assert.ok(await pg.isVisible(panelOnPage('list-' + listId)), 'the list is on Today at once');
    await settle();
    assert.strictEqual(env.server.run('bootstrap()').data.lists.find((l) => l.id === listId).show_today, 'yes', 'show_today reached the server');
    await quickly(async () => { await pg.click('#dlg-submit'); await pg.click('.editbar [data-act="core.layout"]'); });
    assert.ok(!(await pg.isVisible('.editbar')), 'Done leaves Edit layout');
    log('Edit layout: the button, Remove, Add feature and its Add answer at once and reach the server');
  }


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
      const notesHeight = () => pg.evaluate(() => document.querySelector('.notes-panel').getBoundingClientRect().height);
      assert.deepStrictEqual(await overlaps(), [], 'panels overlap before typing');
      const h0 = await notesHeight();
      await pg.click('.notes-edit');
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
      await pg.waitForFunction(() => document.querySelector('.nt-status').textContent === 'Saved', null, { timeout: 10000 });
      log('Notes: typing many lines and deleting them moves the panels around the notes; none overlap');
    }
    await pg.waitForSelector('.notes-edit[contenteditable="true"]');
    await pg.click('.notes-edit');
    await pg.keyboard.press('Control+End');
    await pg.keyboard.press('Enter');
    await pg.keyboard.type('Wiring plan');
    await pg.keyboard.press('Control+Alt+2');
    assert.ok(await pg.isVisible('.notes-edit h2:text("Wiring plan")'), 'Ctrl+Alt+2 makes the line a heading 2');
    await pg.waitForFunction(() => document.querySelector('.nt-status').textContent === 'Saved', null, { timeout: 10000 });
    assert.ok(serverCall('notes', 'get', { projectId: pid }).text.split('\n').some((l) => l === '## Wiring plan'), 'saved as a markdown heading');
    await pg.keyboard.press('Control+Alt+0');
    assert.ok(!(await pg.isVisible('.notes-edit h2')) && await pg.isVisible('.notes-edit p:text("Wiring plan")'), 'Ctrl+Alt+0 makes it normal text again');
    await pg.waitForFunction(() => document.querySelector('.nt-status').textContent === 'Saved', null, { timeout: 10000 });
    assert.ok(!/^## Wiring plan$/m.test(serverCall('notes', 'get', { projectId: pid }).text), 'and that is saved too');
    await pg.click('[data-act="notes.done"]').catch(() => {});
    log('Notes: Ctrl+Alt+2 makes a heading 2 and Ctrl+Alt+0 normal text, and both are saved');

    await pg.click('.notes-edit');
    await pg.keyboard.press('Control+End');
    await pg.keyboard.press('Enter');
    await pg.keyboard.type('Toolbar heading');
    await pg.click('.nt-bar button[data-val="h1"]');
    assert.ok(await pg.isVisible('.notes-edit h1:text("Toolbar heading")'), 'H1 makes the line a heading 1');
    await pg.click('.nt-bar button[data-val="h1"]');
    assert.ok(!(await pg.isVisible('.notes-edit h1')) && await pg.isVisible('.notes-edit p:text("Toolbar heading")'), 'H1 again makes it normal text');
    await pg.keyboard.press('Enter');
    await pg.keyboard.type('- red in a list');
    await pg.click('.nt-bar button[data-val="h2"]');
    assert.ok(await pg.isVisible('.notes-edit li:text("red in a list")') && !(await pg.isVisible('.notes-edit li h2')), 'the H2 button makes no heading in a list');
    await pg.keyboard.press('Shift+Home');
    await pg.click('.nt-bar button[data-cmd="foreColor"][data-val="#d64545"]');
    assert.ok(await pg.isVisible('.notes-edit li font[color="#d64545"]'), 'the red button colours the selection');
    await pg.waitForFunction(() => document.querySelector('.nt-status').textContent === 'Saved', null, { timeout: 10000 });
    const savedNotes = serverCall('notes', 'get', { projectId: pid });
    assert.ok(/^- red in a list$/m.test(savedNotes.text) && savedNotes.html.includes('<font color="#d64545">red in a list</font>'), 'the markdown has the text, the Doc its colour');
    const heightBefore = await pg.evaluate(() => document.querySelector('.notes-edit').offsetHeight);
    await pg.focus('.nt-grip');
    await pg.keyboard.press('ArrowDown');
    await pg.keyboard.press('ArrowDown');
    const resized = await pg.evaluate(() => ({ height: document.querySelector('.notes-edit').offsetHeight, kept: localStorage.getItem('ft.notes.height') }));
    assert.strictEqual(resized.height, heightBefore + 80, 'the arrow keys on the bar under the notes make them taller');
    assert.strictEqual(resized.kept, resized.height + 'px', 'and the height is kept in this browser');
    log('Notes toolbar: H1 twice turns a heading back into text, no heading in a list, a colour is kept in the formatted copy; the bar under the notes resizes them');

    // Paper themes: every text row (paragraphs, headings, list items) starts and ends on a ruled line, at this screen's font size.
    const paperCheck = () => pg.evaluate(() => {
      const ed = document.querySelector('.notes-edit'), cs = getComputedStyle(ed);
      const rule = parseFloat(cs.fontSize) * 1.75;
      const contentTop = ed.getBoundingClientRect().top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - ed.scrollTop;
      const off = (n) => { const r = n % rule; return Math.min(r, rule - r); };
      const blocks = [...ed.querySelectorAll('p, h1, h2, h3, li')].filter((el) => !el.querySelector('p, h1, h2, h3, li'));
      const misaligned = blocks.filter((el) => { const r = el.getBoundingClientRect(); return off(r.top - contentTop) > 1 || off(r.height) > 1; })
        .map((el) => el.tagName + ' "' + el.textContent.slice(0, 20) + '"');
      return { misaligned, count: blocks.length, attachment: cs.backgroundAttachment, image: cs.backgroundImage, color: cs.color };
    });
    for (const paper of ['legal', 'graph', 'card']) {
      await pg.selectOption('.nt-paper', paper);
      const checked = await paperCheck();
      assert.ok(checked.count > 3, 'there are text rows to check');
      assert.deepStrictEqual(checked.misaligned, [], paper + ': every row sits on the lines');
      assert.ok(checked.attachment.split(',').every((a) => a.trim() === 'local'), paper + ': the lines scroll with the text');
      assert.strictEqual(checked.color, 'rgb(27, 42, 74)', paper + ': dark ink on the paper');
    }
    await pg.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await pg.selectOption('.nt-paper', 'legal');
    assert.strictEqual((await paperCheck()).color, 'rgb(27, 42, 74)', 'dark app theme: the pad stays light paper with dark ink');
    await pg.evaluate(() => { document.documentElement.dataset.theme = 'eink'; });
    for (const paper of ['legal', 'graph', 'card']) {
      await pg.selectOption('.nt-paper', paper);
      const eink = await paperCheck();
      assert.strictEqual(eink.color, 'rgb(0, 0, 0)', paper + ' on e-ink: black text');
      const colours = (eink.image.match(/rgba?\([^)]*\)/g) || []).filter((c) => !/^rgba?\((0, 0, 0|255, 255, 255)(, [01])?\)$/.test(c));
      assert.deepStrictEqual(colours, [], paper + ' on e-ink: black and white only, no colour');
      assert.deepStrictEqual(eink.misaligned, [], paper + ' on e-ink: rows still on the lines');
    }
    await pg.evaluate(() => { delete document.documentElement.dataset.theme; });
    await pg.selectOption('.nt-paper', '');
    log('Notes paper: legal pad, graph paper and index card lines match every text row (light, dark and e-ink), and scroll with the text');

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
  await pg.click('.notes-edit');
  await pg.keyboard.press('Control+End');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('Kept after a quick reload');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('- a list item that becomes a heading');
  await pg.keyboard.press('Control+Alt+2'); // the toolbar's H2 refuses a heading in a list; the shortcut still makes one
  if (size.mobile) await pg.click('.notes-done');
  await pg.evaluate(() => localStorage.setItem('ft.openOn', 'last')); // Settings: open on the page I was on (the default is Today)
  await pg.reload();
  unfailNotes();
  await pg.waitForSelector('.notes-edit[contenteditable="true"]', { timeout: 15000 });
  const notesText = () => env.server.run('rpc')('notes', 'get', { projectId: notesId }, null).result.text;
  for (let t0 = Date.now(); !/Kept after a quick reload[\s\S]*a list item that becomes a heading/.test(notesText()); await sleep(100)) {
    assert.ok(Date.now() - t0 < 15000, '[' + size.name + '] the notes typed before the reload never reached the server: ' + JSON.stringify(notesText()));
  }
  assert.ok((await pg.innerText('.notes-edit')).includes('a list item that becomes a heading'), 'and they are in the editor');
  log('Notes typed just before a reload come back and are saved, including a heading inside a list item');

  // ---------- 7: the notes' Google Doc ----------
  // Opening a project with notes makes their Doc in the background; then "Open in Docs" shows and links it.
  await pg.waitForSelector('.nt-link:not([hidden])', { timeout: 15000 });
  const docLink = await pg.evaluate(() => { const a = document.querySelector('.nt-link'); return { text: a.textContent, href: a.href, visible: a.offsetParent !== null }; });
  const docRow = env.server.run('bootstrap()').data.notes.find((n) => n.project_id === notesId);
  assert.strictEqual(docLink.text, 'Open in Docs');
  assert.ok(docLink.visible, '[' + size.name + '] "Open in Docs" is on screen');
  assert.ok(/^https:\/\/docs\.google\.com\/document\/d\//.test(docLink.href) && docLink.href === docRow.doc, '[' + size.name + '] and links the Doc: ' + docLink.href);
  log('"Open in Docs" shows once the notes Doc exists');

  // ---------- 8: a note on Today, the Notes tab's buttons, a to-do's card ----------
  const noteId = call('lists', 'create', { name: 'Chrome note', kind: 'note', showToday: true }).id;
  const notePill = { id: 'ab12cd40', name: 'Chrome note', icon: '', panels: ['list-' + noteId] };
  if (size.mobile) call('layout', 'savePills', { page: 'today', pills: (layoutNow()['today.pills'] || []).concat([notePill]) }); // pills were saved above: a new panel is in none
  await quickly(() => pg.evaluate(() => FT.reload()));
  await gotoTab('Today');
  if (size.mobile) await pg.click('.pchip[data-id="' + notePill.id + '"]');
  const noteEditor = '.notes-edit[data-project="' + noteId + '"]';
  await pg.waitForSelector(noteEditor + '[contenteditable="true"]', { timeout: 15000 });
  assert.strictEqual((await pg.textContent('.notelist-panel .label')).trim(), 'Chrome note', '[' + size.name + '] the note is labelled with its name');
  await pg.click(noteEditor);
  await pg.keyboard.type('Typed into Today in Chrome');
  if (size.mobile) await pg.click('.notes-panel.full .notes-done');
  const noteText = () => env.server.run('rpc')('notes', 'get', { listId: noteId }, null).result.text;
  for (let t0 = Date.now(); !noteText().includes('Typed into Today in Chrome'); await sleep(100)) {
    assert.ok(Date.now() - t0 < 15000, '[' + size.name + '] the note never reached its Doc: ' + JSON.stringify(noteText()));
  }
  assert.ok(env.server.docs.docs().some((f) => f.name === 'Chrome note'), '[' + size.name + '] the Doc "Chrome note" holds it');
  log('A note on Today: typing saves to its own Doc, named after it');

  // ---------- the Notes tab: cards, + New, the pop-up with the real editors, ticking from a card ----------
  env.latency = LATENCY;
  await gotoTab('Notes');
  const newButton = pg.locator(size.mobile ? '#app .nx-fab' : '#app .nx-new');
  const newKind = (kind) => pg.locator((size.mobile ? '#app .nx-fabmenu' : '#app .nx-newwrap .nx-menu') + ` [data-act="lists.new"][data-kind="${kind}"]`);
  const cardOf = (id) => pg.locator(`#app .nx-card[data-id="${id}"]`);
  const listNamed = (name) => env.server.run('bootstrap()').data.lists.find((l) => l.name === name);
  const noteTextOf = (id) => env.server.run('rpc')('notes', 'get', { listId: id }, null).result.text;
  await quick('Notes tab: + New', newButton);
  await quick('Notes tab: + New → Note', newKind('note'));
  assert.ok(await pg.isVisible('#nx-sheet .notes-edit'), '[' + size.name + '] the note opens at once, with its editor');
  assert.strictEqual(await pg.evaluate(() => document.activeElement.id), 'nx-name', 'its name has the cursor');
  await quickly(async () => { await pg.keyboard.type('Made in Chrome'); await pg.keyboard.press('Enter'); });
  await quickly(async () => { await pg.click('#nx-sheet .notes-edit'); await pg.keyboard.type('Typed in the pop-up'); });
  if (size.mobile) await quickly(() => pg.click('.notes-panel.full .notes-done'));
  await quick('Pop-up: ✕', pg.locator('#nx-sheet [data-act="lists.close"]'));
  assert.ok(!(await pg.isVisible('#nx-sheet')), '✕ closes it');
  await settle();
  const madeNote = listNamed('Made in Chrome');
  assert.ok(madeNote && madeNote.kind === 'note', '[' + size.name + '] the note reached the server, with the name typed over "New note"');
  for (let t0 = Date.now(); !noteTextOf(madeNote.id).includes('Typed in the pop-up'); await sleep(100)) {
    assert.ok(Date.now() - t0 < 15000, '[' + size.name + '] the pop-up\'s editor never saved to the Doc: ' + JSON.stringify(noteTextOf(madeNote.id)));
  }
  assert.ok((await cardOf(madeNote.id).innerText()).includes('Typed in the pop-up'), 'its card shows the first lines');

  await quick('Notes tab: + New', newButton);
  await quick('Notes tab: + New → To-do list', newKind('todo'));
  await quickly(async () => { await pg.keyboard.type('Chrome errands'); await pg.keyboard.press('Enter'); });
  await quickly(async () => { await pg.fill('#nx-sheet .todoadd input', 'Buy stamps'); await pg.click('#nx-sheet [data-act="todos.addBtn"]'); });
  assert.ok(await pg.isVisible('#nx-sheet .todos li:has-text("Buy stamps")'), 'a to-do added in the pop-up shows at once');
  await pg.keyboard.press('Escape');
  await sleep(100);
  assert.ok(!(await pg.isVisible('#nx-sheet')), 'Esc closes the pop-up');
  await settle();
  const errands = listNamed('Chrome errands');
  assert.ok(errands && errands.kind === 'todo' && todosNow().some((t) => t.title === 'Buy stamps' && t.list_id === errands.id), '[' + size.name + '] the to-do list and its to-do reached the server');
  await quick('Notes tab: tick a to-do on its card', cardOf(errands.id).locator('.nx-tick').first());
  assert.ok(!(await pg.isVisible('#nx-sheet')), 'a tick does not open the card');
  assert.ok((await cardOf(errands.id).innerText()).includes('1 done'), 'ticked off the card at once');
  await settle();
  assert.ok(todosNow().find((t) => t.title === 'Buy stamps').done, '[' + size.name + '] the tick reached the server');

  await quick('Notes tab: open a list', cardOf(listId).locator('.nx-open'));
  await quickly(async () => { await pg.fill('#nx-sheet .coladd input', 'Milk from the pop-up'); await pg.press('#nx-sheet .coladd input', 'Enter'); });
  assert.ok(await pg.isVisible('#nx-sheet .kcard:has-text("Milk from the pop-up")'), 'an item added in the pop-up shows at once');
  if (!size.mobile) {
    const box = await pg.locator('#nx-sheet').boundingBox();
    assert.ok(box.width <= 642 && box.x > 100, '[desktop] a dialog about 640 px wide over the grid: ' + JSON.stringify(box));
    await quickly(() => pg.mouse.click(20, size.viewport.height - 20));
    assert.ok(!(await pg.isVisible('#nx-sheet')), 'a click on the dim area closes it');
  } else {
    await quickly(() => pg.click('#nx-sheet [data-act="lists.close"]'));
  }
  await settle();
  assert.ok(env.server.run('bootstrap()').data.kanban.tasks.some((t) => t.title === 'Milk from the pop-up' && t.owner === listId), '[' + size.name + '] the list\'s new item reached the server');

  await quick('Notes tab: the To-do lists chip', pg.locator('#app .nx-chip[data-filter="todo"]'));
  assert.ok(await pg.evaluate(() => [...document.querySelectorAll('#app .nx-card')].every((c) => FT.store.lists.find((l) => l.id === c.dataset.id).kind === 'todo')), 'only to-do lists');
  await quick('Notes tab: the All chip', pg.locator('#app .nx-chip[data-filter="all"]'));
  await quickly(() => pg.fill('#nx-q', 'stamps'));
  assert.deepStrictEqual(await pg.evaluate(() => [...document.querySelectorAll('#app .nx-card')].map((c) => c.dataset.id)), [errands.id], 'the search finds a to-do');
  await quickly(() => pg.fill('#nx-q', ''));
  await quick('Notes tab: Project notes off', pg.locator('[data-change="lists.projectNotes"]'));
  assert.strictEqual(await pg.locator('#app .nx-card[data-id^="pnote-"]').count(), 0, 'project notes hidden at once');
  await settle();
  assert.strictEqual((layoutNow()['lists.view'] || {}).projectNotes, 'off', 'the choice reached the server');
  await quick('Notes tab: Project notes on', pg.locator('[data-change="lists.projectNotes"]'));
  await settle();
  log('Notes tab: + New, the pop-up (a note, a to-do list and a list edited in it), ✕, Esc' + (size.mobile ? '' : ' and the dim area') + ', a tick on a card, chips, search and Project notes answer at once and reach the server');

  // dragging the second card to the front: shown at once, saved behind (a long press first on a phone), and a swipe is not taken for it
  if (await pg.evaluate(() => !!window.Sortable)) {
    const order = () => pg.evaluate(() => FT.store.lists.slice().sort((a, b) => a.order - b.order).map((l) => l.id));
    const before = await order(), second = before[1];
    await pg.evaluate(() => window.scrollTo(0, 0));
    const a = await cardOf(second).locator('.nx-cfoot').boundingBox(), b = await cardOf(before[0]).locator('.nx-open').boundingBox();
    const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, to = { x: b.x + 10, y: b.y + 4 };
    if (size.mobile) {
      const cdp = await ctx.newCDPSession(pg);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      await sleep(450);
      for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12 }] }); await sleep(30); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await pg.mouse.move(from.x, from.y); await pg.mouse.down();
      for (let i = 1; i <= 12; i++) { await pg.mouse.move(from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12); await sleep(30); }
      await pg.mouse.up();
    }
    await pg.waitForFunction((id) => !FT.state.dragging && FT.store.lists.slice().sort((x, y) => x.order - y.order)[0].id === id, second, { timeout: 2000 });
    assert.strictEqual(await pg.evaluate(() => FT.state.view), 'lists', '[' + size.name + '] the drag did not change the tab');
    assert.ok(!(await pg.isVisible('#nx-sheet')), 'and did not open the card');
    await settle();
    assert.strictEqual(env.server.run('bootstrap()').data.lists[0].id, second, '[' + size.name + '] the new order reached the server');
    log('Notes tab: a card ' + (size.mobile ? 'pressed, held and dragged' : 'dragged') + ' to the front moves at once and the order reaches the server');
  } else {
    log('Notes tab: card drag not tried, SortableJS did not load from the CDN');
  }

  // a phone 360 px wide: no sideways scroll on the tab or in the full-screen pop-up, its footer on screen, 40 px tap targets
  if (size.mobile) {
    await pg.setViewportSize({ width: 360, height: size.viewport.height });
    await sleep(200);
    const tooSmall = (selector) => pg.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && (r.width < 40 || r.height < 40);
    }).map((el) => (el.dataset.act || el.className || el.tagName) + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)), selector);
    assert.strictEqual(await pg.evaluate(() => document.documentElement.scrollWidth), 360, '[360 px] the Notes tab does not scroll sideways');
    assert.deepStrictEqual(await tooSmall('#app .nx-chip, #app .nx-toggle, #app .nx-tick, #app .nx-fab, #app .nx-search'), [], '[360 px] the tab\'s tap targets are 40 px or more');
    for (const id of [madeNote.id, errands.id, listId]) {
      await quickly(() => cardOf(id).locator('.nx-open').click());
      await pg.waitForSelector('#nx-sheet');
      await pg.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => 'cancelled'))));
      const fit = await pg.evaluate(() => {
        const sheet = document.getElementById('nx-sheet').getBoundingClientRect(), foot = document.querySelector('#nx-sheet .nx-foot').getBoundingClientRect();
        return { sheet: [Math.round(sheet.left), Math.round(sheet.width), Math.round(sheet.height)], screen: [window.innerWidth, window.innerHeight],
          footOnScreen: foot.top >= 0 && foot.bottom <= window.innerHeight + 1, pageWidth: document.documentElement.scrollWidth,
          sideways: [...document.querySelectorAll('#nx-sheet, #nx-sheet .nx-body, #nx-sheet .nx-foot')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className) };
      });
      assert.deepStrictEqual(fit.sheet, [0, 360, fit.screen[1]], '[360 px] the pop-up fills the screen: ' + JSON.stringify(fit));
      assert.ok(fit.footOnScreen && fit.pageWidth === 360 && !fit.sideways.length, '[360 px] its footer is on screen and nothing scrolls sideways: ' + JSON.stringify(fit));
      assert.deepStrictEqual(await tooSmall('#nx-sheet .nx-head button, #nx-sheet .nx-foot button, #nx-sheet .nx-foot .nx-toggle'), [], '[360 px] the pop-up\'s own buttons are 40 px or more');
      await quickly(() => pg.click('#nx-sheet [data-act="lists.close"]'));
    }
    await quickly(() => cardOf(errands.id).locator('.nx-open').click());
    await pg.evaluate(() => history.back()); // the phone's back button
    await pg.waitForFunction(() => !document.getElementById('nx-sheet'), null, { timeout: 2000 });
    assert.strictEqual(await pg.evaluate(() => FT.state.view), 'lists', 'and stays on the Notes tab');
    await pg.setViewportSize(size.viewport);
    log('Notes tab at 360 px: no sideways scroll, 40 px tap targets; the pop-up fills the screen with its footer on screen; the back button closes it');
  }

  await gotoTab('Today');
  await showPanel(todosPanel());
  await quickly(async () => { await pg.fill('.todos-panel .todoadd input >> nth=0', 'Card from Chrome'); await pg.click('.todos-panel [data-act="todos.addBtn"] >> nth=0'); });
  await settle();
  await quick('To-dos: open a to-do\'s card', pg.locator('.todos li:has-text("Card from Chrome") [data-act="todos.open"]'));
  assert.ok(await pg.isVisible('#dlg-tdday') && await pg.isVisible('#dlg-note'), 'the card dialog, with the to-do\'s fields');
  await quickly(() => pg.fill('#dlg-cardtitle', 'Card from Chrome, edited'));
  await quick('To-do card: Save', pg.locator('#dlg-submit'));
  assert.ok(await pg.isVisible('.todos li:has-text("Card from Chrome, edited")'), 'the change shows at once');
  await settle();
  assert.ok(todosNow().some((t) => t.title === 'Card from Chrome, edited'), 'and reached the server');
  log('To-dos: a to-do\'s card dialog opens and saves at once, and the change reaches the server');

  // ---------- 9: pop-out windows ----------
  env.latency = LATENCY;
  await gotoTab('Today');
  const todosId = todosPanel(), popWin = pg.locator('#popRoot .popwin[data-key="today::' + todosId + '"]');
  const saved = () => pg.evaluate(() => JSON.parse(localStorage.getItem('ft.popout.personal')).windows[0]);
  const drag = async (from, dx, dy) => {
    await pg.mouse.move(from.x, from.y); await pg.mouse.down();
    await pg.mouse.move(from.x + dx, from.y + dy, { steps: 6 }); await pg.mouse.up(); await sleep(60);
  };
  const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1.5, '[' + size.name + '] ' + label + ': ' + a + ' vs ' + b);
  const popRootChildren = () => pg.evaluate(() => document.getElementById('popRoot').children.length);
  const DESKTOP_VIEWPORT = SIZES.find((s) => !s.mobile).viewport;
  if (size.mobile) {
    assert.strictEqual(await pg.locator('#app .popbtn').count(), 0, '[' + size.name + '] no Pop out button on a phone');
    await pg.setViewportSize(DESKTOP_VIEWPORT);
    await pg.waitForSelector('#app .popbtn[data-panel="' + todosId + '"]');
  }
  await quick('Pop out: To-dos', pg.locator('#app .popbtn[data-panel="' + todosId + '"]'));
  await popWin.waitFor();
  if (size.mobile) {
    await pg.setViewportSize(size.viewport);
    await pg.waitForFunction(() => !document.getElementById('popRoot').children.length, null, { timeout: 5000 });
    assert.strictEqual(await pg.locator('#app .popslot').count(), 0, 'narrowed to a phone: no placeholder');
    assert.strictEqual(await pg.locator('#app .popbtn').count(), 0, 'and no Pop out buttons');
    await quick('Phone: the To-dos chip', pg.locator('.pchip[data-id="' + todosId + '"]'), false);
    assert.ok(await pg.isVisible('#app .todos-panel .todoadd input'), 'To-dos draws in place');
    assert.strictEqual((await saved()).panel, todosId, 'the desktop window stays saved');
    await pg.setViewportSize(DESKTOP_VIEWPORT);
    await popWin.waitFor();
    await pg.waitForSelector('#app .popslot', { timeout: 5000 });
    assert.ok((await pg.textContent('#app .popslot')).includes('To-dos'), 'wide again: the window and its placeholder are back');
    log('Pop out: a phone has no windows or Pop out buttons; a window popped out on a desktop waits and comes back when the screen is wide again');
  } else {
    const start = await popWin.boundingBox(), title = await popWin.locator('.poptitle').boundingBox();
    const ROOM_BELOW_FOR_THE_MOVE_AND_THE_CORNER_RESIZE = 200;
    const moveDownBy = DESKTOP_VIEWPORT.height - (start.y + start.height) >= ROOM_BELOW_FOR_THE_MOVE_AND_THE_CORNER_RESIZE ? 80 : -200;
    await drag({ x: title.x + 30, y: title.y + title.height / 2 }, 150, moveDownBy);
    const moved = await popWin.boundingBox();
    near(moved.x, start.x + 150, 'dragged by its title bar (x)'); near(moved.y, start.y + moveDownBy, 'dragged by its title bar (y)');
    near(moved.width, start.width, 'same width after a move');
    const grip = await popWin.locator('[data-pop-resize="se"]').boundingBox();
    await drag({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, 120, 90);
    const sized = await popWin.boundingBox();
    near(sized.width, moved.width + 120, 'wider from the corner'); near(sized.height, moved.height + 90, 'taller from the corner');
    near(sized.x, moved.x, 'the corner resize keeps its left edge');
    const left = await popWin.locator('[data-pop-resize="w"]').boundingBox();
    await drag({ x: left.x + left.width / 2, y: left.y + left.height / 2 }, -60, 0);
    const wider = await popWin.boundingBox();
    near(wider.x, sized.x - 60, 'the left edge moves'); near(wider.width, sized.width + 60, 'and the width grows');
    const kept = await saved();
    near(kept.free.x, wider.x, 'place kept'); near(kept.free.w, wider.width, 'size kept');
    await gotoTab('Notes');
    const onLists = await popWin.boundingBox();
    near(onLists.x, wider.x, 'same place on another tab'); near(onLists.height, wider.height, 'same size on another tab');
    assert.ok(await popWin.locator('.todoadd input').isVisible(), 'and still the live To-dos panel');
    log('Pop out: a free window is dragged by its title bar and resized from a corner and an edge; it keeps its place on another tab');

    await pg.click('#popRoot .popwin [data-act="popout.style"][data-style="pane"]');
    const pane = pg.locator('#popRoot .poppane');
    await pane.waitFor();
    const pageRight = () => pg.evaluate(() => document.querySelector('.wrap').getBoundingClientRect().right);
    const paneBefore = await pane.boundingBox();
    assert.ok(await pageRight() <= paneBefore.x + 1, '[' + size.name + '] the page stops where the pane starts (not covered)');
    const divider = await pg.locator('.poppane-divider').boundingBox();
    await drag({ x: divider.x + divider.width / 2, y: divider.y + divider.height / 2 }, -120, 0);
    const paneAfter = await pane.boundingBox();
    near(paneAfter.width, paneBefore.width + 120, 'dragging the divider left widens the pane');
    assert.ok(await pageRight() <= paneAfter.x + 1, '[' + size.name + '] and the page reflows beside it');
    near(await pg.evaluate(() => JSON.parse(localStorage.getItem('ft.popout.personal')).paneWidth), paneAfter.width, 'pane width kept');
    log('Pop out: the side pane\'s divider resizes it and the page reflows beside it');

    await pg.click('#popRoot .poppane [data-act="popout.style"][data-style="mini"]');
    await popWin.waitFor();
    assert.ok(await popWin.evaluate((el) => el.classList.contains('pop-at-bl')), 'a mini card starts in the bottom left corner');
    // Under the pointer the card opens upwards, so its title moves: a person grabs the title where it ends up
    await popWin.hover(); await sleep(250);
    const card = await popWin.locator('.poptitle').boundingBox();
    const grab = { x: card.x + 20, y: card.y + card.height / 2 };
    await drag(grab, size.viewport.width - 200, 120 - grab.y);
    await pg.mouse.move(size.viewport.width / 2, size.viewport.height / 2); await sleep(250);
    assert.strictEqual((await saved()).mini.corner, 'tr', 'dropped near the top right, it snaps to that corner');
    const snapped = await popWin.boundingBox();
    near(snapped.x + snapped.width, size.viewport.width - 12, 'against the right edge');
    log('Pop out: a mini card snaps to the nearest corner');
  }
  await pg.click('#popRoot .popwin [data-act="popout.close"]');
  assert.strictEqual(await popRootChildren(), 0, 'closed');
  await pg.evaluate(() => localStorage.removeItem('ft.popout.personal'));
  if (size.mobile) await pg.setViewportSize(size.viewport);

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
