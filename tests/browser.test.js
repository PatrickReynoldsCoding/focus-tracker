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
  const minutes = pg.locator('[data-act="today.job"]');
  if (await minutes.count()) {
    const before = (await minutes.first().innerText()).trim();
    await quick('Today: Mark minutes done', minutes.first());
    assert.notStrictEqual((await pg.locator('[data-act="today.job"]').first().innerText()).trim(), before, 'the button changes at once');
    await settle();
    assert.strictEqual(todayState().jobDone, true, 'the daily minimum reached the server');
    log('Today: daily minimum answers at once');
  }
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
  await quick('Resources: add a link dialog', pg.locator('[data-act="resources.add"]').first()); await closeDialog();
  await quick('Sticky: + Note', pg.locator('[data-act="stickies.add"]'));
  await settle();
  log('Project: dialogs and panels open at once');

  // ---------- header ----------
  await settle();
  await openMenuIfPhone();
  await quick('Header: Settings', pg.locator('#settingsBtn')); await closeDialog();
  await quick('Header: Undo says it is working', pg.locator('#undoBtn'));
  assert.ok((await pg.evaluate(() => document.getElementById('toast').innerText)).length > 0, 'Undo shows a message at once');
  await settle();
  await quick('Header: Redo says it is working', pg.locator('#redoBtn'));
  await settle();
  log('Header: Settings, Undo and Redo answer at once');

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
