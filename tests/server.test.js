const assert = require('assert');
const { loadServer } = require('./mocks');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
const json = (x) => JSON.parse(JSON.stringify(x));
// A fake tab's rows as objects by header, and an object as a row in the tab's column order.
const rowsOf = (sh) => sh.rows.slice(1).map((r) => Object.fromEntries(sh.rows[0].map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
const rowFrom = (sh, obj) => sh.rows[0].map((h) => (obj[h] === undefined ? '' : obj[h]));

function fresh() {
  const s = loadServer();
  s.run('setup()');
  s.call = (m, fn, args) => json(s.run('rpc')(m, fn, json(args || {})));
  return s;
}

test('setup creates a tab per table and a Drive folder', () => {
  const s = fresh();
  ['Projects', 'Columns', 'Tasks', 'Notes', 'Resources', 'Log'].forEach((n) => assert.ok(s.ss.sheets[n], 'missing tab ' + n));
  assert.deepStrictEqual(s.ss.sheets.Projects.rows[0], ['name', 'category', 'status', 'next_action', 'locked_until', 'last_touched', 'notes', 'problem', 'id', 'created', 'updated_at']);
  assert.ok(s.script._m.FOLDER_ID && s.script._m.SHEET_ID);
});

test('creating a project validates input and gives it default Kanban columns', () => {
  const s = fresh();
  assert.throws(() => s.call('projects', 'create', { name: '  ', category: 'coding' }), /needs a name/);
  assert.throws(() => s.call('projects', 'create', { name: 'x', category: 'nope' }), /Unknown category/);
  const r = s.call('projects', 'create', { name: 'Loft', category: 'house', next_action: 'Get quotes' });
  assert.strictEqual(r.result.name, 'Loft');
  assert.deepStrictEqual(Object.keys(r.slices).sort(), ['categories', 'kanban', 'projects', 'today']);
  const cols = r.slices.kanban.columns.filter((c) => c.project_id === r.result.id).map((c) => c.name);
  assert.deepStrictEqual(cols, ['To do', 'Doing', 'Done']);
});

test('columns can be reordered by hand in the sheet without breaking reads', () => {
  const s = fresh();
  s.call('projects', 'create', { name: 'A', category: 'coding' });
  const rows = s.ss.sheets.Projects.rows;
  rows.forEach((r) => { const t = r[1]; r[1] = r[2]; r[2] = t; }); // swap name and category columns, header included
  const list = s.call('projects', 'list').result;
  assert.strictEqual(list[0].name, 'A');
});

test('today favours the leading category, then the most neglected project, and swap moves on', () => {
  const s = fresh();
  s.mock.weekday = 3; // Wednesday leads with job
  const a = s.call('projects', 'create', { name: 'Code A', category: 'coding' }).result;
  const b = s.call('projects', 'create', { name: 'Job B', category: 'job' }).result;
  const c = s.call('projects', 'create', { name: 'Job C', category: 'job' }).result;
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  s.sandbox.__old = old;
  s.run(`new Table('Projects',['id']).update('${a.id}', { last_touched: __old })`);
  s.run(`new Table('Projects',['id']).update('${c.id}', { last_touched: '${new Date(Date.now() - 4 * 86400000).toISOString()}' })`);
  let t = s.call('today', 'state').result;
  assert.strictEqual(t.focusId, c.id, 'job project untouched longest should lead on a job day');
  s.call('today', 'swap');
  t = s.call('today', 'state').result;
  assert.strictEqual(t.focusId, b.id);
  s.call('today', 'swap'); // all job projects skipped, then falls back through the pool
  t = s.call('today', 'state').result;
  assert.ok([a.id, b.id, c.id].includes(t.focusId));
  s.mock.weekday = 7; // Sunday: no lead category, pure neglect
  s.run("PropertiesService.getUserProperties().setProperty('today.state', '')");
  t = s.call('today', 'state').result;
  assert.strictEqual(t.focusId, a.id);
});

/** Rewrite the saved session as if it had happened earlier. change(session, minutesAgoIso) edits it in place. */
function rewindSession(s, change) {
  const state = JSON.parse(s.user._m['today.state']);
  change(state.session, (minutes) => new Date(Date.now() - minutes * 60000).toISOString());
  s.user._m['today.state'] = JSON.stringify(state);
}

test('pauses are left out of session time, and finishing logs the worked minutes', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  assert.throws(() => s.call('today', 'pause'), /No session/);
  s.call('today', 'start', { projectId: p.id });
  // Started 60 minutes ago, with a finished 15 minute pause and a pause open for the last 5 minutes
  rewindSession(s, (session, minutesAgo) => { session.start = minutesAgo(60); session.pausedMs = 15 * 60000; session.pausedAt = minutesAgo(5); });
  s.call('today', 'pause'); // pausing twice keeps the first pause start
  const resumed = s.call('today', 'resume').result;
  assert.strictEqual(resumed.pausedAt, '');
  assert.ok(Math.abs(resumed.pausedMs - 20 * 60000) < 2000, 'open pause added to the total');
  const log = s.call('today', 'finish', { where: 'Done', next: 'Next' }).slices.log;
  assert.strictEqual(log[0].minutes, 40);
});

test('finishing without a running session logs zero minutes', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  assert.strictEqual(s.call('today', 'finish', { projectId: p.id, where: 'w' }).slices.log[0].minutes, 0);
});

test('pomodoro starts in work, moves to break on request, and pauses with the session', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  s.call('today', 'start', { projectId: p.id });
  assert.strictEqual(s.call('today', 'state').result.session.pomodoro, null, 'off by default');
  assert.throws(() => s.call('today', 'nextPhase'), /pomodoro is off/);
  rewindSession(s, (session, minutesAgo) => { session.start = minutesAgo(30); session.pausedMs = 10 * 60000; });
  let pomodoro = s.call('today', 'pomodoro', { on: true }).result.pomodoro;
  assert.strictEqual(pomodoro.phase, 'work');
  assert.strictEqual(pomodoro.lengthMin, 25);
  assert.ok(Math.abs(pomodoro.phaseStartMs - 20 * 60000) < 2000, 'phase starts at the worked time, not wall time');
  pomodoro = s.call('today', 'nextPhase').result.pomodoro;
  assert.deepStrictEqual([pomodoro.phase, pomodoro.lengthMin], ['break', 5]);
  assert.strictEqual(s.call('today', 'nextPhase').result.pomodoro.phase, 'work');
  assert.strictEqual(s.call('today', 'pomodoro', { on: false }).result.pomodoro, null);
  s.call('today', 'pause');
  const resumed = s.call('today', 'pomodoro', { on: true }).result;
  assert.strictEqual(resumed.pausedAt, '', 'turning the pomodoro on resumes a paused session');
  assert.strictEqual(resumed.pomodoro.phase, 'work');
});

test('pomodoro lengths are validated, remembered, and used from the next period', () => {
  const s = fresh();
  assert.deepStrictEqual(s.call('today', 'state').result.pomodoroSettings, { work: 25, break: 5 });
  assert.throws(() => s.call('today', 'pomodoroSettings', { work: '0', break: '5' }), /Work length/);
  assert.throws(() => s.call('today', 'pomodoroSettings', { work: '25', break: '2.5' }), /Break length/);
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  s.call('today', 'start', { projectId: p.id });
  s.call('today', 'pomodoro', { on: true });
  const r = s.call('today', 'pomodoroSettings', { work: '50', break: '10' });
  assert.deepStrictEqual(r.slices.today.pomodoroSettings, { work: 50, break: 10 });
  assert.strictEqual(r.slices.today.session.pomodoro.lengthMin, 25, 'the running period keeps its length');
  assert.strictEqual(s.call('today', 'nextPhase').result.pomodoro.lengthMin, 10);
});

test('a session saved before pauses existed still works', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Old', category: 'house' }).result;
  s.call('today', 'start', { projectId: p.id });
  rewindSession(s, (session, minutesAgo) => { session.start = minutesAgo(12); delete session.pausedMs; delete session.pausedAt; delete session.pomodoro; });
  assert.strictEqual(s.call('today', 'finish', { where: 'w' }).slices.log[0].minutes, 12);
});

test('doGet only uses meta tags that Apps Script allows', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'core', 'main.js'), 'utf8');
  const names = [...src.matchAll(/addMetaTag\('([^']+)'/g)].map((m) => m[1]);
  names.forEach((n) => assert.ok(['viewport', 'mobile-web-app-capable', 'apple-mobile-web-app-capable'].includes(n), 'Apps Script rejects the meta tag: ' + n));
});

test('redo puts back what undo took away, and a new change ends the redo list', () => {
  const s = fresh();
  const a = s.call('projects', 'create', { name: 'A', category: 'coding' }).result;
  s.call('projects', 'update', { id: a.id, name: 'A2' });
  s.call('projects', 'update', { id: a.id, name: 'A3' });
  const names = () => json(s.run('bootstrap()')).data.projects.map((p) => p.name);
  const undo = () => json(s.run('undo')()), redo = () => json(s.run('redo')());
  assert.strictEqual(redo().redone, null, 'nothing to redo yet');
  assert.strictEqual(undo().undone, 'projects.update');
  assert.deepStrictEqual(names(), ['A2']);
  assert.strictEqual(undo().undone, 'projects.update');
  assert.deepStrictEqual(names(), ['A']);
  assert.strictEqual(redo().redone, 'projects.update');
  assert.deepStrictEqual(names(), ['A2'], 'the older undo comes back first');
  assert.strictEqual(redo().redone, 'projects.update');
  assert.deepStrictEqual(names(), ['A3']);
  assert.strictEqual(redo().redone, null);
  // redone changes can be undone again
  assert.strictEqual(undo().undone, 'projects.update');
  assert.deepStrictEqual(names(), ['A2']);
  // a new change throws the redo list away
  s.call('projects', 'update', { id: a.id, name: 'B' });
  assert.strictEqual(redo().redone, null);
  // undo and redo work for inserts and deletes too
  const b = s.call('projects', 'create', { name: 'C', category: 'house' }).result;
  assert.strictEqual(undo().undone, 'projects.create');
  assert.ok(!names().includes('C'));
  assert.strictEqual(redo().redone, 'projects.create');
  assert.ok(names().includes('C'));
  s.call('projects', 'remove', { id: b.id });
  assert.ok(!names().includes('C'));
  assert.strictEqual(undo().undone, 'projects.remove');
  assert.ok(names().includes('C'), 'deleted project is back');
  assert.strictEqual(redo().redone, 'projects.remove');
  assert.ok(!names().includes('C'), 'and gone again');
});

test('a locked project leaves the focus pick, cannot start a session, and lifting the lock early needs confirmation', () => {
  const s = fresh();
  s.mock.weekday = 7;
  const a = s.call('projects', 'create', { name: 'A', category: 'coding' }).result;
  const b = s.call('projects', 'create', { name: 'B', category: 'house' }).result;
  s.run(`new Table('Projects',['id']).update('${a.id}', { last_touched: '${new Date(Date.now() - 9 * 86400000).toISOString()}' })`);
  assert.strictEqual(s.call('today', 'state').result.focusId, a.id);
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  assert.throws(() => s.call('projects', 'setLock', { id: a.id, until: '2001-01-01' }), /future/);
  assert.throws(() => s.call('projects', 'setLock', { id: a.id, until: 'soon' }), /valid date/);
  s.call('projects', 'setLock', { id: a.id, until: day(3) });
  const state = s.call('today', 'state').result;
  assert.strictEqual(state.focusId, b.id, 'the locked project is not picked');
  assert.ok(state.ranked.indexOf(a.id) === -1, 'and is not in the ranking');
  assert.throws(() => s.call('today', 'start', { projectId: a.id }), /locked/);
  s.call('projects', 'setLock', { id: a.id, until: day(6) }); // longer is always allowed
  assert.throws(() => s.call('projects', 'setLock', { id: a.id, until: day(2) }), /confirmation/);
  assert.throws(() => s.call('projects', 'setLock', { id: a.id, until: '' }), /confirmation/);
  s.call('projects', 'setLock', { id: a.id, until: '', early: true });
  assert.strictEqual(s.call('today', 'state').result.focusId, a.id, 'lifted, it is the most neglected again');
  s.call('projects', 'setLock', { id: a.id, until: new Date(Date.now() + 3600000).toISOString() }); // date and time
  assert.throws(() => s.call('today', 'start', { projectId: a.id }), /locked/);
});

test('swap to a chosen project logs the skip, sets a reminder, and keeps the skipped project neglected', () => {
  const s = fresh();
  s.mock.weekday = 7;
  const a = s.call('projects', 'create', { name: 'A', category: 'coding' }).result;
  const b = s.call('projects', 'create', { name: 'B', category: 'house' }).result;
  const c = s.call('projects', 'create', { name: 'C', category: 'job' }).result;
  s.run(`new Table('Projects',['id']).update('${a.id}', { last_touched: '${new Date(Date.now() - 9 * 86400000).toISOString()}' })`);
  assert.strictEqual(s.call('today', 'state').result.focusId, a.id);
  assert.throws(() => s.call('today', 'swap', { toId: a.id }), /already today/);
  assert.throws(() => s.call('today', 'swap', { toId: 'nope' }), /active project/);
  assert.throws(() => s.call('today', 'swap', { toId: c.id, remindDays: 2 }), /Unknown reminder/);
  const t = s.call('today', 'swap', { toId: c.id, remindDays: 1 }).slices.today;
  assert.strictEqual(t.focusId, c.id);
  assert.deepStrictEqual(t.skipCounts, { [a.id]: 1 });
  assert.deepStrictEqual(t.reminders, [], 'not due until tomorrow');
  const reminder = s.ss.sheets.Reminders.rows[1];
  assert.strictEqual(reminder[1], a.id);
  assert.strictEqual(reminder[2], new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  assert.strictEqual(json(s.run('bootstrap()')).data.projects.find((p) => p.id === a.id).last_touched.slice(0, 10),
    new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10), 'a skip is not work');
  // The reminder comes due: it can become the focus, which closes it
  s.ss.sheets.Reminders.rows[1][2] = '2000-01-01';
  const due = s.call('today', 'state').result.reminders;
  assert.strictEqual(due.length, 1);
  const after = s.call('today', 'focusReminder', { id: due[0].id }).slices.today;
  assert.strictEqual(after.focusId, a.id);
  assert.deepStrictEqual(after.reminders, []);
  s.call('today', 'swap', { toId: b.id, remindDays: 7 });
  s.ss.sheets.Reminders.rows[2][2] = '2000-01-01';
  assert.strictEqual(s.call('today', 'dismissReminder', { id: s.call('today', 'state').result.reminders[0].id }).slices.today.reminders.length, 0);
  assert.strictEqual(s.call('today', 'state').result.skipCounts[a.id], 2);
  s.call('projects', 'remove', { id: a.id });
  assert.deepStrictEqual(s.call('today', 'state').result.skipCounts, {}, 'skips go with the project');
  assert.strictEqual(s.ss.sheets.Reminders.rows.length, 1);
});

test('the rotation can be edited; this-week changes and away days apply only this week', () => {
  const s = fresh();
  s.mock.weekday = 3;
  let t = s.call('today', 'state').result;
  assert.strictEqual(t.lead, 'job');
  assert.deepStrictEqual(t.week, {});
  const usual = { 1: 'house', 2: 'coding', 3: 'coding', 4: '', 5: 'house', 6: 'away', 7: 'away' };
  assert.throws(() => s.call('today', 'saveRotation', { usual: Object.assign({}, usual, { 1: 'nope' }) }), /Unknown category/);
  assert.throws(() => s.call('today', 'saveRotation', { usual, week: { 9: 'away' } }), /Unknown weekday/);
  t = s.call('today', 'saveRotation', { usual, week: { 3: 'away', 4: 'job' } }).slices.today;
  assert.strictEqual(t.away, true);
  assert.strictEqual(t.lead, null);
  assert.deepStrictEqual([t.labels[1], t.labels[3], t.labels[4], t.labels[6]], ['House', 'Away', 'Job search', 'Away']);
  assert.strictEqual(t.usual[4], null);
  assert.strictEqual(t.dailyMinimum, undefined, 'the daily minimum is a habit now');
  // Saved in the mode's Settings tab as readable rows, not in user properties
  const settings = Object.fromEntries(s.ss.sheets.Settings.rows.slice(1));
  assert.deepStrictEqual([settings['rotation.monday'], settings['rotation.thursday'], settings['rotation.saturday'], settings['rotation.daily_minimum']], ['house', 'any', 'away', undefined]);
  assert.deepStrictEqual([settings['week.wednesday'], settings['week.thursday'], settings['week.friday']], ['away', 'job', undefined], 'only the changed days have a value');
  assert.ok(!s.user._m['today.rotation'] && !s.user._m['today.week']);
  // A new week: the saved week no longer matches, so only the usual rotation applies
  s.ss.sheets.Settings.rows.find((r) => r[0] === 'week.of')[1] = '1999-01-04';
  t = s.call('today', 'state').result;
  assert.strictEqual(t.away, false);
  assert.strictEqual(t.lead, 'coding');
  assert.deepStrictEqual(t.week, {});
  assert.strictEqual(json(s.run("bootstrap('work')")).data.today.lead, null, 'work mode has its own rotation');
});

test('finishing a session writes the log, touches the project and clears the session', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house', next_action: 'Measure' }).result;
  s.call('today', 'start', { projectId: p.id });
  assert.ok(s.call('today', 'state').result.session);
  const r = s.call('today', 'finish', { projectId: p.id, where: 'Took cover off', next: 'Order fan' });
  assert.deepStrictEqual(Object.keys(r.slices).sort(), ['log', 'projects', 'today']);
  assert.strictEqual(r.slices.projects[0].next_action, 'Order fan');
  assert.strictEqual(r.slices.log[0].where_stopped, 'Took cover off');
  assert.strictEqual(r.slices.today.session, null);
});

test('kanban: add, move, rename and delete columns without losing tasks', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'K', category: 'coding' }).result;
  let k = s.call('kanban', 'addTask', { projectId: p.id, title: 'one' }).slices.kanban;
  const cols = k.columns.filter((c) => c.project_id === p.id);
  const task = k.tasks[0];
  assert.strictEqual(task.column_id, cols[0].id);
  const inLast = s.call('kanban', 'addTask', { projectId: p.id, columnId: cols[2].id, title: 'straight to done' }).result;
  assert.strictEqual(inLast.column_id, cols[2].id);
  s.call('kanban', 'deleteTask', { id: inLast.id });
  const other = s.call('projects', 'create', { name: 'Other', category: 'coding' }).result;
  assert.throws(() => s.call('kanban', 'addTask', { projectId: other.id, columnId: cols[0].id, title: 'x' }), /not on this board/);
  s.call('kanban', 'moveTask', { id: task.id, columnId: cols[1].id });
  s.call('kanban', 'renameColumn', { id: cols[1].id, name: 'In progress' });
  k = s.call('kanban', 'addColumn', { projectId: p.id, name: 'Review' }).slices.kanban;
  assert.strictEqual(k.columns.filter((c) => c.project_id === p.id).length, 4);
  k = s.call('kanban', 'deleteColumn', { id: cols[1].id }).slices.kanban;
  assert.strictEqual(k.tasks[0].column_id, cols[0].id, 'tasks move to the column on the left');
  assert.strictEqual(k.columns.filter((c) => c.project_id === p.id).length, 3);
  // first column deletes into the next one
  k = s.call('kanban', 'deleteColumn', { id: cols[0].id }).slices.kanban;
  assert.ok(k.columns.some((c) => c.id === k.tasks[0].column_id));
  // cannot delete the last column
  let remaining = k.columns.filter((c) => c.project_id === p.id);
  while (remaining.length > 1) { k = s.call('kanban', 'deleteColumn', { id: remaining[0].id }).slices.kanban; remaining = k.columns.filter((c) => c.project_id === p.id); }
  assert.throws(() => s.call('kanban', 'deleteColumn', { id: remaining[0].id }), /at least one column/);
  assert.strictEqual(k.tasks.length, 1);
});

