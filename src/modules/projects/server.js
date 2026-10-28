/** Projects module: the list of projects and goals, their category, status and next action. */

function projectsModule() {
  var T = new Table('Projects', ['id', 'name', 'category', 'status', 'next_action', 'last_touched', 'created']);
  var STATUSES = ['active', 'paused', 'done', 'archived'];

  function list() { return T.all(); }

  return {
    title: 'Projects',
    tables: [T],
    snapshot: list,
    api: {
      list: list,

      /** a.newCategory: the name of a category to make and use, instead of a.category. */
      create: function (a, ctx) {
        var name = clean_(a.name, 120);
        assert_(name, 'A project needs a name.');
        if (a.newCategory) a.category = ctx.call('categories', 'add', { label: a.newCategory }).id;
        assert_(ctx.call('categories', 'ids').indexOf(a.category) !== -1, 'Unknown category: ' + a.category);
        var now = nowIso_();
        var row = T.insert({
          name: name,
          category: a.category,
          status: 'active',
          next_action: clean_(a.next_action, 300) || 'Decide the first small step',
          last_touched: now,
          created: now
        });
        ctx.optional('kanban', 'initProject', { projectId: row.id, columns: a.columns });
        ctx.refresh('projects', 'kanban', 'today', 'categories');
        return row;
      },

      update: function (a, ctx) {
        var patch = {};
        if (a.newCategory) a.category = ctx.call('categories', 'add', { label: a.newCategory }).id;
        if (a.name !== undefined) { patch.name = clean_(a.name, 120); assert_(patch.name, 'A project needs a name.'); }
        if (a.category !== undefined) { assert_(ctx.call('categories', 'ids').indexOf(a.category) !== -1, 'Unknown category: ' + a.category); patch.category = a.category; }
        if (a.status !== undefined) { assert_(STATUSES.indexOf(a.status) !== -1, 'Unknown status: ' + a.status); patch.status = a.status; }
        if (a.next_action !== undefined) patch.next_action = clean_(a.next_action, 300);
        var row = T.update(a.id, patch);
        ctx.refresh('projects', 'today', 'categories');
        return row;
      },

      countInCategory: function (a) {
        return list().filter(function (p) { return p.category === a.category; }).length;
      },

      /** Record that work happened: bumps last_touched and optionally sets the next action. */
      touch: function (a) {
        var patch = { last_touched: nowIso_() };
        var next = clean_(a.next_action, 300);
        if (next) patch.next_action = next;
        return T.update(a.id, patch);
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.optional('kanban', 'removeProject', { projectId: a.id });
        ctx.optional('resources', 'removeProject', { projectId: a.id });
        ctx.optional('notes', 'removeProject', { projectId: a.id });
        ctx.optional('whiteboard', 'removeProject', { projectId: a.id });
        ctx.optional('log', 'removeProject', { projectId: a.id });
        ctx.optional('today', 'removeProject', { projectId: a.id });
        ctx.refresh('projects', 'kanban', 'resources', 'log', 'today', 'whiteboard');
        return true;
      }
    }
  };
}
