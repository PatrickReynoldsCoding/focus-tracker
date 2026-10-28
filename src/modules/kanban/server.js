/** Kanban module: per-project columns (renameable, addable, deletable) and the tasks in them. */

function kanbanModule() {
  var COLUMNS = new Table('Columns', ['id', 'project_id', 'name', 'order'], ['order']);
  var TASKS = new Table('Tasks', ['id', 'project_id', 'column_id', 'title', 'order', 'created'], ['order']);
  var DEFAULT_COLUMNS = ['To do', 'Doing', 'Done'];

  function columnsOf_(projectId) {
    return COLUMNS.all().filter(function (c) { return c.project_id === projectId; })
      .sort(function (a, b) { return a.order - b.order; });
  }
  function nextOrder_(rows) {
    return rows.reduce(function (m, r) { return Math.max(m, r.order); }, 0) + 1;
  }
  function initProject_(projectId) {
    if (columnsOf_(projectId).length) return;
    DEFAULT_COLUMNS.forEach(function (name, i) {
      COLUMNS.insert({ project_id: projectId, name: name, order: i + 1 });
    });
  }

  return {
    title: 'Kanban',
    tables: [COLUMNS, TASKS],
    snapshot: function () {
      return {
        columns: COLUMNS.all().sort(function (a, b) { return a.order - b.order; }),
        tasks: TASKS.all().sort(function (a, b) { return a.order - b.order; })
      };
    },
    api: {
      initProject: function (a) { initProject_(a.projectId); return true; },

      addColumn: function (a, ctx) {
        var name = clean_(a.name, 60) || 'New column';
        var cols = columnsOf_(a.projectId);
        var row = COLUMNS.insert({ project_id: a.projectId, name: name, order: nextOrder_(cols) });
        ctx.refresh('kanban');
        return row;
      },

      renameColumn: function (a) {
        var name = clean_(a.name, 60) || 'Untitled';
        return COLUMNS.update(a.id, { name: name });
      },

      /** Deleting a column moves its tasks to the column on its left (or right if it is first). Never loses tasks. */
      deleteColumn: function (a, ctx) {
        var col = COLUMNS.get(a.id);
        assert_(col, 'Column not found.');
        var cols = columnsOf_(col.project_id);
        assert_(cols.length > 1, 'A board needs at least one column.');
        var i = cols.map(function (c) { return c.id; }).indexOf(col.id);
        var target = cols[i > 0 ? i - 1 : 1];
        var targetTasks = TASKS.all().filter(function (t) { return t.column_id === target.id; });
        var order = nextOrder_(targetTasks);
        TASKS.all().filter(function (t) { return t.column_id === col.id; })
          .sort(function (x, y) { return x.order - y.order; })
          .forEach(function (t) { TASKS.update(t.id, { column_id: target.id, order: order++ }); });
        COLUMNS.remove(col.id);
        ctx.refresh('kanban');
        return true;
      },

      addTask: function (a, ctx) {
        var title = clean_(a.title, 200);
        assert_(title, 'A task needs a title.');
        initProject_(a.projectId);
        var cols = columnsOf_(a.projectId);
        var colId = a.columnId || cols[0].id;
        var inCol = TASKS.all().filter(function (t) { return t.column_id === colId; });
        var row = TASKS.insert({ project_id: a.projectId, column_id: colId, title: title, order: nextOrder_(inCol), created: nowIso_() });
        ctx.refresh('kanban');
        return row;
      },

      moveTask: function (a) {
        var inCol = TASKS.all().filter(function (t) { return t.column_id === a.columnId; });
        return TASKS.update(a.id, { column_id: a.columnId, order: nextOrder_(inCol) });
      },

      renameTask: function (a) {
        var title = clean_(a.title, 200);
        assert_(title, 'A task needs a title.');
        return TASKS.update(a.id, { title: title });
      },

      deleteTask: function (a, ctx) {
        TASKS.remove(a.id);
        ctx.refresh('kanban');
        return true;
      },

      removeProject: function (a) {
        COLUMNS.removeWhere(function (c) { return c.project_id === a.projectId; });
        TASKS.removeWhere(function (t) { return t.project_id === a.projectId; });
        return true;
      }
    }
  };
}
