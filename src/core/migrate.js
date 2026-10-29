/**
 * Spreadsheet layout versions (docs/schema.md "How the migration runs").
 * Each mode's version is in a script property, SCHEMA_VERSION.<mode id>; no property means version 1 (the layout
 * before v2). The first request that opens a mode after an update (bootstrap, rpc, undo, redo, setup) brings its
 * spreadsheet up to date under the script lock. Steps run in order and each is safe to run again: running a step on a
 * sheet it has already changed changes nothing.
 *
 * Before the first step the mode's spreadsheet is copied into the mode folder. If the copy fails nothing is changed and
 * the error goes back to the page. Each tab is rewritten whole: the new table is built in memory, written to a new tab in
 * one setValues, then the old tab is deleted and the new one renamed, so a failure part way leaves the old tab in place.
 * The headers below are the v2 layout as it was released; later changes are new steps, not edits here.
 */

var SCHEMA_VERSION = 2;

var SCHEMA_STEPS_ = [
  { to: 2, run: migrateToV2_ }
];

// Tabs that mean a spreadsheet already holds app data. A spreadsheet with none of them is new and starts at the latest version.
var V1_TABS_ = ['Projects', 'Tasks', 'Columns', 'Lists', 'Resources', 'Notes', 'Whiteboards', 'Criteria', 'Log', 'Categories', 'Stickies', 'Skips', 'Reminders', 'Undo'];

var V2_HEADERS_ = {
  Projects: ['name', 'category', 'status', 'next_action', 'locked_until', 'last_touched', 'notes', 'problem', 'id', 'created', 'updated_at'],
  Tasks: ['title', 'column', 'project', 'list', 'note', 'color', 'problem', 'id', 'project_id', 'list_id', 'column_id', 'order', 'note_html', 'created', 'updated_at'],
  Lists: ['name', 'project', 'show_today', 'display', 'seconds', 'color', 'problem', 'id', 'project_id', 'order', 'created'],
  Resources: ['title', 'type', 'value', 'group', 'project', 'category', 'note', 'problem', 'id', 'project_id', 'added'],
  Whiteboards: ['name', 'project', 'show_today', 'file', 'updated', 'problem', 'id', 'project_id', 'file_id', 'created'],
  Criteria: ['text', 'done', 'project', 'problem', 'id', 'project_id', 'order', 'created', 'updated_at'],
  Log: ['date', 'project', 'where_stopped', 'next_action', 'minutes', 'id', 'project_id'],
  Categories: ['label', 'color', 'id', 'order'],
  Columns: ['id', 'project_id', 'list_id', 'name', 'order'],
  Notes: ['id', 'project_id', 'file_id', 'file_url', 'updated', 'doc_id'],
  Stickies: ['id', 'project_id', 'text', 'color', 'opacity', 'x', 'y', 'w', 'h', 'created'],
  Skips: ['id', 'project_id', 'to_project_id', 'date'],
  Reminders: ['id', 'project_id', 'due', 'created', 'done'],
  Undo: ['id', 'created', 'action', 'changes', 'kind']
};

// v2 column <- v1 column. The old column is not kept: its values moved.
var V2_RENAMES_ = { Tasks: { note: 'note_text' }, Resources: { value: 'url' }, Whiteboards: { file: 'file_url' } };

function schemaVersionKey_() {
  return 'SCHEMA_VERSION.' + modeId_();
}

function schemaVersion_() {
  return Number(PropertiesService.getScriptProperties().getProperty(schemaVersionKey_()) || 1);
}

/** Bring the active mode's spreadsheet up to SCHEMA_VERSION. One property read when it already is. */
function ensureSchema_() {
  if (schemaVersion_() >= SCHEMA_VERSION) return;
  var props = PropertiesService.getScriptProperties();
  withLock_(function () {
    var version = schemaVersion_();
    if (version >= SCHEMA_VERSION) return;
    var ss = getSpreadsheet_();
    if (!V1_TABS_.some(function (name) { return ss.getSheetByName(name); })) {
      writeStartHere_(ss);
      props.setProperty(schemaVersionKey_(), String(SCHEMA_VERSION));
      return;
    }
    SCHEMA_STEPS_.forEach(function (step) {
      if (version >= step.to) return;
      step.run(ss);
      version = step.to;
      props.setProperty(schemaVersionKey_(), String(version));
    });
  });
  tableCache_ = {}; // tabs were replaced: read them again
}

