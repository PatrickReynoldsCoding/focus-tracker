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
  assert.deepStrictEqual(s.ss.sheets.Projects.rows[0], ['id', 'name', 'category', 'status', 'next_action', 'last_touched', 'created']);
  assert.ok(s.script._m.FOLDER_ID && s.script._m.SHEET_ID);
});

test('creating a project validates input and gives it default Kanban columns', () => {
  const s = fresh();
  assert.throws(() => s.call('projects', 'create', { name: '  ', category: 'coding' }), /needs a name/);
  assert.throws(() => s.call('projects', 'create', { name: 'x', category: 'nope' }), /Unknown category/);
  const r = s.call('projects', 'create', { name: 'Loft', category: 'house', next_action: 'Get quotes' });
  assert.strictEqual(r.result.name, 'Loft');
  assert.deepStrictEqual(Object.keys(r.slices).sort(), ['kanban', 'projects', 'today']);
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

test('notes are stored as a markdown file and read back', () => {
  const s = fresh();
  const p = s.call('projects', 'create', { name: 'My Project!', category: 'coding' }).result;
  assert.deepStrictEqual(s.call('notes', 'get', { projectId: p.id }).result, { text: '', url: '' });
  const saved = s.call('notes', 'save', { projectId: p.id, text: '# hello' }).result;
  assert.ok(saved.url);
  s.call('notes', 'save', { projectId: p.id, text: '# hello again' });
  assert.strictEqual(s.call('notes', 'get', { projectId: p.id }).result.text, '# hello again');
  const mdFiles = Object.values(s.drive.files).filter((f) => f.name.endsWith('.md'));
  const file = mdFiles[0];
  assert.ok(/^my-project-[0-9a-f]{8}\.md$/.test(file.name), file.name);
  assert.strictEqual(file.mime, 'text/markdown');
  assert.strictEqual(mdFiles.length, 1, 'second save updates the same file');
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

test('rpc rejects unknown modules and functions, and bootstrap returns every slice', () => {
  const s = fresh();
  assert.throws(() => s.call('nope', 'x'), /not installed/);
  assert.throws(() => s.call('projects', 'nope'), /no api function/);
  const b = json(s.run('bootstrap()'));
  assert.deepStrictEqual(Object.keys(b.data).sort(), ['categories', 'kanban', 'layout', 'lists', 'log', 'notes', 'projects', 'resources', 'today']);
  assert.strictEqual(b.modules.length, 9);
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

console.log('\n' + passed + ' server tests passed');
