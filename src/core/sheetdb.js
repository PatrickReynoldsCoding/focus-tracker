/**
 * Tiny table layer over a Google Sheet tab. One tab per table, header row on row 1.
 * Every cell is stored as plain text, so dates stay as ISO strings and ids never turn into numbers.
 * Columns are matched by header name, so you can reorder columns or add your own by hand.
 */

// Spreadsheets opened during this request, by mode id. Opening one is slow and every table read needs it.
var openSpreadsheets_ = {};

/** The active mode's spreadsheet. A mode other than the first gets a new spreadsheet in its folder on first use. */
function getSpreadsheet_() {
  if (!openSpreadsheets_[modeId_()]) openSpreadsheets_[modeId_()] = openModeSpreadsheet_();
  return openSpreadsheets_[modeId_()];
}

function openModeSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var key = modeKey_('SHEET_ID');
  var id = props.getProperty(key);
  if (id) return SpreadsheetApp.openById(id);
  if (modeId_() === MODES[0].id) {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) throw new Error('No spreadsheet linked yet. Open the Apps Script editor and run setup() once.');
    return active;
  }
  return withLock_(function () {
    var again = props.getProperty(key);
    if (again) return SpreadsheetApp.openById(again);
    var ss = SpreadsheetApp.create(APP_NAME + ' - ' + activeMode_().label);
    var folder = getModeFolder_();
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    props.setProperty(key, ss.getId());
    return ss;
  });
}

/**
 * @param {string} name     tab name
 * @param {string[]} headers column names; the first must be 'id'
 * @param {string[]=} numeric column names that hold numbers
 */
function Table(name, headers, numeric) {
  this.name = name;
  this.headers = headers;
  this.numeric = numeric || [];
}

/** Returns the sheet, creating it and any missing columns first. */
Table.prototype.ensure = function () {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(this.name);
  if (!sh) {
    sh = ss.insertSheet(this.name);
    sh.getRange(1, 1, 1, this.headers.length).setValues([this.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), this.headers.length).setNumberFormat('@');
    return sh;
  }
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = this.headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    var start = existing.filter(Boolean).length + 1;
    sh.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
    sh.getRange(2, start, Math.max(sh.getMaxRows() - 1, 1), missing.length).setNumberFormat('@');
  }
  return sh;
};

// Tabs already read in this request, by mode and tab name: { sh, headers, rows, fresh }. Sheet calls are the slow
// part of every request, so a tab is read once and writes keep this copy in step with the sheet. rows mirrors the
// sheet's rows 2..n exactly, so row i is sheet row i + 2. fresh is true once the tab was read while holding the lock.
var tableCache_ = {};

function tableCacheKey_(name) {
  return modeId_() + ':' + name;
}

/** The tab's header and rows. forWrite: read again under the lock once per request, so another device's writes are kept. */
Table.prototype.read_ = function (forWrite) {
  var key = tableCacheKey_(this.name), cached = tableCache_[key];
  if (cached && (!forWrite || cached.fresh)) return cached;
  var sh = cached ? cached.sh : getSpreadsheet_().getSheetByName(this.name) || this.ensure();
  var all = readAll_(sh);
  if (!cached && this.headers.some(function (h) { return all[0].indexOf(h) === -1; })) {
    this.ensure();
    all = readAll_(sh);
  }
  tableCache_[key] = { sh: sh, headers: all[0], rows: all.slice(1), fresh: !!forWrite };
  return tableCache_[key];
};

/** Header and rows in one read: [headers, row, row, ...]. */
function readAll_(sh) {
  var lastRow = Math.max(sh.getLastRow(), 1), lastCol = Math.max(sh.getLastColumn(), 1);
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  values[0] = values[0].map(String);
  return values;
}

Table.prototype.toObject_ = function (headers, row) {
  var obj = {};
  for (var i = 0; i < headers.length; i++) {
    if (!headers[i]) continue;
    var v = row[i];
    if (this.numeric.indexOf(headers[i]) !== -1) v = Number(v) || 0;
    else v = v === null || v === undefined ? '' : String(v);
    obj[headers[i]] = v;
  }
  return obj;
};

/** A stored row as plain text by header, the way the sheet holds it, for undo. */
function rawRow_(headers, row) {
  var obj = {};
  headers.forEach(function (h, i) { if (h) obj[h] = row[i] === null || row[i] === undefined ? '' : String(row[i]); });
  return obj;
}

Table.prototype.all = function () {
  var d = this.read_(), self = this;
  return d.rows
    .map(function (r) { return self.toObject_(d.headers, r); })
    .filter(function (o) { return o.id; });
};

