/**
 * The mode a request works in. bootstrap() and rpc() set it first; every call from the browser is a
 * fresh server execution, so it never leaks from one request into another.
 */
var activeModeId_ = null;

/** The active mode's id; the first mode until a request sets one. */
function modeId_() {
  return activeModeId_ || MODES[0].id;
}

// Modes made in the app, kept in a script property as [{ id, label, accent }]. They follow the MODES from config.js.
var CUSTOM_MODES_KEY_ = 'CUSTOM_MODES';
var MAX_MODES_ = 12;
// Accent palette slots for new modes (see --cat-N); 1 and 3 are close to the Personal and Work accents.
var NEW_MODE_ACCENTS_ = ['5', '2', '4', '6', '8', '7'];
var NEW_MODE_CATEGORIES_ = [{ id: 'general', label: 'General', color: '1' }];
var allModesCache_ = null;

/** Every mode: those in config.js, then those made in the app. */
function allModes_() {
  if (allModesCache_) return allModesCache_;
  var raw = PropertiesService.getScriptProperties().getProperty(CUSTOM_MODES_KEY_);
  var custom = (raw ? JSON.parse(raw) : []).map(function (saved) {
    return {
      id: saved.id, label: saved.label, accent: saved.accent, categories: NEW_MODE_CATEGORIES_,
      rotation: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null }
    };
  });
  allModesCache_ = MODES.concat(custom);
  return allModesCache_;
}

function modeById_(id) {
  var modes = allModes_();
  for (var i = 0; i < modes.length; i++) if (modes[i].id === id) return modes[i];
  return null;
}

/** A lower-case id from the name, made unique among the existing ids. */
function newModeId_(label, modes) {
  var base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mode';
  var taken = modes.map(function (m) { return m.id; });
  var id = base, n = 2;
  while (taken.indexOf(id) !== -1) id = base + '-' + n++;
  return id;
}

/**
 * Make a new mode. It starts with one category ("General"), no lead categories and no habits.
 * Its spreadsheet and Drive folder are created the first time it opens.
 */
function addMode_(label) {
  var name = clean_(label, 30);
  assert_(name, 'A mode needs a name.');
  return withLock_(function () {
    allModesCache_ = null;
    var modes = allModes_();
    assert_(modes.length < MAX_MODES_, 'You can have up to ' + MAX_MODES_ + ' modes.');
    assert_(!modes.some(function (m) { return m.label.toLowerCase() === name.toLowerCase(); }), 'There is already a mode called ' + name + '.');
    var used = modes.map(function (m) { return m.accent; });
    var accent = NEW_MODE_ACCENTS_.filter(function (a) { return used.indexOf(a) === -1; })[0] || NEW_MODE_ACCENTS_[modes.length % NEW_MODE_ACCENTS_.length];
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(CUSTOM_MODES_KEY_);
    var custom = raw ? JSON.parse(raw) : [];
    var mode = { id: newModeId_(name, modes), label: name, accent: accent };
    custom.push(mode);
    props.setProperty(CUSTOM_MODES_KEY_, JSON.stringify(custom));
    allModesCache_ = null;
    return mode;
  });
}

/**
 * Forget everything cached during a request. Every browser call starts with this: on Google each call is a fresh
 * execution anyway, and in tests several calls share one runtime. Then bring the mode's spreadsheet up to the current
 * layout if it is older (core/migrate.js; one property read when it is not).
 */
function startRequest_(modeId) {
  tableCache_ = {};
  openSpreadsheets_ = {};
  allModesCache_ = null;
  var mode = setMode_(modeId);
  ensureSchema_();
  return mode;
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
