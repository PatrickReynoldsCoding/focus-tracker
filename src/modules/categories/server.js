/**
 * Categories module: the categories that group projects, one set per mode, kept in the mode's Categories tab.
 * The mode's starting categories (MODES in config.js) fill the tab the first time it is read.
 * A category that projects or resources still use cannot be deleted.
 */

function categoriesModule() {
  var T = new Table('Categories', ['label', 'color', 'id', 'order'], ['order']);
  var COLORS = ['1', '2', '3', '4', '5', '6', '7', '8'];

  function byOrder_(a, b) { return a.order - b.order; }

  function fillDefaultsIfEmpty_() {
    withLock_(function () {
      if (T.all().length) return;
      T.insertMany(activeMode_().categories.map(function (c, i) {
        return { id: c.id, label: c.label, color: c.color, order: i + 1 };
      }));
    });
  }

  function list_() {
    var rows = T.all();
    if (rows.length) return rows.sort(byOrder_);
    fillDefaultsIfEmpty_();
    return T.all().sort(byOrder_);
  }

  function label_(value) {
    var label = clean_(value, 40);
    assert_(label, 'A category needs a name.');
    return label;
  }

  function color_(value) {
    assert_(COLORS.indexOf(String(value)) !== -1, 'Unknown colour: ' + value);
    return String(value);
  }

  /** The palette slot used least, so a new category looks different from the others where possible. */
  function leastUsedColor_(rows) {
    var uses = {};
    rows.forEach(function (r) { uses[r.color] = (uses[r.color] || 0) + 1; });
    return COLORS.reduce(function (best, c) { return (uses[c] || 0) < (uses[best] || 0) ? c : best; }, COLORS[0]);
  }

  return {
    title: 'Categories',
    tables: [T],
    snapshot: list_,
    api: {
      list: list_,

      ids: function () { return list_().map(function (c) { return c.id; }); },

      add: function (a, ctx) {
        var rows = list_();
        var row = T.insert({
          label: label_(a.label),
          color: a.color ? color_(a.color) : leastUsedColor_(rows),
          order: rows.reduce(function (m, r) { return Math.max(m, r.order); }, 0) + 1
        });
        ctx.refresh('categories');
        return row;
      },

      update: function (a, ctx) {
        var patch = {};
        if (a.label !== undefined) patch.label = label_(a.label);
        if (a.color !== undefined) patch.color = color_(a.color);
        var row = T.update(a.id, patch);
        ctx.refresh('categories', 'today');
        return row;
      },

      remove: function (a, ctx) {
        var inUse = ctx.call('projects', 'countInCategory', { category: a.id }) +
          (ctx.optional('resources', 'countInCategory', { category: a.id }) || 0);
        assert_(inUse === 0, 'Move its projects and links to another category first.');
        assert_(list_().length > 1, 'Keep at least one category.');
        T.remove(a.id);
        ctx.refresh('categories', 'today');
        return true;
      }
    }
  };
}