/** Copy the spreadsheet into the mode folder once per target version. Throws, changing nothing, if Drive refuses. */
function backupBeforeMigration_(ss, label) {
  var props = PropertiesService.getScriptProperties();
  var key = 'SCHEMA_BACKUP.' + label + '.' + modeId_();
  if (props.getProperty(key)) return;
  var name = APP_NAME + ' - ' + activeMode_().label + ' - backup before ' + label + ' - ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var copy;
  try {
    copy = DriveApp.getFileById(ss.getId()).makeCopy(name, getModeFolder_());
  } catch (e) {
    throw new Error('The spreadsheet could not be backed up before updating it to the new layout, so nothing was changed. Try again in a minute. (' + (e && e.message ? e.message : e) + ')');
  }
  props.setProperty(key, copy.getId());
}

function tmpTabName_(name) {
  return name + ' (updating)';
}

/** A rewrite that stopped between deleting the old tab and renaming the new one: finish it. */
function recoverTab_(ss, name) {
  var tmp = ss.getSheetByName(tmpTabName_(name));
  if (!tmp) return;
  if (ss.getSheetByName(name)) ss.deleteSheet(tmp); // the old tab is still there: the new one was never finished
  else tmp.setName(name);
}

/** Replace a tab with values ([headers, ...rows]) safely. Returns the new sheet. */
function rewriteTab_(ss, name, values) {
  var tmpName = tmpTabName_(name);
  var stale = ss.getSheetByName(tmpName);
  if (stale) ss.deleteSheet(stale);
  var width = values[0].length, height = values.length;
  var sh = ss.insertSheet(tmpName);
  if (sh.getMaxRows() < height + 1) sh.insertRowsAfter(sh.getMaxRows(), height + 1 - sh.getMaxRows());
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  sh.getRange(1, 1, sh.getMaxRows(), width).setNumberFormat('@');
  sh.getRange(1, 1, height, width).setValues(values);
  var old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  sh.setName(name);
  return sh;
}

/** A tab's values with blank rows left out, or null when there is no such tab. */
function readTabValues_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return null;
  var all = readAll_(sh);
  return [all[0]].concat(all.slice(1).filter(function (r) { return r.some(function (v) { return !cellEmpty_(v); }); }));
}

function objectsOf_(values) {
  return values.slice(1).map(function (r) { return rawRow_(values[0], r); });
}

/**
 * Lay a v1 (or already v2) tab out as v2. change(o) fills the v2 columns of one row (o: plain text by header).
 * Columns the app does not know (a person's own) are kept, after the v2 columns, with their values.
 */
function v2Table_(name, values, change) {
  var headers = V2_HEADERS_[name], renames = V2_RENAMES_[name] || {};
  var old = values[0], consumed = {};
  Object.keys(renames).forEach(function (to) { if (old.indexOf(to) === -1 && old.indexOf(renames[to]) !== -1) consumed[renames[to]] = to; });
  var extra = [];
  old.forEach(function (h, i) { if (headers.indexOf(h) === -1 && !consumed[h] && (h || values.slice(1).some(function (r) { return !cellEmpty_(r[i]); }))) extra.push(i); });
  var out = [headers.concat(extra.map(function (i) { return old[i]; }))];
  values.slice(1).forEach(function (r) {
    var o = rawRow_(old, r);
    Object.keys(consumed).forEach(function (from) { o[consumed[from]] = o[from]; });
    if (change) change(o);
    out.push(headers.map(function (h) { return o[h] === undefined ? '' : String(o[h]); })
      .concat(extra.map(function (i) { return r[i] === null || r[i] === undefined ? '' : String(r[i]); })));
  });
  return out;
}

function sameValues_(a, b) {
  if (!a || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (var j = 0; j < a[i].length; j++) if (String(a[i][j]) !== String(b[i][j])) return false;
  }
  return true;
}

function nameIndex_(rows, label) {
  var out = {};
  rows.forEach(function (r) { if (r.id) out[r.id] = r[label || 'name'] || ''; });
  return out;
}

