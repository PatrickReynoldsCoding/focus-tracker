/**
 * Whiteboard module: named Excalidraw drawings, on a project or on their own. Each is a .excalidraw file (JSON) in
 * <mode folder>/Whiteboards, so it opens where you left off and can also be opened at excalidraw.com.
 * The Whiteboards tab records each board's file, name, project (optional) and whether it shows on Today. Rows from
 * before names existed have an empty name and show as "Whiteboard".
 * Thumbs (a grey tab) holds one small preview per board, made by the browser when it saves the board: a WebP or JPEG
 * data URL under THUMB_MAX characters (a sheet cell holds 50,000). The row's id is the board's id. Thumbnails are not
 * in the snapshot: the browser asks for them with thumbs() when it shows them (see view.html for why).
 */

function whiteboardModule() {
  var T = new Table('Whiteboards', ['name', 'project', 'show_today', 'file', 'updated', 'problem', 'id', 'project_id', 'file_id', 'created']);
  // One row per board: id is the board's id (schema.md planned a whiteboard_id column; Table needs an id, and a second copy would only drift).
  var THUMBS = new Table('Thumbs', ['id', 'image', 'updated']);
  var THUMB_MAX = 45000;
  var THUMB_PATTERN = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+\/]+={0,2}$/;
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

  /** The board's project, or null for a board on its own (no project id). lenient: null too when the project is gone. */
  function project_(ctx, projectId, lenient) {
    if (!projectId) return null;
    var project = ctx.call('projects', 'list', {}).filter(function (p) { return p.id === projectId; })[0];
    assert_(project || lenient, 'Project not found.');
    return project || null;
  }

  /** <project>-<name>-<id>.excalidraw, or <name>-<id>.excalidraw for a board without a project. */
  function fileName_(project, name, id) {
    return (project ? slug_(project.name) + '-' : '') + slug_(name) + '-' + id + '.excalidraw';
  }

  /** undefined: leave the thumbnail as it is. '': no thumbnail (an empty board). Otherwise a small image as a data URL. */
  function checkThumb_(thumb) {
    if (thumb === undefined || thumb === null || thumb === '') return;
    assert_(typeof thumb === 'string' && thumb.length <= THUMB_MAX, 'The preview is too large (over ' + THUMB_MAX + ' characters), so the drawing was not saved.');
    assert_(THUMB_PATTERN.test(thumb), 'The preview is not an image, so the drawing was not saved.');
  }

  function saveThumb_(id, thumb, updated) {
    if (thumb === undefined || thumb === null) return;
    var row = THUMBS.get(id);
    if (!thumb) { if (row) THUMBS.remove(id); return; }
    if (row) THUMBS.update(id, { image: thumb, updated: updated });
    else THUMBS.insert({ id: id, image: thumb, updated: updated });
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
    tables: [T, THUMBS],
    snapshot: function () {
      return T.all().map(function (r) {
        return { id: r.id, project_id: r.project_id, name: r.name || 'Whiteboard', url: r.file, updated: r.updated, created: r.created, show_today: r.show_today };
      });
    },
    api: {
      /** A new, empty whiteboard with a file in Drive straight away, so its Drive link works at once. a.projectId is optional. */
      create: function (a, ctx) {
        var project = project_(ctx, a.projectId), name = name_(a.name), id = clientId_(a.id), now = nowIso_();
        var file = getSubfolder_('Whiteboards').createFile(fileName_(project, name, id), JSON.stringify(EMPTY_SCENE), 'application/json');
        var row = T.insert({ id: id, project_id: project ? project.id : '', file_id: file.getId(), file: file.getUrl(), updated: now, name: name, created: now,
          show_today: a.showToday ? 'yes' : '' });
        ctx.refresh('whiteboard');
        return row;
      },

      get: function (a) {
        var row = board_(a.id);
        return { json: DriveApp.getFileById(row.file_id).getBlob().getDataAsString(), url: row.file, name: row.name || 'Whiteboard' };
      },

      /** a.thumb: the board's preview (see checkThumb_), made by the browser from the same drawing. Checked before anything is written. */
      save: function (a, ctx) {
        checkScene_(a.json);
        checkThumb_(a.thumb);
        var row = board_(a.id), now = nowIso_();
        DriveApp.getFileById(row.file_id).setContent(a.json);
        T.update(row.id, { updated: now });
        saveThumb_(row.id, a.thumb, now);
        ctx.refresh('whiteboard');
        return { url: row.file, updated: now };
      },

      /** Rename the whiteboard and its file in Drive. */
      rename: function (a, ctx) {
        var row = board_(a.id), name = name_(a.name);
        DriveApp.getFileById(row.file_id).setName(fileName_(project_(ctx, row.project_id, true), name, row.id));
        var updated = T.update(row.id, { name: name });
        ctx.refresh('whiteboard');
        return updated;
      },

      /** Show the board as a panel on Today, or stop. */
      setShowToday: function (a, ctx) {
        board_(a.id);
        var row = T.update(a.id, { show_today: a.on ? 'yes' : '' });
        ctx.refresh('whiteboard');
        return row;
      },

      /** The previews of these boards: [{ id, image, updated }]. Boards without one are left out. */
      thumbs: function (a) {
        var want = {};
        (a.ids || []).forEach(function (id) { want[String(id)] = true; });
        return THUMBS.all().filter(function (t) { return want[t.id]; }).map(function (t) { return { id: t.id, image: t.image, updated: t.updated }; });
      },

      /** Take the whiteboard out of the app. Its file stays in Drive. */
      remove: function (a, ctx) {
        T.remove(a.id);
        THUMBS.remove(a.id);
        ctx.refresh('whiteboard');
        return true;
      },

      /** Forget the links. The drawing files stay in Drive. */
      removeProject: function (a) {
        var gone = {};
        T.removeWhere(function (r) { if (r.project_id === a.projectId) { gone[r.id] = true; return true; } return false; });
        if (Object.keys(gone).length) THUMBS.removeWhere(function (t) { return gone[t.id]; });
        return true;
      }
    }
  };
}
