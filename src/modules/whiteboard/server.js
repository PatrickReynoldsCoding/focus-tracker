/**
 * Whiteboard module: named Excalidraw drawings, any number per project. Each is a .excalidraw file (JSON) in
 * <mode folder>/Whiteboards, so it opens where you left off and can also be opened at excalidraw.com.
 * The Whiteboards tab records which file belongs to which project and its name. Rows from before names existed
 * have an empty name and show as "Whiteboard".
 */

function whiteboardModule() {
  var T = new Table('Whiteboards', ['id', 'project_id', 'file_id', 'file_url', 'updated', 'name', 'created']);
  var MAX_LENGTH = 20 * 1024 * 1024;
  var EMPTY_SCENE = { type: 'excalidraw', version: 2, source: 'focus-tracker', elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} };

  function slug_(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'whiteboard';
  }

  function name_(value) {
    var name = clean_(value, 80);
    assert_(name, 'A whiteboard needs a name.');
    return name;
  }

  function project_(ctx, projectId) {
    var project = ctx.call('projects', 'list', {}).filter(function (p) { return p.id === projectId; })[0];
    assert_(project, 'Project not found.');
    return project;
  }

  function fileName_(project, name, id) {
    return slug_(project.name) + '-' + slug_(name) + '-' + id + '.excalidraw';
  }

  function board_(id) {
    var row = T.get(id);
    assert_(row, 'That whiteboard no longer exists.');
    return row;
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
      return T.all().map(function (r) {
        return { id: r.id, project_id: r.project_id, name: r.name || 'Whiteboard', url: r.file_url, updated: r.updated, created: r.created };
      });
    },
    api: {
      /** A new, empty whiteboard with a file in Drive straight away, so its Drive link works at once. */
      create: function (a, ctx) {
        var project = project_(ctx, a.projectId), name = name_(a.name), id = clientId_(a.id), now = nowIso_();
        var file = getSubfolder_('Whiteboards').createFile(fileName_(project, name, id), JSON.stringify(EMPTY_SCENE), 'application/json');
        var row = T.insert({ id: id, project_id: project.id, file_id: file.getId(), file_url: file.getUrl(), updated: now, name: name, created: now });
        ctx.refresh('whiteboard');
        return row;
      },

      get: function (a) {
        var row = board_(a.id);
        return { json: DriveApp.getFileById(row.file_id).getBlob().getDataAsString(), url: row.file_url, name: row.name || 'Whiteboard' };
      },

      save: function (a, ctx) {
        checkScene_(a.json);
        var row = board_(a.id), now = nowIso_();
        DriveApp.getFileById(row.file_id).setContent(a.json);
        T.update(row.id, { updated: now });
        ctx.refresh('whiteboard');
        return { url: row.file_url, updated: now };
      },

      /** Rename the whiteboard and its file in Drive. */
      rename: function (a, ctx) {
        var row = board_(a.id), name = name_(a.name);
        DriveApp.getFileById(row.file_id).setName(fileName_(project_(ctx, row.project_id), name, row.id));
        var updated = T.update(row.id, { name: name });
        ctx.refresh('whiteboard');
        return updated;
      },

      /** Take the whiteboard off the project. Its file stays in Drive. */
      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('whiteboard');
        return true;
      },

      /** Forget the links. The drawing files stay in Drive. */
      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}
