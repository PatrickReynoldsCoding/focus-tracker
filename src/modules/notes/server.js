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
        if (!row) return { text: '', url: '', updated: '' };
        return { text: DriveApp.getFileById(row.file_id).getBlob().getDataAsString(), url: row.file_url, updated: row.updated };
      },

      save: function (a, ctx) {
        assert_(a.projectId, 'No project given.');
        var text = typeof a.text === 'string' ? a.text : '';
        var row = rowFor_(a.projectId);
        var project = ctx.call('projects', 'list', {}).filter(function (p) { return p.id === a.projectId; })[0];
        if (row) {
          var existing = DriveApp.getFileById(row.file_id);
          // Saves carry the version the browser's text builds on (_base) and when it was edited (_editedAt). If the file
          // changed since (another device, or a page that never loaded it), the newest edit wins and the older text is kept
          // as a conflict copy next to it. The same text is no conflict.
          if (a._base !== undefined && row.updated && row.updated !== String(a._base)) {
            var current = existing.getBlob().getDataAsString();
            if (current === text) return { url: row.file_url, updated: row.updated };
            var serverNewer = timeOf_(row.updated) >= timeOf_(a._editedAt);
            var stamp = nowIso_().slice(0, 16).replace(/[-:T]/g, '');
            var copyName = slug_(project ? project.name : 'project') + '-' + a.projectId + '-conflict-' + stamp + '.md';
            var copy = getSubfolder_('Notes').createFile(copyName, serverNewer ? text : current, 'text/markdown');
            reportConflict_({ what: 'notes', kept: serverNewer ? 'server' : 'yours', copyUrl: copy.getUrl() });
            ctx.optional('log', 'conflict', { projectId: a.projectId, text: 'Conflict: the notes were changed on another device. ' +
              (serverNewer ? 'The newer notes were kept; your text' : 'Your text was newer and replaced them; the other text') +
              ' is saved as ' + copyName + ' in the Notes folder.' });
            var conflict = { kept: serverNewer ? 'server' : 'yours', copyName: copyName };
            if (serverNewer) return { url: row.file_url, updated: row.updated, text: current, conflict: conflict };
          }
          existing.setContent(text);
          var stampNow = nowIso_();
          T.update(row.id, { updated: stampNow });
          return conflict ? { url: row.file_url, updated: stampNow, conflict: conflict } : { url: row.file_url, updated: stampNow };
        }
        assert_(project, 'Project not found.');
        var file = getSubfolder_('Notes').createFile(slug_(project.name) + '-' + project.id + '.md', text, 'text/markdown');
        var created = nowIso_();
        T.insert({ project_id: a.projectId, file_id: file.getId(), file_url: file.getUrl(), updated: created });
        return { url: file.getUrl(), updated: created };
      },

      /** Forget the link. The markdown file stays in Drive. */
      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
