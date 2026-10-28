/**
 * Criteria module: a short checklist of acceptance criteria per project ("done when ..."), shown above the Kanban.
 * One row per criterion in the Criteria tab; done is 'yes' or ''.
 */

function criteriaModule() {
  var T = new Table('Criteria', ['id', 'project_id', 'text', 'done', 'order', 'created'], ['order']);

  function text_(value) {
    var text = clean_(value, 300);
    assert_(text, 'A criterion needs some text.');
    return text;
  }

  return {
    title: 'Criteria',
    tables: [T],
    snapshot: function () { return T.all().sort(function (a, b) { return a.order - b.order; }); },
    api: {
      add: function (a, ctx) {
        assert_(ctx.call('projects', 'list', {}).some(function (p) { return p.id === a.projectId; }), 'Project not found.');
        var mine = T.all().filter(function (c) { return c.project_id === a.projectId; });
        var row = T.insert({
          id: clientId_(a.id), project_id: a.projectId, text: text_(a.text), done: '',
          order: mine.reduce(function (m, c) { return Math.max(m, c.order); }, 0) + 1, created: nowIso_()
        });
        ctx.refresh('criteria');
        return row;
      },

      /** Change the text, tick it (a.done true/false) and/or move it (a.order: any number between its neighbours). */
      update: function (a, ctx) {
        var patch = {};
        if (a.text !== undefined) patch.text = text_(a.text);
        if (a.done !== undefined) patch.done = a.done ? 'yes' : '';
        if (typeof a.order === 'number' && isFinite(a.order)) patch.order = a.order;
        var row = T.update(a.id, patch);
        ctx.refresh('criteria');
        return row;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('criteria');
        return true;
      },

      removeProject: function (a) {
        T.removeWhere(function (c) { return c.project_id === a.projectId; });
        return true;
      }
    }
  };
}
