/**
 * Stickies module: floating sticky notes on a project page. Each note has text, a colour, how solid its paper is
 * (opacity 0.4-1, so a note can never vanish) and a place: x as a percentage of the page width (so it stays in
 * place when the window or full-width setting changes), y in pixels from the top of the page, and a size in pixels.
 */

function stickiesModule() {
  var T = new Table('Stickies', ['id', 'project_id', 'text', 'color', 'opacity', 'x', 'y', 'w', 'h', 'created'], ['opacity', 'x', 'y', 'w', 'h']);
  var COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'];
  var LIMITS = { opacity: [0.4, 1], x: [0, 100], y: [0, 20000], w: [120, 900], h: [80, 900] };

  function number_(key, value) {
    var n = Number(value);
    assert_(isFinite(n) && n >= LIMITS[key][0] && n <= LIMITS[key][1], 'Sticky ' + key + ' must be from ' + LIMITS[key][0] + ' to ' + LIMITS[key][1] + '.');
    return Math.round(n * 100) / 100;
  }

  function color_(value) {
    assert_(COLORS.indexOf(value) !== -1, 'Unknown colour: ' + value);
    return value;
  }

  /** The fields of a + b that are given, checked. */
  function patch_(a) {
    var patch = {};
    if (a.text !== undefined) patch.text = typeof a.text === 'string' ? a.text.slice(0, 2000) : '';
    if (a.color !== undefined) patch.color = color_(a.color);
    Object.keys(LIMITS).forEach(function (key) { if (a[key] !== undefined) patch[key] = number_(key, a[key]); });
    return patch;
  }

  return {
    title: 'Stickies',
    tables: [T],
    snapshot: function () { return T.all(); },
    api: {
      add: function (a, ctx) {
        assert_(ctx.call('projects', 'list', {}).some(function (p) { return p.id === a.projectId; }), 'Project not found.');
        var fields = patch_(a);
        var row = T.insert({
          id: clientId_(a.id), project_id: a.projectId, text: fields.text || '', color: fields.color || 'yellow',
          opacity: fields.opacity || 1, x: fields.x !== undefined ? fields.x : 60, y: fields.y !== undefined ? fields.y : 0,
          w: fields.w || 220, h: fields.h || 180, created: nowIso_()
        });
        ctx.refresh('stickies');
        return row;
      },

      /** Change any of text, color, opacity, x, y, w, h. */
      update: function (a, ctx) {
        var row = T.update(a.id, patch_(a));
        ctx.refresh('stickies');
        return row;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('stickies');
        return true;
      },

      removeProject: function (a) {
        T.removeWhere(function (s) { return s.project_id === a.projectId; });
        return true;
      }
    }
  };
}
