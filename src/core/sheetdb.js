/**
 * Tiny table layer over a Google Sheet tab. One tab per table, header row on row 1.
 * Every cell is stored as plain text, so dates stay as ISO strings and ids never turn into numbers.
 * Columns are matched by header name, so you can reorder columns or add your own by hand.
 */

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('No spreadsheet linked yet. Open the Apps Script editor and run setup() once.');
  return active;
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

Table.prototype.read_ = function () {
  var sh = this.ensure();
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  return { sh: sh, headers: headers, rows: rows };
};

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

Table.prototype.insert = function (obj) {
  var self = this;
  return withLock_(function () {
    var d = self.read_();
    var record = {};
    self.headers.forEach(function (h) { record[h] = obj[h] === undefined ? '' : obj[h]; });
    record.id = obj.id || newId_();
    var row = d.headers.map(function (h) { return record[h] === undefined ? '' : record[h]; });
    d.sh.getRange(d.sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    return self.toObject_(d.headers, row);
  });
};

Table.prototype.update = function (id, patch) {
  var self = this;
  return withLock_(function () {
    var d = self.read_();
    var idCol = d.headers.indexOf('id');
    for (var i = 0; i < d.rows.length; i++) {
      if (String(d.rows[i][idCol]) !== id) continue;
      var row = d.rows[i].slice();
      Object.keys(patch).forEach(function (k) {
        var c = d.headers.indexOf(k);
        if (c !== -1) row[c] = patch[k];
      });
      d.sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
      return self.toObject_(d.headers, row);
    }
    throw new Error('Not found in ' + self.name + ': ' + id);
  });
};

Table.prototype.remove = function (id) {
  var self = this;
  return withLock_(function () {
    var d = self.read_();
    var idCol = d.headers.indexOf('id');
    for (var i = 0; i < d.rows.length; i++) {
      if (String(d.rows[i][idCol]) === id) { d.sh.deleteRow(i + 2); return true; }
    }
    return false;
  });
};

/** Remove every row for which predicate(rowObject) is true. Returns how many were removed. */
Table.prototype.removeWhere = function (predicate) {
  var self = this;
  return withLock_(function () {
    var d = self.read_();
    var removed = 0;
    for (var i = d.rows.length - 1; i >= 0; i--) {
      if (predicate(self.toObject_(d.headers, d.rows[i]))) { d.sh.deleteRow(i + 2); removed++; }
    }
    return removed;
  });
};

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}