test('kanban: a column moves to a new place on its own board, and undo puts it back', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'K', category: 'coding' }).result;
  const names = (k) => k.columns.filter((c) => c.project_id === p.id).sort((x, y) => x.order - y.order).map((c) => c.name);
  const cols = json(s.run('bootstrap()')).data.kanban.columns.filter((c) => c.project_id === p.id);
  const other = s.call('projects', 'create', { name: 'Other', category: 'coding' }).result;
  s.call('kanban', 'addTask', { projectId: p.id, columnId: cols[2].id, title: 'stays put' });
  const r = s.call('kanban', 'moveColumn', { id: cols[2].id, projectId: p.id, order: (cols[0].order + cols[1].order) / 2 });
  assert.deepStrictEqual(names(r.slices.kanban), ['To do', 'Done', 'Doing']);
  assert.strictEqual(r.slices.kanban.tasks[0].column_id, cols[2].id, 'its cards go with it');
  assert.strictEqual(r.undo.action, 'kanban.moveColumn');
  s.call('kanban', 'moveColumn', { id: cols[0].id, order: 99 });
  assert.deepStrictEqual(names(json(s.run('bootstrap()')).data.kanban), ['Done', 'Doing', 'To do']);
  assert.throws(() => s.call('kanban', 'moveColumn', { id: cols[1].id, projectId: other.id, order: 1 }), /not on this board/);
  assert.throws(() => s.call('kanban', 'moveColumn', { id: cols[1].id, order: 'first' }), /place to move to/);
  assert.throws(() => s.call('kanban', 'moveColumn', { id: 'nope', order: 1 }), /no longer exists/);
  assert.strictEqual(json(s.run('undo')()).undone, 'kanban.moveColumn');
  assert.deepStrictEqual(names(json(s.run('undo')()).data.kanban), ['To do', 'Doing', 'Done']);
});

test('notes are stored as a markdown file and read back', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'My Project!', category: 'coding' }).result;
  assert.deepStrictEqual(s.call('notes', 'get', { projectId: p.id }).result, { text: '', url: '', updated: '' });
  const saved = s.call('notes', 'save', { projectId: p.id, text: '# hello' }).result;
  assert.ok(saved.url);
  s.call('notes', 'save', { projectId: p.id, text: '# hello again' });
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, '# hello again');
  const mdFiles = Object.values(s.drive.files).filter((f) => f.name.endsWith('.md'));
  const file = mdFiles[0];
  assert.ok(/^my-project-[0-9a-f]{8}\.md$/.test(file.name), file.name);
  assert.strictEqual(file.mime, 'text/markdown');
  assert.strictEqual(mdFiles.length, 1, 'second save updates the same file');
  // A save that builds on an older version (a page left open elsewhere) keeps both texts; the same text is no conflict
  const v = s.call('notes', 'get', { projectId: p.id }).result.updated;
  assert.deepStrictEqual(s.call('notes', 'save', { projectId: p.id, text: '# hello again', _base: 'older', _editedAt: new Date().toISOString() }).result.conflict, undefined);
  const clash = s.call('notes', 'save', { projectId: p.id, text: '# from the old tab', _base: 'older', _editedAt: new Date(Date.parse(v) + 1000).toISOString() }).result;
  assert.strictEqual(clash.conflict.kept, 'yours');
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, '# from the old tab');
  assert.ok(Object.values(s.drive.files).some((f) => f.name === clash.conflict.copyName && f.content === '# hello again'), 'the replaced text is kept as a copy');
  const late = s.call('notes', 'save', { projectId: p.id, text: '# edited long ago', _base: 'older', _editedAt: '2020-01-01T00:00:00.000Z' }).result;
  assert.strictEqual(late.conflict.kept, 'server');
  assert.strictEqual(late.text, '# from the old tab', 'the browser is sent the text that was kept');
  assert.strictEqual(s.drive.pathOf(file), 'Focus Tracker/Personal/Notes/' + file.name);
});

// Saves are versioned by the millisecond: wait for the next one so two saves in a test get different versions.
const tick = () => { const t = Date.now(); while (Date.now() === t) { /* spin */ } };

test('notes Doc: the first sync makes "<project> notes" in the Notes folder, links it, and is skipped while nothing changed', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Garden', category: 'house' }).result;
  assert.deepStrictEqual(s.call('notes', 'syncDoc', { projectId: p.id }).result.skipped, 'no notes', 'no notes, no Doc');
  s.call('notes', 'save', { projectId: p.id, text: '# Plan\nDig the beds\n- spade\n- gloves\n> measure twice\n**bold** and *italic* [a link](https://example.com)' });
  const reply = s.call('notes', 'syncDoc', { projectId: p.id }), r = reply.result;
  assert.ok(!reply.undo, 'bookkeeping, not offered for undo');
  assert.ok(r.created && typeof r.ms === 'number' && r.timings && typeof r.timings.write === 'number', 'reports how long it took');
  assert.ok(s.mock.logs.some((l) => /^notes\.syncDoc \d+ ms .*\(new Doc\)$/.test(l)), 'and writes it to the execution log');
  const docs = s.docs.docs();
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].name, 'Garden notes');
  assert.strictEqual(s.drive.pathOf(docs[0]), 'Focus Tracker/Personal/Notes/Garden notes');
  assert.strictEqual(r.url, 'https://docs.google.com/document/d/' + docs[0].id + '/edit');
  // standard markdown for Drive's import: a blank line between blocks, list items and quote lines kept together
  assert.strictEqual(docs[0].content, '# Plan\n\nDig the beds\n\n- spade\n- gloves\n\n> measure twice\n\n**bold** and *italic* [a link](https://example.com)');
  const b = json(s.run('bootstrap()')).data;
  assert.strictEqual(b.notes.find((n) => n.project_id === p.id).doc, r.url, 'the notes row carries the Doc');
  assert.strictEqual(b.projects.find((x) => x.id === p.id).notes, r.url, 'Projects.notes links the Doc');
  // debounce on the server: nothing changed since the last mirror, so no Drive call at all
  const before = Object.assign({}, s.docs.calls);
  assert.strictEqual(s.call('notes', 'syncDoc', { projectId: p.id }).result.skipped, 'unchanged');
  assert.deepStrictEqual(s.docs.calls, before);
  tick();
  s.call('notes', 'save', { projectId: p.id, text: '# Plan\nDig the beds today' });
  const again = s.call('notes', 'syncDoc', { projectId: p.id }).result;
  assert.ok(!again.created && again.url === r.url, 'the same Doc is updated');
  assert.strictEqual(s.docs.docs().length, 1);
  assert.strictEqual(s.docs.docs()[0].content, '# Plan\n\nDig the beds today');
  assert.strictEqual(s.call('notes', 'checkDoc', { projectId: p.id }).result.changed, false, 'the app\'s own write is not an edit');
  assert.strictEqual(s.docs.calls.export, 0, 'and finding that out needs no export');
});

test('notes Doc: an edit made in the Doc comes back into the markdown when the project opens', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Shed', category: 'house' }).result;
  s.call('notes', 'save', { projectId: p.id, text: 'Roof\n- felt' });
  const doc = s.call('notes', 'syncDoc', { projectId: p.id }).result;
  const id = s.docs.docs()[0].id;
  // What Drive's export of an edited Doc looks like: blank lines between blocks, * bullets, escapes
  s.docs.edit(id, 'Roof\n\n* felt\n* nails\n\n> added by an assistant\n>\n> second quote line\n\nStep 1\\. done\n');
  const before = json(s.run('bootstrap()')).data.notes[0].updated;
  const r = s.call('notes', 'checkDoc', { projectId: p.id }).result;
  assert.ok(r.changed && r.imported && typeof r.ms === 'number');
  assert.strictEqual(r.text, 'Roof\n* felt\n* nails\n> added by an assistant\n> second quote line\nStep 1. done');
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, r.text, 'saved into the markdown file');
  assert.ok(r.updated && r.updated !== before, 'as a new version');
  assert.strictEqual(s.call('notes', 'checkDoc', { projectId: p.id }).result.changed, false, 'brought in once');
  assert.strictEqual(s.call('notes', 'syncDoc', { projectId: p.id }).result.skipped, 'unchanged', 'the Doc already has it');
  assert.strictEqual(doc.url, json(s.run('bootstrap()')).data.notes[0].doc);
  // a Doc edit that only changes what a trip through Docs changes is no edit
  s.docs.edit(id, s.docs.docs()[0].content + '\n\n');
  const same = s.call('notes', 'checkDoc', { projectId: p.id }).result;
  assert.strictEqual(same.changed, false);
  // an empty export never wipes the notes (Drive may have answered with nothing)
  s.docs.edit(id, '');
  assert.strictEqual(s.call('notes', 'checkDoc', { projectId: p.id }).result.changed, false);
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, r.text);
});

test('notes Doc: both the Doc and the markdown changed: the markdown stays and the Doc text is a conflict copy', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Boat', category: 'house' }).result;
  s.call('notes', 'save', { projectId: p.id, text: 'Hull' });
  s.call('notes', 'syncDoc', { projectId: p.id });
  const id = s.docs.docs()[0].id;
  const copies = () => Object.values(s.drive.files).filter((f) => /-conflict-.*-doc\.md$/.test(f.name));
  // on opening: Doc edited, and the markdown changed since the mirror
  s.docs.edit(id, 'Hull\n\nfrom the Doc');
  tick();
  s.call('notes', 'save', { projectId: p.id, text: 'Hull\nfrom the app' });
  const r = s.call('notes', 'checkDoc', { projectId: p.id });
  assert.strictEqual(r.result.conflict.kept, 'app');
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, 'Hull\nfrom the app', 'the markdown stays');
  assert.strictEqual(copies().length, 1);
  assert.strictEqual(copies()[0].content, 'Hull\nfrom the Doc', 'the Doc text is kept');
  assert.strictEqual(s.drive.pathOf(copies()[0]), 'Focus Tracker/Personal/Notes/' + copies()[0].name);
  assert.ok(r.conflicts && r.conflicts.length === 1);
  assert.ok(json(s.run('bootstrap()')).data.log.some((l) => /notes Doc/.test(l.where_stopped)), 'and the Log says so');
  s.call('notes', 'syncDoc', { projectId: p.id });
  assert.strictEqual(s.docs.docs()[0].content, 'Hull\n\nfrom the app', 'the next sync puts the kept notes in the Doc');
  // while editing was not finished yet: the Doc edited, then a sync with newer markdown keeps the Doc text first
  s.docs.edit(id, 'Hull\n\nDoc edit nobody imported');
  tick();
  s.call('notes', 'save', { projectId: p.id, text: 'Hull\nnewer app text' });
  const sync = s.call('notes', 'syncDoc', { projectId: p.id }).result;
  assert.strictEqual(sync.conflict.kept, 'app');
  assert.ok(copies().some((f) => f.content === 'Hull\nDoc edit nobody imported'), 'nothing written in the Doc is lost');
  assert.strictEqual(s.docs.docs()[0].content, 'Hull\n\nnewer app text');
  // a Doc deleted in Drive is made again on the next sync
  delete s.drive.files[id];
  tick();
  s.call('notes', 'save', { projectId: p.id, text: 'Hull\nafter the Doc was deleted' });
  const remade = s.call('notes', 'syncDoc', { projectId: p.id }).result;
  assert.ok(remade.created && s.docs.docs().length === 1 && remade.url !== 'https://docs.google.com/document/d/' + id + '/edit');
});

test('resources only accept https links and attach to a category or a project', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'R', category: 'house' }).result;
  assert.throws(() => s.call('resources', 'add', { category: 'house', title: 'x', url: 'http://example.com' }), /https/);
  assert.throws(() => s.call('resources', 'add', { category: 'house', title: '', url: 'https://example.com' }), /title/);
  s.call('resources', 'add', { category: 'house', title: 'DIY', url: 'https://docs.google.com/document/d/abc', note: 'plans' });
  const r = s.call('resources', 'add', { category: 'house', projectId: p.id, title: 'Fan', url: 'https://example.com/fan' }).slices.resources;
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r.filter((x) => !x.project_id).length, 1);
  assert.deepStrictEqual(r.map((x) => x.type).sort(), ['drive', 'link'], 'with no type, the address decides');
});

test('each resource type checks its value', () => {
  const s = fresh();
  const add = (type, value, extra) => s.call('resources', 'add', Object.assign({ category: 'house', title: type, type, value }, extra)).result;
  const refused = (type, value, why) => assert.throws(() => add(type, value), why, type + ' ' + value);
  assert.strictEqual(add('link', 'https://example.com/a').type, 'link');
  refused('link', 'http://example.com', /https/);
  refused('link', 'javascript:alert(1)', /https/);
  assert.strictEqual(add('drive', 'https://drive.google.com/file/d/x').type, 'drive');
  refused('drive', 'https://example.com/file', /Drive file/);
  assert.strictEqual(add('phone', '+44 (20) 7946-0000').value, '+44 (20) 7946-0000', 'a phone number keeps its spacing');
  refused('phone', 'call me', /phone number/);
  refused('phone', '12', /phone number/);
  assert.strictEqual(add('email', 'builder@example.co.uk').type, 'email');
  refused('email', 'builder@example', /email address/);
  refused('email', 'a b@example.com', /email address/);
  assert.strictEqual(add('text', 'Bin day: Tuesday').value, 'Bin day: Tuesday');
  assert.strictEqual(add('text', 'x'.repeat(600)).value.length, 500, 'text is cut at 500 characters');
  refused('text', '  ', /text/);
  refused('fax', '0123', /Unknown type/);
  const g = add('phone', '0161 496 0000', { group: '  Suppliers  ', note: 'plumber' });
  assert.strictEqual(g.group, 'Suppliers');
  const id = 'abcd1234';
  assert.strictEqual(add('text', 'from the browser', { id }).id, id, 'a browser id is kept');
  assert.throws(() => add('text', 'again', { id }), /already exists/);
});

test('editing a resource checks the new value and can be undone', () => {
  const s = fresh();
  const r = s.call('resources', 'add', { category: 'house', title: 'Plumber', type: 'phone', value: '0161 496 0000' }).result;
  const row = () => json(s.run('bootstrap()')).data.resources.find((x) => x.id === r.id);
  assert.throws(() => s.call('resources', 'update', { id: r.id, type: 'email' }), /email address/, 'a type change checks the kept value');
  assert.throws(() => s.call('resources', 'update', { id: r.id, title: ' ' }), /title/);
  assert.throws(() => s.call('resources', 'update', { id: 'ffffffff', title: 'x' }), /gone/);
  const res = s.call('resources', 'update', { id: r.id, title: 'Plumber (Dave)', type: 'email', value: 'dave@example.com', group: 'Suppliers', note: 'weekdays' });
  assert.ok(res.undo, 'recorded for undo');
  assert.deepStrictEqual([row().title, row().type, row().value, row().group, row().note], ['Plumber (Dave)', 'email', 'dave@example.com', 'Suppliers', 'weekdays']);
  s.call('resources', 'update', { id: r.id, group: '' });
  assert.strictEqual(row().group, '', 'only the fields sent change');
  assert.strictEqual(row().value, 'dave@example.com');
  assert.strictEqual(json(s.run('undo')()).undone, 'resources.update');
  assert.strictEqual(json(s.run('undo')()).undone, 'resources.update');
  assert.deepStrictEqual([row().title, row().type, row().value], ['Plumber', 'phone', '0161 496 0000']);
});

test('searching Drive gives names and addresses only, never contents, and stores nothing', () => {
  const s = fresh();
  s.drive.addDriveFile('Boiler manual', { mime: 'application/pdf', updated: new Date('2026-09-02T10:00:00Z'), content: 'secret' });
  s.drive.addDriveFile('boiler service 2025', { mime: 'application/vnd.google-apps.document' });
  s.drive.addDriveFile('Old boiler quote', { trashed: true });
  for (let i = 0; i < 25; i++) s.drive.addDriveFile('Notes ' + i);
  const before = json(s.run('bootstrap()')).data.resources.length;
  const res = s.call('resources', 'searchDrive', { q: 'Boiler' });
  const found = res.result;
  assert.deepStrictEqual(found.map((f) => f.name).sort(), ['Boiler manual', 'boiler service 2025'], 'a trashed file is left out');
  found.forEach((f) => assert.deepStrictEqual(Object.keys(f).sort(), ['mimeType', 'modified', 'name', 'url']));
  const manual = found.find((f) => f.name === 'Boiler manual');
  assert.strictEqual(manual.mimeType, 'application/pdf');
  assert.strictEqual(manual.modified, '2026-09-02T10:00:00.000Z');
  assert.ok(/^https:\/\//.test(manual.url));
  assert.strictEqual(s.drive.contentReads, 0, 'no file was opened');
  assert.ok(!res.undo, 'a search is not a change');
  assert.strictEqual(json(s.run('bootstrap()')).data.resources.length, before, 'nothing stored');
  assert.strictEqual(s.call('resources', 'searchDrive', { q: 'Notes' }).result.length, 20, 'at most 20');
  assert.deepStrictEqual(s.call('resources', 'searchDrive', { q: "Dave's \\ quote" }).result, []);
  assert.strictEqual(s.drive.queries[s.drive.queries.length - 1], "title contains 'Dave\\'s \\\\ quote' and trashed = false", 'quotes and backslashes are escaped');
  assert.throws(() => s.call('resources', 'searchDrive', { q: '  ' }), /file name/);
});

test('deleting a project removes its board, links and log lines', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Gone', category: 'job' }).result;
  s.call('kanban', 'addTask', { projectId: p.id, title: 't' });
  s.call('resources', 'add', { category: 'job', projectId: p.id, title: 'l', url: 'https://example.com' });
  s.call('notes', 'save', { projectId: p.id, text: 'n' });
  s.call('today', 'finish', { projectId: p.id, where: 'w', next: 'n' });
  const r = s.call('projects', 'remove', { id: p.id });
  assert.strictEqual(r.slices.projects.length, 0);
  assert.strictEqual(r.slices.kanban.columns.length, 0);
  assert.strictEqual(r.slices.kanban.tasks.length, 0);
  assert.strictEqual(r.slices.resources.length, 0);
  assert.strictEqual(r.slices.log.length, 0);
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, '');
});

