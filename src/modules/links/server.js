/**
 * Links module: projects linked as in Jira (docs/SPEC-2026-11.md "Linked projects"). One row per link in the Links tab,
 * read as "<from> <type> <to>":
 *   blocks   from must be done before to starts. While from is not finished, to is left out of the focus pick (like a
 *            lock) and its page says "Waiting on <from>".
 *   relates  the two projects belong together; nothing waits.
 * The readable from and to names are kept in step with the project names by Table (fillNames_ and syncNames_ in
 * core/complete.js, through the refs in TAB_STYLE). A row an assistant types with names only gets its ids there too.
 * Two projects have at most one link, a project is never linked to itself, and blocking links never go round in a circle.
 */

// A blocker in one of these states no longer holds anything up: done, or given up (archived).
var LINK_FINISHED_ = ['done', 'archived'];

/** Does the blocks graph (links) lead from `start` to `goal`? */
function blocksReach_(links, start, goal) {
  var seen = {}, todo = [start];
  while (todo.length) {
    var at = todo.pop();
    if (at === goal) return true;
    if (seen[at]) continue;
    seen[at] = true;
    links.forEach(function (l) { if (l.type === 'blocks' && l.from_id === at) todo.push(l.to_id); });
  }
  return false;
}

function linksModule() {
  var T = new Table('Links', ['from', 'type', 'to', 'note', 'problem', 'id', 'from_id', 'to_id', 'created']);
  var TYPES = ['blocks', 'relates'];

  return {
    title: 'Links',
    tables: [T],
    snapshot: function () { return T.all(); },
    api: {
      /** a.fromId blocks (or relates to) a.toId. a.id: the browser's id, so the link shows before the answer. */
      add: function (a, ctx) {
        assert_(TYPES.indexOf(a.type) !== -1, 'A link is blocks or relates.');
        var projects = ctx.call('projects', 'list', {});
        var exists = function (id) { return projects.some(function (p) { return p.id === id; }); };
        assert_(a.fromId && exists(a.fromId) && a.toId && exists(a.toId), 'Project not found.');
        assert_(a.fromId !== a.toId, 'A project cannot be linked to itself.');
        var all = T.all();
        assert_(!all.some(function (l) {
          return (l.from_id === a.fromId && l.to_id === a.toId) || (l.from_id === a.toId && l.to_id === a.fromId);
        }), 'These projects are already linked. Remove that link first to change it.');
        assert_(a.type !== 'blocks' || !blocksReach_(all, a.toId, a.fromId), 'That would make a circle: each project would wait for the other.');
        var row = T.insert({ id: clientId_(a.id), from_id: a.fromId, type: a.type, to_id: a.toId, note: clean_(a.note, 300), created: nowIso_() });
        ctx.refresh('links', 'today');
        return row;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('links', 'today');
        return true;
      },

      /** { projectId: [ids of its blockers that are not finished] }, for every project that waits. */
      waiting: function (a, ctx) {
        var status = {};
        ctx.call('projects', 'list', {}).forEach(function (p) { status[p.id] = p.status; });
        var out = {};
        T.all().forEach(function (l) {
          if (l.type !== 'blocks' || status[l.from_id] === undefined || LINK_FINISHED_.indexOf(status[l.from_id]) !== -1) return;
          (out[l.to_id] = out[l.to_id] || []).push(l.from_id);
        });
        return out;
      },

      removeProject: function (a) {
        T.removeWhere(function (l) { return l.from_id === a.projectId || l.to_id === a.projectId; });
        return true;
      }
    }
  };
}
