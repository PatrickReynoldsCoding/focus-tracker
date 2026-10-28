/**
 * The mode a request works in. bootstrap() and rpc() set it first; every call from the browser is a
 * fresh server execution, so it never leaks from one request into another.
 */
var activeModeId_ = null;

/** The active mode's id; the first mode until a request sets one. */
function modeId_() {
  return activeModeId_ || MODES[0].id;
}

function modeById_(id) {
  for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
  return null;
}

function setMode_(id) {
  var mode = modeById_(id || MODES[0].id);
  assert_(mode, 'Unknown mode: ' + id);
  activeModeId_ = mode.id;
  return mode;
}

function activeMode_() {
  return modeById_(modeId_());
}

/** Property name for this mode. The default mode keeps the bare name, so its data from before modes still loads. */
function modeKey_(base) {
  return modeId_() === MODES[0].id ? base : base + '.' + modeId_();
}

/** The modules the active mode loads: its own list, or every module in MODULES. */
function modeModules_() {
  return activeMode_().modules || MODULES;
}
