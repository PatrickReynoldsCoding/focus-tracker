/**
 * The spreadsheet layout (docs/schema.md), in one place: which tabs are for people and which only the app uses, their
 * order and colours, which columns wrap, and how a row typed by a person or an AI assistant is completed and checked.
 *
 * People tabs are bright and first. App tabs are grey and last. In a people tab the columns from `id` on are app
 * columns and get a grey header. A tab that is not here yet (made by a later module) gets its style and place from
 * this list the moment Table.ensure creates it, so adding a tab is one line here and one Table in its module.
 *
 * complete (people tabs only, see core/complete.js):
 *   refs     a row points at another row by id and shows its name: { id, name, table, label, noun, within, first, create }
 *            label: the target's name column (default 'name'); within: the target must share these ids with the row
 *            (a card's column must be on the card's board); first: an empty name and id means the first target by
 *            order; create: a board with no columns gets one, so an assistant's card always has somewhere to go (the name
 *            for an unnamed one); starter: { owner id column: names } a board of that kind starts with all of these, as
 *            if it had been made in the app (a column named that is not among them is added after them).
 *   required columns a usable row must have
 *   oneOf    exactly one of these must be set
 *   fill     defaults for a new row (no id yet); 'now' is the time, 'next' one more than the largest in the tab
 *   html     [plain, html]: an assistant writes the plain text and the app makes the formatted copy
 *   check    function (row, look) returning a problem or '' (look(table) gives that tab's usable rows)
 */

var APP_TAB_COLOR_ = '#9e9e9e';
var APP_HEADER_BACKGROUND_ = '#e0e0e0';
var APP_HEADER_FONT_ = '#616161';
var APP_TAB_NOTE_ = 'Used by the app. Do not edit.';
var WRAP_WIDTH_ = 280;

var PROJECT_STATUSES_ = ['active', 'paused', 'done', 'archived'];
var RESOURCE_TYPES_ = ['link', 'drive', 'phone', 'email', 'text'];
var HABIT_PERS_ = ['day', 'week'];
var HABIT_STATUSES_ = ['active', 'paused', 'ended', 'aspiring']; // aspiring: an idea, not started yet (no sessions needed)
var LINK_TYPES_ = ['blocks', 'relates'];
// A project's board starts with these columns: made by the app for a new project, and for a project an assistant typed in.
var BOARD_COLUMNS_ = ['To do', 'Doing', 'Done'];

/** A word from a fixed set, typed by hand ("Active ", "Blocks"), as the app writes it. Changes row in place. */
function lowerWord_(row, key) {
  if (typeof row[key] === 'string' && row[key]) row[key] = row[key].trim().toLowerCase();
}

/** A Google Drive or Docs address is a Drive file; any other address is a link. */
function resourceTypeFor_(value) {
  return /^https:\/\/(docs|drive)\.google\.com\//i.test(String(value || '')) ? 'drive' : 'link';
}

/** A category id, or the id of the category with this label (assistants type "Coding" for "coding"). '' if neither. */
function categoryIdFor_(value, categories) {
  var v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  var hit = categories.filter(function (c) { return c.id.toLowerCase() === v; })[0] ||
    categories.filter(function (c) { return String(c.label).trim().toLowerCase() === v; })[0];
  return hit ? hit.id : '';
}

function checkCategory_(row, look, required) {
  if (!row.category && !required) return '';
  var id = categoryIdFor_(row.category, look('Categories'));
  if (!id) return row.category ? 'No category called "' + row.category + '". Use one from the Categories tab.' : 'Needs a category from the Categories tab.';
  row.category = id;
  return '';
}

var PROJECT_REF_ = { id: 'project_id', name: 'project', table: 'Projects' };

