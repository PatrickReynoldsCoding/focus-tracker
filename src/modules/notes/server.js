/**
 * Notes module: one markdown file per project in <Focus Tracker folder>/Notes.
 * Plain text, so it is readable on any device and by Claude. The Notes tab only records which file belongs to which project.
 *
 * Each project's notes also live as a Google Doc, "<project name> notes", in the same Notes folder (docs/notes-docs.md).
 * The markdown file stays what the editor saves to; the Doc is a mirror written when editing is finished (syncDoc),
 * and edits made in the Doc are brought back when the project is opened (checkDoc). Both use Drive's own markdown
 * import and export (the Drive advanced service), so no new permission is needed.
 */

function notesModule() {
  // doc_id: the notes' Google Doc. doc_synced: the markdown version (`updated`) the Doc was last written from.
  // doc_seen: the Doc's modifiedTime after the app last wrote or read it; a later one means someone edited the Doc.
  var T = new Table('Notes', ['id', 'project_id', 'file_id', 'file_url', 'updated', 'doc_id', 'doc_synced', 'doc_seen']);
  var DOC_MIME = 'application/vnd.google-apps.document';

  function rowFor_(projectId) {
    var all = T.all();
    for (var i = 0; i < all.length; i++) if (all[i].project_id === projectId) return all[i];
    return null;
  }
  function slug_(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  }
  function projectOf_(projectId, ctx) {
    return ctx.call('projects', 'list', {}).filter(function (p) { return p.id === projectId; })[0] || null;
  }
  function docUrl_(docId) {
    return docId ? 'https://docs.google.com/document/d/' + docId + '/edit' : '';
  }

  /** Keep the text that lost a conflict as a copy in the Notes folder. `from` ('doc') goes in the name. Returns the copy's name. */
  function keepCopy_(project, projectId, text, kept, from) {
    var stamp = nowIso_().slice(0, 16).replace(/[-:T]/g, '');
    var copyName = slug_(project ? project.name : 'project') + '-' + projectId + '-conflict-' + stamp + (from ? '-' + from : '') + '.md';
    var copy = getSubfolder_('Notes').createFile(copyName, text, 'text/markdown');
    reportConflict_({ what: 'notes', kept: kept, copyUrl: copy.getUrl() });
    return copyName;
  }

  /** Write the notes file, checking the version: the editor's save, and text brought back from the Doc. */
  function write_(a, ctx) {
    assert_(a.projectId, 'No project given.');
    var text = typeof a.text === 'string' ? a.text : '';
    var row = rowFor_(a.projectId);
    var project = projectOf_(a.projectId, ctx);
    if (row) {
      var existing = DriveApp.getFileById(row.file_id);
      // Saves carry the version the browser's text builds on (_base) and when it was edited (_editedAt). If the file
      // changed since (another device, or a page that never loaded it), the newest edit wins and the older text is kept
      // as a conflict copy next to it. The same text is no conflict.
      if (a._base !== undefined && row.updated && row.updated !== String(a._base)) {
        var current = existing.getBlob().getDataAsString();
        if (current === text) return { url: row.file_url, updated: row.updated };
        var serverNewer = timeOf_(row.updated) >= timeOf_(a._editedAt);
        var copyName = keepCopy_(project, a.projectId, serverNewer ? text : current, serverNewer ? 'server' : 'yours');
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
    ctx.call('projects', 'setNotesLink', { id: a.projectId, url: file.getUrl() });
    return { url: file.getUrl(), updated: created };
  }

  /** The Doc's Drive metadata, or null when it is gone (deleted or in the bin). */
  function docMeta_(docId) {
    try {
      var meta = Drive.Files.get(docId, { fields: 'id,modifiedTime,trashed' });
      return meta && !meta.trashed ? meta : null;
    } catch (e) { return null; }
  }

  /** The Doc as markdown (Drive's export). '' when Drive gives nothing back. */
  function exportDoc_(docId) {
    var out = Drive.Files.export(docId, 'text/markdown', { alt: 'media' });
    if (typeof out === 'string') return out;
    if (out && typeof out.getDataAsString === 'function') return out.getDataAsString();
    if (out && out.length) return Utilities.newBlob(out).getDataAsString();
    return '';
  }

  return {
    title: 'Notes',
    tables: [T],
    snapshot: function () {
      return T.all().map(function (r) { return { project_id: r.project_id, url: r.file_url, updated: r.updated, doc: docUrl_(r.doc_id) }; });
    },
    api: {
      get: function (a) {
        var row = rowFor_(a.projectId);
        if (!row) return { text: '', url: '', updated: '' };
        return { text: DriveApp.getFileById(row.file_id).getBlob().getDataAsString(), url: row.file_url, updated: row.updated };
      },

      save: function (a, ctx) {
        return write_(a, ctx);
      },

      /**
       * Write the markdown into the project's Google Doc, making the Doc the first time. Sent by the browser when editing
       * is finished (Done, leaving the project, hiding the page), never while typing, and in parallel with saves.
       * Does nothing when the Doc already holds this version. If the Doc was edited since the app last wrote it and the
       * markdown changed too, the Doc's text is kept as a conflict copy before it is replaced.
       * Returns { url, ms, ... }: ms is how long the call took on the server, for measuring on Google.
       */
      syncDoc: function (a, ctx) {
        var t0 = Date.now();
        assert_(a.projectId, 'No project given.');
        var row = rowFor_(a.projectId);
        if (!row) return { skipped: 'no notes', ms: Date.now() - t0 };
        if (row.doc_id && row.doc_synced === row.updated) return { skipped: 'unchanged', url: docUrl_(row.doc_id), ms: Date.now() - t0 };
        var project = projectOf_(a.projectId, ctx);
        var name = (project ? project.name : 'Project') + ' notes';
        var version = row.updated; // read before the text: a save meanwhile leaves doc_synced behind, so the next sync runs
        var text = DriveApp.getFileById(row.file_id).getBlob().getDataAsString();
        var tRead = Date.now();
        var meta = row.doc_id ? docMeta_(row.doc_id) : null;
        var conflict = null;
        if (meta && timeOf_(meta.modifiedTime) > timeOf_(row.doc_seen)) {
          var edited = fromDocMarkdown_(exportDoc_(row.doc_id));
          if (edited && !sameNotes_(edited, text)) {
            var copyName = keepCopy_(project, a.projectId, edited, 'app', 'doc');
            ctx.optional('log', 'conflict', { projectId: a.projectId, text: 'Conflict: the notes Doc and the notes in the app were both changed. ' +
              'The app\'s notes were kept and written to the Doc; the Doc\'s text is saved as ' + copyName + ' in the Notes folder.' });
            conflict = { kept: 'app', copyName: copyName };
          }
        }
        var tCheck = Date.now();
        var blob = Utilities.newBlob(toDocMarkdown_(text) || '\n', 'text/markdown', name + '.md');
        var file, created = false;
        if (meta) file = Drive.Files.update({ name: name }, row.doc_id, blob, { fields: 'id,modifiedTime' });
        else {
          file = Drive.Files.create({ name: name, mimeType: DOC_MIME, parents: [getSubfolder_('Notes').getId()] }, blob, { fields: 'id,modifiedTime' });
          created = true;
        }
        var tWrite = Date.now();
        T.update(row.id, { doc_id: file.id, doc_synced: version, doc_seen: file.modifiedTime || nowIso_() });
        if (created) ctx.call('projects', 'setNotesLink', { id: a.projectId, url: docUrl_(file.id) });
        var ms = Date.now() - t0, timings = { read: tRead - t0, check: tCheck - tRead, write: tWrite - tCheck, sheet: Date.now() - tWrite };
        console.log('notes.syncDoc ' + ms + ' ms ' + JSON.stringify(timings) + (created ? ' (new Doc)' : ''));
        var out = { url: docUrl_(file.id), created: created, ms: ms, timings: timings };
        if (conflict) out.conflict = conflict;
        return out;
      },

      /**
       * On opening a project: bring edits made in the Doc (by Paddy or an assistant) into the markdown. Only when the Doc
       * changed after the app last wrote it. If the markdown did not change since, the Doc's text is saved like any
       * other save; a page still typing on the older version then meets the usual save conflict, so both texts are kept.
       * If both changed, the markdown stays and the Doc's text is kept as a conflict copy.
       * Returns { changed, imported, text, updated, conflict, ms }.
       */
      checkDoc: function (a, ctx) {
        var t0 = Date.now();
        var row = rowFor_(a.projectId);
        if (!row || !row.doc_id) return { changed: false, ms: Date.now() - t0 };
        var meta = docMeta_(row.doc_id);
        if (!meta || timeOf_(meta.modifiedTime) <= timeOf_(row.doc_seen)) return { changed: false, ms: Date.now() - t0 };
        var docText = fromDocMarkdown_(exportDoc_(row.doc_id));
        var current = DriveApp.getFileById(row.file_id).getBlob().getDataAsString();
        // An empty export is never taken as "the Doc was cleared": it could be Drive failing to answer.
        if (!docText || sameNotes_(docText, current)) {
          T.update(row.id, { doc_seen: meta.modifiedTime });
          return { changed: false, ms: Date.now() - t0 };
        }
        var out;
        if (row.updated === row.doc_synced) {
          // The markdown is as the app last wrote it into the Doc, so the Doc's text is newer: saved like any other save.
          var saved = write_({ projectId: a.projectId, text: docText, _base: row.updated, _editedAt: meta.modifiedTime }, ctx);
          T.update(row.id, { doc_synced: saved.updated, doc_seen: meta.modifiedTime });
          out = { changed: true, imported: true, text: docText, updated: saved.updated };
        } else {
          var copyName = keepCopy_(projectOf_(a.projectId, ctx), a.projectId, docText, 'app', 'doc');
          ctx.optional('log', 'conflict', { projectId: a.projectId, text: 'Conflict: the notes Doc and the notes in the app were both changed. ' +
            'The app\'s notes were kept; the Doc\'s text is saved as ' + copyName + ' in the Notes folder.' });
          T.update(row.id, { doc_seen: meta.modifiedTime });
          out = { changed: true, conflict: { kept: 'app', copyName: copyName } };
        }
        out.ms = Date.now() - t0;
        console.log('notes.checkDoc ' + out.ms + ' ms' + (out.imported ? ' (imported the Doc)' : ''));
        return out;
      },

      /** Forget the link. The markdown file and the Doc stay in Drive. */
      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      }
    }
  };
}

/**
 * The app's markdown as standard markdown for Drive's import. The app keeps one line per paragraph; standard markdown
 * joins lines that are not separated by a blank line. So every line becomes its own block, except list items and quote
 * lines that follow one another.
 */
function toDocMarkdown_(text) {
  var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  var isItem = function (l) { return /^\s*([-*]|\d+\.)\s+/.test(l); }, isQuote = function (l) { return /^>/.test(l); };
  lines.forEach(function (line, i) {
    if (i > 0) {
      var prev = lines[i - 1];
      if (isItem(prev) && isItem(line)) out.push('\n');
      else if (isQuote(prev) && isQuote(line)) out.push('\n>\n');
      else out.push('\n\n');
    }
    out.push(line);
  });
  return out.join('').replace(/\s+$/, '');
}

/**
 * Drive's markdown export of a Doc in the app's form, the reverse of toDocMarkdown_: each blank line between blocks
 * goes, the empty ">" lines between quote paragraphs go, and backslash escapes the app's editor does not use are
 * removed. The app's own escapes (\* \_ \` \[ \] \~ \\) stay.
 */
function fromDocMarkdown_(md) {
  var t = String(md || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  t = t.replace(/^>\s*$\n?/gm, '');
  t = t.replace(/\n\n/g, '\n');
  t = t.replace(/\\([{}()#+\-.!>|])/g, '$1');
  return t.replace(/[ \t]+$/gm, '').replace(/^\n+|\s+$/g, '');
}

/** The same notes, give or take what a trip through Google Docs changes: blank lines, list markers, trailing spaces. */
function sameNotes_(a, b) {
  function norm(s) {
    return String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^(\s*)\*(\s+)/gm, '$1-$2').replace(/\n{2,}/g, '\n').trim();
  }
  return norm(a) === norm(b);
}
