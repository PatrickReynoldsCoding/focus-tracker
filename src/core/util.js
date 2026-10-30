/** Small helpers shared by the core and by modules. Names end in _ so they are private to the server. */

function nowIso_() {
  return new Date().toISOString();
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

/** An id made by the browser (so it can show a new item before the server answers), or a new one. */
function clientId_(value) {
  if (!value) return newId_();
  assert_(/^[0-9a-f]{8}$/.test(String(value)), 'Bad id: ' + value);
  return String(value);
}

function daysSince_(iso) {
  if (!iso) return 9999;
  var t = new Date(iso).getTime();
  if (isNaN(t)) return 9999;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function assert_(condition, message) {
  if (!condition) throw new Error(message);
}

/** Trim a string and cap its length. Non-strings become ''. */
function clean_(value, max) {
  var s = typeof value === 'string' ? value.trim() : '';
  return max ? s.slice(0, max) : s;
}

// ---------- ISO dates (yyyy-MM-dd) as plain text, worked out with no time zone, so a day is always the day it says ----------

/** The date n days after an ISO date (n may be negative). */
function isoAddDays_(day, n) {
  var t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** ISO weekday of an ISO date: 1 = Monday ... 7 = Sunday. */
function isoWeekday_(day) {
  var d = new Date(day + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

/** The Monday of the week an ISO date is in. */
function isoMonday_(day) {
  return isoAddDays_(day, 1 - isoWeekday_(day));
}

function isIsoDay_(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !isNaN(Date.parse(value + 'T00:00:00Z'));
}

/** Today as an ISO date in the script's time zone. Its own function, so tests can move the clock. */
function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
