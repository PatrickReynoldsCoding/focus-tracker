/**
 * Undo. Every browser call records its row changes (see the change journal in sheetdb.js). If it changed rows, the
 * changes are saved in the mode's Undo tab, newest last, and undo() puts the newest one back. Only sheet rows are
 * undone: notes and whiteboard files in Drive and the Today session are not, so those calls are not offered for undo.
 */

var UNDO_KEEP_ = 30;
var UNDO_MAX_LENGTH_ = 45000; // a sheet cell holds 50,000 characters
// Calls whose row changes are bookkeeping, not something a person would undo.
var NOT_UNDOABLE_ = { 'notes.save': 1, 'whiteboard.save': 1 };

// Made when needed: Table is defined in another file, and Apps Script does not promise the order files load in.
function undoTable_() {
  return new Table('Undo', ['id', 'created', 'action', 'changes']);
}

/** Save one call's changes for undo. Returns { id, action } or null when there is nothing to undo. */
function saveUndo_(action, changes) {
  if (!changes.length || NOT_UNDOABLE_[action]) return null;
  var json = JSON.stringify(changes);
  if (json.length > UNDO_MAX_LENGTH_) return null;
  var table = undoTable_();
  var row = table.insert({ created: nowIso_(), action: action, changes: json });
  var all = table.all();
  if (all.length > UNDO_KEEP_ + 10) {
    var keep = {};
    all.slice(-UNDO_KEEP_).forEach(function (r) { keep[r.id] = true; });
    table.removeWhere(function (r) { return !keep[r.id]; });
  }
  return { id: row.id, action: action };
}

/** Put back the newest saved change. Returns its action name, or null when there is nothing left to undo. */
function undoLast_() {
  var table = undoTable_();
  return withLock_(function () {
    var all = table.all();
    var last = all[all.length - 1];
    if (!last) return null;
    revertChanges_(JSON.parse(last.changes));
    table.remove(last.id);
    return last.action;
  });
}