var TAB_STYLE = [
  { name: 'Start here', people: true, color: '#ff9800' },
  { name: 'Projects', people: true, color: '#1e88e5', wrap: ['name', 'next_action', 'problem'],
    complete: { required: ['name'], fill: { status: 'active', next_action: 'Decide the first small step', last_touched: 'now', created: 'now' },
      check: function (row, look) {
        lowerWord_(row, 'status');
        if (row.status && PROJECT_STATUSES_.indexOf(row.status) === -1) return 'Status must be one of: ' + PROJECT_STATUSES_.join(', ') + '.';
        // Never guess between two projects with one name: rows elsewhere point at projects by name.
        if (look('Projects').some(function (p) { return p.id !== row.id && sameName_(p.name, row.name); })) {
          return 'There is already a project called "' + String(row.name).trim() + '". To change it, edit that row; for a new project, use another name.';
        }
        return checkCategory_(row, look, true);
      } } },
  { name: 'Tasks', people: true, color: '#43a047', wrap: ['title', 'note', 'problem'],
    complete: { required: ['title'], fill: { order: 'next', created: 'now' }, oneOf: ['project_id', 'list_id'], html: ['note', 'note_html'],
      refs: [PROJECT_REF_, { id: 'list_id', name: 'list', table: 'Lists' },
        { id: 'column_id', name: 'column', table: 'Columns', within: ['project_id', 'list_id'], first: true, create: 'To do', starter: { project_id: BOARD_COLUMNS_ } }] } },
  { name: 'Lists', people: true, color: '#fdd835', wrap: ['name', 'problem'],
    complete: { required: ['name'], fill: { order: 'next', created: 'now' }, refs: [PROJECT_REF_] } },
  { name: 'Resources', people: true, color: '#8e24aa', wrap: ['title', 'value', 'note', 'problem'],
    complete: { required: ['title', 'value'], fill: { added: 'now' }, refs: [PROJECT_REF_],
      check: function (row, look) {
        lowerWord_(row, 'type');
        if (!row.type) row.type = /^https:\/\//i.test(row.value) ? resourceTypeFor_(row.value) : 'text';
        if (RESOURCE_TYPES_.indexOf(row.type) === -1) return 'Type must be one of: ' + RESOURCE_TYPES_.join(', ') + '.';
        if ((row.type === 'link' || row.type === 'drive') && !/^https:\/\//i.test(row.value)) return 'A link needs a full address that starts with https://';
        if (!row.category && row.project_id) {
          var project = look('Projects').filter(function (p) { return p.id === row.project_id; })[0];
          if (project) row.category = project.category;
        }
        return checkCategory_(row, look, true);
      } } },
  { name: 'Habits', people: true, color: '#e53935', wrap: ['name', 'intention', 'description', 'problem'],
    complete: { required: ['name'], fill: { order: 'next', started: 'now', status: 'active', per: 'week', sessions: '1', prompts: 'off' },
      check: function (row, look) {
        ['per', 'status', 'prompts'].forEach(function (k) { lowerWord_(row, k); });
        if (row.per && HABIT_PERS_.indexOf(row.per) === -1) return 'Per must be day or week.';
        var n = Number(row.sessions);
        if (row.sessions !== '' && row.sessions !== undefined && !(Math.floor(n) === n && n >= 1)) return 'Sessions must be a whole number, 1 or more.';
        if (row.status && HABIT_STATUSES_.indexOf(row.status) === -1) return 'Status must be one of: ' + HABIT_STATUSES_.join(', ') + '.';
        if (row.prompts && ['on', 'off', 'at goal'].indexOf(row.prompts) === -1) return 'Prompts must be on, off or at goal.';
        if (row.status === 'aspiring') { row.started = ''; row.next_prompt = ''; return checkCategory_(row, look, false); } // starts in the app, with its level
        if (row.prompts === 'on' && !row.next_prompt && row.step_up_every) row.next_prompt = String(row.started || nowIso_()).slice(0, 10);
        return checkCategory_(row, look, false);
      } } },
  { name: 'To-dos', people: true, color: '#00897b', wrap: ['title', 'note', 'problem'],
    complete: { required: ['title'], fill: { order: 'next', created: 'now' }, refs: [PROJECT_REF_] } },
  { name: 'Whiteboards', people: true, color: '#5e35b1', wrap: ['name', 'problem'],
    complete: { required: ['name'], fill: { created: 'now' }, refs: [PROJECT_REF_],
      check: function (row) { return row.file_id ? '' : 'Whiteboards are made in the app (it makes the drawing file). Delete this row or make the whiteboard there.'; } } },
  { name: 'Links', people: true, color: '#3949ab', wrap: ['note', 'problem'],
    complete: { required: ['type'], fill: { created: 'now' },
      refs: [{ id: 'from_id', name: 'from', table: 'Projects', noun: 'project' }, { id: 'to_id', name: 'to', table: 'Projects', noun: 'project' }],
      check: function (row) {
        lowerWord_(row, 'type');
        if (LINK_TYPES_.indexOf(row.type) === -1) return 'Type must be blocks or relates.';
        if (!row.from_id || !row.to_id) return 'Needs a project in both from and to.';
        return row.from_id === row.to_id ? 'A project cannot be linked to itself.' : '';
      } } },
  { name: 'Criteria', people: true, color: '#7cb342', wrap: ['text', 'problem'],
    complete: { required: ['text', 'project_id'], fill: { order: 'next', created: 'now' }, refs: [PROJECT_REF_] } },
  { name: 'Log', people: true, color: '#d81b60', wrap: ['where_stopped', 'next_action'],
    complete: { fill: { date: 'now', minutes: '0' }, refs: [PROJECT_REF_] } },
  { name: 'Categories', people: true, color: '#00acc1',
    complete: { required: ['label'], fill: { order: 'next', color: '1' } } },
  { name: 'Columns' },
  // An app tab, so never completed; the ref keeps the habit's name next to its id when a habit is renamed.
  { name: 'Habit log', complete: { refs: [{ id: 'habit_id', name: 'habit', table: 'Habits', noun: 'habit' }] } },
  { name: 'Notes' },
  { name: 'Stickies' },
  { name: 'Skips' },
  { name: 'Reminders' },
  { name: 'Thumbs' },
  { name: 'Settings' },
  { name: 'Undo' }
];

function tabSpec_(name) {
  for (var i = 0; i < TAB_STYLE.length; i++) if (TAB_STYLE[i].name === name) return TAB_STYLE[i];
  return null;
}

function tabRank_(name) {
  for (var i = 0; i < TAB_STYLE.length; i++) if (TAB_STYLE[i].name === name) return i;
  return -1;
}

/** Header bold and frozen; tab colour; on people tabs a grey header over the app columns, a filter and wrapped long columns. */
function styleTab_(sh, headers) {
  var width = Math.max(headers.length, 1);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(1);
  var spec = tabSpec_(sh.getName());
  if (!spec) return;
  if (!spec.people) {
    sh.setTabColor(APP_TAB_COLOR_);
    sh.getRange(1, 1, 1, width).setBackground(APP_HEADER_BACKGROUND_).setFontColor(APP_HEADER_FONT_);
    sh.getRange(1, 1).setNote(APP_TAB_NOTE_);
    return;
  }
  sh.setTabColor(spec.color);
  var appFrom = headers.indexOf('id');
  if (appFrom !== -1) sh.getRange(1, appFrom + 1, 1, headers.length - appFrom).setBackground(APP_HEADER_BACKGROUND_).setFontColor(APP_HEADER_FONT_);
  if (spec.complete && !sh.getFilter()) sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), width).createFilter();
  (spec.wrap || []).forEach(function (h) {
    var c = headers.indexOf(h);
    if (c === -1) return;
    sh.getRange(1, c + 1, Math.max(sh.getMaxRows(), 1), 1).setWrap(true);
    sh.setColumnWidth(c + 1, WRAP_WIDTH_);
  });
}

