/**
 * Rows a person or an AI assistant typed into a people tab (docs/schema.md "Rows can be incomplete").
 * Run by Table.read_ on every tab with a `complete` rule in TAB_STYLE (core/schema.js):
 *  - a row with content but no id gets an id, and order and created (and the tab's other defaults) when they are empty;
 *  - a name with no id (Tasks.project filled, project_id empty) gets the id when exactly one row has that name;
 *  - a row the app cannot use keeps everything typed in it, gets the reason in its problem cell and is left out of
 *    Table.all() until it is fixed; once it is fixed the problem is cleared.
 * Rows are never deleted here. The check is in memory and needs no sheet call when nothing is missing; when something
 * is, the tab is read again under the lock and the changed rows go back in one write. These writes are not recorded
 * for undo: undoing them would take away what the assistant typed.
 *
 * Names next to ids are kept in step by Table: an insert or update that sets an id fills its name (fillNames_), and
 * renaming a row rewrites the name in every tab that points at it, one write per tab (syncNames_).
 */

// Tabs being completed right now, so a lookup into the same tab does not start again.
var completing_ = {};

function cellEmpty_(v) {
  return v === '' || v === null || v === undefined;
}

/** Tabs whose refs point at `target`: [{ tab, ref }]. */
function refsTo_(target) {
  var out = [];
  TAB_STYLE.forEach(function (spec) {
    ((spec.complete && spec.complete.refs) || []).forEach(function (ref) { if (ref.table === target) out.push({ tab: spec.name, ref: ref }); });
  });
  return out;
}

/** The usable rows of a tab, or [] when the tab does not exist (a lookup never creates a tab). */
function lookRows_(name) {
  if (!tableCache_[tableCacheKey_(name)] && !getSpreadsheet_().getSheetByName(name)) return [];
  return new Table(name, ['id']).all();
}

/** Does this raw row need completing or checking? Only in-memory work. */
function rowNeedsCompleting_(rule, col, row) {
  var content = false;
  for (var h in col) {
    if (h !== 'id' && h !== 'problem' && !cellEmpty_(row[col[h]])) { content = true; break; }
  }
  if (!content) return false;
  if (cellEmpty_(row[col.id])) return true;
  if (col.problem !== undefined && !cellEmpty_(row[col.problem])) return true;
  var fill = rule.fill || {};
  if (fill.order !== undefined && col.order !== undefined && cellEmpty_(row[col.order])) return true;
  if (fill.created !== undefined && col.created !== undefined && cellEmpty_(row[col.created])) return true;
  var refs = rule.refs || [];
  for (var i = 0; i < refs.length; i++) {
    var ci = col[refs[i].id], ni = col[refs[i].name];
    if (ci !== undefined && ni !== undefined && cellEmpty_(row[ci]) && !cellEmpty_(row[ni])) return true;
  }
  if (rule.html && col[rule.html[0]] !== undefined && col[rule.html[1]] !== undefined && !cellEmpty_(row[col[rule.html[0]]]) && cellEmpty_(row[col[rule.html[1]]])) return true;
  return false;
}

function columnIndex_(headers) {
  var col = {};
  headers.forEach(function (h, i) { if (h && col[h] === undefined) col[h] = i; });
  return col;
}

function anyRowNeedsCompleting_(rule, headers, rows) {
  var col = columnIndex_(headers);
  if (col.id === undefined) return false;
  for (var i = 0; i < rows.length; i++) if (rowNeedsCompleting_(rule, col, rows[i])) return true;
  return false;
}

function sameName_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/** Called by Table.read_ with the tab's cached copy d ({ sh, headers, rows, fresh }). Changes d in place. */
function completeRows_(table, d) {
  var spec = tabSpec_(table.name);
  if (!spec || !spec.people || !spec.complete || completing_[table.name]) return;
  var rule = spec.complete;
  if (!anyRowNeedsCompleting_(rule, d.headers, d.rows)) return;
  completing_[table.name] = true;
  try {
    withLock_(function () {
      if (!d.fresh) {
        var all = readAll_(d.sh);
        d.headers = all[0]; d.rows = all.slice(1); d.fresh = true;
      }
      completeFresh_(table.name, rule, d);
    });
  } finally {
    completing_[table.name] = false;
  }
}