/** v1 to v2, docs/schema.md "What changes from today". */
function migrateToV2_(ss) {
  Object.keys(V2_HEADERS_).forEach(function (name) { recoverTab_(ss, name); });
  backupBeforeMigration_(ss, 'v2');

  var values = {};
  Object.keys(V2_HEADERS_).forEach(function (name) { values[name] = readTabValues_(ss, name); });
  var rows = {};
  Object.keys(values).forEach(function (name) { rows[name] = values[name] ? objectsOf_(values[name]) : []; });

  var isList = {};
  rows.Lists.forEach(function (l) { if (l.id) isList[l.id] = true; });
  var projectName = nameIndex_(rows.Projects), listName = nameIndex_(rows.Lists), columnName = nameIndex_(rows.Columns);
  var notesUrl = {};
  rows.Notes.forEach(function (n) { if (n.project_id && !notesUrl[n.project_id]) notesUrl[n.project_id] = n.file_url; });

  // A board's owner was kept in project_id; an owner that is a list goes to list_id.
  function splitOwner(o) {
    if (cellEmpty_(o.list_id) && isList[o.project_id]) { o.list_id = o.project_id; o.project_id = ''; }
  }
  function name(o, field, idField, index) {
    o[field] = index[o[idField]] !== undefined && o[idField] ? index[o[idField]] : (o[field] || '');
  }
  var change = {
    Projects: function (o) { if (!o.notes) o.notes = notesUrl[o.id] || ''; },
    Tasks: function (o) {
      splitOwner(o);
      name(o, 'project', 'project_id', projectName);
      name(o, 'list', 'list_id', listName);
      name(o, 'column', 'column_id', columnName);
    },
    Columns: splitOwner,
    Lists: function (o) { name(o, 'project', 'project_id', projectName); },
    Resources: function (o) {
      if (!o.type) o.type = /^https:\/\//i.test(o.value || '') ? resourceTypeFor_(o.value) : (o.value ? 'text' : '');
      name(o, 'project', 'project_id', projectName);
    },
    Whiteboards: function (o) { name(o, 'project', 'project_id', projectName); },
    Criteria: function (o) { name(o, 'project', 'project_id', projectName); },
    Log: function (o) { name(o, 'project', 'project_id', projectName); }
  };

  // Everything is built before anything is written, so a mistake in the data stops the migration before it starts.
  var next = {};
  Object.keys(V2_HEADERS_).forEach(function (tab) {
    if (!values[tab]) return;
    next[tab] = tab === 'Undo' ? [V2_HEADERS_.Undo] : v2Table_(tab, values[tab], change[tab]); // old undo steps use old columns
  });
  Object.keys(next).forEach(function (tab) {
    if (!sameValues_(values[tab], next[tab])) rewriteTab_(ss, tab, next[tab]);
  });

  migrateSettingsToSheet_();

  tableCache_ = {};
  ss.getSheets().forEach(function (sh) {
    if (!tabSpec_(sh.getName()) || sh.getName() === 'Start here') return;
    styleTab_(sh, sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String));
  });
  writeStartHere_(ss);
  orderTabs_(ss);
}

/**
 * Rotation, this week's changes and layouts move from the user's properties into the Settings tab. A setting already
 * in the tab is kept (it is newer). The old properties are left as they were, so older code still finds them.
 */
function migrateSettingsToSheet_() {
  var user = PropertiesService.getUserProperties();
  function json(key) {
    var raw = user.getProperty(modeKey_(key));
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  var values = {};
  var rotation = json('today.rotation'), week = json('today.week'), layout = json('layout');
  if (rotation && rotation.days) {
    Object.keys(WEEKDAY_NAMES_).forEach(function (day) { values['rotation.' + WEEKDAY_NAMES_[day]] = dayPlanText_(rotation.days[day]); });
  }
  if (rotation && Object.prototype.hasOwnProperty.call(rotation, 'dailyMinimum')) values['rotation.daily_minimum'] = rotation.dailyMinimum || 'none';
  if (week && week.week) {
    values['week.of'] = week.week;
    Object.keys(week.days || {}).forEach(function (day) { if (WEEKDAY_NAMES_[day]) values['week.' + WEEKDAY_NAMES_[day]] = dayPlanText_(week.days[day]); });
  }
  Object.keys(layout || {}).forEach(function (page) { values['layout.' + page] = JSON.stringify(layout[page]); });
  var existing = settingsWithPrefix_('', true); // a setting cleared in the app is a choice too
  Object.keys(values).forEach(function (key) { if (existing[key] !== undefined) delete values[key]; });
  setSettings_(values);
}

/** A day of the rotation as Settings text: a category id, away, or any. */
function dayPlanText_(value) {
  return value === null || value === undefined || value === '' ? 'any' : String(value);
}
