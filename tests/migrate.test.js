/**
 * Schema v2 migration (src/core/migrate.js, docs/schema.md) on a fixture shaped exactly like a v1 spreadsheet:
 * every tab, a board owned by a list, resources with Drive and other addresses, notes, whiteboards, a person's own
 * column and tab, and the rotation, this week's changes and layouts in user properties.
 * Also the tab styles and order, and rows an assistant typed (core/complete.js).
 */
const assert = require('assert');
const { loadServer, sheetCalls } = require('./mocks');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
const json = (x) => JSON.parse(JSON.stringify(x));
const rowsOf = (sh) => sh.rows.slice(1).map((r) => Object.fromEntries(sh.rows[0].map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
const byId = (sh) => Object.fromEntries(rowsOf(sh).map((r) => [r.id, r]));
const copyRows = (ss) => Object.fromEntries(ss.order().map((n) => [n, ss.sheets[n].rows.map((r) => r.slice())]));

const DAY = 86400000;
const weekday = (new Date().getUTCDay() + 6) % 7 + 1;
const MONDAY = new Date(Date.now() - (weekday - 1) * DAY).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const T0 = '2026-10-01T09:00:00.000Z', T1 = '2026-10-20T10:30:00.000Z';

// v1 tabs as the old code wrote them (header row first). Ids are made up.
const V1 = {
  Projects: [
    ['id', 'name', 'category', 'status', 'next_action', 'last_touched', 'created', 'locked_until', 'updated_at', 'my_column'],
    ['p0000001', 'Android MIDI', 'coding', 'active', 'Send note-on', T1, T0, '', T1, 'kept by hand'],
    ['p0000002', 'Bathroom fan', 'house', 'paused', 'Measure the duct', T0, T0, '2099-01-01', T0, '']
  ],
  Columns: [
    ['id', 'project_id', 'name', 'order'],
    ['c0000001', 'p0000001', 'To do', '1'], ['c0000002', 'p0000001', 'Doing', '2'], ['c0000003', 'p0000001', 'Done', '3'],
    ['c0000004', 'p0000002', 'To do', '1'],
    ['g0000001', 'l0000001', 'Watch', '1'], ['g0000002', 'l0000001', 'Read', '2.5']
  ],
  Tasks: [
    ['id', 'project_id', 'column_id', 'title', 'order', 'created', 'color', 'note_html', 'note_text', 'updated_at'],
    ['t0000001', 'p0000001', 'c0000001', 'Draw the pad', '1', T0, '', '', '', T0],
    ['t0000002', 'p0000001', 'c0000002', 'MIDI out', '1.5', T0, '4', '<b>Use</b> USB', 'Use USB', T1],
    ['t0000003', 'l0000001', 'g0000001', 'A film', '1', T0, '', '', '', T0],
    ['t0000004', 'l0000001', 'g0000002', 'A book', '2', T1, '2', 'Chapter <i>3</i>', 'Chapter 3', T1],
    ['t0000005', 'p0000002', 'c0000004', 'Buy fan', '1', T0, '', '', '', T0]
  ],
  Lists: [
    ['id', 'name', 'order', 'show_today', 'created', 'color', 'display', 'seconds'],
    ['l0000001', 'Read and watch', '1', 'yes', T0, '3', 'one', '30']
  ],
  Resources: [
    ['id', 'category', 'project_id', 'title', 'url', 'note', 'added'],
    ['r0000001', 'coding', 'p0000001', 'Design doc', 'https://docs.google.com/document/d/FAKE/edit', 'the plan', T0],
    ['r0000002', 'house', '', 'Fan shop', 'https://example.com/fans', '', T0],
    ['r0000003', 'coding', 'p0000001', 'Samples', 'https://drive.google.com/drive/folders/FAKE', '', T1]
  ],
  Notes: [
    ['id', 'project_id', 'file_id', 'file_url', 'updated'],
    ['n0000001', 'p0000001', 'file-notes-1', 'https://docs.google.com/file/file-notes-1', T1]
  ],
  Whiteboards: [
    ['id', 'project_id', 'file_id', 'file_url', 'updated', 'name', 'created'],
    ['w0000001', 'p0000001', 'file-wb-1', 'https://docs.google.com/file/file-wb-1', T1, 'Pad layout', T0],
    ['w0000002', 'p0000001', 'file-wb-2', 'https://docs.google.com/file/file-wb-2', T0, '', '']
  ],
  Criteria: [
    ['id', 'project_id', 'text', 'done', 'order', 'created', 'updated_at'],
    ['k0000001', 'p0000001', 'Plays a note', 'yes', '1', T0, T1]
  ],
  Log: [
    ['id', 'project_id', 'date', 'where_stopped', 'next_action', 'minutes'],
    ['o0000001', 'p0000001', T1, 'Pad draws', 'Send note-on', '25'],
    ['o0000002', '', T1, 'Conflict: card "x" was changed', '', '0']
  ],
  Categories: [
    ['id', 'label', 'color', 'order'],
    ['coding', 'Coding', '1', '1'], ['job', 'Job search', '2', '2'], ['house', 'House', '3', '3']
  ],
  Stickies: [
    ['id', 'project_id', 'text', 'color', 'opacity', 'x', 'y', 'w', 'h', 'created'],
    ['s0000001', 'p0000001', 'Remember MPE', 'yellow', '0.8', '60', '120', '220', '180', T0]
  ],
  Skips: [['id', 'project_id', 'to_project_id', 'date'], ['x0000001', 'p0000002', 'p0000001', T0]],
  Reminders: [['id', 'project_id', 'due', 'created', 'done'], ['m0000001', 'p0000002', '2026-10-02', T0, '']],
  Undo: [['id', 'created', 'action', 'changes', 'kind'], ['u0000001', T1, 'projects.update', '[{"table":"Tasks","op":"update","id":"t0000001","before":{"note_text":""}}]', '']],
  'My sums': [['what', 'cost'], ['fan', '40']]
};
const V2_NAMES = { Tasks: { note_text: 'note' }, Resources: { url: 'value' }, Whiteboards: { file_url: 'file' } };
const LIST_IDS = ['l0000001'];
const LAYOUT = { today: { focus: { x: 0, y: 0, w: 8 }, 'list-l0000001': { x: 8, y: 0, w: 4 } }, project: { kanban: { x: 0, y: 3, w: 12, hidden: true } } };

/** A server whose personal spreadsheet holds the v1 fixture, as the owner's does before the update. */
function v1Server() {
  const s = loadServer();
  Object.keys(V1).forEach((name) => { s.ss.insertSheet(name).rows = V1[name].map((r) => r.slice()); });
  s.script._m.SHEET_ID = s.ss.getId();
  s.user._m['today.rotation'] = JSON.stringify({ days: { 1: 'coding', 2: 'coding', 3: 'job', 4: null, 5: 'house', 6: 'away', 7: null }, dailyMinimum: 'job' });
  s.user._m['today.week'] = JSON.stringify({ week: MONDAY, days: { [weekday]: 'house' } });
  s.user._m.layout = JSON.stringify(LAYOUT);
  s.user._m['today.state'] = JSON.stringify({ day: TODAY, skipped: [], jobDone: true, session: null });
  ['file-notes-1', 'file-wb-1', 'file-wb-2'].forEach((id) => { s.drive.files[id] = { id, name: id, getId: () => id, getUrl: () => 'https://docs.google.com/file/' + id, getBlob: () => ({ getDataAsString: () => (id.startsWith('file-wb') ? '{"type":"excalidraw","elements":[]}' : '# Notes') }), setContent() {}, setName() {} }; });
  s.boot = (mode) => json(s.run('bootstrap')(mode));
  s.call = (m, fn, args) => json(s.run('rpc')(m, fn, json(args || {})));
  return s;
}

/** Every v1 value is in the v2 tab, under its v2 column name; a list's board moved from project_id to list_id. */
function assertNoDataLost(s) {
  Object.keys(V1).forEach((tab) => {
    if (tab === 'Undo') return;
    const sh = s.ss.sheets[tab];
    assert.ok(sh, 'tab kept: ' + tab);
    const headers = V1[tab][0];
    const now = tab === 'My sums' ? Object.fromEntries(rowsOf(sh).map((r) => [r.what, r])) : byId(sh);
    V1[tab].slice(1).forEach((row) => {
      const key = tab === 'My sums' ? row[0] : row[headers.indexOf('id')];
      const got = now[key];
      assert.ok(got, tab + ' row kept: ' + key);
      headers.forEach((h, i) => {
        const to = (V2_NAMES[tab] || {})[h] || h;
        if ((tab === 'Tasks' || tab === 'Columns') && h === 'project_id' && LIST_IDS.includes(row[i])) {
          assert.strictEqual(got.list_id, row[i], tab + ' ' + key + ': a list owner moves to list_id');
          assert.strictEqual(got.project_id, '', tab + ' ' + key + ': and project_id is empty');
        } else if (to === 'created' && row[i] === '') {
          assert.ok(got[to] === '' || /^\d{4}-\d\d-\d\dT/.test(got[to]), tab + ' ' + key + ': an empty created is filled in when the tab is read'); // docs/schema.md "Rows can be incomplete"
        } else {
          assert.strictEqual(got[to], row[i], tab + ' ' + key + '.' + to);
        }
      });
    });
    assert.strictEqual(rowsOf(sh).length, V1[tab].length - 1, tab + ': no rows added or lost');
  });
}

test('a v1 spreadsheet is backed up, then migrated to v2 with no value lost', () => {
  const s = v1Server();
  const before = copyRows(s.ss);
  const b = s.boot();
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], '2');

  // the backup: a full copy of the v1 sheet, in the mode folder, made before anything changed
  const backups = Object.values(s.drive.files).filter((f) => /backup/.test(f.name));
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(backups[0].name, 'Focus Tracker - Personal - backup before v2 - ' + TODAY);
  assert.strictEqual(s.drive.pathOf(backups[0]), 'Focus Tracker/Personal/' + backups[0].name);
  assert.deepStrictEqual(copyRows(s.spreadsheets[backups[0].id]), before, 'the backup holds the sheet as it was');

  assertNoDataLost(s);
  const sh = s.ss.sheets;
  assert.deepStrictEqual(sh.Projects.rows[0], ['name', 'category', 'status', 'next_action', 'locked_until', 'last_touched', 'notes', 'problem', 'id', 'created', 'updated_at', 'my_column'], 'people columns first, a person\'s own column kept at the end');
  assert.deepStrictEqual(sh.Tasks.rows[0], ['title', 'column', 'project', 'list', 'note', 'color', 'problem', 'id', 'project_id', 'list_id', 'column_id', 'order', 'note_html', 'created', 'updated_at']);
  assert.deepStrictEqual(sh.Columns.rows[0], ['id', 'project_id', 'list_id', 'name', 'order']);
  assert.deepStrictEqual(sh.Lists.rows[0], ['name', 'project', 'show_today', 'display', 'seconds', 'color', 'problem', 'id', 'project_id', 'order', 'created']);
  assert.deepStrictEqual(sh.Resources.rows[0], ['title', 'type', 'value', 'group', 'project', 'category', 'note', 'problem', 'id', 'project_id', 'added']);
  assert.deepStrictEqual(sh.Whiteboards.rows[0], ['name', 'project', 'show_today', 'file', 'updated', 'problem', 'id', 'project_id', 'file_id', 'created']);
  assert.deepStrictEqual(sh.Criteria.rows[0], ['text', 'done', 'project', 'problem', 'id', 'project_id', 'order', 'created', 'updated_at']);
  assert.deepStrictEqual(sh.Log.rows[0], ['date', 'project', 'where_stopped', 'next_action', 'minutes', 'id', 'project_id']);
  assert.deepStrictEqual(sh.Categories.rows[0], ['label', 'color', 'id', 'order']);
  assert.deepStrictEqual(sh.Notes.rows[0], ['id', 'project_id', 'file_id', 'file_url', 'updated', 'doc_id', 'doc_synced', 'doc_seen']);
  assert.deepStrictEqual(sh.Undo.rows, [['id', 'created', 'action', 'changes', 'kind']], 'old undo steps use old columns, so they are cleared');
  assert.deepStrictEqual(sh['My sums'].rows, V1['My sums'], 'a person\'s own tab is not touched');

  // the new readable columns
  const tasks = byId(sh.Tasks);
  assert.deepStrictEqual(['t0000001', 't0000002', 't0000003', 't0000004', 't0000005'].map((id) => [tasks[id].project, tasks[id].list, tasks[id].column]),
    [['Android MIDI', '', 'To do'], ['Android MIDI', '', 'Doing'], ['', 'Read and watch', 'Watch'], ['', 'Read and watch', 'Read'], ['Bathroom fan', '', 'To do']]);
  assert.deepStrictEqual(Object.values(byId(sh.Columns)).map((c) => [c.id, c.project_id, c.list_id]),
    [['c0000001', 'p0000001', ''], ['c0000002', 'p0000001', ''], ['c0000003', 'p0000001', ''], ['c0000004', 'p0000002', ''], ['g0000001', '', 'l0000001'], ['g0000002', '', 'l0000001']]);
  const res = byId(sh.Resources);
  assert.deepStrictEqual(['r0000001', 'r0000002', 'r0000003'].map((id) => [res[id].type, res[id].group, res[id].project]), [['drive', '', 'Android MIDI'], ['link', '', ''], ['drive', '', 'Android MIDI']]);
  const projects = byId(sh.Projects);
  assert.strictEqual(projects.p0000001.notes, 'https://docs.google.com/file/file-notes-1', 'the notes link comes from the Notes tab');
  assert.strictEqual(projects.p0000002.notes, '');
  assert.ok(rowsOf(sh.Projects).every((p) => p.problem === ''));
  assert.deepStrictEqual(rowsOf(sh.Whiteboards).map((w) => [w.project, w.show_today]), [['Android MIDI', ''], ['Android MIDI', '']]);
  assert.deepStrictEqual(rowsOf(sh.Lists).map((l) => [l.project_id, l.project]), [['', '']]);
  assert.deepStrictEqual(rowsOf(sh.Criteria).map((c) => c.project), ['Android MIDI']);
  assert.deepStrictEqual(rowsOf(sh.Log).map((l) => l.project), ['Android MIDI', '']);

  // rotation, this week and layouts are readable rows in Settings now; the session stays in user properties
  const settings = Object.fromEntries(sh.Settings.rows.slice(1));
  assert.deepStrictEqual(settings, {
    'rotation.monday': 'coding', 'rotation.tuesday': 'coding', 'rotation.wednesday': 'job', 'rotation.thursday': 'any',
    'rotation.friday': 'house', 'rotation.saturday': 'away', 'rotation.sunday': 'any', 'rotation.daily_minimum': 'job',
    'week.of': MONDAY, ['week.' + ['', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][weekday]]: 'house',
    'layout.today': JSON.stringify(LAYOUT.today), 'layout.project': JSON.stringify(LAYOUT.project)
  });
  assert.ok(s.user._m['today.rotation'] && s.user._m.layout, 'the old properties are left, so older code still finds them');
  assert.ok(JSON.parse(s.user._m['today.state']).jobDone, 'the day state stays in user properties');

  // and the app reads it all as before
  assert.strictEqual(b.data.today.lead, 'house', 'this week\'s change applies today');
  assert.strictEqual(b.data.today.usual[6], 'away');
  assert.strictEqual(b.data.today.dailyMinimum, 'job');
  assert.deepStrictEqual(b.data.layout, LAYOUT);
  assert.deepStrictEqual(b.data.kanban.tasks.filter((t) => t.owner === 'l0000001').map((t) => t.title), ['A film', 'A book']);
  assert.deepStrictEqual(b.data.kanban.columns.filter((c) => c.owner === 'l0000001').map((c) => c.name), ['Watch', 'Read']);
  assert.deepStrictEqual(b.data.kanban.tasks.find((t) => t.id === 't0000002').note, 'Use USB');
  assert.deepStrictEqual(b.data.resources.map((r) => r.value), V1.Resources.slice(1).map((r) => r[4]));
  assert.deepStrictEqual(b.data.whiteboard.map((w) => [w.name, w.url]), [['Pad layout', 'https://docs.google.com/file/file-wb-1'], ['Whiteboard', 'https://docs.google.com/file/file-wb-2']]);
  assert.deepStrictEqual(b.data.notes, [{ project_id: 'p0000001', url: 'https://docs.google.com/file/file-notes-1', updated: T1, doc: '' }]);
  assert.strictEqual(b.data.projects.length, 2);
  assert.strictEqual(b.data.categories.length, 3);
});