function completeFresh_(name, rule, d) {
  var col = columnIndex_(d.headers);
  if (col.id === undefined) return;
  var looked = {};
  function look(tab) {
    if (!looked[tab]) looked[tab] = lookRows_(tab);
    return looked[tab];
  }
  var nextOrder = null;
  function next() {
    if (nextOrder === null) nextOrder = d.rows.reduce(function (m, r) { return Math.max(m, Number(r[col.order]) || 0); }, 0);
    return ++nextOrder;
  }
  var first = -1, last = -1;
  d.rows.forEach(function (row, i) {
    if (!rowNeedsCompleting_(rule, col, row)) return;
    var o = rawRow_(d.headers, row);
    var problem = completeRow_(rule, o, look, next, function (tab) { delete looked[tab]; });
    if (col.problem !== undefined) o.problem = problem;
    var changed = false;
    d.headers.forEach(function (h, c) {
      if (h && o[h] !== undefined && String(o[h]) !== String(row[c] === null || row[c] === undefined ? '' : row[c])) { row[c] = o[h]; changed = true; }
    });
    if (!changed) return;
    if (first === -1) first = i;
    last = i;
  });
  if (first === -1) return;
  var width = d.headers.length;
  var span = d.rows.slice(first, last + 1).map(function (r) {
    var out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out.map(function (v) { return v === null || v === undefined ? '' : v; });
  });
  d.sh.getRange(first + 2, 1, span.length, width).setNumberFormat('@').setValues(span);
}

/** Fill in and check one row (o: plain text by header, changed in place). Returns the problem, or ''. */
function completeRow_(rule, o, look, next, forget) {
  var isNew = cellEmpty_(o.id);
  if (isNew) o.id = newId_();
  Object.keys(rule.fill || {}).forEach(function (k) {
    if (o[k] === undefined || !cellEmpty_(o[k])) return;
    if (!isNew && k !== 'order' && k !== 'created') return;
    var v = rule.fill[k];
    o[k] = v === 'now' ? nowIso_() : v === 'next' ? next() : v;
  });
  // A row with an id and no problem was made by the app (or is from before a column existed): fill it, never judge it.
  var unresolved = (rule.refs || []).some(function (ref) { return o[ref.id] !== undefined && cellEmpty_(o[ref.id]) && !cellEmpty_(o[ref.name]); });
  if (!isNew && cellEmpty_(o.problem) && !unresolved) return '';
  var problem = '';
  (rule.refs || []).forEach(function (ref) {
    if (problem || o[ref.id] === undefined || o[ref.name] === undefined) return;
    problem = resolveRef_(ref, o, look, forget);
  });
  (rule.required || []).forEach(function (h) {
    if (!problem && o[h] !== undefined && cellEmpty_(String(o[h]).trim())) problem = 'Needs ' + h.replace(/_id$/, '').replace(/_/g, ' ') + '.';
  });
  if (!problem && rule.oneOf) {
    var set = rule.oneOf.filter(function (h) { return !cellEmpty_(o[h]); });
    var words = rule.oneOf.map(function (h) { return h.replace(/_id$/, ''); }).join(' or a ');
    if (!set.length) problem = 'Needs a ' + words + '.';
    else if (set.length > 1) problem = 'Has both a ' + words + '. Keep one.';
  }
  if (!problem && rule.check) problem = rule.check(o, look) || '';
  if (!problem && rule.html && !cellEmpty_(o[rule.html[0]]) && cellEmpty_(o[rule.html[1]])) o[rule.html[1]] = plainToRichText_(o[rule.html[0]]);
  return problem;
}

