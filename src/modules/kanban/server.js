/**
 * Kanban module: boards of columns (renameable, addable, deletable) and the cards in them.
 * A board belongs to an owner: a project (project_id) or a list (list_id). Exactly one of the two is set on every
 * column and card. Calls from the browser give the owner's id as projectId, whichever it is, and the server works out
 * which column it goes in. Snapshot rows carry it as `owner` too, so the browser filters on one field.
 */

function kanbanModule() {
  var COLUMNS = new Table('Columns', ['id', 'project_id', 'list_id', 'name', 'order'], ['order']);
  var TASKS = new Table('Tasks', ['title', 'column', 'project', 'list', 'note', 'color', 'problem', 'id', 'project_id', 'list_id', 'column_id', 'order', 'note_html', 'created', 'updated_at'], ['order']);
  var CARD_COLORS = ['', '1', '2', '3', '4', '5', '6', '7', '8'];
  var DEFAULT_COLUMNS = ['To do', 'Doing', 'Done'];

  function ownerOf_(row) { return row.project_id || row.list_id; }
  function withOwner_(row) { row.owner = ownerOf_(row); return row; }

  function columnsOf_(ownerId) {
    return COLUMNS.all().filter(function (c) { return ownerOf_(c) === ownerId; })
      .sort(function (a, b) { return a.order - b.order; });
  }
  function nextOrder_(rows) {
    return rows.reduce(function (m, r) { return Math.max(m, r.order); }, 0) + 1;
  }
  /**
   * { project_id, list_id } for an owner id. isList: true or false when the caller knows; otherwise taken from the
   * board's columns, or, for a board with none yet, from whether the Lists tab has that id.
   */
  function ownerFields_(ownerId, isList) {
    if (isList === undefined) {
      var col = columnsOf_(ownerId)[0];
      isList = col ? !!col.list_id : lookRows_('Lists').some(function (l) { return l.id === ownerId; }); // never makes the tab
    }
    return isList ? { project_id: '', list_id: ownerId } : { project_id: ownerId, list_id: '' };
  }
  function initBoard_(ownerId, isList, names) {
    if (columnsOf_(ownerId).length) return;
    var owner = ownerFields_(ownerId, isList);
    COLUMNS.insertMany((names || DEFAULT_COLUMNS).map(function (name, i) {
      return { project_id: owner.project_id, list_id: owner.list_id, name: name, order: i + 1 };
    }));
  }
  /** The owner a call names: a.listId for a list's board, a.projectId for a project's. */
  function ownerArg_(a) {
    return a.listId ? { id: a.listId, isList: true } : { id: a.projectId, isList: false };
  }

  return {
    title: 'Kanban',
    tables: [COLUMNS, TASKS],
    snapshot: function () {
      return {
        columns: COLUMNS.all().sort(function (a, b) { return a.order - b.order; }).map(withOwner_),
        tasks: TASKS.all().sort(function (a, b) { return a.order - b.order; }).map(withOwner_)
      };
    },
    api: {
      /** Give a board its first columns: a.columns (names) or To do / Doing / Done. Does nothing if it has columns. */
      initProject: function (a) { var o = ownerArg_(a); initBoard_(o.id, o.isList, a.columns); return true; },

      addColumn: function (a, ctx) {
        var name = clean_(a.name, 60) || 'New column';
        var cols = columnsOf_(a.projectId);
        var owner = ownerFields_(a.projectId);
        var row = COLUMNS.insert({ id: clientId_(a.id), project_id: owner.project_id, list_id: owner.list_id, name: name, order: nextOrder_(cols) });
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
        assert_(a.projectId === undefined || a.projectId === ownerOf_(col), 'That column is not on this board.');
        assert_(typeof a.order === 'number' && isFinite(a.order), 'A column needs a place to move to.');
        ctx.refresh('kanban');
        return COLUMNS.update(col.id, { order: a.order });
      },

      /** Deleting a column moves its tasks to the column on its left (or right if it is first). Never loses tasks. */
      deleteColumn: function (a, ctx) {
        var col = COLUMNS.get(a.id);
        assert_(col, 'Column not found.');
        var cols = columnsOf_(ownerOf_(col));
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

      /** a.projectId: the board's owner (a project or a list). */
      addTask: function (a, ctx) {
        var title = clean_(a.title, 200);
        assert_(title, 'A task needs a title.');
        initBoard_(a.projectId);
        var cols = columnsOf_(a.projectId);
        var colId = a.columnId || cols[0].id;
        var col = cols.filter(function (c) { return c.id === colId; })[0];
        assert_(col, 'That column is not on this board. Reload and try again.');
        var inCol = TASKS.all().filter(function (t) { return t.column_id === colId; });
        var row = TASKS.insert({
          id: clientId_(a.id), project_id: col.project_id, list_id: col.list_id, column_id: colId, column: col.name,
          title: title, order: nextOrder_(inCol), created: nowIso_()
        });
        ctx.refresh('kanban');
        return withOwner_(row);
      },

      /** Change a card's title, colour ('' for none) and/or note (editor HTML; cleaned, with a plain-text copy in `note`). */
      updateTask: function (a, ctx) {
        var patch = {};
        if (a.title !== undefined) { patch.title = clean_(a.title, 200); assert_(patch.title, 'A task needs a title.'); }
        if (a.color !== undefined) { assert_(CARD_COLORS.indexOf(String(a.color)) !== -1, 'Unknown colour: ' + a.color); patch.color = String(a.color); }
        if (a.noteHtml !== undefined) {
          patch.note_html = sanitizeRichText_(a.noteHtml);
          patch.note = richTextToPlain_(patch.note_html);
          if (!patch.note) patch.note_html = '';
        }
        var row = TASKS.update(a.id, patch);
        ctx.refresh('kanban');
        return withOwner_(row);
      },

      /**
       * Add many cards to a board in one write, for imports. a.cards: [{ column (name), title, color, noteHtml }].
       * Cards go into the named column (the first column if the name is unknown), after any cards already there.
       * a.listId for a list's board, a.projectId for a project's.
       */
      importCards: function (a, ctx) {
        var cols = columnsOf_(ownerArg_(a).id);
        assert_(cols.length, 'That board has no columns.');
        var byName = {};
        cols.forEach(function (c) { byName[c.name] = c; });
        var nextInColumn = {};
        TASKS.all().forEach(function (t) { nextInColumn[t.column_id] = Math.max(nextInColumn[t.column_id] || 0, t.order); });
        var rows = (a.cards || []).map(function (card) {
          var col = byName[card.column] || cols[0];
          nextInColumn[col.id] = (nextInColumn[col.id] || 0) + 1;
          var noteHtml = sanitizeRichText_(card.noteHtml || '');
          var noteText = richTextToPlain_(noteHtml);
          return {
            project_id: col.project_id, list_id: col.list_id, column_id: col.id, column: col.name,
            title: clean_(card.title, 200) || 'Untitled', order: nextInColumn[col.id],
            created: nowIso_(), color: CARD_COLORS.indexOf(String(card.color || '')) !== -1 ? String(card.color || '') : '',
            note_html: noteText ? noteHtml : '', note: noteText
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
        assert_(columnsOf_(ownerOf_(task)).some(function (c) { return c.id === a.columnId; }), 'That column is not on this board.');
        var inCol = TASKS.all().filter(function (t) { return t.column_id === a.columnId && t.id !== a.id; });
        var order = typeof a.order === 'number' && isFinite(a.order) ? a.order : nextOrder_(inCol);
        ctx.refresh('kanban');
        return withOwner_(TASKS.update(a.id, { column_id: a.columnId, order: order }));
      },

      renameTask: function (a, ctx) {
        var title = clean_(a.title, 200);
        assert_(title, 'A task needs a title.');
        ctx.refresh('kanban');
        return withOwner_(TASKS.update(a.id, { title: title }));
      },

      deleteTask: function (a, ctx) {
        TASKS.remove(a.id);
        ctx.refresh('kanban');
        return true;
      },

      /** Remove a board with its cards: a.projectId (or a.listId) is its owner. */
      removeProject: function (a) {
        var ownerId = ownerArg_(a).id;
        assert_(ownerId, 'No board given.');
        COLUMNS.removeWhere(function (c) { return ownerOf_(c) === ownerId; });
        TASKS.removeWhere(function (t) { return ownerOf_(t) === ownerId; });
        return true;
      }
    }
  };
}