test('tabs are coloured, ordered people first, with a Start here guide; app columns have a grey header', () => {
  const s = v1Server();
  s.boot();
  assert.deepStrictEqual(s.ss.order(), ['Start here', 'Projects', 'Tasks', 'Lists', 'Resources', 'Whiteboards', 'Criteria', 'Log', 'Categories', 'My sums',
    'Columns', 'Notes', 'Stickies', 'Skips', 'Reminders', 'Settings', 'Undo']);
  const spec = Object.fromEntries(json(s.run('TAB_STYLE')).map((t) => [t.name, t]));
  ['Projects', 'Tasks', 'Lists', 'Resources', 'Whiteboards', 'Criteria', 'Log', 'Categories'].forEach((n) => {
    const st = s.ss.sheets[n].style;
    assert.strictEqual(st.tabColor, spec[n].color, n + ' is bright');
    assert.strictEqual(st.frozen, 1, n + ' header frozen');
    assert.ok(st.filter, n + ' has a filter');
    const idCol = s.ss.sheets[n].rows[0].indexOf('id') + 1;
    assert.ok(st.backgrounds.some((b) => b.r === 1 && b.c === idCol && b.c + b.nc - 1 === s.ss.sheets[n].rows[0].length), n + ' app columns have a grey header');
    (spec[n].wrap || []).forEach((h) => assert.ok(st.wraps.some((w) => w.c === s.ss.sheets[n].rows[0].indexOf(h) + 1 && w.on), n + '.' + h + ' wraps'));
  });
  ['Columns', 'Notes', 'Stickies', 'Skips', 'Reminders', 'Settings', 'Undo'].forEach((n) => {
    const st = s.ss.sheets[n].style;
    assert.strictEqual(st.tabColor, '#9e9e9e', n + ' is grey');
    assert.strictEqual(st.notes['1,1'], 'Used by the app. Do not edit.');
    assert.ok(!st.filter);
  });
  assert.strictEqual(s.ss.sheets['My sums'].style.tabColor, undefined, 'a person\'s own tab keeps its look');
  const guide = s.ss.sheets['Start here'].rows.map((r) => r[0]).join('\n');
  ['Projects:', 'Tasks:', 'Resources:', 'Leave id, order and created empty', 'problem column', 'bank or card details', 'AGENTS.md'].forEach((w) => assert.ok(guide.includes(w), 'Start here says ' + w));
});

