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
  const file = Object.values(s.drive.files)[0];
  assert.ok(/^my-project-[0-9a-f]{8}\.md$/.test(file.name), file.name);
  assert.strictEqual(file.mime, 'text/markdown');
  assert.strictEqual(Object.keys(s.drive.files).length, 1, 'second save updates the same file');
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

test('rpc rejects unknown modules and functions, and bootstrap returns every slice', () => {
  const s = fresh();
  assert.throws(() => s.call('nope', 'x'), /not installed/);
  assert.throws(() => s.call('projects', 'nope'), /no api function/);
  const b = json(s.run('bootstrap()'));
  assert.deepStrictEqual(Object.keys(b.data).sort(), ['kanban', 'log', 'notes', 'projects', 'resources', 'today']);
  assert.strictEqual(b.modules.length, 6);
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