test('data from before modes moves into the Personal folder on first load', () => {
  const s = loadServer();
  // The layout before modes: spreadsheet in My Drive, Notes/ directly in the tracker folder
  const root = s.drive.createFolder('Focus Tracker');
  const oldNote = root.createFolder('Notes').createFile('fan-1.md', 'hello', 'text/markdown');
  s.script._m.SHEET_ID = s.ss.getId();
  s.script._m.FOLDER_ID = root.getId();
  const b = json(s.run('bootstrap()'));
  assert.strictEqual(b.config.mode, 'personal');
  assert.strictEqual(s.drive.pathOf(s.drive.getFileById(s.ss.getId())), 'Focus Tracker/Personal/Focus Tracker');
  assert.strictEqual(s.drive.pathOf(oldNote), 'Focus Tracker/Personal/Notes/fan-1.md');
  assert.strictEqual(b.config.folderUrl, s.drive.getFolderById(s.script._m['MODE_FOLDER_ID.personal']).getUrl());
  json(s.run('bootstrap()'));
  assert.deepStrictEqual(Object.values(root.children).map((c) => c.name).sort(), ['Focus Tracker – guide for AI assistants', 'Personal'], 'a second load moves nothing (the guide for assistants sits at the top)');
});

test('work mode gets its own spreadsheet, folder, categories and Today state', () => {
  const s = fresh();
  const personal = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  s.call('today', 'start', { projectId: personal.id });
  const work = (fn, args, m = 'projects') => json(s.run('rpc')(m, fn, json(args || {}), 'work'));
  assert.throws(() => work('create', { name: 'X', category: 'house' }), /Unknown category/);
  const ticket = work('create', { name: 'Ticket', category: 'delivery' }).result;
  const workSheetId = s.script._m['SHEET_ID.work'];
  assert.ok(workSheetId && workSheetId !== s.ss.getId());
  assert.strictEqual(s.drive.pathOf(s.drive.getFileById(workSheetId)), 'Focus Tracker/Work/Focus Tracker - Work');
  assert.ok(s.spreadsheets[workSheetId].sheets.Projects, 'tabs are created in the work spreadsheet');

  const wb = json(s.run("bootstrap('work')"));
  assert.deepStrictEqual(wb.data.projects.map((p) => p.name), ['Ticket']);
  assert.deepStrictEqual(wb.data.categories.map((c) => c.id), ['delivery', 'ops', 'learning', 'career', 'admin']);
  assert.strictEqual(wb.data.today.session, null, 'the personal session does not show in work');
  assert.deepStrictEqual(wb.data.habits.habits, [], 'work has no habits');
  assert.strictEqual(wb.data.today.focusId, ticket.id);
  assert.notStrictEqual(wb.config.folderUrl, json(s.run('bootstrap()')).config.folderUrl);
  assert.deepStrictEqual(wb.config.modes.map((m) => m.id), ['personal', 'work']);

  const pb = json(s.run('bootstrap()'));
  assert.deepStrictEqual(pb.data.projects.map((p) => p.name), ['Fan']);
  assert.strictEqual(pb.data.today.session.projectId, personal.id);
  assert.throws(() => s.run("bootstrap('nope')"), /Unknown mode/);
});

test('new modes can be made in the app, with a safe unique id, their own folder, sheet and categories', () => {
  const s = fresh();
  const make = (label) => json(s.run('createMode')(label));
  assert.throws(() => make('  '), /needs a name/);
  assert.throws(() => make('work'), /already a mode called work/);
  const side = make('Side projects!');
  assert.deepStrictEqual(side, { id: 'side-projects', label: 'Side projects!', accent: '5' });
  assert.strictEqual(make('Side-projects').id, 'side-projects-2', 'ids stay unique');
  assert.strictEqual(make('日本').id, 'mode');
  const b = json(s.run("bootstrap('side-projects')"));
  assert.deepStrictEqual(b.config.modes.map((m) => m.id), ['personal', 'work', 'side-projects', 'side-projects-2', 'mode']);
  assert.deepStrictEqual(b.data.categories.map((c) => c.label), ['General']);
  assert.deepStrictEqual(b.data.habits.habits, []);
  const p = json(s.run('rpc')('projects', 'create', { name: 'Shed', category: 'general' }, 'side-projects')).result;
  assert.ok(p.id);
  const sheetId = s.script._m['SHEET_ID.side-projects'];
  assert.strictEqual(s.drive.pathOf(s.drive.getFileById(sheetId)), 'Focus Tracker/Side projects!/Focus Tracker - Side projects!');
  assert.strictEqual(json(s.run('bootstrap()')).data.projects.length, 0, 'personal data untouched');
  for (let i = 0; i < 7; i++) make('Extra ' + i);
  assert.throws(() => make('One too many'), /up to 12 modes/);
});

test('categories can be added, renamed, recoloured and deleted only when unused', () => {
  const s = fresh();
  const added = s.call('categories', 'add', { label: '  Garden  ' });
  assert.strictEqual(added.result.label, 'Garden');
  assert.ok(added.result.color, 'gets a colour');
  const garden = added.result.id;
  const p = s.call('projects', 'create', { name: 'Shed', category: garden }).result;
  s.call('categories', 'update', { id: garden, label: 'Garden and shed', color: '6' });
  assert.throws(() => s.call('categories', 'update', { id: garden, color: '9' }), /Unknown colour/);
  assert.throws(() => s.call('categories', 'update', { id: garden, label: ' ' }), /needs a name/);
  assert.throws(() => s.call('categories', 'remove', { id: garden }), /Move its projects/);
  s.call('projects', 'update', { id: p.id, category: 'house' });
  s.call('resources', 'add', { category: garden, title: 'Plan', url: 'https://example.com' });
  assert.throws(() => s.call('categories', 'remove', { id: garden }), /Move its projects and links/);
  s.call('resources', 'remove', { id: s.call('resources', 'add', { category: 'house', title: 'x', url: 'https://example.com' }).result.id });
  const linkId = json(s.run('bootstrap()')).data.resources.find((r) => r.category === garden).id;
  s.call('resources', 'remove', { id: linkId });
  const after = s.call('categories', 'remove', { id: garden }).slices.categories;
  assert.deepStrictEqual(after.map((c) => c.label), ['Coding', 'Job search', 'House']);
});

test('a deleted lead category makes that day "Any category"', () => {
  const s = fresh();
  s.mock.weekday = 3;
  assert.strictEqual(s.call('today', 'state').result.lead, 'job');
  s.call('categories', 'remove', { id: 'job' });
  const t = s.call('today', 'state').result;
  assert.strictEqual(t.lead, null);
  assert.strictEqual(t.labels[3], 'Any category');
  assert.strictEqual(t.labels[1], 'Coding');
});

test('lists have groups and items on their own board, can be shown on Today, reordered and deleted', () => {
  const s = fresh();
  assert.throws(() => s.call('lists', 'create', { name: ' ' }), /needs a name/);
  const reading = s.call('lists', 'create', { name: 'Read and watch', groups: ['Work', 'Rainy day'] });
  assert.deepStrictEqual(reading.slices.kanban.columns.filter((c) => c.list_id === reading.result.id && c.owner === reading.result.id).map((c) => c.name), ['Work', 'Rainy day']);
  const keep = s.call('lists', 'create', { name: 'Keep in mind', showToday: true }).result;
  assert.strictEqual(keep.show_today, 'yes');
  const groups = (id) => json(s.run('bootstrap()')).data.kanban.columns.filter((c) => c.list_id === id);
  assert.deepStrictEqual(groups(keep.id).map((c) => c.name), ['Items']);
  const item = s.call('kanban', 'addTask', { projectId: keep.id, columnId: groups(keep.id)[0].id, title: 'Tell a story with commits' }).result;
  assert.deepStrictEqual([item.list_id, item.project_id, item.owner, item.list, item.column], [keep.id, '', keep.id, 'Keep in mind', 'Items'], 'a list item is kept in list_id, with readable names');
  s.call('lists', 'showToday', { id: reading.result.id, on: true });
  s.call('lists', 'rename', { id: keep.id, name: 'How I work' });
  let lists = s.call('lists', 'move', { id: keep.id, d: -1 }).slices.lists;
  assert.deepStrictEqual(lists.map((l) => l.name), ['How I work', 'Read and watch']);
  assert.ok(lists.every((l) => l.show_today === 'yes'));
  assert.strictEqual(s.call('lists', 'move', { id: keep.id, d: -1 }).result, false, 'already first');
  const after = s.call('lists', 'remove', { id: keep.id }).slices;
  assert.deepStrictEqual(after.lists.map((l) => l.name), ['Read and watch']);
  assert.ok(!after.kanban.tasks.some((t) => t.owner === keep.id), 'its items are removed');
  assert.ok(!after.kanban.columns.some((c) => c.owner === keep.id), 'its groups are removed');
});

test('rich-text notes keep safe formatting and drop anything that could run or load', () => {
  const s = fresh();
  const clean = (html) => s.run('sanitizeRichText_')(html);
  assert.strictEqual(clean('<b>Bold</b> <i>it</i><ul><li>one</li></ul>'), '<b>Bold</b> <i>it</i><ul><li>one</li></ul>');
  assert.strictEqual(clean('<h1>One</h1><h2>Two</h2><h3 class="x">Three</h3><p>Text</p>'), '<h1>One</h1><h2>Two</h2><h3>Three</h3><p>Text</p>', 'headings 1 to 3 (Ctrl+Alt+1 to 3) are kept');
  assert.strictEqual(s.run('richTextToPlain_')('<h1>Title</h1><h2>Part</h2>Body'), 'Title\nPart\nBody', 'each heading is its own line in the plain copy');
  assert.strictEqual(clean('<font size="5" color="#d64545" face="x">Big</font>'), '<font color="#d64545" size="5">Big</font>');
  assert.strictEqual(clean('a<script>alert(1)</script>b'), 'ab');
  assert.strictEqual(clean('<img src=x onerror="alert(1)">hi'), 'hi');
  assert.strictEqual(clean('<b onclick="x()" style="color: red; background: url(x.png)">t</b>'), '<b style="color: red">t</b>');
  assert.strictEqual(clean('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.strictEqual(clean('<a href="https://example.com/?a=1&amp;b=2" onmouseover="x">ok</a>'),
    '<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ok</a>');
  assert.strictEqual(clean('<span style="font-size: 18px; position: fixed">s</span>'), '<span style="font-size: 18px">s</span>');
  assert.strictEqual(clean('<svg><script>x</script><b>gone</b></svg>kept'), 'kept');
  assert.strictEqual(clean('1 < 2 <img src=x onerror=alert(1)'), '1 &lt; 2 &lt;img src=x onerror=alert(1)');
  assert.strictEqual(clean('<b title="a>b" onclick=x>t</b>'), '<b>t</b>');
  assert.throws(() => clean('x'.repeat(40001)), /too long/);
  assert.strictEqual(clean('See https://a.io/x?y=1&amp;z=2. Done'),
    'See <a href="https://a.io/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">https://a.io/x?y=1&amp;z=2</a>. Done', 'typed addresses become links');
  assert.strictEqual(clean('<a href="https://a.io">https://a.io</a>'), '<a href="https://a.io" target="_blank" rel="noopener noreferrer">https://a.io</a>', 'no link inside a link');
  assert.strictEqual(clean('javascript:alert(1) and ftp://x'), 'javascript:alert(1) and ftp://x', 'only web addresses');
  const plain = s.run('richTextToPlain_')('<p>Intro &amp; more</p><ul><li>One</li><li><a href="https://a.io">site</a></li></ul>Line<br>two');
  assert.strictEqual(plain, 'Intro & more\n\n- One\n- site (https://a.io)\nLine\ntwo');
  assert.strictEqual(s.run('plainToRichText_')('See https://a.io/x?y=1&z=2\n<b>'),
    'See <a href="https://a.io/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">https://a.io/x?y=1&amp;z=2</a><br>&lt;b&gt;');
});

test('a card gets a colour and a cleaned note with a plain-text copy in the sheet', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'K', category: 'coding' }).result;
  const t = s.call('kanban', 'addTask', { projectId: p.id, title: 'Card' }).result;
  const r = s.call('kanban', 'updateTask', { id: t.id, title: ' Renamed ', color: '4', noteHtml: '<b>Do</b> this<script>x</script><br>then <a href="https://x.io">that</a>' });
  assert.strictEqual(r.result.title, 'Renamed');
  assert.strictEqual(r.result.color, '4');
  assert.strictEqual(r.result.note_html, '<b>Do</b> this<br>then <a href="https://x.io" target="_blank" rel="noopener noreferrer">that</a>');
  assert.strictEqual(r.result.note, 'Do this\nthen that (https://x.io)');
  const header = s.ss.sheets.Tasks.rows[0];
  assert.ok(['color', 'note_html', 'note'].every((h) => header.includes(h)));
  assert.throws(() => s.call('kanban', 'updateTask', { id: t.id, color: '12' }), /Unknown colour/);
  assert.strictEqual(s.call('kanban', 'updateTask', { id: t.id, noteHtml: '<div><br></div>' }).result.note_html, '', 'an empty note is stored as empty');
  assert.strictEqual(s.call('kanban', 'updateTask', { id: t.id, color: '' }).result.color, '');
});

test('page layouts are saved per page and per mode, validated, and can be reset', () => {
  const s = fresh();
  const items = [{ id: 'focus', x: 0, y: 0, w: 8 }, { id: 'list-ab12', x: 8, y: 0, w: 6 }];
  s.call('layout', 'save', { page: 'today', items });
  s.call('layout', 'save', { page: 'project', items: [{ id: 'kanban', x: 0, y: 3, w: 12 }] });
  let saved = json(s.run('bootstrap()')).data.layout;
  assert.deepStrictEqual(saved.today, { focus: { x: 0, y: 0, w: 8 }, 'list-ab12': { x: 8, y: 0, w: 4 } }, 'width is cut to fit the grid');
  assert.deepStrictEqual(Object.keys(saved), ['today', 'project']);
  assert.deepStrictEqual(json(s.run("bootstrap('work')")).data.layout, {}, 'work mode has its own layouts');
  assert.throws(() => s.call('layout', 'save', { page: 'Today!', items }), /Unknown page/);
  assert.throws(() => s.call('layout', 'save', { page: 'today', items: [{ id: 'x', x: 0, y: 0, w: 13 }] }), /Bad panel position/);
  assert.throws(() => s.call('layout', 'save', { page: 'today', items: [{ id: '<b>', x: 0, y: 0, w: 2 }] }), /Bad panel id/);
  const r = s.call('layout', 'reset', { page: 'today' });
  assert.deepStrictEqual(Object.keys(r.slices.layout), ['project']);
});

test('a saved Today layout with the old "Small tasks" panel puts Habits in its place and To-dos just below', () => {
  const s = fresh();
  s.call('layout', 'save', { page: 'today', items: [{ id: 'focus', x: 0, y: 0, w: 7 }, { id: 'smalltasks', x: 7, y: 0, w: 5 }, { id: 'rotation', x: 0, y: 30, w: 7 }] });
  let today = json(s.run('bootstrap()')).data.layout.today;
  assert.deepStrictEqual(today, { focus: { x: 0, y: 0, w: 7 }, rotation: { x: 0, y: 30, w: 7 }, habits: { x: 7, y: 0, w: 5 }, todos: { x: 7, y: 1, w: 5 } });
  s.call('layout', 'save', { page: 'today', items: [{ id: 'smalltasks', x: 0, y: 10000, w: 12, hidden: true }] });
  today = s.call('layout', 'setHidden', { page: 'today', id: 'todos', hidden: false }).slices.layout.today;
  assert.deepStrictEqual(today, { habits: { x: 0, y: 10000, w: 12, hidden: true }, todos: { x: 0, y: 10000, w: 12 } }, 'hidden stays hidden; a panel shown again keeps its place');
});

test('a pending import runs once, in its own mode, when that mode is first opened', () => {
  const s = fresh();
  s.run(`function pendingImportData_() { return {
    id: 'sample-1', mode: 'work',
    projects: [{ name: 'Tickets', category: 'delivery', next_action: 'Fix it', columns: ['in-progress', 'Waiting', 'Done'],
      cards: [{ column: 'Waiting', title: 'Token', color: '4', note: 'See https://x.io/a?b=1&c=2\\n<script>x</script>' },
              { column: 'nope', title: 'Lands in the first column' }] }],
    lists: [{ name: 'Keep in mind', showToday: true, groups: ['Items'], items: [{ group: 'Items', title: 'Tell a story' }] }]
  }; }`);
  assert.strictEqual(json(s.run('bootstrap()')).data.projects.length, 0, 'the personal mode is not touched');
  const w = json(s.run("bootstrap('work')")).data;
  assert.deepStrictEqual(w.projects.map((p) => [p.name, p.category, p.next_action]), [['Tickets', 'delivery', 'Fix it']]);
  const cols = w.kanban.columns.filter((c) => c.project_id === w.projects[0].id).map((c) => c.name);
  assert.deepStrictEqual(cols, ['in-progress', 'Waiting', 'Done']);
  const token = w.kanban.tasks.find((t) => t.title === 'Token');
  assert.strictEqual(w.kanban.columns.find((c) => c.id === token.column_id).name, 'Waiting');
  assert.strictEqual(token.color, '4');
  assert.strictEqual(token.note, 'See https://x.io/a?b=1&c=2\n<script>x</script>', 'the note is text, not markup');
  assert.ok(!token.note_html.includes('<script'), 'imported notes are escaped');
  assert.strictEqual(w.kanban.columns.find((c) => c.id === w.kanban.tasks.find((t) => t.title === 'Lands in the first column').column_id).name, 'in-progress');
  assert.deepStrictEqual(w.lists.map((l) => [l.name, l.show_today]), [['Keep in mind', 'yes']]);
  json(s.run("bootstrap('work')"));
  assert.strictEqual(json(s.run("bootstrap('work')")).data.projects.length, 1, 'never imported twice');
  assert.ok(s.script._m['IMPORT_DONE.sample-1']);
});