test('running the migration again changes nothing, and makes no second backup', () => {
  const s = v1Server();
  s.boot();
  const after = copyRows(s.ss), order = s.ss.order(), settings = s.ss.sheets.Settings.rows.map((r) => r.slice());
  delete s.script._m['SCHEMA_VERSION.personal']; // as if the version had not been saved
  s.boot();
  assert.deepStrictEqual(copyRows(s.ss), after);
  assert.deepStrictEqual(s.ss.order(), order);
  s.run('migrateToV2_(getSpreadsheet_())');
  assert.deepStrictEqual(copyRows(s.ss), after, 'running the step itself on v2 data changes nothing');
  assert.deepStrictEqual(s.ss.sheets.Settings.rows, settings);
  assert.strictEqual(Object.values(s.drive.files).filter((f) => /backup/.test(f.name)).length, 1);
  // settings changed in the app after the migration are not put back from the old properties
  s.call('layout', 'reset', { page: 'today' });
  delete s.script._m['SCHEMA_VERSION.personal'];
  assert.deepStrictEqual(Object.keys(s.boot().data.layout), ['project']);
});

test('if the backup fails nothing is changed and the page gets the reason', () => {
  const s = v1Server();
  const before = copyRows(s.ss);
  s.drive.failCopy = true;
  assert.throws(() => s.boot(), /could not be backed up .* nothing was changed/);
  assert.deepStrictEqual(copyRows(s.ss), before);
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], undefined);
  s.drive.failCopy = false;
  s.boot();
  assertNoDataLost(s);
});

