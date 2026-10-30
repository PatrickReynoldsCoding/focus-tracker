/** Projects module: the list of projects and goals, their category, status and next action. */

/**
 * A project can be locked until a date (YYYY-MM-DD, opens at the start of that day) or a date and time (ISO).
 * While locked it is left out of the focus pick and no session can start on it.
 */
function lockEndMs_(until) {
  if (!until) return 0;
  var ms = /^\d{4}-\d{2}-\d{2}$/.test(until) ? new Date(until + 'T00:00:00').getTime() : Date.parse(until);
  return isNaN(ms) ? 0 : ms;
}
function projectLocked_(p) { return !!p && lockEndMs_(p.locked_until) > Date.now(); }

function projectsModule() {
  var T = new Table('Projects', ['name', 'category', 'status', 'next_action', 'locked_until', 'last_touched', 'notes', 'problem', 'id', 'created', 'updated_at']);
  var STATUSES = PROJECT_STATUSES_;

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

      /**
       * a.until: a date or an ISO date and time; empty lifts the lock. Making a lock longer is free. Shortening or lifting
       * a lock that is still running needs a.early === true, which the app only sends after two warnings.
       */
      setLock: function (a, ctx) {
        var row = T.get(a.id);
        assert_(row, 'That project no longer exists.');
        var until = clean_(a.until, 40);
        if (until) {
          assert_(lockEndMs_(until), 'Pick a valid date to lock until.');
          assert_(lockEndMs_(until) > Date.now(), 'Lock until a time in the future.');
        }
        if (projectLocked_(row) && lockEndMs_(until) < lockEndMs_(row.locked_until)) {
          assert_(a.early === true, 'This project is locked. Lifting a lock early needs confirmation.');
        }
        var saved = T.update(a.id, { locked_until: until });
        ctx.refresh('projects', 'today');
        return saved;
      },

      /** The link to the project's notes, shown in the sheet's notes column. Set by the notes module when it makes the file. */
      setNotesLink: function (a) {
        var row = T.get(a.id);
        if (!row || row.notes === a.url) return row;
        return T.update(a.id, { notes: clean_(a.url, 500), updated_at: row.updated_at }); // not an edit: an offline edit of the project is no conflict
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
        ctx.optional('criteria', 'removeProject', { projectId: a.id });
        ctx.optional('stickies', 'removeProject', { projectId: a.id });
        ctx.optional('log', 'removeProject', { projectId: a.id });
        ctx.optional('today', 'removeProject', { projectId: a.id });
        ctx.optional('links', 'removeProject', { projectId: a.id });
        ctx.optional('lists', 'unlinkProject', { projectId: a.id });
        ctx.optional('todos', 'removeProject', { projectId: a.id });
        ctx.refresh('projects', 'kanban', 'resources', 'log', 'today', 'whiteboard', 'criteria', 'stickies', 'links', 'lists', 'todos');
        return true;
      }
    }
  };
}
