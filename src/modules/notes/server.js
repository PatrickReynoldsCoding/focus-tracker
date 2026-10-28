/**
 * Notes module: one markdown file per project in <Focus Tracker folder>/Notes.
 * Plain text, so it is readable on any device and by Claude. The Notes tab only records which file belongs to which project.
 */

function notesModule() {
  var T = new Table('Notes', ['id', 'project_id', 'file_id', 'file_url', 'updated']);

  function rowFor_(projectId) {
    var all = T.all();
    for (var i = 0; i < all.length; i++) if (all[i].project_id === projectId) return all[i];
    return null;
  }
  function slug_(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  }

  return {
    title: 'Notes',
    tables: [T],
    snapshot: function () {
      return T.all().map(function (r) { return { project_id: r.project_id, url: r.file_url, updated: r.updated }; });
    },
    api: {
      get: function (a) {
        var row = rowFor_(a.projectId);
        if (!row) return { text: '', url: '' };
        return { text: DriveApp.getFileById(row.file_id).getBlob().getDataAsString(), url: row.file_url };
      },

      save: function (a, ctx) {
        assert_(a.projectId, 'No project given.');
        var text = typeof a.text === 'string' ? a.text : '';
        var row = rowFor_(a.projectId);
        if (row) {
          DriveApp.getFileById(row.file_id).setContent(text);
          T.update(row.id, { updated: nowIso_() });
          return { url: row.file_url };
        }
        var project = ctx.call('projects', 'list', {}).filter(function (p) { return p.id === a.projectId; })[0];
        assert_(project, 'Project not found.');
        var file = getSubfolder_('Notes').createFile(slug_(project.name) + '-' + project.id + '.md', text, 'text/markdown');
        T.insert({ project_id: a.projectId, file_id: file.getId(), file_url: file.getUrl(), updated: nowIso_() });
        return { url: file.getUrl() };
      },

      /** Forget the link. The markdown file stays in Drive. */
      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