test('a failure part way leaves the old tab, and the next load finishes the job', () => {
  const s = v1Server();
  s.ss.failInsert = (name) => name === 'Lists (updating)';
  assert.throws(() => s.boot(), /fake failure inserting Lists/);
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], undefined, 'not marked as done');
  assert.deepStrictEqual(s.ss.sheets.Lists.rows, V1.Lists, 'the tab that failed is untouched');
  ['Resources', 'Whiteboards', 'Log', 'Undo'].forEach((n) => assert.deepStrictEqual(s.ss.sheets[n].rows, V1[n], n + ' not reached yet, untouched'));
  assert.strictEqual(s.ss.sheets.Tasks.rows[0][0], 'title', 'tabs before it are already v2');
  // a half-written new tab from a stopped run is thrown away, not used
  s.ss.failInsert = null;
  s.ss.insertSheet('Lists (updating)').rows = [['junk']];
  s.boot();
  assert.ok(!s.ss.order().some((n) => /updating/.test(n)));
  assertNoDataLost(s);
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], '2');
  assert.strictEqual(Object.values(s.drive.files).filter((f) => /backup/.test(f.name)).length, 1, 'one backup, taken before the first try');
  // a run stopped after the old tab was deleted but before the new one was renamed is finished
  const s2 = v1Server();
  const v2Lists = (() => { const t = v1Server(); t.boot(); return t.ss.sheets.Lists.rows; })();
  s2.ss.deleteSheet(s2.ss.sheets.Lists);
  s2.ss.insertSheet('Lists (updating)').rows = v2Lists.map((r) => r.slice());
  s2.boot();
  assert.deepStrictEqual(s2.ss.sheets.Lists.rows, v2Lists);
  assert.ok(!s2.ss.order().some((n) => /updating/.test(n)));
});

