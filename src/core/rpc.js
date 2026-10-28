/** The functions the browser calls. Everything else is reached through rpc(). */

/** Everything the page needs on first load, for one mode (the first mode if none is given). */
function bootstrap(modeId) {
  var mode = startRequest_(modeId);
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  runPendingImport_(ctx);
  var data = {};
  Object.keys(mods).forEach(function (id) {
    if (typeof mods[id].snapshot === 'function') data[id] = mods[id].snapshot(ctx);
  });
  return {
    config: {
      appName: APP_NAME,
      staleDays: STALE_DAYS,
      mode: mode.id,
      modes: allModes_().map(function (m) { return { id: m.id, label: m.label, accent: m.accent || '' }; }),
      folderUrl: getModeFolder_().getUrl(),
      wrapperUrl: WRAPPER_URL,
      execUrl: webAppUrl_()
    },
    modules: modeModules_().map(function (id) { return { id: id, title: mods[id].title || id }; }),
    data: data
  };
}

/**
 * Call a module api function in a mode (the first mode if none is given).
 * Returns { result, slices } where slices holds fresh snapshots for any modules the handler refreshed.
 */
function rpc(moduleId, fn, args, modeId) {
  startRequest_(modeId);
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  var run = withChangeJournal_(function () { return ctx.call(moduleId, fn, args); });
  var undo = saveUndo_(moduleId + '.' + fn, run.changes);
  var slices = {};
  ctx.refreshed_().forEach(function (id) { slices[id] = mods[id].snapshot(ctx); });
  return { result: run.result === undefined ? null : run.result, slices: slices, undo: undo };
}

/** Undo the last change made in this mode. Returns fresh data for every module, like bootstrap. */
function undo(modeId) {
  startRequest_(modeId);
  var undone = undoLast_();
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  var data = {};
  Object.keys(mods).forEach(function (id) {
    if (typeof mods[id].snapshot === 'function') data[id] = mods[id].snapshot(ctx);
  });
  return { undone: undone, data: data };
}

/** Make a new mode from the mode menu. Returns { id, label, accent }; the browser then opens it. */
function createMode(label) {
  startRequest_();
  return addMode_(label);
}

/** This web app's own address, for Settings to copy. An empty string if Apps Script will not say; nothing else depends on it. */
function webAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}
