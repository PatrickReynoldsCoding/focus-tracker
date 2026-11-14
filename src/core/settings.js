/**
 * Per-mode settings in the mode's grey Settings tab: one readable row per setting (key, value), for example
 * `rotation.monday = coding` or `layout.today = {...}`. They lived in user properties before schema v2; they moved so
 * the sheet holds everything a mode needs (docs/schema.md). Session and pomodoro state stay in user properties: they
 * change every few seconds.
 *
 * An empty value means "not set". Settings are not undone (they never were), so writes here skip the undo journal.
 */

// Settings keys name weekdays in words, so a row reads `rotation.monday = coding`. ISO weekday numbers, as Today uses.
var WEEKDAY_NAMES_ = { 1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday', 6: 'saturday', 7: 'sunday' };

function settingsTable_() {
  return new Table('Settings', ['key', 'value']);
}

/** Every setting whose key starts with prefix, as { key: value }, in sheet order. Empty values are left out unless withEmpty. */
function settingsWithPrefix_(prefix, withEmpty) {
  var d = settingsTable_().read_(), k = d.headers.indexOf('key'), v = d.headers.indexOf('value');
  var out = {};
  d.rows.forEach(function (r) {
    var key = String(r[k] === undefined || r[k] === null ? '' : r[k]);
    var value = String(r[v] === undefined || r[v] === null ? '' : r[v]);
    if (key && key.indexOf(prefix) === 0 && (value !== '' || withEmpty)) out[key] = value;
  });
  return out;
}

/**
 * Set several settings with one write. values: { key: value }; '' clears a setting (its row stays, empty).
 * Rows that change are rewritten from the first changed row down, new keys are added at the end.
 */
function setSettings_(values) {
  withLock_(function () {
    var d = settingsTable_().read_(true), k = d.headers.indexOf('key'), v = d.headers.indexOf('value');
    var width = d.headers.length, first = -1, byKey = {};
    d.rows.forEach(function (r, i) { if (r[k] !== '' && byKey[r[k]] === undefined) byKey[r[k]] = i; });
    Object.keys(values).forEach(function (key) {
      var value = values[key] === null || values[key] === undefined ? '' : String(values[key]);
      var i = byKey[key];
      if (i === undefined) {
        if (value === '') return;
        var row = []; for (var c = 0; c < width; c++) row.push('');
        row[k] = key;
        d.rows.push(row);
        i = byKey[key] = d.rows.length - 1;
      } else if (String(d.rows[i][v]) === value) {
        return;
      }
      d.rows[i][v] = value;
      if (first === -1 || i < first) first = i;
    });
    if (first === -1) return;
    var span = d.rows.slice(first).map(function (r) {
      var out = r.slice(0, width);
      while (out.length < width) out.push('');
      return out;
    });
    d.sh.getRange(first + 2, 1, span.length, width).setNumberFormat('@').setValues(span);
  });
}