test('after the migration the app works: boards by owner, renames keep names in step, undo, resources', () => {
  const s = v1Server();
  s.boot();
  const listCard = s.call('kanban', 'addTask', { projectId: 'l0000001', title: 'A podcast' }).result;
  assert.deepStrictEqual([listCard.list_id, listCard.project_id, listCard.owner, listCard.list, listCard.column], ['l0000001', '', 'l0000001', 'Read and watch', 'Watch']);
  const card = s.call('kanban', 'addTask', { projectId: 'p0000001', columnId: 'c0000003', title: 'Ship it' }).result;
  assert.deepStrictEqual([card.project_id, card.list_id, card.project, card.column], ['p0000001', '', 'Android MIDI', 'Done']);
  assert.strictEqual(s.call('kanban', 'moveTask', { id: card.id, columnId: 'c0000002' }).result.column, 'Doing', 'moving a card keeps its column name in step');
  assert.throws(() => s.call('kanban', 'moveTask', { id: listCard.id, columnId: 'c0000001' }), /not on this board/);
  const col = s.call('kanban', 'addColumn', { projectId: 'l0000001', name: 'Listen' }).result;
  assert.deepStrictEqual([col.list_id, col.project_id], ['l0000001', '']);
  s.call('kanban', 'moveTask', { id: listCard.id, columnId: col.id });

  s.call('projects', 'update', { id: 'p0000001', name: 'MIDI pad' });
  const sh = s.ss.sheets;
  assert.ok(rowsOf(sh.Tasks).filter((t) => t.project_id === 'p0000001').every((t) => t.project === 'MIDI pad'), 'Tasks.project follows a rename');
  assert.ok(rowsOf(sh.Resources).filter((r) => r.project_id === 'p0000001').every((r) => r.project === 'MIDI pad'));
  ['Whiteboards', 'Criteria', 'Log'].forEach((n) => assert.ok(rowsOf(sh[n]).filter((r) => r.project_id === 'p0000001').every((r) => r.project === 'MIDI pad'), n));
  s.call('lists', 'rename', { id: 'l0000001', name: 'Media' });
  assert.ok(rowsOf(sh.Tasks).filter((t) => t.list_id === 'l0000001').every((t) => t.list === 'Media'));
  s.call('kanban', 'renameColumn', { id: 'c0000002', name: 'In progress' });
  assert.deepStrictEqual(rowsOf(sh.Tasks).filter((t) => t.column_id === 'c0000002').map((t) => t.column), ['In progress', 'In progress']);
  assert.strictEqual(json(s.run('undo')()).undone, 'kanban.renameColumn');
  assert.deepStrictEqual(rowsOf(sh.Tasks).filter((t) => t.column_id === 'c0000002').map((t) => t.column), ['Doing', 'Doing'], 'undo puts the names back too');
  assert.strictEqual(json(s.run('undo')()).undone, 'lists.rename');
  assert.ok(rowsOf(sh.Tasks).filter((t) => t.list_id === 'l0000001').every((t) => t.list === 'Read and watch'));
  assert.strictEqual(json(s.run('redo')()).redone, 'lists.rename');
  assert.ok(rowsOf(sh.Tasks).filter((t) => t.list_id === 'l0000001').every((t) => t.list === 'Media'));

  const r = s.call('resources', 'add', { category: 'house', projectId: 'p0000002', title: 'Manual', url: 'https://drive.google.com/file/d/FAKE/view' }).result;
  assert.deepStrictEqual([r.type, r.value, r.project], ['drive', 'https://drive.google.com/file/d/FAKE/view', 'Bathroom fan']);
  assert.strictEqual(s.call('resources', 'add', { category: 'house', title: 'Shop', url: 'https://example.com/x' }).result.type, 'link');
  const n = s.call('notes', 'save', { projectId: 'p0000002', text: 'Fan notes' }).result;
  assert.strictEqual(byId(sh.Projects).p0000002.notes, n.url, 'a new notes file is linked from the project');
  // an offline edit to a card with a note is settled on the renamed column
  const t2 = byId(sh.Tasks).t0000002;
  const settled = s.call('kanban', 'updateTask', { id: 't0000002', noteHtml: 'Older offline note', _base: '2000-01-01T00:00:00Z', _editedAt: '2000-01-02T00:00:00Z' });
  assert.strictEqual(settled.result, null, 'the stored card is newer, so the offline edit is only logged');
  assert.ok(json(s.run('bootstrap()')).data.log.some((l) => /Older offline note/.test(l.where_stopped)));
  assert.strictEqual(byId(sh.Tasks).t0000002.note, t2.note);
  s.call('lists', 'remove', { id: 'l0000001' });
  assert.ok(!rowsOf(sh.Tasks).some((t) => t.list_id === 'l0000001') && !rowsOf(sh.Columns).some((c) => c.list_id === 'l0000001'), 'a deleted list takes its board');
  assert.strictEqual(rowsOf(sh.Tasks).filter((t) => t.project_id === 'p0000001').length, 3, 'and only its board');
});

