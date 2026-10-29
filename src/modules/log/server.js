/** Log module: one line per working session, written when you finish a session. */

function logModule() {
  var T = new Table('Log', ['date', 'project', 'where_stopped', 'next_action', 'minutes', 'id', 'project_id'], ['minutes']);
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

      /** A line for an edit that lost a conflict (see core/conflicts.js), so the older version is not lost. */
      conflict: function (a) {
        return T.insert({
          project_id: a.projectId || '',
          date: nowIso_(),
          where_stopped: clean_(a.text, 300) || 'Conflict',
          next_action: '',
          minutes: 0
        });
      },

      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
