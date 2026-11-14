/**
 * Backlog module: projects not started yet, as a simple list on the Projects tab. A backlog item is only a title with an
 * optional category and a short note, kept in order by hand (dragged up or down), not a project. Start makes it a real
 * project through projects.create and takes it off the backlog, in one call, so one Undo puts it back.
 */

function backlogModule() {
  var T = new Table('Backlog', ['title', 'category', 'note', 'problem', 'id', 'order', 'created', 'updated_at'], ['order']);

  function byOrder_(a, b) { return a.order - b.order; }

  function title_(value) {
    var title = clean_(value, 120);
    assert_(title, 'A backlog item needs a title.');
    return title;
  }

  /** '' (no category) or one of the mode's categories. */
  function category_(value, ctx) {
    if (!value) return '';
    assert_(ctx.call('categories', 'ids').indexOf(value) !== -1, 'Unknown category: ' + value);
    return value;
  }

  function existing_(id) {
    var row = T.get(id);
    assert_(row, 'That backlog item no longer exists.');
    return row;
  }

  function nextOrder_() {
    return T.all().reduce(function (largest, item) { return Math.max(largest, item.order); }, 0) + 1;
  }

  return {
    title: 'Backlog',
    tables: [T],
    snapshot: function () { return T.all().sort(byOrder_); },
    api: {
      /** a.title, a.category and a.note (both optional); a.id from the browser. Goes to the bottom of the list. */
      add: function (a, ctx) {
        var row = T.insert({
          id: clientId_(a.id), title: title_(a.title), category: category_(a.category, ctx), note: clean_(a.note, 300),
          order: nextOrder_(), created: nowIso_()
        });
        ctx.refresh('backlog');
        return row;
      },

      /** Change the title, category or note, and/or move it (a.order: any number between its new neighbours). */
      update: function (a, ctx) {
        existing_(a.id);
        var patch = {};
        if (a.title !== undefined) patch.title = title_(a.title);
        if (a.category !== undefined) patch.category = category_(a.category, ctx);
        if (a.note !== undefined) patch.note = clean_(a.note, 300);
        if (typeof a.order === 'number' && isFinite(a.order)) patch.order = a.order;
        var row = T.update(a.id, patch);
        ctx.refresh('backlog');
        return row;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('backlog');
        return true;
      },

      /**
       * Make the item a project and take it off the backlog. a.name, a.category, a.newCategory and a.next_action are the
       * project's, as in projects.create; an empty name keeps the item's title. Returns the new project.
       */
      start: function (a, ctx) {
        var item = existing_(a.id);
        var project = ctx.call('projects', 'create', {
          name: clean_(a.name, 120) || item.title, category: a.category, newCategory: a.newCategory, next_action: a.next_action
        });
        T.remove(item.id);
        ctx.refresh('backlog');
        return project;
      }
    }
  };
}
