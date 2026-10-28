/**
 * Module registry. A module is a function named <id>Module() returning:
 *   {
 *     title:    'Projects',
 *     tables:   [new Table(...)],                  // created by setup()
 *     snapshot: function (ctx) { return data; },   // this module's slice of the client store
 *     api:      { fnName: function (args, ctx) {} } // callable from the browser via rpc()
 *   }
 * ctx offers:
 *   ctx.call(id, fn, args)      call another module's api; throws if it is not installed
 *   ctx.optional(id, fn, args)  same, but quietly does nothing if that module is not installed
 *   ctx.refresh(id, ...)        ask for fresh snapshots of these modules to be sent back to the browser
 *
 * Modules are looked up by name at call time, so file load order does not matter.
 */

function loadModules_() {
  var mods = {};
  MODULES.forEach(function (id) {
    var factory = globalThis[id + 'Module'];
    assert_(typeof factory === 'function',
      'Module "' + id + '" is listed in MODULES but ' + id + 'Module() is not defined. Check src/modules/' + id + '/server.js.');
    var def = factory();
    def.id = id;
    mods[id] = def;
  });
  return mods;
}

function makeCtx_(mods) {
  var refreshed = {};
  var ctx = {
    call: function (id, fn, args) {
      var m = mods[id];
      assert_(m, 'Module not installed: ' + id);
      var handler = m.api && m.api[fn];
      assert_(typeof handler === 'function', 'Module ' + id + ' has no api function ' + fn);
      return handler(args || {}, ctx);
    },
    optional: function (id, fn, args) {
      if (!mods[id]) return undefined;
      return ctx.call(id, fn, args);
    },
    refresh: function () {
      for (var i = 0; i < arguments.length; i++) if (mods[arguments[i]]) refreshed[arguments[i]] = true;
    },
    refreshed_: function () { return Object.keys(refreshed); }
  };
  return ctx;
}
