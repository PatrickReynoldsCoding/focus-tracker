/** Log module: one line per working session, written when you finish a session. */

function logModule() {
  var T = new Table('Log', ['id', 'project_id', 'date', 'where_stopped', 'next_action', 'minutes'], ['minutes']);
  var KEEP = 300; // newest entries sent to the browser

  return {
    title: 'Log',
    tables: [T],
    snapshot: function () {
      return T.all().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, KEEP);
    },
    api: {
      add: function (a) {
        return T.insert({
          project_id: a.projectId,
          date: nowIso_(),
          where_stopped: clean_(a.where, 300) || 'No note',
          next_action: clean_(a.next, 300),
          minutes: Math.max(0, Math.round(Number(a.minutes) || 0))
        });
      },

      /**
       * Change a line's text and/or its day (a.date, YYYY-MM-DD; the time of day stays). The minutes and the project stay as
       * they were. If it is the project's newest line, the project's next action follows the edited one.
       */
      update: function (a, ctx) {
        var patch = {};
        if (a.where !== undefined) {
          patch.where_stopped = clean_(a.where, 300);
          assert_(patch.where_stopped, 'Say where you stopped.');
        }
        if (a.next !== undefined) patch.next_action = clean_(a.next, 300);
        var old = T.all().filter(function (r) { return r.id === a.id; })[0];
        assert_(old, 'Log line not found.');
        if (a.date !== undefined && a.date !== old.date.slice(0, 10)) {
          assert_(/^\d{4}-\d{2}-\d{2}$/.test(a.date) && !isNaN(new Date(a.date + 'T00:00:00Z')) &&
            new Date(a.date + 'T00:00:00Z').toISOString().slice(0, 10) === a.date, 'The date must look like 2026-10-28.');
          patch.date = a.date + old.date.slice(10);
        }
        var row = T.update(a.id, patch);
        var newest = T.all().filter(function (r) { return r.project_id === row.project_id; })
          .sort(function (x, y) { return x.date < y.date ? 1 : -1; })[0];
        if (newest.id === row.id && row.next_action) {
          ctx.optional('projects', 'update', { id: row.project_id, next_action: row.next_action });
        }
        ctx.refresh('log', 'projects', 'today');
        return row;
      },

      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