test('rows an assistant typed are completed, resolved by name, or flagged with a problem, never deleted', () => {
  const s = v1Server();
  s.boot();
  const sh = s.ss.sheets;
  const add = (tab, obj) => sh[tab].rows.push(sh[tab].rows[0].map((h) => obj[h] || ''));
  add('Projects', { name: 'Garden shed', category: 'House', next_action: 'Get quotes' });
  add('Projects', { name: 'Odd one', category: 'Nope' });
  add('Tasks', { title: 'Wire the pads', project: 'android midi', column: 'Doing', note: 'See https://x.io\nthen test' });
  add('Tasks', { title: 'Lost card', project: 'No such project' });
  add('Tasks', { title: 'A documentary', list: 'Read and watch' });
  add('Tasks', { title: 'First job', project: 'Garden shed' });
  add('Tasks', { title: 'Bad column', project: 'Android MIDI', column: 'Someday' });
  add('Resources', { title: 'Shed plans', value: 'https://drive.google.com/file/d/FAKE', project: 'Garden shed' });
  add('Resources', { title: 'Builder', type: 'phone', value: '01234 567890', category: 'house' });
  add('Criteria', { text: 'Shed is dry', project: 'Garden shed' });
  const b = s.boot();

  const shed = b.data.projects.find((p) => p.name === 'Garden shed');
  assert.ok(shed && /^[0-9a-f]{8}$/.test(shed.id), 'a project row gets an id');
  assert.deepStrictEqual([shed.category, shed.status, shed.next_action, !!shed.created, !!shed.last_touched], ['house', 'active', 'Get quotes', true, true], 'and its defaults; the category label becomes the id');
  const odd = rowsOf(sh.Projects).find((p) => p.name === 'Odd one');
  assert.ok(/No category called "Nope"/.test(odd.problem), 'a row it cannot use gets a reason');
  assert.ok(!b.data.projects.some((p) => p.name === 'Odd one'), 'and is left out of the app');

  const tasks = rowsOf(sh.Tasks);
  const wire = tasks.find((t) => t.title === 'Wire the pads');
  assert.deepStrictEqual([wire.project_id, wire.project, wire.column_id, wire.column, wire.problem], ['p0000001', 'Android MIDI', 'c0000002', 'Doing', ''], 'names become ids, written as the target spells them');
  assert.ok(wire.order && wire.created && wire.id);
  assert.strictEqual(wire.note_html, 'See <a href="https://x.io" target="_blank" rel="noopener noreferrer">https://x.io</a><br>then test', 'the app makes the formatted copy of the note');
  assert.ok(b.data.kanban.tasks.some((t) => t.id === wire.id && t.owner === 'p0000001'));
  const doc = tasks.find((t) => t.title === 'A documentary');
  assert.deepStrictEqual([doc.list_id, doc.column_id, doc.column, doc.project_id], ['l0000001', 'g0000001', 'Watch', ''], 'no column means the first one');
  const first = tasks.find((t) => t.title === 'First job');
  assert.strictEqual(first.project_id, shed.id, 'a project typed in the same load is found');
  const shedCols = rowsOf(sh.Columns).filter((c) => c.project_id === shed.id);
  assert.deepStrictEqual(shedCols.map((c) => [c.name, c.id === first.column_id]), [['To do', true]], 'a board with no columns gets one');
  assert.ok(/No project called "No such project"/.test(tasks.find((t) => t.title === 'Lost card').problem));
  assert.ok(/No column called "Someday".*Use one of: To do, Doing, Done/.test(tasks.find((t) => t.title === 'Bad column').problem));
  assert.ok(!b.data.kanban.tasks.some((t) => t.title === 'Lost card' || t.title === 'Bad column'));

  const res = rowsOf(sh.Resources);
  const plans = res.find((r) => r.title === 'Shed plans');
  assert.deepStrictEqual([plans.type, plans.project_id, plans.category, plans.problem, !!plans.added], ['drive', shed.id, 'house', '', true]);
  assert.deepStrictEqual(res.find((r) => r.title === 'Builder').problem, '', 'a phone number is a resource too');
  assert.strictEqual(rowsOf(sh.Criteria).find((c) => c.text === 'Shed is dry').project_id, shed.id);

  // fixing the row clears the problem; deleting its project in the app never deletes the typed row
  const lost = sh.Tasks.rows.find((r) => r.includes('Lost card'));
  lost[sh.Tasks.rows[0].indexOf('project')] = 'Bathroom fan';
  const b2 = s.boot();
  const fixed = rowsOf(sh.Tasks).find((t) => t.title === 'Lost card');
  assert.deepStrictEqual([fixed.problem, fixed.project_id, fixed.column], ['', 'p0000002', 'To do']);
  assert.ok(b2.data.kanban.tasks.some((t) => t.title === 'Lost card'));
  s.call('projects', 'remove', { id: 'p0000001' });
  const bad = rowsOf(sh.Tasks).find((t) => t.title === 'Bad column');
  assert.ok(bad, 'a flagged row is never deleted by the app');
  assert.ok(/No project with id p0000001/.test(bad.problem), 'and now says its project is gone');
});

