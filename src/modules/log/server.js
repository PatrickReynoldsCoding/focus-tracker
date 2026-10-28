/** Log module: one line per working session, written when you finish a session. */

function logModule() {
  var T = new Table('Log', ['id', 'project_id', 'date', 'where_stopped', 'next_action']);
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
          next_action: clean_(a.next, 300)
        });
      },

      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
