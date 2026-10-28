/**
 * Notes module: one markdown file per project in <Focus Tracker folder>/Notes.
 * Plain text, so it is readable on any device and by Claude. The editor also keeps its formatting (colours, headings)
 * in a cleaned HTML file beside it. The Notes tab only records which files belong to which project.
 */

var NOTES_HTML_MAX_ = 1000000;

function notesModule() {
  var T = new Table('Notes', ['id', 'project_id', 'file_id', 'file_url', 'updated', 'html_file_id']);

  function rowFor_(projectId) {
    var all = T.all();
    for (var i = 0; i < all.length; i++) if (all[i].project_id === projectId) return all[i];
    return null;
  }
  function slug_(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  }

  function projectFor_(projectId, ctx) {
    var project = ctx.call('projects', 'list', {}).filter(function (p) { return p.id === projectId; })[0];
    assert_(project, 'Project not found.');
    return project;
  }

  /** The formatted copy: written when the editor sends HTML, found again by its own file id. */
  function saveHtml_(row, project, html) {
    var clean = sanitizeRichText_(html, NOTES_HTML_MAX_);
    if (row.html_file_id) {
      DriveApp.getFileById(row.html_file_id).setContent(clean);
      return row.html_file_id;
    }
    return getSubfolder_('Notes').createFile(slug_(project.name) + '-' + project.id + '.html', clean, 'text/html').getId();
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
        if (!row) return { text: '', html: '', url: '' };
        return {
          text: DriveApp.getFileById(row.file_id).getBlob().getDataAsString(),
          html: row.html_file_id ? DriveApp.getFileById(row.html_file_id).getBlob().getDataAsString() : '',
          url: row.file_url
        };
      },

      save: function (a, ctx) {
        assert_(a.projectId, 'No project given.');
        var text = typeof a.text === 'string' ? a.text : '';
        var wantsHtml = typeof a.html === 'string';
        var row = rowFor_(a.projectId);
        if (row) {
          var patch = { updated: nowIso_() };
          if (wantsHtml) patch.html_file_id = saveHtml_(row, row.html_file_id ? null : projectFor_(a.projectId, ctx), a.html);
          DriveApp.getFileById(row.file_id).setContent(text);
          T.update(row.id, patch);
          return { url: row.file_url };
        }
        var project = projectFor_(a.projectId, ctx);
        var file = getSubfolder_('Notes').createFile(slug_(project.name) + '-' + project.id + '.md', text, 'text/markdown');
        T.insert({ project_id: a.projectId, file_id: file.getId(), file_url: file.getUrl(), updated: nowIso_(),
          html_file_id: wantsHtml ? saveHtml_({}, project, a.html) : '' });
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
