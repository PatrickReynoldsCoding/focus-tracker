/** The two functions the browser calls. Everything else is reached through rpc(). */

/** Everything the page needs on first load, for one mode (the first mode if none is given). */
function bootstrap(modeId) {
  var mode = setMode_(modeId);
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
      modes: MODES.map(function (m) { return { id: m.id, label: m.label }; }),
      folderUrl: getModeFolder_().getUrl()
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
  setMode_(modeId);
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  var result = ctx.call(moduleId, fn, args);
  var slices = {};
  ctx.refreshed_().forEach(function (id) { slices[id] = mods[id].snapshot(ctx); });
  return { result: result === undefined ? null : result, slices: slices };
}
