/**
 * Lists module: the rows of the Lists tab, shown together on the Notes tab. A row is one of three kinds (`kind`):
 *  - a list ('') such as "Keep in mind" or "Read and watch": its groups and items are a Kanban board owned by the list,
 *    so they are edited the same way;
 *  - a to-do list ('todo'): its groups are board columns too, its to-dos are rows of the To-dos tab (todos module);
 *  - a note ('note'): its text is a Google Doc, kept by the notes module like a project's notes.
 * Every kind has a name, a colour, a place in the order, can be shown on Today as its own panel and linked to a project
 * (project_id, with the project's name in `project`): it then shows as a panel on that project's page as well.
 * Deleting the project unlinks its lists; it does not delete them.
 * A list can be shown on Today in full or one item at a time (display 'one'): a random item that changes every `seconds` seconds.
 */

function listsModule() {
  var T = new Table('Lists', ['name', 'kind', 'project', 'show_today', 'display', 'seconds', 'color', 'problem', 'id', 'project_id', 'order', 'created'], ['order', 'seconds']);
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

  function kind_(value) {
    var kind = String(value || '');
    assert_(LIST_KINDS_.indexOf(kind) !== -1, 'Unknown kind of list: ' + kind);
    return kind;
  }

  /** The lists' order values, lowest first; 1, 2, 3... instead when two are the same (rows typed into the sheet). */
  function ordersToGiveOut_(lists) {
    var orders = lists.map(function (l) { return l.order; });
    var allDifferent = orders.every(function (order, place) { return place === 0 || order > orders[place - 1]; });
    return allDifferent ? orders : lists.map(function (l, place) { return place + 1; });
  }

  /** The first groups a new list or to-do list starts with: names, and the ids the browser made for them (optional). */
  function firstGroups_(a, kind) {
    if (kind === TODO_LIST_KIND_) return { names: [FIRST_TODO_GROUP_], ids: a.groupId ? [a.groupId] : [] };
    return { names: a.groups && a.groups.length ? a.groups : [FIRST_GROUP], ids: a.groupId ? [a.groupId] : [] };
  }

  return {
    title: 'Lists',
    tables: [T],
    snapshot: list_,
    api: {
      /**
       * a.name; a.kind '' (a list), 'todo' or 'note'; a.id and a.groupId made by the browser (optional); a.groups:
       * optional names of a list's first groups; a.showToday. A note has no board: its Doc is made on its first save.
       */
      create: function (a, ctx) {
        var kind = kind_(a.kind);
        var row = T.insert({
          id: clientId_(a.id), name: name_(a.name), kind: kind,
          order: list_().reduce(function (m, l) { return Math.max(m, l.order); }, 0) + 1,
          show_today: a.showToday ? 'yes' : '',
          created: nowIso_()
        });
        if (kind !== NOTE_LIST_KIND_) {
          var groups = firstGroups_(a, kind);
          ctx.call('kanban', 'initProject', { listId: row.id, columns: groups.names, columnIds: groups.ids });
        }
        ctx.refresh('lists', 'kanban');
        return row;
      },

      /** One row of the Lists tab, or null. For other modules (a note's name, a to-do list's kind). */
      get: function (a) {
        return T.get(String(a.id || ''));
      },

      /** The rows of one kind, in order. */
      ofKind: function (a) {
        var kind = String(a.kind || '');
        return list_().filter(function (l) { return (l.kind || '') === kind; });
      },

      rename: function (a, ctx) {
        var row = T.update(a.id, { name: name_(a.name) });
        if (row.kind === NOTE_LIST_KIND_) ctx.optional('notes', 'renameList', { listId: row.id, name: row.name });
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

      /**
       * Move a list a.d places earlier (negative) or later in the order; the lists it passes move one place the other
       * way. With a.d -1 or 1 that swaps it with its neighbour. The order values already used are kept, given out again.
       */
      move: function (a, ctx) {
        var lists = list_(), places = Number(a.d);
        var from = lists.map(function (l) { return l.id; }).indexOf(a.id), to = from + places;
        assert_(from !== -1, 'List not found.');
        assert_(Math.floor(places) === places, 'Move a list by whole places.');
        if (to < 0 || to >= lists.length || to === from) return false;
        var orders = ordersToGiveOut_(lists);
        var moved = lists.splice(from, 1)[0];
        lists.splice(to, 0, moved);
        lists.forEach(function (l, place) { if (l.order !== orders[place]) T.update(l.id, { order: orders[place] }); });
        ctx.refresh('lists');
        return true;
      },

      /** Delete a list with everything in it: its board, a to-do list's to-dos, a note's Doc (to Drive's bin). */
      remove: function (a, ctx) {
        var row = T.get(a.id);
        T.remove(a.id);
        if (row && row.kind === TODO_LIST_KIND_) ctx.optional('todos', 'removeList', { listId: a.id });
        if (row && row.kind === NOTE_LIST_KIND_) ctx.optional('notes', 'removeList', { listId: a.id });
        else ctx.call('kanban', 'removeProject', { listId: a.id });
        ctx.refresh('lists', 'kanban', 'todos', 'notes');
        return true;
      }
    }
  };
}
