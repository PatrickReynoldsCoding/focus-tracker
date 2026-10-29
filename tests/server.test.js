const assert = require('assert');
const { loadServer } = require('./mocks');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
const json = (x) => JSON.parse(JSON.stringify(x));

function fresh() {
  const s = loadServer();
  s.run('setup()');
  s.call = (m, fn, args) => json(s.run('rpc')(m, fn, json(args || {})));
  return s;
}

test('setup creates a tab per table and a Drive folder', () => {
  const s = fresh();
  ['Projects', 'Columns', 'Tasks', 'Notes', 'Resources', 'Log'].forEach((n) => assert.ok(s.ss.sheets[n], 'missing tab ' + n));
  assert.deepStrictEqual(s.ss.sheets.Projects.rows[0], ['id', 'name', 'category', 'status', 'next_action', 'last_touched', 'created', 'locked_until', 'updated_at']);
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
  t = s.call('today', 'saveRotation', { usual, week: { 3: 'away', 4: 'job' }, dailyMinimum: '' }).slices.today;
  assert.strictEqual(t.away, true);
  assert.strictEqual(t.lead, null);
  assert.deepStrictEqual([t.labels[1], t.labels[3], t.labels[4], t.labels[6]], ['House', 'Away', 'Job search', 'Away']);
  assert.strictEqual(t.usual[4], null);
  assert.strictEqual(t.dailyMinimum, null, 'daily minimum switched off');
  // A new week: the saved week no longer matches, so only the usual rotation applies
  const props = s.user._m;
  props['today.week'] = JSON.stringify(Object.assign(JSON.parse(props['today.week']), { week: '1999-01-04' }));
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

test('resources only accept https links and attach to a category or a project', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'R', category: 'house' }).result;
  assert.throws(() => s.call('resources', 'add', { category: 'house', title: 'x', url: 'http://example.com' }), /https/);
  assert.throws(() => s.call('resources', 'add', { category: 'house', title: '', url: 'https://example.com' }), /title/);
  s.call('resources', 'add', { category: 'house', title: 'DIY', url: 'https://docs.google.com/document/d/abc', note: 'plans' });
  const r = s.call('resources', 'add', { category: 'house', projectId: p.id, title: 'Fan', url: 'https://example.com/fan' }).slices.resources;
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r.filter((x) => !x.project_id).length, 1);
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
  assert.strictEqual(Object.keys(root.children).length, 1, 'a second load moves nothing');
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
  assert.strictEqual(wb.data.today.dailyMinimum, null);
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
  assert.strictEqual(b.data.today.dailyMinimum, null);
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

test('a deleted lead category makes that day "Any category" and drops the daily minimum', () => {
  const s = fresh();
  s.mock.weekday = 3;
  assert.strictEqual(s.call('today', 'state').result.lead, 'job');
  s.call('categories', 'remove', { id: 'job' });
  const t = s.call('today', 'state').result;
  assert.strictEqual(t.lead, null);
  assert.strictEqual(t.labels[3], 'Any category');
  assert.strictEqual(t.dailyMinimum, null);
  assert.strictEqual(t.labels[1], 'Coding');
});

test('lists have groups and items on their own board, can be shown on Today, reordered and deleted', () => {
  const s = fresh();
  assert.throws(() => s.call('lists', 'create', { name: ' ' }), /needs a name/);
  const reading = s.call('lists', 'create', { name: 'Read and watch', groups: ['Work', 'Rainy day'] });
  assert.deepStrictEqual(reading.slices.kanban.columns.filter((c) => c.project_id === reading.result.id).map((c) => c.name), ['Work', 'Rainy day']);
  const keep = s.call('lists', 'create', { name: 'Keep in mind', showToday: true }).result;
  assert.strictEqual(keep.show_today, 'yes');
  const groups = (id) => json(s.run('bootstrap()')).data.kanban.columns.filter((c) => c.project_id === id);
  assert.deepStrictEqual(groups(keep.id).map((c) => c.name), ['Items']);
  const item = s.call('kanban', 'addTask', { projectId: keep.id, columnId: groups(keep.id)[0].id, title: 'Tell a story with commits' }).result;
  assert.strictEqual(item.project_id, keep.id);
  s.call('lists', 'showToday', { id: reading.result.id, on: true });
  s.call('lists', 'rename', { id: keep.id, name: 'How I work' });
  let lists = s.call('lists', 'move', { id: keep.id, d: -1 }).slices.lists;
  assert.deepStrictEqual(lists.map((l) => l.name), ['How I work', 'Read and watch']);
  assert.ok(lists.every((l) => l.show_today === 'yes'));
  assert.strictEqual(s.call('lists', 'move', { id: keep.id, d: -1 }).result, false, 'already first');
  const after = s.call('lists', 'remove', { id: keep.id }).slices;
  assert.deepStrictEqual(after.lists.map((l) => l.name), ['Read and watch']);
  assert.ok(!after.kanban.tasks.some((t) => t.project_id === keep.id), 'its items are removed');
  assert.ok(!after.kanban.columns.some((c) => c.project_id === keep.id), 'its groups are removed');
});

test('rich-text notes keep safe formatting and drop anything that could run or load', () => {
  const s = fresh();
  const clean = (html) => s.run('sanitizeRichText_')(html);
  assert.strictEqual(clean('<b>Bold</b> <i>it</i><ul><li>one</li></ul>'), '<b>Bold</b> <i>it</i><ul><li>one</li></ul>');
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
  assert.strictEqual(r.result.note_text, 'Do this\nthen that (https://x.io)');
  const header = s.ss.sheets.Tasks.rows[0];
  assert.ok(['color', 'note_html', 'note_text'].every((h) => header.includes(h)));
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
  assert.strictEqual(token.note_text, 'See https://x.io/a?b=1&c=2\n<script>x</script>', 'the note is text, not markup');
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
  const file = (id) => s.drive.getFileById(json(s.run('bootstrap()')).data.whiteboard.length && s.ss.sheets.Whiteboards.rows.find((r) => r[0] === id)[2]);
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
  s.ss.sheets.Whiteboards.rows.push(['old00001', p.id, file(a.id).id, 'https://x', '2026-10-01T00:00:00Z', '', '']);
  assert.strictEqual(json(s.run('bootstrap()')).data.whiteboard.find((w) => w.id === 'old00001').name, 'Whiteboard');
  assert.ok(s.call('whiteboard', 'get', { id: 'old00001' }).result.json);
  const fileIds = s.ss.sheets.Whiteboards.rows.slice(1).map((r) => r[2]);
  s.call('projects', 'remove', { id: p.id });
  assert.strictEqual(json(s.run('bootstrap()')).data.whiteboard.length, 0, 'the links go with the project');
  assert.ok(fileIds.every((id) => s.drive.files[id]), 'the drawing files stay in Drive');
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
  assert.deepStrictEqual(Object.keys(b.data).sort(), ['categories', 'criteria', 'kanban', 'layout', 'lists', 'log', 'notes', 'projects', 'resources', 'stickies', 'today', 'whiteboard']);
  assert.strictEqual(b.modules.length, 12);
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

console.log('\n' + passed + ' server tests passed');
