/**
 * Resources module: links to Drive files and web pages, shared by a whole category or kept on one project.
 * Stores only the link, a title and a note. It never opens or copies the linked file.
 * See AGENTS.md: check for sensitive material before adding a link on someone's behalf.
 */

function resourcesModule() {
  var T = new Table('Resources', ['id', 'category', 'project_id', 'title', 'url', 'note', 'added']);

  return {
    title: 'Resources',
    tables: [T],
    snapshot: function () { return T.all(); },
    api: {
      add: function (a, ctx) {
        var title = clean_(a.title, 120);
        var url = clean_(a.url, 500);
        assert_(title, 'Add a title.');
        assert_(/^https:\/\//i.test(url), 'Use a full link that starts with https://');
        assert_(categoryIds_().indexOf(a.category) !== -1, 'Unknown category: ' + a.category);
        var row = T.insert({
          category: a.category,
          project_id: a.projectId || '',
          title: title,
          url: url,
          note: clean_(a.note, 300),
          added: nowIso_()
        });
        ctx.refresh('resources');
        return row;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('resources');
        return true;
      },

      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