test('a project can have several named whiteboards, each its own .excalidraw file in the mode folder', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'MIDI app', category: 'coding' }).result;
  assert.throws(() => s.call('whiteboard', 'create', { projectId: p.id, name: ' ' }), /needs a name/);
  const a = s.call('whiteboard', 'create', { id: 'dddd0001', projectId: p.id, name: 'Touch pad layout' }).result;
  const b = s.call('whiteboard', 'create', { projectId: p.id, name: 'Signal flow' }).result;
  const file = (id) => s.drive.getFileById(json(s.run('bootstrap()')).data.whiteboard.length && rowsOf(s.ss.sheets.Whiteboards).find((r) => r.id === id).file_id);
  assert.strictEqual(s.drive.pathOf(file(a.id)), 'Focus Tracker/Personal/Whiteboards/midi-app-touch-pad-layout-dddd0001.excalidraw');
  assert.deepStrictEqual(JSON.parse(s.call('whiteboard', 'get', { id: a.id }).result.json).elements, [], 'starts empty and white');
  const scene = (n) => JSON.stringify({ type: 'excalidraw', version: 2, elements: Array.from({ length: n }, (_, i) => ({ id: 'e' + i, type: 'rectangle' })), appState: {}, files: {} });
  assert.throws(() => s.call('whiteboard', 'save', { id: a.id, json: '{not json' }), /could not be read/);
  assert.throws(() => s.call('whiteboard', 'save', { id: a.id, json: '{"type":"other"}' }), /not an Excalidraw drawing/);
  s.call('whiteboard', 'save', { id: a.id, json: scene(3) });
  s.call('whiteboard', 'save', { id: b.id, json: scene(1) });
  assert.strictEqual(JSON.parse(s.call('whiteboard', 'get', { id: a.id }).result.json).elements.length, 3);
  assert.strictEqual(JSON.parse(s.call('whiteboard', 'get', { id: b.id }).result.json).elements.length, 1, 'boards are separate');
  const renamed = s.call('whiteboard', 'rename', { id: b.id, name: 'Audio path' });
  assert.strictEqual(renamed.result.name, 'Audio path');
  assert.ok(file(b.id).name.startsWith('midi-app-audio-path-'), 'the Drive file is renamed');
  assert.deepStrictEqual(renamed.slices.whiteboard.map((w) => w.name), ['Touch pad layout', 'Audio path']);
  s.call('whiteboard', 'remove', { id: b.id });
  assert.strictEqual(json(s.run('undo')()).undone, 'whiteboard.remove');
  assert.strictEqual(json(s.run('bootstrap()')).data.whiteboard.length, 2, 'undo brings the link back');
  // A row from before names existed still opens, as "Whiteboard"
  s.ss.sheets.Whiteboards.rows.push(rowFrom(s.ss.sheets.Whiteboards, { id: 'old00001', project_id: p.id, file_id: file(a.id).id, file: 'https://x', updated: '2026-10-01T00:00:00Z' }));
  assert.strictEqual(json(s.run('bootstrap()')).data.whiteboard.find((w) => w.id === 'old00001').name, 'Whiteboard');
  assert.ok(s.call('whiteboard', 'get', { id: 'old00001' }).result.json);
  const fileIds = rowsOf(s.ss.sheets.Whiteboards).map((r) => r.file_id);
  s.call('projects', 'remove', { id: p.id });
  assert.strictEqual(json(s.run('bootstrap()')).data.whiteboard.length, 0, 'the links go with the project');
  assert.ok(fileIds.every((id) => s.drive.files[id]), 'the drawing files stay in Drive');
});

test('a whiteboard needs no project, can be shown on Today, and keeps a small preview in the Thumbs tab', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'MIDI app', category: 'coding' }).result;
  const solo = s.call('whiteboard', 'create', { id: 'eeee0001', name: 'Garden ideas' }).result;
  assert.strictEqual(solo.project_id, '');
  assert.strictEqual(solo.project, '');
  const fileOf = (id) => s.drive.getFileById(rowsOf(s.ss.sheets.Whiteboards).find((r) => r.id === id).file_id);
  assert.strictEqual(s.drive.pathOf(fileOf(solo.id)), 'Focus Tracker/Personal/Whiteboards/garden-ideas-eeee0001.excalidraw', 'no project in the file name');
  s.call('whiteboard', 'rename', { id: solo.id, name: 'Garden plan' });
  assert.strictEqual(fileOf(solo.id).name, 'garden-plan-eeee0001.excalidraw');
  assert.throws(() => s.call('whiteboard', 'create', { projectId: 'nope', name: 'X' }), /Project not found/);
  const onProject = s.call('whiteboard', 'create', { projectId: p.id, name: 'Signal flow' }).result;
  assert.strictEqual(onProject.project, 'MIDI app', 'the readable project name is filled in');

  // Shown on Today
  const today = s.call('whiteboard', 'setShowToday', { id: solo.id, on: true });
  assert.strictEqual(today.result.show_today, 'yes');
  assert.strictEqual(today.slices.whiteboard.find((w) => w.id === solo.id).show_today, 'yes');
  assert.strictEqual(json(s.run('undo')()).undone, 'whiteboard.setShowToday', 'showing on Today can be undone');
  assert.strictEqual(json(s.run('bootstrap()')).data.whiteboard.find((w) => w.id === solo.id).show_today, '');
  s.call('whiteboard', 'setShowToday', { id: solo.id, on: true });

  // Previews: a WebP or JPEG data URL under 45,000 characters, checked before the drawing is written
  const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'e1', type: 'rectangle' }], appState: {}, files: {} });
  const thumb = 'data:image/webp;base64,' + 'A'.repeat(2000);
  const saved = s.call('whiteboard', 'save', { id: solo.id, json: scene, thumb }).result;
  assert.deepStrictEqual(rowsOf(s.ss.sheets.Thumbs), [{ id: solo.id, image: thumb, updated: saved.updated }], 'one row per board, keyed by its id');
  assert.ok(!JSON.stringify(json(s.run('bootstrap()')).data.whiteboard).includes('base64'), 'previews are not in the first load');
  assert.deepStrictEqual(s.call('whiteboard', 'thumbs', { ids: [solo.id, onProject.id] }).result, [{ id: solo.id, image: thumb, updated: saved.updated }], 'only boards with a preview');
  const empty = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} });
  const tooBig = 'data:image/webp;base64,' + 'A'.repeat(45000);
  assert.throws(() => s.call('whiteboard', 'save', { id: solo.id, json: empty, thumb: tooBig }), /too large/);
  assert.throws(() => s.call('whiteboard', 'save', { id: solo.id, json: empty, thumb: 'javascript:alert(1)' }), /not an image/);
  assert.throws(() => s.call('whiteboard', 'save', { id: solo.id, json: empty, thumb: 'data:text/html;base64,PHNjcmlwdD4=' }), /not an image/);
  assert.throws(() => s.call('whiteboard', 'save', { id: solo.id, json: empty, thumb: 'data:image/webp;base64,AA"><script>' }), /not an image/);
  assert.throws(() => s.call('whiteboard', 'save', { id: solo.id, json: empty, thumb: 'data:image/svg+xml;base64,AAAA' }), /not an image/, 'no SVG: it can hold script');
  assert.strictEqual(JSON.parse(s.call('whiteboard', 'get', { id: solo.id }).result.json).elements.length, 1, 'a refused preview leaves the drawing as it was');
  const jpeg = 'data:image/jpeg;base64,/9j/' + 'B'.repeat(100) + '==';
  s.call('whiteboard', 'save', { id: solo.id, json: scene, thumb: jpeg });
  assert.strictEqual(rowsOf(s.ss.sheets.Thumbs).length, 1, 'a new preview replaces the old one');
  assert.strictEqual(rowsOf(s.ss.sheets.Thumbs)[0].image, jpeg);
  s.call('whiteboard', 'save', { id: solo.id, json: JSON.stringify(JSON.parse(scene)) + ' ' });
  assert.strictEqual(rowsOf(s.ss.sheets.Thumbs)[0].image, jpeg, 'a save without a preview keeps the old one');
  s.call('whiteboard', 'save', { id: solo.id, json: empty, thumb: '' });
  assert.deepStrictEqual(rowsOf(s.ss.sheets.Thumbs), [], 'an empty board has no preview');
  s.call('whiteboard', 'save', { id: onProject.id, json: scene, thumb });
  s.call('whiteboard', 'remove', { id: onProject.id });
  assert.deepStrictEqual(rowsOf(s.ss.sheets.Thumbs), [], 'removing a board removes its preview');
  json(s.run('undo')());
  assert.strictEqual(rowsOf(s.ss.sheets.Thumbs).length, 1, 'undo brings the board and its preview back');
  s.call('projects', 'remove', { id: p.id });
  const left = json(s.run('bootstrap()')).data.whiteboard;
  assert.deepStrictEqual(left.map((w) => w.id), [solo.id], 'a board without a project stays when a project is deleted');
  assert.deepStrictEqual(rowsOf(s.ss.sheets.Thumbs), [], 'the project\'s boards take their previews with them');
  assert.ok(s.ss.sheets.Thumbs, 'the Thumbs tab exists');
});

test('a list can be linked to a project, unlinked, and survives the project being deleted', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'House move', category: 'house' }).result;
  const l = s.call('lists', 'create', { name: 'Boxes' }).result;
  assert.throws(() => s.call('lists', 'setProject', { id: l.id, projectId: 'nope' }), /Project not found/);
  const linked = s.call('lists', 'setProject', { id: l.id, projectId: p.id });
  assert.deepStrictEqual([linked.result.project_id, linked.result.project], [p.id, 'House move'], 'the readable name is filled in');
  assert.strictEqual(linked.slices.lists[0].project_id, p.id);
  s.call('projects', 'update', { id: p.id, name: 'House move 2027' });
  assert.strictEqual(rowsOf(s.ss.sheets.Lists)[0].project, 'House move 2027', 'a rename is kept in step');
  const unlinked = s.call('lists', 'setProject', { id: l.id, projectId: '' }).result;
  assert.deepStrictEqual([unlinked.project_id, unlinked.project], ['', '']);
  s.call('lists', 'setProject', { id: l.id, projectId: p.id });
  const item = s.call('kanban', 'addTask', { projectId: l.id, columnId: json(s.run('bootstrap()')).data.kanban.columns.find((c) => c.list_id === l.id).id, title: 'Kitchen' }).result;
  const after = s.call('projects', 'remove', { id: p.id }).slices;
  assert.deepStrictEqual(after.lists.map((x) => [x.name, x.project_id]), [['Boxes', '']], 'the list stays, unlinked');
  assert.ok(after.kanban.tasks.some((t) => t.id === item.id), 'with its items');
  assert.strictEqual(rowsOf(s.ss.sheets.Lists)[0].project, '');
  json(s.run('undo')());
  assert.strictEqual(json(s.run('bootstrap()')).data.lists[0].project_id, p.id, 'undoing the delete links it again');
});

test('undo puts back the newest change: a deleted project with its board, an edit, an add', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house', next_action: 'Measure' }).result;
  const cols = json(s.run('bootstrap()')).data.kanban.columns.filter((c) => c.project_id === p.id);
  const add = s.call('kanban', 'addTask', { projectId: p.id, columnId: cols[1].id, title: 'Order fan' });
  assert.deepStrictEqual(add.undo.action, 'kanban.addTask');
  s.call('kanban', 'updateTask', { id: add.result.id, title: 'Order the 100mm fan', color: '4', noteHtml: '<b>Screwfix</b>' });
  s.call('projects', 'update', { id: p.id, next_action: 'Buy screws' });
  s.call('projects', 'remove', { id: p.id });
  let data = json(s.run('bootstrap()')).data;
  assert.strictEqual(data.projects.length, 0);
  assert.strictEqual(data.kanban.tasks.length, 0);

  const undo = () => json(s.run('undo')());
  let r = undo();
  assert.strictEqual(r.undone, 'projects.remove');
  assert.deepStrictEqual(r.data.projects.map((x) => [x.id, x.next_action]), [[p.id, 'Buy screws']], 'same id, last value');
  const back = r.data.kanban.tasks.find((t) => t.id === add.result.id);
  assert.deepStrictEqual([back.title, back.color, back.column_id], ['Order the 100mm fan', '4', cols[1].id], 'the board comes back as it was');
  assert.strictEqual(r.data.kanban.columns.filter((c) => c.project_id === p.id).length, 3);
  assert.strictEqual(undo().undone, 'projects.update');
  assert.strictEqual(json(s.run('bootstrap()')).data.projects[0].next_action, 'Measure');
  r = undo();
  assert.strictEqual(r.undone, 'kanban.updateTask');
  assert.deepStrictEqual([r.data.kanban.tasks[0].title, r.data.kanban.tasks[0].color, r.data.kanban.tasks[0].note_html], ['Order fan', '', '']);
  assert.strictEqual(undo().undone, 'kanban.addTask');
  assert.strictEqual(undo().undone, 'projects.create');
  assert.strictEqual(undo().undone, null, 'nothing left');
  assert.strictEqual(json(s.run('bootstrap()')).data.projects.length, 0);
});

test('undo is per mode, skips calls that change nothing, and keeps a bounded history', () => {
  const s = fresh();
  s.call('projects', 'create', { name: 'Home', category: 'house' });
  json(s.run('rpc')('projects', 'create', { name: 'Ticket', category: 'delivery' }, 'work'));
  assert.strictEqual(s.call('projects', 'list').undo, null, 'reads are not undoable');
  assert.strictEqual(json(s.run("undo('work')")).undone, 'projects.create');
  assert.deepStrictEqual(json(s.run('bootstrap()')).data.projects.map((p) => p.name), ['Home'], 'personal untouched');
  for (let i = 0; i < 45; i++) s.call('categories', 'add', { label: 'C' + i });
  assert.ok(s.ss.sheets.Undo.rows.length - 1 <= 40, 'old undo steps are dropped');
});

test('browser-made ids are used, checked and never doubled; cards move to an exact place', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'K', category: 'coding' }).result;
  const cols = json(s.run('bootstrap()')).data.kanban.columns.filter((c) => c.project_id === p.id);
  const a = s.call('kanban', 'addTask', { id: 'aaaa0001', projectId: p.id, columnId: cols[0].id, title: 'A' }).result;
  assert.strictEqual(a.id, 'aaaa0001');
  assert.throws(() => s.call('kanban', 'addTask', { id: 'aaaa0001', projectId: p.id, columnId: cols[0].id, title: 'A again' }), /already exists/);
  assert.throws(() => s.call('kanban', 'addTask', { id: '<script>', projectId: p.id, title: 'x' }), /Bad id/);
  s.call('kanban', 'addTask', { id: 'aaaa0002', projectId: p.id, columnId: cols[1].id, title: 'B' });
  s.call('kanban', 'addTask', { id: 'aaaa0003', projectId: p.id, columnId: cols[1].id, title: 'C' });
  const moved = s.call('kanban', 'moveTask', { id: 'aaaa0001', columnId: cols[1].id, order: 1.5 });
  const order = moved.slices.kanban.tasks.filter((t) => t.column_id === cols[1].id).sort((x, y) => x.order - y.order).map((t) => t.title);
  assert.deepStrictEqual(order, ['B', 'A', 'C']);
  const other = s.call('projects', 'create', { name: 'Other', category: 'coding' }).result;
  const otherCol = json(s.run('bootstrap()')).data.kanban.columns.find((c) => c.project_id === other.id);
  assert.throws(() => s.call('kanban', 'moveTask', { id: 'aaaa0001', columnId: otherCol.id }), /not on this board/);
  const col = s.call('kanban', 'addColumn', { id: 'bbbb0001', projectId: p.id, name: 'Review' }).result;
  assert.strictEqual(col.id, 'bbbb0001');
});

test('a project can be made with a new category; lists get a colour; panels can be hidden', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Shed', newCategory: 'Garden' });
  const garden = p.slices.categories.find((c) => c.label === 'Garden');
  assert.strictEqual(p.result.category, garden.id);
  const q = s.call('projects', 'update', { id: p.result.id, newCategory: 'Outdoor' });
  assert.strictEqual(q.result.category, q.slices.categories.find((c) => c.label === 'Outdoor').id);
  const l = s.call('lists', 'create', { name: 'Reading' }).result;
  assert.strictEqual(s.call('lists', 'setColor', { id: l.id, color: '5' }).result.color, '5');
  assert.throws(() => s.call('lists', 'setColor', { id: l.id, color: 'red' }), /Unknown colour/);
  s.call('layout', 'save', { page: 'today', items: [{ id: 'focus', x: 0, y: 0, w: 7 }] });
  let layout = s.call('layout', 'setHidden', { page: 'today', id: 'rotation', hidden: true }).slices.layout;
  assert.deepStrictEqual(layout.today.rotation, { x: 0, y: 10000, w: 12, hidden: true });
  s.call('layout', 'setHidden', { page: 'today', id: 'focus', hidden: true });
  layout = s.call('layout', 'setHidden', { page: 'today', id: 'focus', hidden: false }).slices.layout;
  assert.deepStrictEqual(layout.today.focus, { x: 0, y: 0, w: 7 }, 'showing keeps its old place');
  s.call('layout', 'save', { page: 'today', items: [{ id: 'focus', x: 0, y: 0, w: 7 }, { id: 'rotation', x: 0, y: 0, w: 5, hidden: true }] });
  assert.strictEqual(json(s.run('bootstrap()')).data.layout.today.rotation.hidden, true);
});

test('acceptance criteria: add, tick, edit, reorder, delete, undo, and they go with the project', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  assert.throws(() => s.call('criteria', 'add', { projectId: 'nope', text: 'x' }), /Project not found/);
  assert.throws(() => s.call('criteria', 'add', { projectId: p.id, text: ' ' }), /needs some text/);
  const a = s.call('criteria', 'add', { id: 'cccc0001', projectId: p.id, text: 'Fan is quiet' }).result;
  s.call('criteria', 'add', { projectId: p.id, text: 'Steam clears in 5 minutes' });
  assert.strictEqual(a.id, 'cccc0001');
  let list = s.call('criteria', 'update', { id: a.id, done: true }).slices.criteria;
  assert.strictEqual(list[0].done, 'yes');
  list = s.call('criteria', 'update', { id: a.id, text: 'Fan is quiet at night', order: 9 }).slices.criteria;
  assert.deepStrictEqual(list.map((c) => c.text), ['Steam clears in 5 minutes', 'Fan is quiet at night']);
  s.call('criteria', 'remove', { id: a.id });
  assert.strictEqual(json(s.run('undo')()).undone, 'criteria.remove');
  assert.strictEqual(json(s.run('bootstrap()')).data.criteria.length, 2);
  s.call('projects', 'remove', { id: p.id });
  assert.strictEqual(json(s.run('bootstrap()')).data.criteria.length, 0);
});