test('checking typed rows costs no sheet call when nothing is missing', () => {
  const s = v1Server();
  s.boot();
  s.boot(); // the first load after the migration fills the empty created of an old whiteboard
  const before = copyRows(s.ss);
  let n0 = sheetCalls.n; s.boot(); const withCheck = sheetCalls.n - n0;
  s.run('completeRows_ = function () {}');
  n0 = sheetCalls.n; s.boot(); const without = sheetCalls.n - n0;
  assert.strictEqual(withCheck, without);
  assert.deepStrictEqual(copyRows(s.ss), before, 'and writes nothing');
});

test('each mode migrates on its own, when it is first opened', () => {
  const s = v1Server();
  const work = s.run("SpreadsheetApp.create('Focus Tracker - Work')");
  s.script._m['SHEET_ID.work'] = work.getId();
  ['Projects', 'Categories'].forEach((n) => { work.insertSheet(n).rows = V1[n].map((r) => r.slice()); });
  s.user._m['layout.work'] = JSON.stringify({ today: { focus: { x: 0, y: 0, w: 6 } } });
  s.boot('work');
  assert.strictEqual(s.script._m['SCHEMA_VERSION.work'], '2');
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], undefined, 'the personal sheet waits until it is opened');
  assert.deepStrictEqual(s.ss.sheets.Projects.rows, V1.Projects);
  assert.deepStrictEqual(work.sheets.Projects.rows[0].slice(0, 3), ['name', 'category', 'status']);
  assert.deepStrictEqual(Object.fromEntries(work.sheets.Settings.rows.slice(1)), { 'layout.today': '{"focus":{"x":0,"y":0,"w":6}}' }, 'the work layout, not the personal one');
  const backup = Object.values(s.drive.files).find((f) => /backup/.test(f.name));
  assert.strictEqual(s.drive.pathOf(backup), 'Focus Tracker/Work/Focus Tracker - Work - backup before v2 - ' + TODAY);
  s.boot();
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], '2');
});

