/**
 * Conflicts for edits that waited offline. A browser that lost its connection keeps its edits and sends them later,
 * each with the updated_at it had seen for the row (_base) and the moment the edit was made (_editedAt).
 * If the row has been changed since (another device), the newest edit wins and the older version is kept:
 * a line in the Log for rows, a conflict copy file for project notes. Edits sent straight away carry no _base and skip all this.
 * Not covered: columns, lists themselves, sticky notes, whiteboards, resources, categories, the Today state (last write wins).
 */

// api call -> table, the fields the call changes (argument name -> row field), and how to name the row.
var CONFLICT_TARGETS_ = {
  'projects.update': { table: 'Projects', fields: { name: 'name', category: 'category', status: 'status', next_action: 'next_action' }, owner: 'self', label: function (r) { return 'project "' + r.name + '"'; } },
  'kanban.updateTask': { table: 'Tasks', fields: { title: 'title', color: 'color', noteHtml: 'note_text' }, owner: 'project_id', label: function (r) { return 'card "' + r.title + '"'; } },
  'kanban.moveTask': { table: 'Tasks', fields: { columnId: 'column_id', order: 'order' }, owner: 'project_id', label: function (r) { return 'card "' + r.title + '"'; } },
  'criteria.update': { table: 'Criteria', fields: { text: 'text', done: 'done', order: 'order' }, owner: 'project_id', label: function (r) { return 'criterion "' + r.text + '"'; } }
};

// Conflicts found while the current request runs, sent back to the browser with the reply.
var requestConflicts_ = [];

function reportConflict_(conflict) {
  requestConflicts_.push(conflict);
}

function startConflictReport_() {
  requestConflicts_ = [];
}

function timeOf_(iso) {
  var t = Date.parse(iso || '');
  return isNaN(t) ? 0 : t;
}

function shortValue_(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ');
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function describeValues_(pairs) {
  return pairs.map(function (p) { return p[0] + '="' + shortValue_(p[1]) + '"'; }).join(', ') || 'no field changes';
}

/**
 * Called before a conflict-checked api call. Returns null when there is nothing to settle (no _base, a call that is
 * not checked, or the row has not changed), or { skip, version } where skip means the stored row is newer and the edit was not applied.
 * Settling writes the Log line, so it must run inside the request's change journal.
 */
function settleConflict_(moduleId, fn, args, ctx) {
  var target = CONFLICT_TARGETS_[moduleId + '.' + fn];
  if (!target || !args || args._base === undefined || args.id === undefined) return null;
  var row = new Table(target.table, ['id']).get(args.id);
  if (!row || !row.updated_at || row.updated_at === String(args._base)) return null;
  var serverNewer = timeOf_(row.updated_at) >= timeOf_(args._editedAt);
  var yours = [], theirs = [];
  Object.keys(target.fields).forEach(function (k) {
    if (args[k] === undefined) return;
    yours.push([target.fields[k], k === 'noteHtml' ? String(args[k]).replace(/<[^>]*>/g, ' ') : args[k]]);
    theirs.push([target.fields[k], row[target.fields[k]]]);
  });
  var name = target.label(row);
  var text = serverNewer
    ? 'Conflict: ' + name + ' was changed on another device after your offline edit, so the newer version was kept. Your edit was: ' + describeValues_(yours)
    : 'Conflict: ' + name + ' was changed on another device, but your offline edit was newer and replaced it. The other version was: ' + describeValues_(theirs);
  var projectId = '';
  if (target.owner === 'self') projectId = row.id;
  else if (ctx.call('projects', 'list', {}).some(function (p) { return p.id === row[target.owner]; })) projectId = row[target.owner];
  ctx.optional('log', 'conflict', { projectId: projectId, text: text });
  reportConflict_({ what: name, kept: serverNewer ? 'server' : 'yours' });
  return { skip: serverNewer, version: row.updated_at };
}

/** The row's updated_at after a checked call, so the browser can chain its next queued edit to the new version. */
function versionAfter_(moduleId, fn, args) {
  var target = CONFLICT_TARGETS_[moduleId + '.' + fn];
  if (!target || !args || args.id === undefined) return '';
  var row = new Table(target.table, ['id']).get(args.id);
  return row ? row.updated_at || '' : '';
}
