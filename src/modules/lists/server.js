/**
 * Lists module: named lists, such as "Keep in mind" or "Read and watch", that are not projects.
 * Each list's groups and items are a Kanban board owned by the list, so they are edited the same way.
 * A list can be shown as a panel on Today, either in full or one item at a time (display 'one'): a random item that
 * changes every `seconds` seconds.
 * A list can be linked to a project (project_id, with the project's name in `project`): it then shows as a panel on that
 * project's page as well as on the Lists tab. Deleting the project unlinks its lists; it does not delete them.
 */

function listsModule() {
  var T = new Table('Lists', ['name', 'project', 'show_today', 'display', 'seconds', 'color', 'problem', 'id', 'project_id', 'order', 'created'], ['order', 'seconds']);
  var DISPLAYS = ['', 'one'];
  var COLORS = ['', '1', '2', '3', '4', '5', '6', '7', '8'];
  var FIRST_GROUP = 'Items';

  function list_() {
    return T.all().sort(function (a, b) { return a.order - b.order; });
  }

  function name_(value) {
    var name = clean_(value, 80);
    assert_(name, 'A list needs a name.');
    return name;
  }

  return {
    title: 'Lists',
    tables: [T],
    snapshot: list_,
    api: {
      /** a.groups: optional names of the first groups. */
      create: function (a, ctx) {
        var lists = list_();
        var row = T.insert({
          name: name_(a.name),
          order: lists.reduce(function (m, l) { return Math.max(m, l.order); }, 0) + 1,
          show_today: a.showToday ? 'yes' : '',
          created: nowIso_()
        });
        ctx.call('kanban', 'initProject', { listId: row.id, columns: a.groups && a.groups.length ? a.groups : [FIRST_GROUP] });
        ctx.refresh('lists', 'kanban');
        return row;
      },

      rename: function (a, ctx) {
        var row = T.update(a.id, { name: name_(a.name) });
        ctx.refresh('lists');
        return row;
      },

      /** Background colour: a palette slot 1-8, or '' for none. */
      setColor: function (a, ctx) {
        assert_(COLORS.indexOf(String(a.color)) !== -1, 'Unknown colour: ' + a.color);
        var row = T.update(a.id, { color: String(a.color) });
        ctx.refresh('lists');
        return row;
      },

      /** How the list shows on Today: a.display '' (full list) or 'one' (one item at a time, every a.seconds seconds). */
      setDisplay: function (a, ctx) {
        assert_(DISPLAYS.indexOf(String(a.display)) !== -1, 'Unknown display: ' + a.display);
        var seconds = Number(a.seconds);
        assert_(Math.floor(seconds) === seconds && seconds >= 5 && seconds <= 3600, 'Show each item for 5 to 3600 seconds.');
        var row = T.update(a.id, { display: String(a.display), seconds: seconds });
        ctx.refresh('lists');
        return row;
      },

      showToday: function (a, ctx) {
        var row = T.update(a.id, { show_today: a.on ? 'yes' : '' });
        ctx.refresh('lists');
        return row;
      },

      /** Link the list to a project (a.projectId), or unlink it (empty). The readable project name is filled in by Table. */
      setProject: function (a, ctx) {
        var projectId = String(a.projectId || '');
        if (projectId) assert_(ctx.call('projects', 'list', {}).some(function (p) { return p.id === projectId; }), 'Project not found.');
        var row = T.update(a.id, { project_id: projectId });
        ctx.refresh('lists');
        return row;
      },

      /** A project is being deleted: its lists stay, unlinked. */
      unlinkProject: function (a) {
        list_().filter(function (l) { return l.project_id === a.projectId; }).forEach(function (l) { T.update(l.id, { project_id: '' }); });
        return true;
      },

      /** Swap a list with its neighbour: a.d is -1 (earlier) or 1 (later). */
      move: function (a, ctx) {
        var lists = list_();
        var i = lists.map(function (l) { return l.id; }).indexOf(a.id), j = i + Number(a.d);
        assert_(i !== -1, 'List not found.');
        if (j < 0 || j >= lists.length) return false;
        T.update(lists[i].id, { order: lists[j].order });
        T.update(lists[j].id, { order: lists[i].order });
        ctx.refresh('lists');
        return true;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.call('kanban', 'removeProject', { listId: a.id });
        ctx.refresh('lists', 'kanban');
        return true;
      }
    }
  };
}