test('linked projects: add, refuse self, duplicate and circle, remove with undo, names kept in step', () => {
  const s = fresh();
  const a = s.call('projects', 'create', { name: 'Walls', category: 'house' }).result;
  const b = s.call('projects', 'create', { name: 'Paint', category: 'house' }).result;
  const c = s.call('projects', 'create', { name: 'Hang pictures', category: 'house' }).result;
  assert.throws(() => s.call('links', 'add', { fromId: a.id, toId: a.id, type: 'blocks' }), /itself/);
  assert.throws(() => s.call('links', 'add', { fromId: a.id, toId: 'nope', type: 'blocks' }), /Project not found/);
  assert.throws(() => s.call('links', 'add', { fromId: a.id, toId: b.id, type: 'depends' }), /blocks or relates/);
  const r = s.call('links', 'add', { id: 'aaaa0001', fromId: a.id, toId: b.id, type: 'blocks', note: ' Plaster first ' });
  assert.deepStrictEqual(Object.keys(r.slices).sort(), ['links', 'today']);
  assert.strictEqual(r.undo.action, 'links.add');
  const row = rowsOf(s.ss.sheets.Links)[0];
  assert.deepStrictEqual([row.from, row.type, row.to, row.note, row.id], ['Walls', 'blocks', 'Paint', 'Plaster first', 'aaaa0001'], 'readable "<from> blocks <to>"');
  assert.throws(() => s.call('links', 'add', { fromId: a.id, toId: b.id, type: 'relates' }), /already linked/);
  assert.throws(() => s.call('links', 'add', { fromId: b.id, toId: a.id, type: 'relates' }), /already linked/, 'either way round');
  s.call('links', 'add', { fromId: b.id, toId: c.id, type: 'blocks' });
  assert.throws(() => s.call('links', 'add', { fromId: c.id, toId: a.id, type: 'blocks' }), /circle/, 'Walls > Paint > Hang pictures > Walls');
  s.call('links', 'add', { fromId: c.id, toId: a.id, type: 'relates' }); // relating is no circle
  s.call('projects', 'update', { id: a.id, name: 'Plaster walls' });
  assert.strictEqual(rowsOf(s.ss.sheets.Links).find((l) => l.id === 'aaaa0001').from, 'Plaster walls', 'a rename shows in the Links tab');
  assert.strictEqual(rowsOf(s.ss.sheets.Links).find((l) => l.type === 'relates').to, 'Plaster walls');
  s.call('links', 'remove', { id: 'aaaa0001' });
  assert.ok(!json(s.run('bootstrap()')).data.links.some((l) => l.id === 'aaaa0001'));
  assert.strictEqual(json(s.run('undo')()).undone, 'links.remove');
  assert.ok(json(s.run('bootstrap()')).data.links.some((l) => l.id === 'aaaa0001'), 'undo brings the link back');
  assert.strictEqual(json(s.run('undo')()).undone, 'projects.update');
  assert.strictEqual(json(s.run('undo')()).undone, 'links.add');
  assert.strictEqual(json(s.run('bootstrap()')).data.links.length, 2, 'undo takes an added link away');
});

test('a project blocked by an unfinished project leaves the focus pick until the blocker is done', () => {
  const s = fresh();
  s.mock.weekday = 7;
  const a = s.call('projects', 'create', { name: 'Blocker', category: 'coding' }).result;
  const b = s.call('projects', 'create', { name: 'Waits', category: 'house' }).result;
  s.run(`new Table('Projects',['id']).update('${b.id}', { last_touched: '${new Date(Date.now() - 9 * 86400000).toISOString()}' })`);
  assert.strictEqual(s.call('today', 'state').result.focusId, b.id, 'the most neglected project leads');
  const r = s.call('links', 'add', { fromId: a.id, toId: b.id, type: 'blocks' });
  assert.ok(r.slices.today.ranked.indexOf(b.id) === -1, 'the answer brings Today up to date');
  assert.deepStrictEqual(s.call('links', 'waiting').result, { [b.id]: [a.id] });
  const state = s.call('today', 'state').result;
  assert.strictEqual(state.focusId, a.id, 'the waiting project is not picked');
  assert.ok(state.ranked.indexOf(b.id) === -1, 'and is not offered in Swap');
  assert.throws(() => s.call('today', 'swap', { toId: b.id }), /active project/);
  s.call('projects', 'update', { id: a.id, status: 'done' });
  assert.deepStrictEqual(s.call('links', 'waiting').result, {});
  assert.strictEqual(s.call('today', 'state').result.focusId, b.id, 'once the blocker is done it can be picked again');
  s.call('projects', 'update', { id: a.id, status: 'archived' });
  assert.strictEqual(s.call('today', 'state').result.focusId, b.id, 'an archived blocker holds nothing up either');
  s.call('projects', 'update', { id: a.id, status: 'paused' });
  assert.ok(s.call('today', 'state').result.ranked.indexOf(b.id) === -1, 'a paused blocker is not finished');
});

test('today works without the links module', () => {
  const s = fresh();
  s.run("MODULES = MODULES.filter(function (m) { return m !== 'links'; })");
  const p = s.call('projects', 'create', { name: 'Alone', category: 'coding' }).result;
  assert.strictEqual(s.call('today', 'state').result.focusId, p.id);
  assert.strictEqual(s.call('projects', 'remove', { id: p.id }).result, true);
});

test('deleting a project removes its links both ways, and undo brings them back', () => {
  const s = fresh();
  const a = s.call('projects', 'create', { name: 'A', category: 'coding' }).result;
  const b = s.call('projects', 'create', { name: 'B', category: 'coding' }).result;
  const c = s.call('projects', 'create', { name: 'C', category: 'coding' }).result;
  s.call('links', 'add', { fromId: a.id, toId: b.id, type: 'blocks' });
  s.call('links', 'add', { fromId: c.id, toId: a.id, type: 'relates' });
  s.call('links', 'add', { fromId: b.id, toId: c.id, type: 'relates' });
  const r = s.call('projects', 'remove', { id: a.id });
  assert.deepStrictEqual(r.slices.links.map((l) => [l.from_id, l.to_id]), [[b.id, c.id]], 'only the link without A is left');
  assert.strictEqual(json(s.run('undo')()).undone, 'projects.remove');
  assert.strictEqual(json(s.run('bootstrap()')).data.links.length, 3);
});

test('a link typed into the Links tab with names only gets its ids; a bad one is flagged', () => {
  const s = fresh();
  const a = s.call('projects', 'create', { name: 'Roof', category: 'house' }).result;
  const b = s.call('projects', 'create', { name: 'Loft', category: 'house' }).result;
  const sh = s.ss.sheets.Links;
  assert.ok(sh, 'setup made the Links tab');
  sh.rows.push(rowFrom(sh, { from: 'roof', type: 'blocks', to: 'Loft' }));
  sh.rows.push(rowFrom(sh, { from: 'Roof', type: 'blocks', to: 'Roof' }));
  sh.rows.push(rowFrom(sh, { from: 'Roof', type: 'needs', to: 'Loft' }));
  sh.rows.push(rowFrom(sh, { from: 'Shed', type: 'blocks', to: 'Loft' }));
  const links = json(s.run('bootstrap()')).data.links;
  assert.strictEqual(links.length, 1);
  assert.deepStrictEqual([links[0].from_id, links[0].to_id, links[0].from], [a.id, b.id, 'Roof']);
  assert.ok(links[0].id && links[0].created);
  const rows = rowsOf(sh);
  assert.strictEqual(rows[1].problem, 'A project cannot be linked to itself.');
  assert.strictEqual(rows[2].problem, 'Type must be blocks or relates.');
  assert.ok(/No project called "Shed"/.test(rows[3].problem), rows[3].problem);
  assert.ok(s.call('today', 'state').result.ranked.indexOf(b.id) === -1, 'the typed blocking link counts');
});

test('a list can show one item at a time on Today, every n seconds', () => {
  const s = fresh();
  const l = s.call('lists', 'create', { name: 'Life lessons' }).result;
  assert.strictEqual(l.display, '');
  const r = s.call('lists', 'setDisplay', { id: l.id, display: 'one', seconds: 45 });
  assert.deepStrictEqual([r.result.display, r.result.seconds], ['one', 45]);
  assert.throws(() => s.call('lists', 'setDisplay', { id: l.id, display: 'grid', seconds: 30 }), /Unknown display/);
  assert.throws(() => s.call('lists', 'setDisplay', { id: l.id, display: 'one', seconds: 2 }), /5 to 3600 seconds/);
  assert.throws(() => s.call('lists', 'setDisplay', { id: l.id, display: 'one', seconds: 7.5 }), /5 to 3600 seconds/);
  assert.strictEqual(s.call('lists', 'setDisplay', { id: l.id, display: '', seconds: 45 }).result.display, '');
});

test('sticky notes: add, move, resize, recolour, see-through within limits, delete with undo', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  assert.throws(() => s.call('stickies', 'add', { projectId: 'nope' }), /Project not found/);
  const a = s.call('stickies', 'add', { id: 'eeee0001', projectId: p.id, x: 62, y: 90, w: 220, h: 180 }).result;
  assert.deepStrictEqual([a.id, a.color, a.opacity, a.text], ['eeee0001', 'yellow', 1, '']);
  const u = s.call('stickies', 'update', { id: a.id, text: 'Check the fuse first', color: 'blue', opacity: 0.55, x: 12.345, y: 400, w: 300, h: 160 }).result;
  assert.deepStrictEqual([u.text, u.color, u.opacity, u.x, u.y, u.w, u.h], ['Check the fuse first', 'blue', 0.55, 12.35, 400, 300, 160]);
  assert.throws(() => s.call('stickies', 'update', { id: a.id, opacity: 0.1 }), /opacity must be from 0.4 to 1/);
  assert.throws(() => s.call('stickies', 'update', { id: a.id, color: 'black' }), /Unknown colour/);
  assert.strictEqual(s.call('stickies', 'update', { id: a.id, color: 'lavender' }).result.color, 'lavender', 'the new colours are accepted');
  s.call('stickies', 'update', { id: a.id, color: 'blue' });
  assert.throws(() => s.call('stickies', 'update', { id: a.id, x: 140 }), /x must be from 0 to 100/);
  assert.throws(() => s.call('stickies', 'update', { id: a.id, w: 20 }), /w must be from 120 to 900/);
  assert.strictEqual(s.call('stickies', 'update', { id: a.id, text: 'x'.repeat(2500) }).result.text.length, 2000);
  s.call('stickies', 'remove', { id: a.id });
  assert.strictEqual(json(s.run('undo')()).undone, 'stickies.remove');
  assert.strictEqual(json(s.run('bootstrap()')).data.stickies[0].color, 'blue');
  s.call('projects', 'remove', { id: p.id });
  assert.strictEqual(json(s.run('bootstrap()')).data.stickies.length, 0, 'notes go with the project');
});

test('rpc rejects unknown modules and functions, and bootstrap returns every slice', () => {
  const s = fresh();
  assert.throws(() => s.call('nope', 'x'), /not installed/);
  assert.throws(() => s.call('projects', 'nope'), /no api function/);
  const b = json(s.run('bootstrap()'));
  assert.deepStrictEqual(Object.keys(b.data).sort(), ['categories', 'criteria', 'habits', 'kanban', 'layout', 'links', 'lists', 'log', 'notes', 'projects', 'resources', 'stickies', 'today', 'todos', 'whiteboard']);
  assert.strictEqual(b.modules.length, 16); // insights has no slice: it loads when its tab opens
});

test('a module can be removed by deleting its line in MODULES', () => {
  const s = fresh();
  s.run("MODULES = MODULES.filter(function (m) { return m !== 'resources'; })");
  const p = s.call('projects', 'create', { name: 'Still works', category: 'coding' });
  assert.ok(p.result.id);
  assert.strictEqual(json(s.run('bootstrap()')).data.resources, undefined);
  assert.strictEqual(s.call('projects', 'remove', { id: p.result.id }).result, true);
});

test('seed fills an empty tracker once and refuses to run twice', () => {
  const s = fresh();
  s.run('seedStarterData()');
  const b = json(s.run('bootstrap()'));
  assert.strictEqual(b.data.projects.length, 7);
  assert.ok(b.data.kanban.tasks.length >= 15);
  assert.ok(b.data.notes.length >= 5);
  assert.throws(() => s.run('seedStarterData()'), /already has projects/);
});

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

test('rows stamp updated_at on insert and update, and a sheet from before the column gets it added', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'A', category: 'coding' }).result;
  assert.ok(p.updated_at && !isNaN(Date.parse(p.updated_at)));
  s.run(`new Table('Projects',['id']).update('${p.id}', { updated_at: '2001-01-01T00:00:00.000Z' })`);
  const changed = s.call('projects', 'update', { id: p.id, next_action: 'Do it' }).result;
  assert.ok(changed.updated_at > '2001-01-01', 'an update stamps the row again');
  // A sheet made before the column existed: the header is added on the next read, rows start blank
  const sheet = s.ss.sheets.Projects;
  const col = sheet.rows[0].indexOf('updated_at');
  sheet.rows.forEach((r) => r.splice(col, 1));
  assert.strictEqual(s.call('projects', 'list').result[0].updated_at, '');
  assert.ok(s.ss.sheets.Projects.rows[0].indexOf('updated_at') !== -1);
  const kcol = s.run('bootstrap()').data.kanban.columns.find((c) => c.project_id === p.id);
  const task = s.call('kanban', 'addTask', { projectId: p.id, columnId: kcol.id, title: 'T' }).result;
  assert.ok(task.updated_at, 'tasks are stamped too');
  assert.strictEqual(s.run('ping()'), 'pong');
});

test('an edit made offline that finds the row changed since keeps the newest version and logs the older one', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Garden', category: 'house', next_action: 'Buy seeds' }).result;
  const seen = p.updated_at;
  // Nothing changed since the browser looked: applied quietly, with the new version sent back
  const quiet = s.call('projects', 'update', { id: p.id, next_action: 'Buy soil', _base: seen, _editedAt: iso(0) });
  assert.strictEqual(quiet.result.next_action, 'Buy soil');
  assert.strictEqual(quiet.conflicts, undefined);
  assert.strictEqual(quiet.version, quiet.result.updated_at);
  const logCount = () => s.run('bootstrap()').data.log.length;
  assert.strictEqual(logCount(), 0);
  // Another device changed it since (the browser still holds the old version): the stored change is newer, so it stays
  s.run(`new Table('Projects',['id']).update('${p.id}', { next_action: 'Other device', updated_at: '${iso(60000)}' })`);
  const lost = s.call('projects', 'update', { id: p.id, next_action: 'Mine, offline', _base: quiet.version, _editedAt: iso(0) });
  assert.deepStrictEqual(lost.conflicts, [{ what: 'project "Garden"', kept: 'server' }]);
  assert.strictEqual(s.call('projects', 'list').result[0].next_action, 'Other device');
  let line = s.run('bootstrap()').data.log[0];
  assert.strictEqual(line.project_id, p.id);
  assert.ok(/newer version was kept/.test(line.where_stopped) && /Mine, offline/.test(line.where_stopped), line.where_stopped);
  // The offline edit is the newer one: it replaces the stored row, and the replaced version is logged
  const base = s.call('projects', 'list').result[0].updated_at;
  s.run(`new Table('Projects',['id']).update('${p.id}', { next_action: 'Older elsewhere', updated_at: '${iso(-60000)}' })`);
  const won = s.call('projects', 'update', { id: p.id, next_action: 'Mine, later', _base: base, _editedAt: iso(0) });
  assert.deepStrictEqual(won.conflicts, [{ what: 'project "Garden"', kept: 'yours' }]);
  assert.strictEqual(won.result.next_action, 'Mine, later');
  line = s.run('bootstrap()').data.log[0];
  assert.ok(/replaced it/.test(line.where_stopped) && /Older elsewhere/.test(line.where_stopped), line.where_stopped);
});

test('offline conflicts on cards and criteria are settled the same way, and a skipped edit is not undoable', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Loft', category: 'house' }).result;
  const col = s.run('bootstrap()').data.kanban.columns.find((c) => c.project_id === p.id);
  const task = s.call('kanban', 'addTask', { projectId: p.id, columnId: col.id, title: 'Quotes' }).result;
  s.run(`new Table('Tasks',['id']).update('${task.id}', { title: 'Renamed elsewhere', updated_at: '${iso(60000)}' })`);
  const r = s.call('kanban', 'updateTask', { id: task.id, title: 'Mine', _base: task.updated_at, _editedAt: iso(0) });
  assert.strictEqual(r.conflicts[0].kept, 'server');
  assert.strictEqual(r.undo, false);
  assert.strictEqual(s.run('bootstrap()').data.kanban.tasks.find((t) => t.id === task.id).title, 'Renamed elsewhere');
  const crit = s.call('criteria', 'add', { projectId: p.id, text: 'Done when it is tidy' }).result;
  s.run(`new Table('Criteria',['id']).update('${crit.id}', { done: 'yes', updated_at: '${iso(-90000)}' })`);
  const c = s.call('criteria', 'update', { id: crit.id, done: false, _base: crit.updated_at, _editedAt: iso(0) });
  assert.strictEqual(c.conflicts[0].kept, 'yours');
  assert.strictEqual(s.run('bootstrap()').data.criteria.find((x) => x.id === crit.id).done, '');
  assert.strictEqual(s.run('bootstrap()').data.log.length, 2, 'one log line per conflict');
});

test('project notes saved after waiting offline: the older text is kept as a conflict copy', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Loft', category: 'house' }).result;
  const first = s.call('notes', 'save', { projectId: p.id, text: 'one' });
  assert.ok(first.result.updated && first.version === first.result.updated, 'save returns the version it wrote');
  const mdFiles = () => Object.values(s.drive.files).filter((f) => f.name.endsWith('.md'));
  // No change elsewhere: saved quietly
  const second = s.call('notes', 'save', { projectId: p.id, text: 'two', _base: first.version, _editedAt: iso(0) });
  assert.strictEqual(second.conflicts, undefined);
  assert.strictEqual(mdFiles().length, 1);
  // Changed elsewhere after the browser looked, and that change is newer: stored text stays, offline text is copied
  s.run(`new Table('Notes',['id']).update(new Table('Notes',['id']).all()[0].id, { updated: '${iso(60000)}' })`);
  const lost = s.call('notes', 'save', { projectId: p.id, text: 'mine offline', _base: first.version, _editedAt: iso(0) });
  assert.strictEqual(lost.conflicts[0].kept, 'server');
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, 'two');
  const copy = mdFiles().find((f) => /conflict/.test(f.name));
  assert.strictEqual(copy.content, 'mine offline');
  // The offline text is newer: it replaces the file and the replaced text is copied
  const now = s.call('notes', 'get', { projectId: p.id });
  s.run(`new Table('Notes',['id']).update(new Table('Notes',['id']).all()[0].id, { updated: '${iso(-60000)}' })`);
  const won = s.call('notes', 'save', { projectId: p.id, text: 'mine, later', _base: first.version, _editedAt: iso(0) });
  assert.strictEqual(won.conflicts[0].kept, 'yours');
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, 'mine, later');
  assert.ok(mdFiles().some((f) => /conflict/.test(f.name) && f.content === 'two'));
  assert.ok(s.run('bootstrap()').data.log.some((l) => /Notes folder/.test(l.where_stopped)));
});

// ---------- Insights ----------
// Thursday 29 Oct 2026; its week runs Monday 26 Oct to Sunday 1 Nov.
function insightsServer() {
  const s = fresh();
  s.run('insightsToday_ = function () { return "2026-10-29"; }');
  return s;
}
/** Make a tab in the fake sheet and write rows into it directly, as a person or another module would. */
function writeTab(s, name, headers, rows) {
  const sh = s.ss.sheets[name] || s.ss.insertSheet(name);
  if (!sh.rows.length) sh.rows.push(headers.slice());
  rows.forEach((r) => sh.rows.push(rowFrom(sh, r)));
  return sh;
}
const HABIT_HEADERS = ['name', 'intention', 'sessions', 'per', 'size', 'small_version', 'goal', 'step_up_every', 'prompts', 'category', 'description', 'status', 'problem', 'id', 'next_prompt', 'started', 'order', 'updated_at'];
const HABIT_LOG_HEADERS = ['id', 'habit_id', 'habit', 'day', 'kind', 'count', 'value', 'updated_at'];
let hlogN = 0;
const hlog = (habit, day, kind, count, value) => ({ id: 'hl' + String(++hlogN).padStart(6, '0'), habit_id: habit, day, kind, count: count === undefined ? '' : String(count), value: value || '' });