/** Point a row at its target by name, fill the name from the id, or pick the first target. Returns a problem or ''. */
function resolveRef_(ref, o, look, forget) {
  var label = ref.label || 'name', noun = ref.noun || ref.name;
  var targets = look(ref.table);
  var scoped = !ref.within;
  if (ref.within) {
    var keys = ref.within.filter(function (w) { return !cellEmpty_(o[w]); });
    if (!keys.length) return ''; // no board yet: the owner check reports it
    scoped = true;
    targets = targets.filter(function (t) { return keys.every(function (w) { return t[w] === o[w]; }); });
  }
  if (!cellEmpty_(o[ref.id])) {
    var byId = targets.filter(function (t) { return t.id === o[ref.id]; })[0];
    if (!byId) return 'No ' + noun + ' with id ' + o[ref.id] + (ref.within ? ' on this board.' : '.');
    if (cellEmpty_(o[ref.name])) o[ref.name] = byId[label];
    return '';
  }
  if (!cellEmpty_(o[ref.name])) {
    var hits = targets.filter(function (t) { return sameName_(t[label], o[ref.name]); });
    if (hits.length === 1) { o[ref.id] = hits[0].id; o[ref.name] = hits[0][label]; return ''; }
    if (hits.length > 1) return hits.length + ' ' + noun + 's are called "' + o[ref.name] + '". Put the right id in ' + ref.id + '.';
    if (ref.create && scoped && !targets.length) return createTarget_(ref, o, o[ref.name], forget);
    var known = targets.slice(0, 8).map(function (t) { return t[label]; });
    return 'No ' + noun + ' called "' + o[ref.name] + '".' + (ref.within && known.length ? ' Use one of: ' + known.join(', ') + '.' : '');
  }
  if (ref.first) {
    if (targets.length) {
      var firstTarget = targets.slice().sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); })[0];
      o[ref.id] = firstTarget.id; o[ref.name] = firstTarget[label];
      return '';
    }
    if (ref.create && scoped) return createTarget_(ref, o, ref.create, forget);
  }
  return '';
}

/** A board with no columns gets one, so a card an assistant added has somewhere to go. Not recorded for undo. */
function createTarget_(ref, o, name, forget) {
  if (!tableCache_[tableCacheKey_(ref.table)] && !getSpreadsheet_().getSheetByName(ref.table)) return 'Open the app once, so it can make the ' + ref.table + ' tab.';
  var row = { id: newId_(), name: name, order: 1 };
  (ref.within || []).forEach(function (w) { row[w] = o[w] || ''; });
  appendRaw_(ref.table, row);
  forget(ref.table);
  o[ref.id] = row.id; o[ref.name] = name;
  return '';
}

/** Add a row with one write, outside the undo journal. */
function appendRaw_(name, obj) {
  withLock_(function () {
    var d = new Table(name, ['id']).read_(true);
    var row = d.headers.map(function (h) { return obj[h] === undefined ? '' : String(obj[h]); });
    d.sh.getRange(d.rows.length + 2, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    d.rows.push(row);
  });
}

/** Before an insert or update: for each id being set whose name is not given, the target's name. Changes obj in place. */
function fillNames_(tableName, headers, obj) {
  var spec = tabSpec_(tableName);
  ((spec && spec.complete && spec.complete.refs) || []).forEach(function (ref) {
    if (obj[ref.id] === undefined || obj[ref.name] !== undefined || headers.indexOf(ref.name) === -1) return;
    if (cellEmpty_(obj[ref.id])) { obj[ref.name] = ''; return; }
    var hit = lookRows_(ref.table).filter(function (t) { return t.id === obj[ref.id]; })[0];
    if (hit) obj[ref.name] = hit[ref.label || 'name'];
  });
}

/** After a row of `target` got a new name: write it into every tab that shows it next to the id. One write per tab touched. */
function syncNames_(target, id, label, value) {
  refsTo_(target).forEach(function (link) {
    if ((link.ref.label || 'name') !== label) return;
    if (!tableCache_[tableCacheKey_(link.tab)] && !getSpreadsheet_().getSheetByName(link.tab)) return;
    var d = new Table(link.tab, ['id']).read_(true);
    var ci = d.headers.indexOf(link.ref.id), ni = d.headers.indexOf(link.ref.name);
    if (ci === -1 || ni === -1) return;
    var first = -1, last = -1;
    d.rows.forEach(function (r, i) {
      if (String(r[ci]) !== id || String(r[ni]) === value) return;
      r[ni] = value;
      if (first === -1) first = i;
      last = i;
    });
    if (first === -1) return;
    var span = d.rows.slice(first, last + 1).map(function (r) { return [r[ni] === null || r[ni] === undefined ? '' : r[ni]]; });
    d.sh.getRange(first + 2, ni + 1, span.length, 1).setNumberFormat('@').setValues(span);
  });
}
