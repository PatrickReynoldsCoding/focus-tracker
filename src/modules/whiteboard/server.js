/**
 * Whiteboard module: one Excalidraw drawing per project, saved as a .excalidraw file (JSON) in
 * <mode folder>/Whiteboards, so it opens where you left off and can also be opened at excalidraw.com.
 * The Whiteboards tab only records which file belongs to which project.
 */

function whiteboardModule() {
  var T = new Table('Whiteboards', ['id', 'project_id', 'file_id', 'file_url', 'updated']);
  var MAX_LENGTH = 20 * 1024 * 1024;

  function rowFor_(projectId) {
    return T.all().filter(function (r) { return r.project_id === projectId; })[0] || null;
  }

  function slug_(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  }

  /** Only a parseable Excalidraw scene is saved, so a broken save can never replace a good drawing. */
  function checkScene_(json) {
    assert_(typeof json === 'string' && json.length <= MAX_LENGTH, 'That drawing is too large to save (over 20 MB). Remove some images.');
    var scene;
    try { scene = JSON.parse(json); } catch (e) { throw new Error('The drawing could not be read, so it was not saved.'); }
    assert_(scene && scene.type === 'excalidraw' && Array.isArray(scene.elements), 'That is not an Excalidraw drawing, so it was not saved.');
  }

  return {
    title: 'Whiteboard',
    tables: [T],
    snapshot: function () {
      return T.all().map(function (r) { return { project_id: r.project_id, url: r.file_url, updated: r.updated }; });
    },
    api: {
      get: function (a) {
        var row = rowFor_(a.projectId);
        if (!row) return { json: '', url: '' };
        return { json: DriveApp.getFileById(row.file_id).getBlob().getDataAsString(), url: row.file_url };
      },

      save: function (a, ctx) {
        checkScene_(a.json);
        var row = rowFor_(a.projectId), now = nowIso_();
        if (row) {
          DriveApp.getFileById(row.file_id).setContent(a.json);
          T.update(row.id, { updated: now });
          ctx.refresh('whiteboard');
          return { url: row.file_url, updated: now };
        }
        var project = ctx.call('projects', 'list', {}).filter(function (p) { return p.id === a.projectId; })[0];
        assert_(project, 'Project not found.');
        var file = getSubfolder_('Whiteboards').createFile(slug_(project.name) + '-' + project.id + '.excalidraw', a.json, 'application/json');
        T.insert({ project_id: a.projectId, file_id: file.getId(), file_url: file.getUrl(), updated: now });
        ctx.refresh('whiteboard');
        return { url: file.getUrl(), updated: now };
      },

      /** Forget the link. The drawing file stays in Drive. */
      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