Table.prototype.get = function (id) {
  var all = this.all();
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
};

Table.prototype.rowFor_ = function (headers, obj) {
  var record = {};
  this.headers.forEach(function (h) { record[h] = obj[h] === undefined ? '' : obj[h]; });
  Object.keys(obj).forEach(function (h) { if (record[h] === undefined) record[h] = obj[h]; });
  record.id = obj.id || newId_();
  return headers.map(function (h) { return record[h] === undefined ? '' : record[h]; });
};

/** obj.id may be given (the browser makes ids for instant updates); an id that is already used is refused. */
Table.prototype.insert = function (obj) {
  return this.insertMany([obj])[0];
};

/** Insert several rows with one write. Returns the inserted rows in order. */
Table.prototype.insertMany = function (objs) {
  var self = this;
  if (!objs.length) return [];
  return withLock_(function () {
    var d = self.read_(true);
    var idCol = d.headers.indexOf('id');
    var taken = {};
    d.rows.forEach(function (r) { taken[String(r[idCol])] = true; });
    var rows = objs.map(function (obj) {
      var row = self.rowFor_(d.headers, obj);
      assert_(!taken[row[idCol]], 'That item already exists: ' + row[idCol]);
      taken[row[idCol]] = true;
      return row;
    });
    d.sh.getRange(d.rows.length + 2, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
    rows.forEach(function (row) {
      d.rows.push(row);
      recordChange_({ table: self.name, op: 'insert', id: String(row[idCol]) });
    });
    return rows.map(function (row) { return self.toObject_(d.headers, row); });
  });
};

Table.prototype.update = function (id, patch) {
  var self = this;
  return withLock_(function () {
    var d = self.read_(true);
    var idCol = d.headers.indexOf('id');
    for (var i = 0; i < d.rows.length; i++) {
      if (String(d.rows[i][idCol]) !== id) continue;
      var before = d.rows[i], row = before.slice();
      Object.keys(patch).forEach(function (k) {
        var c = d.headers.indexOf(k);
        if (c !== -1) row[c] = patch[k];
      });
      d.sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
      d.rows[i] = row;
      recordChange_({ table: self.name, op: 'update', id: id, before: rawRow_(d.headers, before) });
      return self.toObject_(d.headers, row);
    }
    throw new Error('Not found in ' + self.name + ': ' + id);
  });
};

Table.prototype.remove = function (id) {
  var self = this;
  return withLock_(function () {
    var d = self.read_(true);
    var idCol = d.headers.indexOf('id');
    for (var i = 0; i < d.rows.length; i++) {
      if (String(d.rows[i][idCol]) === id) { self.deleteAt_(d, i); return true; }
    }
    return false;
  });
};

/** Remove every row for which predicate(rowObject) is true. Returns how many were removed. */
Table.prototype.removeWhere = function (predicate) {
  var self = this;
  return withLock_(function () {
    var d = self.read_(true);
    var removed = 0;
    for (var i = d.rows.length - 1; i >= 0; i--) {
      if (predicate(self.toObject_(d.headers, d.rows[i]))) { self.deleteAt_(d, i); removed++; }
    }
    return removed;
  });
};

Table.prototype.deleteAt_ = function (d, i) {
  recordChange_({ table: this.name, op: 'remove', row: rawRow_(d.headers, d.rows[i]) });
  d.sh.deleteRow(i + 2);
  d.rows.splice(i, 1);
};

// ---------- change journal (for undo) ----------
// While a browser call runs, every row change is recorded here so the whole call can be undone. null when not recording.
var changeJournal_ = null;

function recordChange_(change) {
  if (changeJournal_) changeJournal_.push(change);
}

/** Run fn while recording row changes. Returns { result, changes }. */
function withChangeJournal_(fn) {
  changeJournal_ = [];
  try {
    var result = fn();
    return { result: result, changes: changeJournal_ };
  } finally {
    changeJournal_ = null;
  }
}

/** Put rows back as they were before the recorded changes, newest change first. */
function revertChanges_(changes) {
  changes.slice().reverse().forEach(function (c) {
    if (c.op === 'insert') new Table(c.table, ['id']).remove(c.id);
    else if (c.op === 'update') new Table(c.table, ['id']).update(c.id, c.before);
    else if (c.op === 'remove') new Table(c.table, Object.keys(c.row)).insertMany([c.row]);
  });
}

// How many withLock_ calls are open in this request, so a locked step can call another without waiting on itself.
var lockDepth_ = 0;

function withLock_(fn) {
  if (lockDepth_ > 0) return fn();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  lockDepth_++;
  try { return fn(); } finally { lockDepth_--; lock.releaseLock(); }
}