test('insights: weeks run Monday to Sunday, and levels are read as people write them', () => {
  const s = insightsServer();
  assert.strictEqual(s.run('insightsMonday_("2026-11-01")'), '2026-10-26', 'Sunday belongs to the week before it');
  assert.strictEqual(s.run('insightsMonday_("2026-10-26")'), '2026-10-26');
  assert.strictEqual(s.run('insightsMonday_("2026-10-25")'), '2026-10-19');
  assert.strictEqual(s.run('insightsMonday_("2027-01-01")'), '2026-12-28', 'across a new year');
  assert.strictEqual(s.run('insightsMonday_("2026-03-30")'), '2026-03-30', 'the clocks changing does not move a day');
  assert.deepStrictEqual(json(s.run('insightsParseLevel_("4 a week, 30 min", "week")')), { sessions: 4, per: 'week', size: '30 min' });
  assert.deepStrictEqual(json(s.run('insightsParseLevel_("1 per day", "week")')), { sessions: 1, per: 'day', size: '' });
  assert.deepStrictEqual(json(s.run('insightsParseLevel_("3", "day")')), { sessions: 3, per: 'day', size: '' });
  assert.strictEqual(s.run('insightsParseLevel_("lots", "day")'), null);
});

test('insights: focus sessions and minutes per week and per project, split on Monday', () => {
  const s = insightsServer();
  const a = s.call('projects', 'create', { name: 'Focus Tracker', category: 'coding' }).result;
  const b = s.call('projects', 'create', { name: 'Garden app', category: 'coding' }).result;
  const log = s.ss.sheets.Log;
  [
    { id: 'l0000001', project_id: a.id, date: '2026-10-25T23:30:00.000Z', where_stopped: 'Sunday night', minutes: '40' },
    { id: 'l0000002', project_id: a.id, date: '2026-10-26T00:10:00.000Z', where_stopped: 'Monday, just after midnight', minutes: '55' },
    { id: 'l0000003', project_id: a.id, date: '2026-10-28T10:00:00.000Z', where_stopped: 'Wednesday', minutes: '40' },
    { id: 'l0000004', project_id: b.id, date: '2026-09-01T10:00:00.000Z', where_stopped: 'Long ago', minutes: '30' },
    { id: 'l0000005', project_id: '', date: '2026-10-27T10:00:00.000Z', where_stopped: 'Sync conflict', minutes: '0' }
  ].forEach((r) => log.rows.push(rowFrom(log, r)));
  writeTab(s, 'Skips', ['id', 'project_id', 'to_project_id', 'date'], [
    { id: 'k0000001', project_id: b.id, to_project_id: a.id, date: '2026-10-20T09:00:00.000Z' },
    { id: 'k0000002', project_id: b.id, to_project_id: '', date: '2026-08-01T09:00:00.000Z' }
  ]);
  const r = s.call('insights', 'summary').result;
  assert.strictEqual(r.today, '2026-10-29');
  assert.deepStrictEqual([r.weeks.this.start, r.weeks.this.end, r.weeks.last.start], ['2026-10-26', '2026-11-01', '2026-10-19']);
  assert.deepStrictEqual([r.weeks.this.focus.sessions, r.weeks.this.focus.minutes], [2, 95], 'Monday 00:10 is this week; the conflict line is not a session');
  assert.deepStrictEqual(r.weeks.this.focus.days.map((d) => d.day), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'], 'days so far');
  assert.deepStrictEqual(r.weeks.this.focus.days[2], { day: '2026-10-28', weekday: 3, lead: 'Job search', away: false, focus: ['Focus Tracker'], sessions: 1, minutes: 40 });
  assert.strictEqual(r.weeks.last.focus.days.length, 7, 'last week shows every day');
  assert.deepStrictEqual([r.weeks.last.focus.sessions, r.weeks.last.focus.days[6].minutes], [1, 40], 'Sunday 23:30 is last week');
  const four = r.projects[4], twelve = r.projects[12];
  assert.strictEqual(four.from, '2026-10-05');
  assert.deepStrictEqual(four.rows.map((x) => [x.name, x.sessions, x.minutes, x.skips]), [['Focus Tracker', 3, 135, 0], ['Garden app', 0, 0, 1]], 'most time first; old skips left out');
  assert.deepStrictEqual(twelve.rows.find((x) => x.name === 'Garden app').minutes, 30, 'a session 8 weeks ago counts in 12 weeks');
  assert.deepStrictEqual(r.weeks.this.todos, { done: 0, onDay: 0, toCome: 0, anytime: 0, open: 0 }, 'no to-dos yet');
  assert.deepStrictEqual(r.habits, [], 'no habits yet');
  assert.strictEqual(r.weeks.this.habits.length, 0);
});

test('insights: each habit week is compared with the target that applied then, from the Habit log', () => {
  const s = insightsServer();
  const usual = { 1: 'coding', 2: 'coding', 3: 'job', 4: 'coding', 5: 'house', 6: 'house', 7: 'away' };
  s.call('today', 'saveRotation', { usual, week: {}, dailyMinimum: '' });
  writeTab(s, 'Habits', HABIT_HEADERS, [
    { id: 'h0000001', name: 'Job hunting', sessions: '5', per: 'week', size: '30 min', status: 'active', started: '2026-08-31', order: '1', prompts: 'on' },
    { id: 'h0000002', name: 'Fitness', sessions: '1', per: 'day', size: '10 min', status: 'active', started: '2026-10-12', order: '2', prompts: 'at goal' },
    { id: 'h0000003', name: 'Old one', sessions: '2', per: 'week', status: 'ended', started: '2026-01-05', order: '3' }
  ]);
  writeTab(s, 'Habit log', HABIT_LOG_HEADERS, [
    hlog('h0000001', '2026-08-31', 'level', '', '3 a week, 30 min'),
    hlog('h0000001', '2026-09-21', 'level', '', '4 a week, 30 min'),
    hlog('h0000001', '2026-10-19', 'level', '', '5 a week, 30 min'),
    hlog('h0000001', '2026-09-15', 'done', 2), hlog('h0000001', '2026-09-17', 'done', 1),   // week of 14 Sep: 3 of 3
    hlog('h0000001', '2026-09-22', 'done', 3),                                               // week of 21 Sep: 3 of 4
    hlog('h0000001', '2026-10-13', 'done', 5),                                               // week of 12 Oct: 5 of 4, one extra
    hlog('h0000001', '2026-10-20', 'done', 3), hlog('h0000001', '2026-10-25', 'done', 1),    // week of 19 Oct, Sunday included: 4 of 5
    hlog('h0000001', '2026-10-26', 'done', 2), hlog('h0000001', '2026-10-31', 'plan', 2),    // this week: 2 so far, 2 planned for Saturday
    hlog('h0000001', '2026-10-24', 'prompt', '', 'not now'),
    hlog('h0000002', '2026-10-14', 'pause'), hlog('h0000002', '2026-10-16', 'resume'),
    ...['2026-10-12', '2026-10-13', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-26', '2026-10-29'].map((d) => hlog('h0000002', d, 'done', 1))
  ]);
  const r = s.call('insights', 'summary').result;
  assert.deepStrictEqual(r.habits.map((h) => h.name), ['Job hunting', 'Fitness'], 'an ended habit with nothing done is left out');
  const job = r.habits[0], fit = r.habits[1];
  assert.strictEqual(job.weeks.length, 12);
  const week = (h, start) => h.weeks.find((w) => w.start === start);
  assert.ok(week(job, '2026-08-24').before, 'weeks before it started are marked');
  assert.deepStrictEqual([week(job, '2026-09-14').done, week(job, '2026-09-14').target, week(job, '2026-09-14').onTarget], [3, 3, true]);
  assert.deepStrictEqual([week(job, '2026-09-21').done, week(job, '2026-09-21').target, week(job, '2026-09-21').onTarget], [3, 4, false], 'the step-up applies from its Monday');
  assert.deepStrictEqual([week(job, '2026-10-12').target, week(job, '2026-10-12').extra], [4, 1], 'over target');
  assert.deepStrictEqual([week(job, '2026-10-19').done, week(job, '2026-10-19').target], [4, 5], 'Sunday counts in the week it ends');
  const now = week(job, '2026-10-26');
  assert.deepStrictEqual([now.done, now.target, now.current, now.full, now.planLater], [2, 5, true, false, 2]);
  assert.deepStrictEqual(job.ranges[8], { n: 2, of: 7, unit: 'weeks' }, 'on target 2 of 7 full weeks; this week is not over');
  assert.deepStrictEqual(job.ranges[12], { n: 2, of: 8, unit: 'weeks' }, 'weeks before it started are not counted');
  assert.deepStrictEqual(job.changes, [
    { day: '2026-09-21', from: '3 a week, 30 min', to: '4 a week, 30 min' },
    { day: '2026-10-19', from: '4 a week, 30 min', to: '5 a week, 30 min' }
  ]);
  assert.deepStrictEqual(job.lastPrompt, { day: '2026-10-24', value: 'not now' });
  assert.ok(['Starting', 'Building', 'Steady', 'Strong'].includes(job.strength));
  assert.ok(job.trend === null || ['up', 'level', 'down'].includes(job.trend));

  const fitWeek = week(fit, '2026-10-12');
  assert.deepStrictEqual([fitWeek.target, fitWeek.done, fitWeek.extra, fitWeek.pausedDays, fitWeek.awayDays], [4, 5, 1, 2, [7]], 'paused days and Away Sunday are left out of a daily target');
  assert.strictEqual(fitWeek.full, true);
  assert.deepStrictEqual([week(fit, '2026-10-19').target, week(fit, '2026-10-19').done], [6, 3]);
  assert.deepStrictEqual([week(fit, '2026-10-26').target, week(fit, '2026-10-26').targetSoFar, week(fit, '2026-10-26').done], [6, 4, 2]);
  assert.deepStrictEqual(fit.ranges[8], { n: 9, of: 14, unit: 'days' }, 'a daily habit counts days on target, today only once it is met');
  assert.ok(fit.atGoal);

  const tw = r.weeks.this;
  assert.deepStrictEqual(tw.away, [7]);
  assert.strictEqual(tw.daysLeft, 3);
  assert.deepStrictEqual(tw.habits.map((h) => [h.name, h.done, h.target, h.planLater]), [['Job hunting', 2, 5, 2], ['Fitness', 2, 6, 0]]);
  assert.deepStrictEqual(r.weeks.last.habits.map((h) => [h.name, h.done, h.target]), [['Job hunting', 4, 5], ['Fitness', 3, 6]]);
  assert.strictEqual(s.ss.sheets['Habit log'].rows.length, 1 + 24, 'reading writes nothing');
});

test('insights: to-dos done this week, still to come and anytime, from the To-dos tab', () => {
  const s = insightsServer();
  writeTab(s, 'To-dos', ['title', 'day', 'done', 'project', 'note', 'problem', 'id', 'project_id', 'order', 'created', 'updated_at'], [
    { id: 't0000001', title: 'Post parcel', day: '2026-10-27', done: '2026-10-27', order: '1' },
    { id: 't0000002', title: 'Call plumber', day: '2026-10-26', done: '2026-10-28', order: '2' },
    { id: 't0000003', title: 'Interview', day: '2026-10-30', done: '', order: '3' },
    { id: 't0000004', title: 'Groceries', day: '', done: '', order: '4' },
    { id: 't0000005', title: 'Last week', day: '2026-10-20', done: '2026-10-21', order: '5' },
    { id: 't0000006', title: 'Next week', day: '2026-11-03', done: '', order: '6' }
  ]);
  const r = s.call('insights', 'summary').result;
  assert.deepStrictEqual(r.weeks.this.todos, { done: 2, onDay: 1, toCome: 1, anytime: 1, open: 0 });
  assert.deepStrictEqual(r.weeks.last.todos, { done: 1, onDay: 0, toCome: 0, anytime: 0, open: 0 });
});

test('insights: uses the habits module\'s history api when it is installed', () => {
  const s = insightsServer();
  s.run(`habitsModule = function () { return { title: 'Habits', tables: [], api: { history: function (a) {
    __historyArgs = a;
    return { habits: [{ id: 'h1', name: 'Cardio', sessions: 3, per: 'week', size: '20 min', status: 'active', started: '2026-10-01', order: 1 }],
      log: [{ habit_id: 'h1', day: '2026-10-27', kind: 'done', count: 4, value: '' }] };
  } } }; }; MODULES.push('habits');`);
  const r = s.call('insights', 'summary').result;
  assert.deepStrictEqual(json(s.run('__historyArgs')), { from: '2026-08-10', to: '2026-11-01' }, 'asks for 12 weeks, Monday to Sunday');
  assert.deepStrictEqual(r.weeks.this.habits.map((h) => [h.name, h.done, h.target, h.extra]), [['Cardio', 4, 3, 1]]);
  s.run(`habitsModule = function () { return { title: 'Habits', tables: [], api: {} }; };`);
  assert.deepStrictEqual(s.call('insights', 'summary').result.habits, [], 'a habits module without history falls back to the (missing) tabs');
});

// ---------- habits and to-dos ----------

/** A server whose "today" is a fixed date (a Wednesday), so weeks and prompts can be tested. */
function onDay(day) {
  const s = fresh();
  s.setDay = (d) => s.run(`todayIso_ = function () { return '${d}'; }`);
  s.setDay(day);
  s.rows = (tab) => rowsOf(s.ss.sheets[tab]);
  return s;
}
const WED = '2026-11-04', MON = '2026-11-02';

test('habits: create with a level row, edit, reorder, pause, resume, end and delete', () => {
  const s = onDay(WED);
  assert.throws(() => s.call('habits', 'create', { name: ' ' }), /needs a name/);
  assert.throws(() => s.call('habits', 'create', { name: 'X', per: 'month' }), /per day or per week/);
  assert.throws(() => s.call('habits', 'create', { name: 'X', per: 'day', sessions: 11 }), /1 to 10 a day/);
  assert.throws(() => s.call('habits', 'create', { name: 'X', category: 'nope' }), /Unknown category/);
  assert.throws(() => s.call('habits', 'create', { name: 'X', step_up_every: 'sometimes' }), /Ask every/);
  const cardio = s.call('habits', 'create', { name: 'Cardio', intention: 'Just trying it out', sessions: 2, per: 'week', size: '15 min', goal: '5 a week, 30 min', step_up_every: '2 weeks' }).result;
  assert.deepStrictEqual([cardio.status, cardio.prompts, cardio.next_prompt, cardio.started, cardio.order], ['active', 'on', '2026-11-18', WED, 1]);
  const fit = s.call('habits', 'create', { name: 'Fitness', sessions: 1, per: 'day', size: '10 min', category: 'house' }).result;
  assert.strictEqual(fit.prompts, 'off', 'no pace, no prompts');
  assert.deepStrictEqual(s.rows('Habit log').map((r) => [r.habit, r.day, r.kind, r.value]), [['Cardio', WED, 'level', '2 a week, 15 min'], ['Fitness', WED, 'level', '1 a day, 10 min']]);
  assert.deepStrictEqual(s.ss.sheets.Habits.rows[0], ['name', 'intention', 'sessions', 'per', 'size', 'small_version', 'goal', 'step_up_every', 'prompts', 'category', 'description', 'status', 'problem', 'id', 'next_prompt', 'started', 'order', 'updated_at']);

  s.call('habits', 'update', { id: cardio.id, name: 'Cycling', sessions: 3 });
  assert.ok(s.rows('Habit log').filter((r) => r.habit_id === cardio.id).every((r) => r.habit === 'Cycling'), 'the name next to the id follows a rename');
  assert.deepStrictEqual(s.rows('Habit log').filter((r) => r.habit_id === cardio.id && r.kind === 'level').map((r) => [r.day, r.value]), [[WED, '3 a week, 15 min']], 'an edit applies from today, replacing today\'s level');
  s.call('habits', 'move', { id: fit.id, d: -1 });
  assert.deepStrictEqual(s.call('habits', 'history', {}).result.habits.map((h) => h.name), ['Fitness', 'Cycling']);
  s.call('habits', 'setStatus', { id: fit.id, status: 'paused' });
  s.call('habits', 'setStatus', { id: fit.id, status: 'active' });
  assert.deepStrictEqual(s.rows('Habit log').filter((r) => r.habit_id === fit.id).map((r) => r.kind), ['level', 'pause', 'resume']);
  let b = json(s.run('bootstrap()')).data.habits;
  s.call('habits', 'setStatus', { id: fit.id, status: 'ended' });
  b = json(s.run('bootstrap()')).data.habits;
  assert.deepStrictEqual(b.habits.map((h) => [h.name, h.status]), [['Fitness', 'ended'], ['Cycling', 'active']], 'an ended habit is still sent, for All habits (Today shows active ones)');
  assert.strictEqual(s.rows('Habits').length, 2, 'and stays in the sheet');
  s.call('habits', 'remove', { id: cardio.id });
  assert.ok(!s.rows('Habit log').some((r) => r.habit_id === cardio.id), 'delete takes its history too');
  s.run('undo()');
  assert.ok(s.rows('Habit log').some((r) => r.habit_id === cardio.id), 'and Undo brings both back');
});

test('habits: an aspiring habit is a name and a why, with no sessions; Start makes it active with its level row', () => {
  const s = onDay(WED);
  const cardio = s.call('habits', 'create', { name: 'Cardio', sessions: 2, per: 'week', size: '15 min', step_up_every: '1 week' }).result;
  assert.throws(() => s.call('habits', 'aspire', { name: ' ' }), /needs a name/);
  const idea = s.call('habits', 'aspire', { id: 'aaaa0001', name: 'Learn Spanish', description: 'For the trip next summer' }).result;
  assert.strictEqual(idea.id, 'aaaa0001', 'the browser\'s id is kept');
  let row = s.rows('Habits').find((h) => h.id === idea.id);
  assert.deepStrictEqual([row.status, row.sessions, row.per, row.started, row.prompts, row.next_prompt], ['aspiring', '', '', '', '', '']);
  assert.ok(!s.rows('Habit log').some((r) => r.habit_id === idea.id), 'no level row before it starts');
  s.call('habits', 'update', { id: idea.id, name: 'Spanish', description: 'Duolingo first', sessions: 3, per: 'day' });
  row = s.rows('Habits').find((h) => h.id === idea.id);
  assert.deepStrictEqual([row.name, row.description, row.sessions, row.per, row.status], ['Spanish', 'Duolingo first', '', '', 'aspiring'], 'an edit changes the name and notes only');
  assert.throws(() => s.call('habits', 'setStatus', { id: idea.id, status: 'active' }), /has not started yet/);
  assert.throws(() => s.call('habits', 'start', { id: cardio.id, sessions: 1, per: 'week' }), /already started/);

  // never on Today's list of active habits, never a prompt, never in Insights or plans
  s.run(`tableCache_ = {}; new Table('Habits', ['id']).update('${idea.id}', { prompts: 'on', step_up_every: '1 week', next_prompt: '2026-11-01' })`);
  const b = json(s.run('bootstrap()')).data.habits;
  assert.deepStrictEqual(b.habits.map((h) => [h.name, h.status]), [['Cardio', 'active'], ['Spanish', 'aspiring']]);
  assert.strictEqual(b.prompt, null, 'no prompt for an aspiring habit');
  assert.deepStrictEqual(s.call('habits', 'history', {}).result.habits.map((h) => h.name), ['Cardio'], 'history leaves it out');
  assert.deepStrictEqual(s.call('insights', 'summary').result.habits.map((h) => h.name), ['Cardio'], 'so Insights never count it');
  s.call('habits', 'copyWeek', { week: MON });
  assert.ok(!s.rows('Habit log').some((r) => r.habit_id === idea.id), 'nothing planned for it');
  assert.strictEqual(s.call('habits', 'move', { id: cardio.id, d: 1 }).result, false, 'it is not a place to move an active habit to');

  const started = s.call('habits', 'start', { id: idea.id, name: 'Spanish', description: 'Duolingo first', sessions: 1, per: 'day', size: '10 min', goal: '1 a day, 20 min', step_up_every: '2 weeks' }).result;
  assert.deepStrictEqual([started.status, started.started, started.sessions, started.per, started.size, started.prompts, started.next_prompt, started.order],
    ['active', WED, 1, 'day', '10 min', 'on', '2026-11-18', 3], 'active from today, last on Today');
  assert.deepStrictEqual(s.rows('Habit log').filter((r) => r.habit_id === idea.id).map((r) => [r.day, r.kind, r.value]), [[WED, 'level', '1 a day, 10 min']]);
  assert.deepStrictEqual(s.call('habits', 'history', {}).result.habits.map((h) => h.name), ['Cardio', 'Spanish'], 'now it counts');

  const later = s.call('habits', 'aspire', { name: 'Meditate' }).result;
  s.call('habits', 'remove', { id: later.id });
  assert.ok(!s.rows('Habits').some((h) => h.id === later.id), 'an aspiring habit can be deleted');
  s.run('undo()');
  assert.ok(s.rows('Habits').some((h) => h.id === later.id), 'and Undo brings it back');
});

test('insights read straight from the tabs leave aspiring habits out too', () => {
  const s = insightsServer();
  writeTab(s, 'Habits', HABIT_HEADERS, [
    { id: 'h0000001', name: 'Job hunting', sessions: '5', per: 'week', status: 'active', started: '2026-08-31', order: '1' },
    { id: 'h0000002', name: 'Learn Spanish', status: 'Aspiring', order: '2' }
  ]);
  s.run(`habitsModule = function () { return { title: 'Habits', tables: [], api: {} }; };`);
  assert.deepStrictEqual(s.call('insights', 'summary').result.habits.map((h) => h.name), ['Job hunting']);
});

test('habits: a tap adds a session, taps past the target are extra, −1 takes one off; one log row per habit per day', () => {
  const s = onDay(WED);
  const h = s.call('habits', 'create', { name: 'Cardio', sessions: 2, per: 'week' }).result;
  s.call('habits', 'tap', { id: h.id });
  s.call('habits', 'tap', { id: h.id, day: MON, delta: 1 });
  s.call('habits', 'tap', { id: h.id, delta: 1 });
  let r = s.call('habits', 'tap', { id: h.id, delta: 1 });
  assert.strictEqual(r.result, 3);
  const done = s.rows('Habit log').filter((x) => x.kind === 'done');
  assert.deepStrictEqual(done.map((x) => [x.day, x.count]), [[WED, '3'], [MON, '1']], 'counts, not one row per tap');
  const slice = r.slices.habits;
  assert.strictEqual(slice.log.filter((x) => x.kind === 'done').reduce((n, x) => n + x.count, 0), 4, '4 of 2 this week: two extra');
  assert.strictEqual(s.call('habits', 'tap', { id: h.id, delta: -1 }).result, 2);
  s.call('habits', 'tap', { id: h.id, day: MON, delta: -1 });
  assert.ok(!s.rows('Habit log').some((x) => x.kind === 'done' && x.day === MON), 'a count back to 0 removes the row');
  assert.strictEqual(s.call('habits', 'tap', { id: h.id, day: MON, delta: -1 }).result, 0, 'never below 0');
  assert.throws(() => s.call('habits', 'tap', { id: h.id, delta: 2 }), /one session/);
  assert.throws(() => s.call('habits', 'tap', { id: h.id, day: '2026-11-05' }), /today or the last 7 days/);
  assert.throws(() => s.call('habits', 'tap', { id: h.id, day: '2026-10-27' }), /today or the last 7 days/);
  s.run('undo()');
  assert.strictEqual(s.rows('Habit log').find((x) => x.kind === 'done' && x.day === WED).count, '2', 'a tap can be undone');
});

test('habits offline: taps from two devices that waited offline add up, also for an earlier day', () => {
  const s = onDay(WED);
  const h = s.call('habits', 'create', { name: 'Fitness', sessions: 1, per: 'day' }).result;
  // phone and laptop both tapped Tuesday while offline, then Wednesday the queues are sent (each +1, never a total)
  s.call('habits', 'tap', { id: h.id, day: '2026-11-03', delta: 1 });
  s.call('habits', 'tap', { id: h.id, day: '2026-11-03', delta: 1 });
  assert.strictEqual(s.rows('Habit log').find((x) => x.kind === 'done').count, '2', 'added, not overwritten');
  // the queue keeps taps as their own calls: they are queueable and never merged into one
  const offline = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'offline.html'), 'utf8');
  assert.ok(/'habits\.tap': 1/.test(offline), 'habits.tap waits in the offline queue');
  assert.ok(!/MERGEABLE = [^\n]*tap/.test(offline), 'and two waiting taps are not merged into one');
});

