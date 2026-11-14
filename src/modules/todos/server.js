/**
 * To-dos module: one-off small tasks (grocery shopping, a job interview), one row each in the To-dos tab. Every to-do
 * is on a to-do list: a row of the Lists tab with kind 'todo' (list_id, its name in `list`), in one of the list's groups
 * (group_id, its name in `group`). A to-do list's groups are its board columns, made and renamed by the kanban module
 * like a list's groups; deleting one moves its to-dos to the group beside it (moveGroup). There can be any number of
 * to-do lists; each is its own panel (lists module) that can go on Today, in a pill or on a project's page.
 * `day` is the ISO date a to-do is for, empty for anytime; `done` is the date it was ticked, empty while open. A to-do
 * can point at a project (project_id, with its name in `project`). Its description is `note_html` (cleaned rich text,
 * from the card dialog) with a plain copy in `note`; `color` is a card colour.
 * Plan my week puts to-dos of every list on days, from today to the end of next week, never further. A to-do added
 * without a list (Plan my week, an older page) goes on the first to-do list, made ("To-dos") if there is none.
 */

var TODOS_HEADERS_ = ['title', 'list', 'group', 'day', 'done', 'project', 'note', 'color', 'problem', 'id', 'list_id', 'group_id', 'project_id', 'order', 'note_html', 'created', 'updated_at'];
var DEFAULT_TODO_LIST_NAME_ = 'To-dos';

function todosModule() {
  var T = new Table('To-dos', TODOS_HEADERS_, ['order']);
  var KEEP_DONE_DAYS = 14; // ticked to-dos stay in the browser this long (Plan my week shows them on their day)
  var NOTE_MAX_LENGTH = 300;
  var CARD_COLORS = ['', '1', '2', '3', '4', '5', '6', '7', '8'];

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

  function nextOrder_() {
    return T.all().reduce(function (m, t) { return Math.max(m, t.order); }, 0) + 1;
  }

  function isTodoList_(list) { return !!list && list.kind === TODO_LIST_KIND_; }

  /** The to-do list a.listId names, or the first one, made (and refreshed on the page) if there is none. */
  function listFor_(listId, ctx) {
    if (listId) {
      var named = ctx.call('lists', 'get', { id: listId });
      assert_(isTodoList_(named), 'That to-do list no longer exists.');
      return named;
    }
    var first = ctx.call('lists', 'ofKind', { kind: TODO_LIST_KIND_ })[0];
    if (first) return first;
    ctx.refresh('lists', 'kanban');
    return ctx.call('lists', 'create', { name: DEFAULT_TODO_LIST_NAME_, kind: TODO_LIST_KIND_, showToday: true });
  }

  /** The list a to-do is on. One typed in the sheet before any to-do list existed (or whose list is gone) joins the first. */
  function listOf_(todo, ctx) {
    var own = todo.list_id ? ctx.call('lists', 'get', { id: todo.list_id }) : null;
    return isTodoList_(own) ? own : listFor_('', ctx);
  }

  /**
   * A group of the list: the one named (it must be on that list), else the list's first group. A to-do list typed into
   * the sheet has no group until its first to-do: it gets one, as a list made in the app does.
   */
  function groupFor_(listId, groupId, ctx) {
    var groups = ctx.call('kanban', 'groups', { listId: listId });
    if (!groups.length) {
      ctx.call('kanban', 'initProject', { listId: listId, columns: [FIRST_TODO_GROUP_] });
      ctx.refresh('kanban');
      groups = ctx.call('kanban', 'groups', { listId: listId });
    }
    if (!groupId) return groups[0];
    var named = groups.filter(function (g) { return g.id === groupId; })[0];
    assert_(named, 'That group is not on this to-do list. Reload and try again.');
    return named;
  }

  /** The description from the card dialog: cleaned HTML and its plain copy. */
  function notePatch_(noteHtml) {
    var html = sanitizeRichText_(noteHtml);
    var plain = richTextToPlain_(html);
    return { note_html: plain ? html : '', note: plain };
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
      /**
       * a.title, a.day ('' for anytime), a.projectId (optional), a.listId and a.groupId (optional: the first to-do
       * list and its first group), a.note (plain, optional); a.id from the browser.
       */
      add: function (a, ctx) {
        var list = listFor_(a.listId, ctx);
        var group = groupFor_(list.id, a.groupId, ctx);
        var row = T.insert({
          id: clientId_(a.id), title: title_(a.title), day: day_(a.day), done: '', note: clean_(a.note, NOTE_MAX_LENGTH), project_id: project_(a.projectId, ctx),
          list_id: list.id, group_id: group.id, order: nextOrder_(), created: nowIso_()
        });
        ctx.refresh('todos');
        return row;
      },

      /**
       * The card dialog: any of a.title, a.noteHtml (the description, cleaned here) or a.note (plain), a.color, a.day,
       * a.projectId, a.groupId (another group of its list) and a.done (true ticks it today, false unticks it).
       */
      update: function (a, ctx) {
        var todo = T.get(a.id);
        assert_(todo, 'That to-do no longer exists.');
        var patch = {};
        if (a.title !== undefined) patch.title = title_(a.title);
        if (a.noteHtml !== undefined) Object.assign(patch, notePatch_(a.noteHtml));
        else if (a.note !== undefined) patch.note = clean_(a.note, NOTE_MAX_LENGTH);
        if (a.color !== undefined) { assert_(CARD_COLORS.indexOf(String(a.color)) !== -1, 'Unknown colour: ' + a.color); patch.color = String(a.color); }
        if (a.day !== undefined && a.day !== todo.day) patch.day = day_(a.day);
        if (a.projectId !== undefined) patch.project_id = project_(a.projectId, ctx);
        if (a.groupId !== undefined && a.groupId !== todo.group_id) {
          var list = listOf_(todo, ctx);
          patch.list_id = list.id;
          patch.group_id = groupFor_(list.id, a.groupId, ctx).id;
        }
        if (a.done !== undefined && !!a.done !== !!todo.done) patch.done = a.done ? todayIso_() : '';
        var row = T.update(a.id, patch);
        ctx.refresh('todos');
        return row;
      },

      /** Drag and drop: a.groupId (a group of the to-do's list) and a.order, any number (between two neighbours). */
      move: function (a, ctx) {
        var todo = T.get(a.id);
        assert_(todo, 'That to-do no longer exists.');
        assert_(typeof a.order === 'number' && isFinite(a.order), 'A to-do needs a place to move to.');
        var list = listOf_(todo, ctx);
        var row = T.update(a.id, { list_id: list.id, group_id: groupFor_(list.id, a.groupId, ctx).id, order: a.order });
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

      /** A group of a to-do list was deleted (kanban.deleteColumn): its to-dos go to a.to, after the ones there. */
      moveGroup: function (a, ctx) {
        var order = nextOrder_();
        T.all().filter(function (t) { return t.group_id === a.from; }).sort(function (x, y) { return x.order - y.order; })
          .forEach(function (t) { T.update(t.id, { group_id: a.to, order: order++ }); });
        ctx.refresh('todos');
        return true;
      },

      /** A to-do list was deleted (lists.remove): its to-dos go with it. Undo brings them back. */
      removeList: function (a, ctx) {
        T.removeWhere(function (t) { return t.list_id === a.listId; });
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
