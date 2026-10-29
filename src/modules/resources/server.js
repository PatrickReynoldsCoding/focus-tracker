/**
 * Resources module: links to Drive files and web pages, shared by a whole category or kept on one project.
 * Stores only the link, a title and a note. It never opens or copies the linked file.
 * See AGENTS.md: check for sensitive material before adding a link on someone's behalf.
 *
 * Schema v2: the address is in `value`, with a `type` (link, or drive for a Google Drive or Docs address) and a free
 * text `group`. Phone numbers, email addresses and plain text (the other types) come with the resources feature;
 * the app adds links only for now. add() still takes the address as `url`, as the page sends it.
 */

function resourcesModule() {
  var T = new Table('Resources', ['title', 'type', 'value', 'group', 'project', 'category', 'note', 'problem', 'id', 'project_id', 'added']);

  return {
    title: 'Resources',
    tables: [T],
    snapshot: function () { return T.all(); },
    api: {
      add: function (a, ctx) {
        var title = clean_(a.title, 120);
        var value = clean_(a.value !== undefined ? a.value : a.url, 500);
        assert_(title, 'Add a title.');
        assert_(/^https:\/\//i.test(value), 'Use a full link that starts with https://');
        assert_(ctx.call('categories', 'ids').indexOf(a.category) !== -1, 'Unknown category: ' + a.category);
        var row = T.insert({
          title: title,
          type: resourceTypeFor_(value),
          value: value,
          group: clean_(a.group, 60),
          category: a.category,
          project_id: a.projectId || '',
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

      countInCategory: function (a) {
        return T.all().filter(function (r) { return r.category === a.category; }).length;
      },

      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
