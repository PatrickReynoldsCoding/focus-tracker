/**
 * SPIKE, throwaway. Proves, in real Chrome, that the real Focus Tracker page plus the real server code can:
 *   1. start online, make its spreadsheet and sync it through (fake) Sheets API calls;
 *   2. COLD START with the browser closed and reopened, the server stopped and the network off, from the
 *      service worker cache and IndexedDB;
 *   3. take edits offline that survive a reload;
 *   4. sync them later on top of another device's edit, without losing either;
 *   5. pick up a new version through the service worker update flow.
 * Run: node spike/standalone/test.js   (needs Chrome; CHROME_PATH or /usr/bin/google-chrome, and playwright-core)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { build } = require('./build');
const fake = require('./fake-google');

function loadPlaywright() {
  for (const p of ['playwright-core', path.join(__dirname, '..', '..', 'node_modules', 'playwright-core'), path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules', 'playwright-core')]) {
    try { return require(p); } catch (e) { /* next */ }
  }
  return null;
}

const PORT = 18000 + Math.floor(Math.random() * 1000);
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const DIST = path.join(__dirname, 'dist');
const step = (m) => console.log('·', m);

(async () => {
  const pw = loadPlaywright();
  if (!pw || !CHROME) { console.log('SKIP: needs playwright-core and Chrome'); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-spike-'));
  const books = {}, log = [];
  const launch = () => pw.chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true, viewport: { width: 1200, height: 900 } });
  const ready = (page) => page.waitForFunction(() => window.__spike && window.__spike.ready && window.FT && FT.ready && FT.store && FT.store.projects, null, { timeout: 20000 });
  const names = (page) => page.evaluate(() => FT.store.projects.map((p) => p.name));
  const tab = (id, t) => books[id].sheets.find((s) => s.properties.title === t);

  build('v1');
  let srv = await fake.start({ dir: DIST, port: PORT, books, log });
  let ctx = await launch();
  let page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // 1. First run, online
  let t0 = Date.now();
  await page.goto(srv.url);
  await ready(page);
  step('first run rendered in ' + (Date.now() - t0) + ' ms');
  await page.waitForFunction(() => __spike.journal() === 0 && __spike.syncs >= 1, null, { timeout: 20000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
  const sheetId = Object.keys(books)[0];
  const projectsTab = tab(sheetId, 'Projects');
  assert.ok(projectsTab && projectsTab.rows.length > 3, 'Projects tab reached the fake Sheets API');
  const seeded = projectsTab.rows.slice(1).map((r) => r[1]);
  step('synced to fake Sheets: ' + books[sheetId].sheets.length + ' tabs, Projects rows: ' + seeded.join(', '));
  assert.deepStrictEqual((await names(page)).sort(), seeded.slice().sort(), 'page and sheet agree');
  await page.waitForTimeout(500); // let the service worker finish filling its caches
  await ctx.close();

  // 2. Cold start: browser closed, server down, network off
  await srv.close();
  ctx = await launch();
  await ctx.setOffline(true);
  page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  t0 = Date.now();
  await page.goto(srv.url);
  await ready(page);
  const coldMs = Date.now() - t0;
  assert.deepStrictEqual((await names(page)).sort(), seeded.slice().sort());
  const shown = await page.evaluate(() => document.querySelector('main').innerText.slice(0, 200).replace(/\s+/g, ' '));
  step('COLD START offline, server down: rendered in ' + coldMs + ' ms. Page shows: "' + shown.slice(0, 90) + '…"');
  const libs = await page.evaluate(() => ({ GridStack: typeof GridStack !== 'undefined', Sortable: typeof Sortable !== 'undefined', fonts: document.fonts ? document.fonts.check('16px "IBM Plex Sans"') : null }));
  step('CDN libraries from the service worker cache while offline: ' + JSON.stringify(libs));
  const callMs = await page.evaluate(() => { const t = performance.now(); return FT.rpc('projects', 'list', {}).then(() => performance.now() - t); });
  step('one local call (fresh server instance, read all tabs) took ' + callMs.toFixed(1) + ' ms');

  // 3. Edit offline, then reload offline
  const cat = await page.evaluate(() => FT.store.categories[0].id);
  await page.evaluate((c) => FT.rpc('projects', 'create', { name: 'Made offline', category: c }), cat);
  await page.evaluate(() => FT.rpc('projects', 'update', { id: FT.store.projects.find((p) => p.name === 'Made offline').id, next_action: 'Edited offline too' }));
  const offlineId = await page.evaluate(() => FT.store.projects.find((p) => p.name === 'Made offline').id);
  const tasksForIt = await page.evaluate((id) => FT.store.kanban.columns.filter((c) => c.project_id === id).map((c) => c.id), offlineId);
  assert.strictEqual(await page.evaluate(() => __spike.journal()), 2);
  await page.reload();
  await ready(page);
  assert.ok((await names(page)).includes('Made offline'), 'offline edit survives a reload with no network');
  assert.strictEqual(await page.evaluate(() => __spike.journal()), 2);
  step('offline create + update kept across an offline reload; 2 calls waiting');

  // 4. Another device edits the sheet, then this one comes back online
  srv = await fake.start({ dir: DIST, port: PORT, books, log });
  const p = tab(sheetId, 'Projects'), hdr = p.rows[0];
  const otherRow = 1 + p.rows.slice(1).findIndex((r) => r[hdr.indexOf('name')] === seeded[1]);
  p.rows[otherRow][hdr.indexOf('next_action')] = 'Changed on another device';
  // and deletes the first project row, so every row number this browser knew is now off by one
  p.rows.splice(1, 1);
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => __spike.journal() === 0, null, { timeout: 20000 });
  await page.waitForFunction(() => FT.store.projects.some((x) => x.next_action === 'Changed on another device'), null, { timeout: 10000 });
  const after = tab(sheetId, 'Projects').rows;
  const mine = after.find((r) => r[0] === offlineId);
  assert.ok(mine, 'the offline project reached the sheet with the id the browser gave it');
  assert.strictEqual(mine[hdr.indexOf('next_action')], 'Edited offline too');
  assert.ok(after.some((r) => r[hdr.indexOf('next_action')] === 'Changed on another device'), 'the other device edit is kept');
  assert.ok(!after.some((r) => r[hdr.indexOf('name')] === seeded[0]), 'the other device delete is kept');
  const colsInSheet = tab(sheetId, 'Columns') ? tab(sheetId, 'Columns').rows.filter((r) => r.includes(offlineId)).map((r) => r[0]) : [];
  assert.deepStrictEqual(colsInSheet.sort(), tasksForIt.slice().sort(), 'kanban columns made offline have the same ids in the sheet');
  step('back online: replayed on the fresh sheet; offline project, its ' + colsInSheet.length + ' columns, the other device edit and delete are all there');

  // 5. Service worker update
  build('v2');
  await page.evaluate(() => __spike.checkUpdate());
  await page.waitForFunction(() => __spike.updateWaiting === true, null, { timeout: 10000 });
  step('new version found and waiting (page still on ' + (await page.evaluate(() => FT_BUILD)) + ')');
  await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.evaluate(() => __spike.applyUpdate())]);
  await ready(page);
  assert.strictEqual(await page.evaluate(() => FT_BUILD), 'v2');
  assert.ok((await names(page)).includes('Made offline'), 'data kept across the update');
  step('update applied after the page said so; now on v2, data kept');

  const calls = log.reduce((m, l) => { const k = l.replace(/fake-sheet-\d+/, ':id'); m[k] = (m[k] || 0) + 1; return m; }, {});
  step('fake Google calls: ' + JSON.stringify(calls));
  if (errors.length) step('page errors: ' + errors.join(' | '));
  await ctx.close();
  await srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