test('plan my week: habit sessions and to-dos only from today to the end of next week; copy last week', () => {
  const s = onDay(WED);
  const h = s.call('habits', 'create', { name: 'Job hunting', sessions: 5, per: 'week' }).result;
  s.call('habits', 'plan', { id: h.id, day: WED, count: 2 });
  s.call('habits', 'plan', { id: h.id, day: '2026-11-15', count: 1 });
  assert.throws(() => s.call('habits', 'plan', { id: h.id, day: '2026-11-16', count: 1 }), /end of next week/, 'never the week after next');
  assert.throws(() => s.call('habits', 'plan', { id: h.id, day: '2026-11-03', count: 1 }), /from today/, 'not a day gone by');
  assert.throws(() => s.call('habits', 'plan', { id: h.id, day: WED, count: 11 }), /0 to 10/);
  s.call('habits', 'plan', { id: h.id, day: WED, count: 0 });
  assert.deepStrictEqual(s.rows('Habit log').filter((x) => x.kind === 'plan').map((x) => [x.day, x.count]), [['2026-11-15', '1']]);
  // last week: done Monday and Thursday; this week from today on is planned the same
  s.setDay('2026-10-29');
  s.call('habits', 'tap', { id: h.id, day: '2026-10-29' });
  s.setDay(WED);
  s.call('habits', 'copyWeek', { week: MON });
  assert.deepStrictEqual(s.rows('Habit log').filter((x) => x.kind === 'plan' && x.day < '2026-11-09').map((x) => [x.day, x.count]), [['2026-11-05', '1']]);
  assert.throws(() => s.call('habits', 'copyWeek', { week: '2026-11-16' }), /this week or next/);

  assert.throws(() => s.call('todos', 'add', { title: 'Far away', day: '2026-11-16' }), /end of next week/);
  assert.throws(() => s.call('todos', 'add', { title: 'Past', day: '2026-11-03' }), /from today/);
  const t = s.call('todos', 'add', { title: 'Paint samples', day: '' }).result;
  s.call('todos', 'setDay', { id: t.id, day: '2026-11-14' });
  assert.throws(() => s.call('todos', 'setDay', { id: t.id, day: '2026-11-20' }), /end of next week/);

  // the focus lead: this week and next week, never further; next week's plan applies when it starts
  assert.throws(() => s.call('today', 'planDay', { week: '2026-11-16', day: 1, plan: 'house' }), /this week or next/);
  let today = s.call('today', 'state').result;
  s.call('today', 'planDay', { week: today.nextWeekKey, day: 1, plan: 'away' });
  today = s.call('today', 'state').result;
  assert.deepStrictEqual([today.next[1], today.week[1]], ['away', undefined]);
  const settings = Object.fromEntries(s.ss.sheets.Settings.rows.slice(1));
  assert.deepStrictEqual([settings['next.of'], settings['next.monday']], [today.nextWeekKey, 'away']);
  s.call('today', 'planDay', { week: today.weekKey, day: 2, plan: 'house' });
  assert.strictEqual(s.call('today', 'state').result.week[2], 'house');
  s.call('today', 'planDay', { week: today.weekKey, day: 2, plan: 'usual' });
  assert.strictEqual(s.call('today', 'state').result.week[2], undefined);
});

test('to-dos: add, tick, untick, delete with undo; done ones fall away after two weeks; history', () => {
  const s = onDay(WED);
  assert.throws(() => s.call('todos', 'add', { title: '  ' }), /needs a title/);
  const p = s.call('projects', 'create', { name: 'Fan', category: 'house' }).result;
  const a = s.call('todos', 'add', { title: 'Grocery shopping', day: WED }).result;
  const b = s.call('todos', 'add', { title: 'Order fan', projectId: p.id }).result;
  assert.strictEqual(s.rows('To-dos').find((t) => t.id === b.id).project, 'Fan', 'the project name next to its id');
  s.call('todos', 'toggle', { id: a.id, done: true });
  assert.strictEqual(s.rows('To-dos').find((t) => t.id === a.id).done, WED);
  s.call('todos', 'toggle', { id: a.id, done: false });
  s.call('todos', 'toggle', { id: a.id, done: true });
  assert.deepStrictEqual(s.call('todos', 'history', { from: MON, to: '2026-11-08' }).result.map((t) => [t.title, t.day, t.done]), [['Grocery shopping', WED, WED], ['Order fan', '', '']], 'open anytime to-dos come too, for Insights');
  s.call('todos', 'remove', { id: b.id });
  assert.strictEqual(s.rows('To-dos').length, 1);
  s.run('undo()');
  assert.strictEqual(s.rows('To-dos').length, 2, 'Undo brings it back');
  s.setDay('2026-11-30');
  assert.deepStrictEqual(json(s.run('bootstrap()')).data.todos.items.map((t) => t.title), ['Order fan'], 'ticked long ago: off the page, kept in the sheet');
  s.call('projects', 'remove', { id: p.id });
  assert.strictEqual(s.rows('To-dos').find((t) => t.id === b.id).project_id, '', 'a deleted project\'s to-dos stay, unlinked');
});

/** A habit at 2 a week, 15 min since `levelDay`, prompts every `pace`, and done counts by day. */
function rampHabit(s, pace, levelDay, done) {
  const h = s.call('habits', 'create', { name: 'Cardio', sessions: 2, per: 'week', size: '15 min', goal: '5 a week, 30 min', step_up_every: pace }).result;
  s.run(`tableCache_ = {}; new Table('Habit log', ['id']).removeWhere(function (r) { return r.kind === 'level'; }); new Table('Habit log', ['id']).insert({ habit_id: '${h.id}', day: '${levelDay}', kind: 'level', value: '2 a week, 15 min' }); new Table('Habits', ['id']).update('${h.id}', { next_prompt: '${WED}', started: '${levelDay}' })`);
  Object.entries(done).forEach(([day, n]) => s.run(`tableCache_ = {}; new Table('Habit log', ['id']).insert({ habit_id: '${h.id}', day: '${day}', kind: 'done', count: ${n} })`));
  return h;
}
const promptNow = (s) => json(s.run('bootstrap()')).data.habits.prompt;

test('step-up prompt: only when due and earned (80 % of the sessions in the full weeks since the level), one step, never past the goal', () => {
  let s = onDay(WED);
  rampHabit(s, '2 weeks', '2026-10-19', { '2026-10-20': 2, '2026-10-28': 1 });
  assert.strictEqual(promptNow(s), null, '3 of 4 is under 80 %: it waits, and says nothing');
  s = onDay(WED);
  const h = rampHabit(s, '2 weeks', '2026-10-19', { '2026-10-20': 2, '2026-10-27': 1, '2026-10-30': 1 });
  let p = promptNow(s);
  assert.deepStrictEqual([p.kind, p.habitId, p.weeks, p.level, p.selected, p.from], ['step', h.id, 2, '2 a week, 15 min', 0, 'Monday']);
  assert.deepStrictEqual(p.options.map((o) => [o.sessions, o.size, o.change]), [[3, '15 min', '+1 session'], [2, '20 min', '+5 min']]);
  s.run(`tableCache_ = {}; new Table('Habits', ['id']).update('${h.id}', { next_prompt: '2026-11-05' })`);
  assert.strictEqual(promptNow(s), null, 'not due yet');
  s.run(`tableCache_ = {}; new Table('Habits', ['id']).update('${h.id}', { next_prompt: '${WED}', status: 'paused' })`);
  assert.strictEqual(promptNow(s), null, 'a paused habit is never asked');
  // a paused week is left out: the week before still counts
  s = onDay(WED);
  const k = rampHabit(s, '2 weeks', '2026-10-19', { '2026-10-20': 2 });
  s.run(`tableCache_ = {}; new Table('Habit log', ['id']).insertMany([{ habit_id: '${k.id}', day: '2026-10-27', kind: 'pause' }, { habit_id: '${k.id}', day: '2026-11-02', kind: 'resume' }])`);
  assert.strictEqual(promptNow(s).weeks, 1, 'the paused week is skipped');
  // no full week since the level changed: nothing to judge yet
  s = onDay(WED);
  rampHabit(s, '1 week', '2026-10-28', { '2026-10-28': 5 });
  assert.strictEqual(promptNow(s), null);
  // at the goal there is nothing to offer
  s = onDay(WED);
  const g = rampHabit(s, '1 week', '2026-10-19', { '2026-10-27': 5 });
  s.run(`tableCache_ = {}; new Table('Habits', ['id']).update('${g.id}', { goal: '2 a week, 15 min' })`);
  assert.strictEqual(promptNow(s), null);
  s.run(`tableCache_ = {}; new Table('Habits', ['id']).update('${g.id}', { goal: '2 a week, 18 min' })`);
  assert.deepStrictEqual(promptNow(s).options.map((o) => o.size), ['18 min'], 'a longer session, capped at the goal');
});

test('step-up answers: Yes adjusts from next Monday (daily: tomorrow); Not now waits a pace, three ask once to stop; I\'m at my goal', () => {
  let s = onDay(WED);
  const h = rampHabit(s, '2 weeks', '2026-10-19', { '2026-10-20': 2, '2026-10-27': 2 });
  let r = s.call('habits', 'answer', { id: h.id, answer: 'yes', option: 1 });
  assert.strictEqual(r.result.text, 'Cardio is 2 a week, 20 min from Monday. Next check in 2 weeks.');
  const row = s.rows('Habits')[0];
  assert.deepStrictEqual([row.sessions, row.size, row.next_prompt], ['2', '20 min', '2026-11-18']);
  assert.deepStrictEqual(s.rows('Habit log').filter((x) => x.kind === 'level').map((x) => [x.day, x.value]), [['2026-10-19', '2 a week, 15 min'], ['2026-11-09', '2 a week, 20 min']]);
  const slice = r.slices.habits;
  assert.deepStrictEqual(slice.habits[0].level, { sessions: 2, size: '15 min' }, 'this week keeps its target');
  assert.deepStrictEqual(slice.habits[0].nextLevel, { value: '2 a week, 20 min', from: '2026-11-09' });
  assert.strictEqual(slice.prompt, null, 'at most one a day');
  s.setDay('2026-11-09');
  assert.deepStrictEqual(json(s.run('bootstrap()')).data.habits.habits[0].level, { sessions: 2, size: '20 min' }, 'Monday: the new level');
  s.run('undo()');
  s.setDay(WED);
  assert.strictEqual(s.rows('Habits')[0].size, '15 min', 'Yes can be undone');

  const daily = s.call('habits', 'create', { name: 'Fitness', sessions: 1, per: 'day', size: '10 min', step_up_every: '1 week' }).result;
  s.call('habits', 'answer', { id: daily.id, answer: 'yes' });
  assert.ok(s.rows('Habit log').some((x) => x.habit_id === daily.id && x.kind === 'level' && x.day === '2026-11-05'), 'a daily habit changes tomorrow');

  s = onDay(WED);
  const n = rampHabit(s, '1 week', '2026-10-19', { '2026-10-27': 2 });
  assert.strictEqual(s.call('habits', 'answer', { id: n.id, answer: 'not now' }).result.text, 'No change. We\'ll ask again in a week.');
  assert.strictEqual(s.rows('Habits')[0].next_prompt, '2026-11-11');
  assert.strictEqual(s.rows('Habits')[0].sessions, '2');
  s.setDay('2026-11-11'); s.call('habits', 'tap', { id: n.id, day: '2026-11-05' }); s.call('habits', 'tap', { id: n.id, day: '2026-11-06' });
  assert.strictEqual(promptNow(s).kind, 'step');
  s.call('habits', 'answer', { id: n.id, answer: 'not now' });
  assert.strictEqual(promptNow(s), null, 'two in a row: nothing more today');
  s.run(`tableCache_ = {}; new Table('Habits', ['id']).update('${n.id}', { next_prompt: '2026-11-11' })`);
  s.setDay('2026-11-12');
  s.run(`tableCache_ = {}; new Table('Habits', ['id']).update('${n.id}', { next_prompt: '2026-11-12' })`);
  s.call('habits', 'answer', { id: n.id, answer: 'not now' });
  let p = promptNow(s);
  assert.deepStrictEqual([p.kind, p.level], ['stop', '2 a week, 15 min'], 'after three Not now in a row it asks once whether to stop');
  s.call('habits', 'answer', { id: n.id, answer: 'keep asking' });
  assert.strictEqual(promptNow(s), null, 'Keep asking: the count starts again');
  for (let i = 0; i < 3; i++) s.call('habits', 'answer', { id: n.id, answer: 'not now' });
  assert.strictEqual(promptNow(s).kind, 'stop');
  assert.strictEqual(s.call('habits', 'answer', { id: n.id, answer: 'stop asking' }).result.text, 'No more prompts for Cardio. Turn them back on in its settings.');
  assert.strictEqual(s.rows('Habits')[0].prompts, 'off');
  assert.strictEqual(promptNow(s), null);
  s.call('habits', 'update', { id: n.id, step_up_every: '1 week' });
  assert.strictEqual(s.rows('Habits')[0].prompts, 'on', 'a pace in the settings turns prompts back on');

  s = onDay(WED);
  const g = rampHabit(s, '1 week', '2026-10-19', { '2026-10-27': 2 });
  assert.strictEqual(s.call('habits', 'answer', { id: g.id, answer: 'at goal' }).result.text, 'Cardio is at your goal: 2 a week, 15 min. No more prompts.');
  assert.deepStrictEqual([s.rows('Habits')[0].prompts, s.rows('Habits')[0].goal], ['at goal', '2 a week, 15 min']);
  assert.deepStrictEqual(s.rows('Habit log').filter((x) => x.kind === 'prompt').map((x) => [x.day, x.value]), [[WED, 'at goal']]);
  assert.throws(() => s.call('habits', 'answer', { id: g.id, answer: 'maybe' }), /Unknown answer/);
});

