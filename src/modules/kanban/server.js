/**
 * Kanban module: boards of columns (renameable, addable, deletable) and the cards in them.
 * A board belongs to an owner id, kept in the project_id column: a project, or another module's item such as a list.
 */

function kanbanModule() {
  var COLUMNS = new Table('Columns', ['id', 'project_id', 'name', 'order'], ['order']);
  var TASKS = new Table('Tasks', ['id', 'project_id', 'column_id', 'title', 'order', 'created', 'color', 'note_html', 'note_text', 'updated_at'], ['order']);
  var CARD_COLORS = ['', '1', '2', '3', '4', '5', '6', '7', '8'];
  var DEFAULT_COLUMNS = ['To do', 'Doing', 'Done'];

  function columnsOf_(projectId) {
    return COLUMNS.all().filter(function (c) { return c.project_id === projectId; })
      .sort(function (a, b) { return a.order - b.order; });
  }
  function nextOrder_(rows) {
    return rows.reduce(function (m, r) { return Math.max(m, r.order); }, 0) + 1;
  }
  function initProject_(projectId, names) {
    if (columnsOf_(projectId).length) return;
    COLUMNS.insertMany((names || DEFAULT_COLUMNS).map(function (name, i) {
      return { project_id: projectId, name: name, order: i + 1 };
    }));
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
      /** Give a board its first columns: a.columns (names) or To do / Doing / Done. Does nothing if it has columns. */
      initProject: function (a) { initProject_(a.projectId, a.columns); return true; },

      addColumn: function (a, ctx) {
        var name = clean_(a.name, 60) || 'New column';
        var cols = columnsOf_(a.projectId);
        var row = COLUMNS.insert({ id: clientId_(a.id), project_id: a.projectId, name: name, order: nextOrder_(cols) });
        ctx.refresh('kanban');
        return row;
      },

      renameColumn: function (a, ctx) {
        var name = clean_(a.name, 60) || 'Untitled';
        ctx.refresh('kanban');
        return COLUMNS.update(a.id, { name: name });
      },

      /** Move a column to a new place on its board. a.order: any number, for example between two neighbours. a.projectId, if given, must be its board. */
      moveColumn: function (a, ctx) {
        var col = COLUMNS.get(a.id);
        assert_(col, 'That column no longer exists.');
        assert_(a.projectId === undefined || a.projectId === col.project_id, 'That column is not on this board.');
        assert_(typeof a.order === 'number' && isFinite(a.order), 'A column needs a place to move to.');
        ctx.refresh('kanban');
        return COLUMNS.update(col.id, { order: a.order });
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
        assert_(cols.some(function (c) { return c.id === colId; }), 'That column is not on this board. Reload and try again.');
        var inCol = TASKS.all().filter(function (t) { return t.column_id === colId; });
        var row = TASKS.insert({ id: clientId_(a.id), project_id: a.projectId, column_id: colId, title: title, order: nextOrder_(inCol), created: nowIso_() });
        ctx.refresh('kanban');
        return row;
      },

      /** Change a card's title, colour ('' for none) and/or note (editor HTML; cleaned, with a plain-text copy). */
      updateTask: function (a, ctx) {
        var patch = {};
        if (a.title !== undefined) { patch.title = clean_(a.title, 200); assert_(patch.title, 'A task needs a title.'); }
        if (a.color !== undefined) { assert_(CARD_COLORS.indexOf(String(a.color)) !== -1, 'Unknown colour: ' + a.color); patch.color = String(a.color); }
        if (a.noteHtml !== undefined) {
          patch.note_html = sanitizeRichText_(a.noteHtml);
          patch.note_text = richTextToPlain_(patch.note_html);
          if (!patch.note_text) patch.note_html = '';
        }
        var row = TASKS.update(a.id, patch);
        ctx.refresh('kanban');
        return row;
      },

      /**
       * Add many cards to a board in one write, for imports. a.cards: [{ column (name), title, color, noteHtml }].
       * Cards go into the named column (the first column if the name is unknown), after any cards already there.
       */
      importCards: function (a, ctx) {
        var cols = columnsOf_(a.projectId);
        assert_(cols.length, 'That board has no columns.');
        var byName = {};
        cols.forEach(function (c) { byName[c.name] = c.id; });
        var nextInColumn = {};
        TASKS.all().forEach(function (t) { nextInColumn[t.column_id] = Math.max(nextInColumn[t.column_id] || 0, t.order); });
        var rows = (a.cards || []).map(function (card) {
          var columnId = byName[card.column] || cols[0].id;
          nextInColumn[columnId] = (nextInColumn[columnId] || 0) + 1;
          var noteHtml = sanitizeRichText_(card.noteHtml || '');
          var noteText = richTextToPlain_(noteHtml);
          return {
            project_id: a.projectId, column_id: columnId, title: clean_(card.title, 200) || 'Untitled', order: nextInColumn[columnId],
            created: nowIso_(), color: CARD_COLORS.indexOf(String(card.color || '')) !== -1 ? String(card.color || '') : '',
            note_html: noteText ? noteHtml : '', note_text: noteText
          };
        });
        TASKS.insertMany(rows);
        ctx.refresh('kanban');
        return rows.length;
      },

      /** Move a card to a column. a.order: its place (any number, for example between two neighbours); last if left out. */
      moveTask: function (a, ctx) {
        var task = TASKS.get(a.id);
        assert_(task, 'That card no longer exists.');
        assert_(columnsOf_(task.project_id).some(function (c) { return c.id === a.columnId; }), 'That column is not on this board.');
        var inCol = TASKS.all().filter(function (t) { return t.column_id === a.columnId && t.id !== a.id; });
        var order = typeof a.order === 'number' && isFinite(a.order) ? a.order : nextOrder_(inCol);
        ctx.refresh('kanban');
        return TASKS.update(a.id, { column_id: a.columnId, order: order });
      },

      renameTask: function (a, ctx) {
        var title = clean_(a.title, 200);
        assert_(title, 'A task needs a title.');
        ctx.refresh('kanban');
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
