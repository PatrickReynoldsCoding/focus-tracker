/** The two functions the browser calls. Everything else is reached through rpc(). */

/** Everything the page needs on first load. */
function bootstrap() {
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  var data = {};
  Object.keys(mods).forEach(function (id) {
    if (typeof mods[id].snapshot === 'function') data[id] = mods[id].snapshot(ctx);
  });
  return {
    config: { appName: APP_NAME, categories: CATEGORIES, staleDays: STALE_DAYS },
    modules: MODULES.map(function (id) { return { id: id, title: mods[id].title || id }; }),
    data: data
  };
}

/**
 * Call a module api function.
 * Returns { result, slices } where slices holds fresh snapshots for any modules the handler refreshed.
 */
function rpc(moduleId, fn, args) {
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  var result = ctx.call(moduleId, fn, args);
  var slices = {};
  ctx.refreshed_().forEach(function (id) { slices[id] = mods[id].snapshot(ctx); });
  return { result: result === undefined ? null : result, slices: slices };
}