test('migrateAllModes, run from the editor, migrates every mode that has a spreadsheet and makes none', () => {
  const s = v1Server();
  const sheetsBefore = Object.keys(s.spreadsheets).length;
  s.run('migrateAllModes()');
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], '2');
  assert.strictEqual(s.script._m['SCHEMA_VERSION.work'], undefined);
  assert.strictEqual(Object.keys(s.spreadsheets).length, sheetsBefore + 1, 'only the backup is new');
  assert.ok(s.mock.logs.some((l) => l === 'Personal: spreadsheet layout 1 -> 2'));
  assertNoDataLost(s);
});

test('a row with a name shared by two targets is flagged, not guessed', () => {
  const s = v1Server();
  s.boot();
  s.call('projects', 'create', { name: 'Android MIDI', category: 'coding' });
  const sh = s.ss.sheets.Tasks;
  sh.rows.push(sh.rows[0].map((h) => ({ title: 'Which one', project: 'Android MIDI' })[h] || ''));
  s.boot();
  assert.ok(/2 projects are called "Android MIDI"\. Put the right id in project_id/.test(rowsOf(sh).find((t) => t.title === 'Which one').problem));
});

test('a new spreadsheet starts at v2; tabs made later by a module get their colour and place from TAB_STYLE', () => {
  const s = loadServer();
  s.run('setup()');
  assert.strictEqual(s.script._m['SCHEMA_VERSION.personal'], '2');
  assert.strictEqual(Object.values(s.drive.files).filter((f) => /backup/.test(f.name)).length, 0, 'nothing to back up');
  assert.deepStrictEqual(s.ss.order(), ['Start here', 'Projects', 'Tasks', 'Lists', 'Resources', 'Whiteboards', 'Criteria', 'Log', 'Categories',
    'Columns', 'Notes', 'Stickies', 'Skips', 'Reminders']);
  s.run("new Table('Habits', ['name', 'intention', 'problem', 'id', 'order']).ensure()");
  s.run("new Table('Thumbs', ['whiteboard_id', 'image', 'updated']).ensure()");
  s.run("new Table('To-dos', ['title', 'day', 'problem', 'id']).ensure()");
  s.ss.insertSheet('Mine');
  s.run("new Table('Links', ['from', 'type', 'to', 'problem', 'id']).ensure()");
  json(s.run('bootstrap()')); // makes Settings and Undo when first used
  json(s.run('rpc')('projects', 'create', { name: 'A', category: 'coding' }));
  assert.deepStrictEqual(s.ss.order(), ['Start here', 'Projects', 'Tasks', 'Lists', 'Resources', 'Habits', 'To-dos', 'Whiteboards', 'Links', 'Criteria', 'Log', 'Categories',
    'Columns', 'Notes', 'Stickies', 'Skips', 'Reminders', 'Thumbs', 'Mine', 'Settings', 'Undo'], 'a person\'s own tab stays where it was put; app tabs go after it');
  assert.strictEqual(s.ss.sheets.Habits.style.tabColor, '#e53935');
  assert.ok(s.ss.sheets.Habits.style.filter);
  assert.strictEqual(s.ss.sheets.Thumbs.style.tabColor, '#9e9e9e');
  assert.deepStrictEqual(s.ss.sheets.Habits.style.backgrounds.map((b) => [b.c, b.nc]), [[4, 2]], 'the grey header starts at id');
});

console.log(passed + ' migration tests passed');