test('habits.history gives Insights the habits, done and plan rows in the range, and every level, prompt and pause row up to its end', () => {
  const s = onDay(WED);
  const h = rampHabit(s, '1 week', '2026-10-19', { '2026-10-20': 2, '2026-11-03': 1 });
  s.call('habits', 'plan', { id: h.id, day: '2026-11-06', count: 1 });
  s.call('habits', 'answer', { id: h.id, answer: 'not now' });
  const r = s.call('habits', 'history', { from: '2026-10-26', to: '2026-11-08' }).result;
  assert.deepStrictEqual(Object.keys(r.habits[0]).sort(), ['category', 'goal', 'id', 'intention', 'name', 'order', 'per', 'prompts', 'sessions', 'size', 'started', 'status']);
  assert.deepStrictEqual(r.log.map((x) => [x.day, x.kind, x.count, x.value]),
    [['2026-10-19', 'level', 0, '2 a week, 15 min'], ['2026-11-03', 'done', 1, ''], [WED, 'prompt', 0, 'not now'], ['2026-11-06', 'plan', 1, '']]);
});

test('a habit typed into the sheet is completed, and one the app cannot use is flagged', () => {
  const s = onDay(WED);
  s.call('habits', 'create', { name: 'Seed' });
  const sh = s.ss.sheets.Habits;
  sh.rows.push(rowFrom(sh, { name: 'Water plants', sessions: '1', per: 'week' }));
  sh.rows.push(rowFrom(sh, { name: 'Bad one', per: 'month' }));
  sh.rows.push(rowFrom(sh, { name: 'Linked', category: 'Job search' }));
  // as the guide says: an idea for a habit not started yet is a row with name, description and status aspiring
  sh.rows.push(rowFrom(sh, { name: 'Learn piano', description: 'One song by spring', status: 'Aspiring' }));
  const b = json(s.run('bootstrap()')).data.habits;
  assert.deepStrictEqual(b.habits.map((h) => [h.name, h.status]), [['Seed', 'active'], ['Water plants', 'active'], ['Linked', 'active'], ['Learn piano', 'aspiring']]);
  assert.strictEqual(b.prompt, null);
  const rows = s.rows('Habits');
  assert.strictEqual(rows.find((h) => h.name === 'Bad one').problem, 'Per must be day or week.');
  const linked = rows.find((h) => h.name === 'Linked');
  assert.deepStrictEqual([linked.category, linked.status, linked.per, linked.sessions, linked.prompts], ['job', 'active', 'week', '1', 'off']);
  const piano = rows.find((h) => h.name === 'Learn piano');
  assert.deepStrictEqual([piano.problem, piano.status, piano.started, piano.description], ['', 'aspiring', '', 'One song by spring'], 'accepted, not started');
  assert.ok(piano.id, 'with an id');
  assert.ok(!s.call('habits', 'history', {}).result.habits.some((h) => h.name === 'Learn piano'), 'and not in Insights');
  s.call('habits', 'start', { id: piano.id, sessions: 2, per: 'week', size: '15 min' });
  assert.strictEqual(s.rows('Habits').find((h) => h.id === piano.id).status, 'active', 'it can be started in the app');
});


// ---------- the guide for AI assistants (core/guide.js) ----------

const GUIDE_NAME = 'Focus Tracker – guide for AI assistants';

test('the guide for assistants describes every people tab and every column, from the code', () => {
  const s = fresh();
  assert.deepStrictEqual(json(s.run('guideGaps_()')), [], 'every people column has a meaning in GUIDE_TABS_');
  const md = String(s.run('guideMarkdown_()'));
  const people = json(s.run('TAB_STYLE')).filter((t) => t.people && t.name !== 'Start here');
  assert.ok(people.length >= 11);
  people.forEach((t) => {
    assert.ok(md.includes('\n### ' + t.name + '\n'), 'a section for ' + t.name);
    const section = md.split('\n### ' + t.name + '\n')[1].split('\n### ')[0].split('\n## ')[0];
    s.ss.sheets[t.name].rows[0].forEach((h) => assert.ok(new RegExp('(^|[ |,])' + h + '([ |,.]|$)', 'm').test(section), t.name + ' lists its column ' + h));
  });
  ['Where things go', 'Notes', 'Worked example', 'Changing an existing project safely', 'Safety rules', 'Checklist before you finish'].forEach((h) => assert.ok(md.includes('\n## ' + h), 'has ' + h));
  ['active, paused, done, archived', 'link, drive, phone, email, text', 'One of: day, week', 'blocks', 'group Code', 'bank or card details', 'Never delete rows', 'problem column', '"Personal" or "Work"'].forEach((w) => assert.ok(md.includes(w), 'says ' + w));
  const fs = require('fs'), path = require('path');
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'docs', 'assistant-guide.md'), 'utf8'), md, 'docs/assistant-guide.md is current: run node scripts/write-guide.js');
});

test('the guide holds no ids or addresses from the sheet: only mode names and its own address', () => {
  const s = fresh();
  s.run('seedStarterData()');
  const p = s.call('projects', 'create', { name: 'Secret robot', category: 'coding' }).result;
  s.call('resources', 'add', { projectId: p.id, category: 'coding', title: 'Robot repo', url: 'https://github.com/someone/secret-robot' });
  s.call('notes', 'save', { projectId: p.id, text: 'private plans' });
  s.call('notes', 'syncDoc', { projectId: p.id });
  const b = json(s.run('bootstrap()'));
  const guide = s.docs.guide();
  assert.strictEqual(guide.length, 1);
  const texts = [String(s.run('guideMarkdown_()')), guide[0].content, s.ss.sheets['Start here'].rows.map((r) => r[0]).join('\n')];
  const ids = [s.ss.getId(), s.script._m.FOLDER_ID, s.script._m['MODE_FOLDER_ID.personal'], p.id, 'secret-robot', 'Secret robot', 'private plans']
    .concat(b.data.projects.map((x) => x.id), b.data.kanban.tasks.map((t) => t.id), Object.keys(s.drive.files));
  texts.forEach((t, i) => ids.forEach((id) => assert.ok(id && !t.includes(id), 'text ' + i + ' does not contain ' + id)));
  texts.forEach((t) => (t.match(/https:\/\/[^\s)|"]+/g) || []).forEach((u) => assert.ok(/^https:\/\/(github\.com\/example\/|docs\.google\.com\/(document\/)?\.\.\.|docs\.google\.com\/$|drive\.google\.com\/$|\.\.\.)/.test(u) || u === 'https://' , 'only example addresses: ' + u)));
});

test('the guide Doc is made in the root folder on setup, and rewritten only when its text changes', () => {
  const s = fresh();
  const [doc] = s.docs.guide();
  assert.ok(doc, 'setup makes it');
  assert.strictEqual(s.drive.pathOf(doc), 'Focus Tracker/' + GUIDE_NAME);
  assert.strictEqual(doc.content, String(s.run('guideMarkdown_()')), 'Drive\'s markdown import gets the generated guide');
  assert.strictEqual(s.script._m.GUIDE_DOC_ID, doc.id);
  // the page gets its address and the paragraph for an assistant's instructions
  const b = json(s.run('bootstrap()'));
  const url = 'https://docs.google.com/document/d/' + doc.id + '/edit';
  assert.strictEqual(b.config.guideUrl, url);
  assert.strictEqual(b.config.guideName, GUIDE_NAME);
  ['"Focus Tracker"', '"' + GUIDE_NAME + '"', url, '"Personal" or "Work"', 'Never delete rows'].forEach((w) => assert.ok(b.config.assistantNote.includes(w), 'the paragraph says ' + w));
  // unchanged text: no Drive call on later loads or migrations
  const calls = Object.assign({}, s.docs.calls);
  json(s.run('bootstrap()')); s.call('projects', 'create', { name: 'X', category: 'coding' }); s.run('ensureSchema_()'); json(s.run('bootstrap("work")'));
  assert.deepStrictEqual(s.docs.calls, calls, 'no Drive call while the guide is the same');
  // a new mode changes the text: the same Doc is rewritten once
  json(s.run('createMode')('Side projects'));
  json(s.run('bootstrap()')); json(s.run('bootstrap()'));
  assert.strictEqual(s.docs.calls.update, calls.update + 1, 'rewritten once');
  assert.strictEqual(s.docs.calls.create, calls.create);
  assert.strictEqual(s.docs.guide().length, 1);
  assert.ok(doc.content.includes('"Personal", "Work" or "Side projects"'));
  // a Doc deleted in Drive is made again when the text next changes
  delete s.drive.files[doc.id]; delete doc.parent.children[doc.id];
  json(s.run('createMode')('Garden'));
  const again = json(s.run('bootstrap()'));
  const [remade] = s.docs.guide();
  assert.ok(remade && remade.id !== doc.id && again.config.guideUrl.includes(remade.id), 'a new Doc, and the page links it');
  // Drive refusing never stops the app
  json(s.run('createMode')('Boat'));
  s.run('Drive.Files.update = Drive.Files.create = function () { throw new Error("Drive is down"); }');
  const down = json(s.run('bootstrap()'));
  assert.strictEqual(down.config.guideUrl, again.config.guideUrl, 'the last address is still offered');
  assert.ok(s.mock.logs.some((l) => /guide Doc not written: Drive is down/.test(l)));
});

test('Start here is the short guide, rewritten when its text changes', () => {
  const s = fresh();
  const text = () => s.ss.sheets['Start here'].rows.map((r) => r[0]).join('\n');
  assert.strictEqual(text(), json(s.run('guideShortLines_()')).join('\n'));
  ['Projects:', 'Tasks:', 'Resources:', GUIDE_NAME, 'Leave id, order and created empty', 'group Code', 'To do, Doing, Done'].forEach((w) => assert.ok(text().includes(w), 'says ' + w));
  s.ss.sheets['Start here'].rows[1] = ['old text'];
  json(s.run('bootstrap()'));
  assert.strictEqual(s.ss.sheets['Start here'].rows[1][0], 'old text', 'not rewritten on every load');
  s.script._m['START_HERE_HASH.personal'] = 'older code';
  json(s.run('bootstrap()'));
  assert.strictEqual(text(), json(s.run('guideShortLines_()')).join('\n'), 'rewritten once the guide changed');
});

/** Type rows into the fake sheet as an assistant would: only the columns given, everything else empty. */
function typeRows(s, rows) {
  rows.forEach(({ tab, row }) => { const sh = s.ss.sheets[tab]; sh.rows.push(sh.rows[0].map((h) => (row[h] === undefined ? '' : row[h]))); });
}

test('assistant rows: the guide\'s worked example, typed as written, loads with every id filled and no problem', () => {
  const s = fresh();
  s.run('seedStarterData()');
  json(s.run('bootstrap()'));
  const example = json(s.run('GUIDE_EXAMPLE_'));
  typeRows(s, example.rows);
  const b = json(s.run('bootstrap()')).data;
  const sh = s.ss.sheets;
  ['Projects', 'Tasks', 'Resources', 'Links', 'Criteria'].forEach((tab) => rowsOf(sh[tab]).forEach((r) => {
    assert.strictEqual(r.problem, '', tab + ' row has no problem: ' + JSON.stringify(r));
    assert.ok(/^[0-9a-f]{8}$/.test(r.id), tab + ' row has an id');
  }));
  const p = b.projects.find((x) => x.name === 'Garden irrigation');
  assert.deepStrictEqual([p.category, p.status, p.next_action], ['house', 'active', 'Measure the two back beds']);
  const cols = b.kanban.columns.filter((c) => c.owner === p.id);
  assert.deepStrictEqual(cols.map((c) => c.name), ['To do', 'Doing', 'Done'], 'the usual board');
  const cards = b.kanban.tasks.filter((t) => t.owner === p.id);
  const colName = (t) => cols.find((c) => c.id === t.column_id).name;
  assert.deepStrictEqual(cards.map((t) => [t.title, colName(t)]).sort(), [['Choose a drip kit', 'To do'], ['Measure the beds', 'To do'], ['Sketch the layout', 'Doing']]);
  assert.ok(cards.find((t) => t.title === 'Choose a drip kit').note_html.includes('Compare two kits'));
  const repo = b.resources.find((r) => r.title === 'garden-irrigation repo');
  assert.deepStrictEqual([repo.type, repo.value, repo.group, repo.project_id, repo.category], ['link', 'https://github.com/example/garden-irrigation', 'Code', p.id, 'house']);
  const fence = b.projects.find((x) => x.name === 'Garden fence repair');
  assert.ok(b.links.some((l) => l.from_id === fence.id && l.to_id === p.id && l.type === 'blocks'));
  assert.ok(rowsOf(sh.Criteria).some((c) => c.project_id === p.id && c.text === 'Every bed gets water from the timer'));
  // the notes typed into the notes cell became the project's notes, and the cell holds the link again
  const notes = b.notes.find((n) => n.project_id === p.id);
  assert.ok(notes, 'a notes file was made');
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, '# Plan\nDrip lines on the two back beds.\n- Timer on the outside tap\n- Water butt as a backup');
  assert.strictEqual(rowsOf(sh.Projects).find((x) => x.id === p.id).notes, notes.url);
  // loading again changes nothing
  const before = JSON.stringify(Object.fromEntries(Object.keys(sh).map((n) => [n, sh[n].rows])));
  json(s.run('bootstrap()'));
  assert.strictEqual(JSON.stringify(Object.fromEntries(Object.keys(sh).map((n) => [n, sh[n].rows]))), before);
});

test('assistant rows: notes typed into the cell of a project that has a notes Doc go to the end of its notes', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Shed', category: 'house' }).result;
  s.call('notes', 'save', { projectId: p.id, text: '# Shed\nFirst line' });
  const doc = s.call('notes', 'syncDoc', { projectId: p.id }).result.url;
  const sh = s.ss.sheets.Projects, col = sh.rows[0].indexOf('notes');
  sh.rows.find((r) => r.includes(p.id))[col] = '## 2026-11-03\nRoof felt ordered';
  json(s.run('bootstrap()'));
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, '# Shed\nFirst line\n## 2026-11-03\nRoof felt ordered');
  assert.strictEqual(sh.rows.find((r) => r.includes(p.id))[col], doc, 'the Doc\'s link is back');
  assert.ok(s.call('notes', 'syncDoc', { projectId: p.id }).result.url === doc && s.docs.docs()[0].content.includes('Roof felt ordered'), 'the Doc gets it on its next sync');
});

test('assistant rows that cannot be used are flagged with a reason, never guessed or deleted', () => {
  const s = fresh();
  s.run('seedStarterData()');
  json(s.run('bootstrap()'));
  typeRows(s, [
    { tab: 'Projects', row: { name: 'Pond', category: 'House' } },
    { tab: 'Projects', row: { name: 'garden FENCE repair ', category: 'House' } },
    { tab: 'Projects', row: { name: 'Twin', category: 'Coding', status: 'Paused' } },
    { tab: 'Projects', row: { name: 'twin', category: 'Coding' } },
    { tab: 'Tasks', row: { title: 'Dig', project: 'Pond', column: 'Doing' } },
    { tab: 'Tasks', row: { title: 'Ghost', project: 'No such project', column: 'To do' } },
    { tab: 'Tasks', row: { title: 'Which twin', project: 'Twin' } },
    { tab: 'Resources', row: { title: 'Pond repo', type: 'Link', value: 'https://github.com/example/pond', group: 'Code', project: 'Pond' } },
    { tab: 'Resources', row: { title: 'Bad link', type: 'link', value: 'github.com/example/pond', project: 'Pond' } },
    { tab: 'Links', row: { from: 'Pond', type: 'Relates', to: 'Twin' } },
    { tab: 'Links', row: { from: 'Pond', type: 'blocks', to: 'Nowhere' } }
  ]);
  const b = json(s.run('bootstrap()')).data;
  const problem = (tab, key, value) => rowsOf(s.ss.sheets[tab]).find((r) => r[key] === value).problem;
  const pond = b.projects.find((p) => p.name === 'Pond');
  assert.ok(pond && pond.category === 'house', 'a project with only a name and a category label');
  assert.strictEqual(b.projects.filter((p) => /fence/i.test(p.name)).length, 1, 'no second fence project');
  assert.match(problem('Projects', 'name', 'garden FENCE repair '), /already a project called "garden FENCE repair"/);
  assert.strictEqual(b.projects.find((p) => p.name === 'Twin').status, 'paused', 'a capital letter is fine');
  assert.match(problem('Projects', 'name', 'twin'), /already a project called "twin"/, 'two new rows with one name: the second is flagged');
  assert.strictEqual(problem('Tasks', 'title', 'Dig'), '');
  assert.match(problem('Tasks', 'title', 'Ghost'), /No project called "No such project"/);
  assert.strictEqual(problem('Tasks', 'title', 'Which twin'), '', 'the flagged twin does not count, so the name is not shared');
  assert.strictEqual(b.resources.find((r) => r.title === 'Pond repo').type, 'link');
  assert.match(problem('Resources', 'title', 'Bad link'), /starts with https:\/\//);
  assert.ok(b.links.some((l) => l.type === 'relates' && l.from_id === pond.id));
  assert.match(problem('Links', 'to', 'Nowhere'), /No project called "Nowhere"/);
  assert.ok(!b.kanban.tasks.some((t) => t.title === 'Ghost') && !b.resources.some((r) => r.title === 'Bad link'));
  // fixing a flagged row clears its problem: the duplicate gets its own name
  const sh = s.ss.sheets.Projects;
  sh.rows.find((r) => r[0] === 'twin')[0] = 'Twin two';
  const b2 = json(s.run('bootstrap()')).data;
  assert.ok(b2.projects.some((p) => p.name === 'Twin two'));
  assert.strictEqual(rowsOf(s.ss.sheets.Projects).length, json(s.run('bootstrap()')).data.projects.length + 1, 'only the fence duplicate is left out, and still there');
});

test('assistant rows: a card moves when its column name changes and column_id is emptied', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'Kiln', category: 'house' }).result;
  const t = s.call('kanban', 'addTask', { projectId: p.id, title: 'Fire it' });
  const id = (t.result && t.result.id) || t.result;
  const sh = s.ss.sheets.Tasks, h = sh.rows[0];
  const row = sh.rows.find((r) => r.includes('Fire it'));
  row[h.indexOf('column')] = 'done'; row[h.indexOf('column_id')] = '';
  const b = json(s.run('bootstrap()')).data;
  const done = b.kanban.columns.find((c) => c.owner === p.id && c.name === 'Done');
  const card = b.kanban.tasks.find((x) => x.title === 'Fire it');
  assert.ok(id);
  assert.strictEqual(card.column_id, done.id);
  assert.strictEqual(row[h.indexOf('column')], 'Done', 'written as the board spells it');
});

console.log('\n' + passed + ' server tests passed');
