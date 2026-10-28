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
  startConflictReport_();
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  var skipped = false;
  var run = withChangeJournal_(function () {
    // An edit that waited offline may find its row changed since (see conflicts.js); a newer stored row wins and the edit is only logged.
    var settled = settleConflict_(moduleId, fn, args, ctx);
    if (settled && settled.skip) { skipped = true; ctx.refresh(moduleId); return null; }
    return ctx.call(moduleId, fn, args);
  });
  var undo = skipped ? false : saveUndo_(moduleId + '.' + fn, run.changes);
  var slices = {};
  ctx.refreshed_().forEach(function (id) { slices[id] = mods[id].snapshot(ctx); });
  var reply = { result: run.result === undefined ? null : run.result, slices: slices, undo: undo };
  if (requestConflicts_.length) reply.conflicts = requestConflicts_;
  // The row's version after the call, so a browser replaying several queued edits can chain them.
  var version = versionAfter_(moduleId, fn, args);
  if (!version && run.result && run.result.updated) version = run.result.updated;
  if (version) reply.version = version;
  return reply;
}

/** A cheap call that touches no sheet: the browser uses it to find out whether Google is reachable again. */
function ping() {
  return 'pong';
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
