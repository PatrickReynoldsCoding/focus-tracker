/**
 * To-dos module: one-off small tasks (grocery shopping, a job interview), shown in Today's To-dos panel (next to the
 * Habits panel). One row per to-do in the To-dos tab. `day` is the ISO date it is for, empty for anytime; `done` is the date it
 * was ticked, empty while open. A to-do can point at a project (project_id, with its name in `project`).
 * Plan my week puts to-dos on days, from today to the end of next week, never further.
 */

function todosModule() {
  var T = new Table('To-dos', ['title', 'day', 'done', 'project', 'note', 'problem', 'id', 'project_id', 'order', 'created', 'updated_at'], ['order']);
  var KEEP_DONE_DAYS = 14; // ticked to-dos stay in the browser this long (Plan my week shows them on their day)

  function title_(value) {
    var title = clean_(value, 200);
    assert_(title, 'A to-do needs a title.');
    return title;
  }

  /** '' (anytime) or a day from today to the end of next week. */
  function day_(value) {
    if (!value) return '';
    var today = todayIso_();
    assert_(isIsoDay_(value) && value >= today && value <= isoAddDays_(isoMonday_(today), 13), 'A to-do can be for a day from today to the end of next week, or anytime.');
    return value;
  }

  function project_(value, ctx) {
    if (!value) return '';
    assert_(ctx.call('projects', 'list', {}).some(function (p) { return p.id === value; }), 'Project not found.');
    return value;
  }

  /** { day: today, items: open to-dos and those ticked in the last two weeks }. */
  function snapshot_() {
    var today = todayIso_(), since = isoAddDays_(today, -KEEP_DONE_DAYS);
    return {
      day: today,
      items: T.all().filter(function (t) { return !t.done || t.done >= since; }).sort(function (a, b) { return a.order - b.order; })
    };
  }

  return {
    title: 'To-dos',
    tables: [T],
    snapshot: snapshot_,
    api: {
      /** a.title, a.day ('' for anytime), a.projectId (optional); a.id from the browser. */
      add: function (a, ctx) {
        var row = T.insert({
          id: clientId_(a.id), title: title_(a.title), day: day_(a.day), done: '', note: clean_(a.note, 300), project_id: project_(a.projectId, ctx),
          order: T.all().reduce(function (m, t) { return Math.max(m, t.order); }, 0) + 1, created: nowIso_()
        });
        ctx.refresh('todos');
        return row;
      },

      update: function (a, ctx) {
        var patch = {};
        if (a.title !== undefined) patch.title = title_(a.title);
        if (a.note !== undefined) patch.note = clean_(a.note, 300);
        if (a.day !== undefined) patch.day = day_(a.day);
        var row = T.update(a.id, patch);
        ctx.refresh('todos');
        return row;
      },

      /** Plan my week: move a to-do to a day, or to anytime with ''. */
      setDay: function (a, ctx) {
        var row = T.update(a.id, { day: day_(a.day) });
        ctx.refresh('todos');
        return row;
      },

      /** Tick (a.done true) or untick. A tick is dated today. */
      toggle: function (a, ctx) {
        var row = T.update(a.id, { done: a.done ? todayIso_() : '' });
        ctx.refresh('todos');
        return row;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('todos');
        return true;
      },

      /** For Insights (ctx.optional): to-dos for a day from a.from to a.to (ISO, inclusive), or done in that time. */
      history: function (a) {
        var from = String(a.from || ''), to = String(a.to || '9999-12-31');
        function inside(d) { return !!d && d >= from && d <= to; }
        // Also the open "anytime" to-dos (no day, not done): Insights counts them as still waiting.
        return T.all().filter(function (t) { return inside(t.day) || inside(String(t.done).slice(0, 10)) || (!t.day && !t.done); })
          .map(function (t) { return { id: t.id, title: t.title, day: t.day, done: t.done, project_id: t.project_id, created: t.created }; });
      },

      /** A deleted project's to-dos stay, unlinked: they are still things to do. */
      removeProject: function (a) {
        T.all().filter(function (t) { return t.project_id === a.projectId; }).forEach(function (t) { T.update(t.id, { project_id: '', project: '' }); });
        return true;
      }
    }
  };
}
