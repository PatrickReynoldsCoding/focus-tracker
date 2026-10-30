/**
 * Undo. Every browser call records its row changes (see the change journal in sheetdb.js). If it changed rows, the
 * changes are saved in the mode's Undo tab, newest last, and undo() puts the newest one back. Only sheet rows are
 * undone: notes and whiteboard files in Drive and the Today session are not, so those calls are not offered for undo.
 *
 * Redo: undoing a change records the opposite change (the journal runs while the rows are put back), and that is kept in
 * the same tab as a row with kind 'redo'. redo() puts it back and returns the change to the undo list. Any new change
 * clears the redo rows.
 */

var UNDO_KEEP_ = 30;
var UNDO_MAX_LENGTH_ = 45000; // a sheet cell holds 50,000 characters
// Calls whose row changes are bookkeeping, not something a person would undo.
var NOT_UNDOABLE_ = { 'notes.save': 1, 'notes.syncDoc': 1, 'notes.checkDoc': 1, 'whiteboard.save': 1 };

// Made when needed: Table is defined in another file, and Apps Script does not promise the order files load in.
function undoTable_() {
  return new Table('Undo', ['id', 'created', 'action', 'changes', 'kind']);
}

/** Save one call's changes for undo. Returns { id, action } or null when there is nothing to undo. */
function saveUndo_(action, changes) {
  if (!changes.length || NOT_UNDOABLE_[action]) return null;
  var json = JSON.stringify(changes);
  if (json.length > UNDO_MAX_LENGTH_) return null;
  var table = undoTable_();
  table.removeWhere(function (r) { return r.kind === 'redo'; }); // a new change ends the redo list
  var row = table.insert({ created: nowIso_(), action: action, changes: json, kind: '' });
  var all = table.all();
  if (all.length > UNDO_KEEP_ + 10) {
    var keep = {};
    all.slice(-UNDO_KEEP_).forEach(function (r) { keep[r.id] = true; });
    table.removeWhere(function (r) { return !keep[r.id]; });
  }
  return { id: row.id, action: action };
}

/** The newest row of a kind ('redo' or the plain undo rows), or null. */
function newestUndoRow_(all, kind) {
  for (var i = all.length - 1; i >= 0; i--) {
    if ((all[i].kind === 'redo') === (kind === 'redo')) return all[i];
  }
  return null;
}

/**
 * Put rows back as in `changes` while recording what that did, so it can be reversed again.
 * Returns the opposite changes (a redo for an undo, the original change for a redo).
 */
function applyAndInvert_(changes) {
  return withChangeJournal_(function () { revertChanges_(changes); }).changes;
}

/** Put back the newest saved change. Returns its action name, or null when there is nothing left to undo. */
function undoLast_() {
  var table = undoTable_();
  return withLock_(function () {
    var last = newestUndoRow_(table.all(), 'undo');
    if (!last) return null;
    var inverse = applyAndInvert_(JSON.parse(last.changes));
    table.remove(last.id);
    var json = JSON.stringify(inverse);
    if (inverse.length && json.length <= UNDO_MAX_LENGTH_) table.insert({ created: nowIso_(), action: last.action, changes: json, kind: 'redo' });
    return last.action;
  });
}

/** Do again the change that was just undone. Returns its action name, or null when there is nothing to redo. */
function redoLast_() {
  var table = undoTable_();
  return withLock_(function () {
    var last = newestUndoRow_(table.all(), 'redo');
    if (!last) return null;
    var inverse = applyAndInvert_(JSON.parse(last.changes));
    table.remove(last.id);
    var json = JSON.stringify(inverse);
    if (inverse.length && json.length <= UNDO_MAX_LENGTH_) table.insert({ created: nowIso_(), action: last.action, changes: json, kind: '' });
    return last.action;
  });
}