/** Put a new tab in its place: after the last tab that comes before it in TAB_STYLE (an app tab: after every other tab too). */
function placeTab_(ss, sh) {
  var rank = tabRank_(sh.getName());
  if (rank === -1) return;
  var people = tabSpec_(sh.getName()).people;
  var sheets = ss.getSheets(), after = 0;
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName() === sh.getName()) continue;
    var other = tabRank_(sheets[i].getName());
    // An app tab also goes after a person's own tabs; a people tab only after the people tabs before it.
    if (other !== -1 ? other < rank : !people) after = i + 1;
  }
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(Math.min(after + 1, sheets.length));
}

/** Every tab in order: people tabs first, then tabs the app does not know (a person's own), then app tabs. Run by the migration. */
function orderTabs_(ss) {
  var byName = {};
  ss.getSheets().forEach(function (sh) { byName[sh.getName()] = sh; });
  var position = 1;
  TAB_STYLE.forEach(function (spec) {
    if (!spec.people || !byName[spec.name]) return;
    ss.setActiveSheet(byName[spec.name]);
    ss.moveActiveSheet(position++);
  });
  TAB_STYLE.forEach(function (spec) {
    if (spec.people || !byName[spec.name]) return;
    ss.setActiveSheet(byName[spec.name]);
    ss.moveActiveSheet(ss.getSheets().length);
  });
  if (byName['Start here']) ss.setActiveSheet(byName['Start here']);
}

/** Write (or rewrite) the Start here tab, the short version of the guide for assistants (core/guide.js): one column, first in the sheet. */
function writeStartHere_(ss) {
  var text = guideShortLines_();
  var lines = text.map(function (line) { return [line]; });
  var sh = ss.getSheetByName('Start here');
  var created = !sh;
  if (created) sh = ss.insertSheet('Start here');
  var lastRow = sh.getLastRow();
  if (lastRow > lines.length) sh.getRange(lines.length + 1, 1, lastRow - lines.length, 1).clearContent();
  sh.getRange(1, 1, lines.length, 1).setValues(lines);
  sh.getRange(1, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 900);
  sh.setTabColor(tabSpec_('Start here').color);
  if (created) placeTab_(ss, sh);
  // refreshGuide_ (core/guide.js) rewrites the tab only when this changes
  PropertiesService.getScriptProperties().setProperty('START_HERE_HASH.' + modeId_(), textHash_(text.join('\n')));
}
