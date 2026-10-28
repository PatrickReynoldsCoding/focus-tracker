/** Small helpers shared by the core and by modules. Names end in _ so they are private to the server. */

function nowIso_() {
  return new Date().toISOString();
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 8);
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
