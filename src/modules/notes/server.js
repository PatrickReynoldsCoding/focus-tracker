/**
 * Notes module: each project's notes ARE its Google Doc, "<project name> notes", in <mode folder>/Notes
 * (docs/notes-docs.md). There is no other copy in Drive. The Notes tab only records which Doc belongs to which project.
 *
 * The app's editor loads the Doc and saves straight back to it, through Drive's own conversion both ways (the Drive
 * advanced service, no extra permission): the Doc is exported as HTML and turned into the editor's few tags
 * (fromDocHtml_), and the editor's cleaned HTML is imported over the Doc's content (docHtmlFor_). Headings, bold,
 * italic, underline, strikethrough, colours, highlights, lists, links and quotes (an indented paragraph in the Doc)
 * survive the trip.
 *
 * Versions are the Doc's Drive modifiedTime. `updated` is the version the app last wrote or read, and `written` a
 * fingerprint of the text it had then. A save carries the version the browser's text builds on (_base); if the Doc
 * changed since (another device, or an edit made in Google Docs), the newest edit wins and the other text is kept as a
 * conflict copy, another Doc in the Notes folder. A modifiedTime that moved while the text did not (Google may touch
 * it after a write) is no change.
 *
 * An AI assistant cannot make a notes Doc the app would see, so for a project with no notes Doc yet it writes the notes
 * as plain text into the project's notes cell in the sheet (the guide for assistants, core/guide.js, says so). The next
 * snapshot adds that text to the end of the project's notes Doc and puts the Doc's link back in the cell (importTyped_).
 *
 * A note of the Notes tab (a row of the Lists tab with kind 'note', lists module) is kept the same way: its own Doc,
 * named after the note, in the mode's Notes folder, and a Notes row with list_id where a project's has project_id. The
 * api takes a.listId for it instead of a.projectId; the editor, drafts, versions and conflict copies work as for a
 * project. Nothing about it reaches the Projects tab or the Log's project column. Deleting the note puts its Doc in
 * Drive's bin; undo brings the row back, and the Doc comes out of the bin the next time the note is read or saved.
 * A project's notes can be shown on Today too (show_today on its Notes row).
 */

var NOTES_HTML_MAX_LENGTH_ = 1000000;
var NOTES_DOC_MIME_ = 'application/vnd.google-apps.document';
var NOTES_HEADERS_ = ['id', 'project_id', 'list_id', 'doc_id', 'updated', 'written', 'show_today'];
// Before schema v6 Today had one running note of its own, keyed 'today' where a project id goes. v6 made it a note of
// the Notes tab and kept its id in a script property, so a save from an older page (or one that waited offline) still
// reaches it.
var LEGACY_TODAY_NOTES_KEY_ = 'today';

function legacyTodayNoteProperty_() {
  return 'TODAY_NOTE_LIST.' + modeId_();
}

/** The note that Today's own note became (schema v6), for a call that still says projectId 'today'. '' if none. */
function legacyTodayNoteId_(projectId) {
  if (projectId !== LEGACY_TODAY_NOTES_KEY_) return '';
  return PropertiesService.getScriptProperties().getProperty(legacyTodayNoteProperty_()) || '';
}

/** The notes Doc's name: a note's own name, else "<project name> notes". */
function notesDocName_(project, list) {
  return list ? list.name : (project ? project.name : 'Project') + ' notes';
}

function notesModule() {
  var T = new Table('Notes', NOTES_HEADERS_);

  /** The Notes row of a project (its id) or a note (its list id). */
  function rowFor_(notesKey) {
    if (!notesKey) return null;
    var all = T.all();
    for (var i = 0; i < all.length; i++) if (all[i].project_id === notesKey || all[i].list_id === notesKey) return all[i];
    return null;
  }

  /** The key a call names: a.listId for a note, a.projectId for a project's notes. */
  function keyOf_(a) {
    return String(a.listId || '') || legacyTodayNoteId_(a.projectId) || String(a.projectId || '');
  }

  /** What a save writes to: { key, list } for a note, { key, project } for a project's notes. */
  function targetOf_(a, ctx) {
    var key = keyOf_(a);
    assert_(key, 'No project given.');
    if (a.listId || legacyTodayNoteId_(a.projectId)) {
      var list = ctx.optional('lists', 'get', { id: key });
      assert_(list && list.kind === NOTE_LIST_KIND_, 'That note no longer exists.');
      return { key: key, list: list, project: null };
    }
    var project = ctx.call('projects', 'list', {}).filter(function (p) { return p.id === key; })[0] || null;
    return { key: key, list: null, project: project };
  }

  /** The row's Doc, or null when it is gone. A note's Doc in Drive's bin (its delete was undone) comes back out. */
  function liveDocMeta_(row) {
    if (!row || !row.doc_id) return null;
    return notesDocMeta_(row.doc_id) || (row.list_id ? untrashNotesDoc_(row.doc_id) : null);
  }

  /** Keep the text that lost a conflict as its own Doc in the Notes folder. Returns the copy's name. */
  function keepCopy_(docName, html, kept) {
    var stamp = nowIso_().slice(0, 16).replace(/[-:T]/g, '');
    var copyName = docName + ' - conflict ' + stamp;
    var copy = createNotesDoc_(copyName, html);
    reportConflict_({ what: 'notes', kept: kept, copyUrl: notesDocUrl_(copy.id) });
    return copyName;
  }

  /**
   * Save notes into their Doc, checking the version. a.projectId: the project, or a.listId: the note. a.html is the
   * editor's HTML (cleaned here); a.text is markdown, used when there is no HTML (notes typed in the sheet). _base: the
   * version the text builds on; _editedAt: when it was edited. No _base: written without a check (the app's own appends).
   */
  function write_(a, ctx) {
    var target = targetOf_(a, ctx);
    var html = typeof a.html === 'string' ? sanitizeRichText_(a.html, NOTES_HTML_MAX_LENGTH_) : notesMarkdownToHtml_(a.text);
    var row = rowFor_(target.key);
    var docName = notesDocName_(target.project, target.list);
    var conflict = null;
    var meta = liveDocMeta_(row);
    if (meta && a._base !== undefined) {
      var baseIsOld = String(a._base) !== String(row.updated);
      var docMoved = meta.modifiedTime !== row.updated;
      if (baseIsOld || docMoved) {
        var current = readNotesDoc_(row.doc_id);
        var editedInDocs = docMoved && notesFingerprint_(current) !== row.written;
        if (baseIsOld || editedInDocs) {
          if (notesFingerprint_(current) === notesFingerprint_(html)) {
            T.update(row.id, { updated: meta.modifiedTime, written: notesFingerprint_(current) });
            return { url: notesDocUrl_(row.doc_id), updated: meta.modifiedTime };
          }
          var docNewer = timeOf_(meta.modifiedTime) >= timeOf_(a._editedAt);
          var copyName = keepCopy_(docName, docNewer ? html : current, docNewer ? 'server' : 'yours');
          ctx.optional('log', 'conflict', { projectId: target.list ? '' : target.key, text: 'Conflict: ' + (target.list ? 'the note "' + target.list.name + '" was' : 'the notes were') + ' changed elsewhere (another device or Google Docs). ' +
            (docNewer ? 'The newer notes were kept; your text' : 'Your text was newer and replaced them; the other text') + ' is saved as the Doc "' + copyName + '" in the Notes folder.' });
          conflict = { kept: docNewer ? 'server' : 'yours', copyName: copyName };
          if (docNewer) {
            T.update(row.id, { updated: meta.modifiedTime, written: notesFingerprint_(current) });
            return { url: notesDocUrl_(row.doc_id), updated: meta.modifiedTime, html: current, text: notesHtmlToMarkdown_(current), conflict: conflict };
          }
        }
      }
    }
    var t0 = Date.now();
    var file = meta ? updateNotesDoc_(row.doc_id, docName, html) : createNotesDoc_(docName, html);
    var patch = { doc_id: file.id, updated: file.modifiedTime || nowIso_(), written: notesFingerprint_(html) };
    if (row) T.update(row.id, patch);
    else {
      assert_(target.project || target.list, 'Project not found.');
      T.insert(Object.assign(target.list ? { list_id: target.key } : { project_id: target.key }, patch));
    }
    if (!meta && !target.list) ctx.call('projects', 'setNotesLink', { id: target.key, url: notesDocUrl_(file.id) });
    console.log('notes.save ' + (Date.now() - t0) + ' ms' + (meta ? '' : ' (new Doc)'));
    var out = { url: notesDocUrl_(file.id), updated: patch.updated };
    if (conflict) out.conflict = conflict;
    return out;
  }

  /** A Projects.notes cell that holds text instead of a link: notes typed in the sheet. */
  function typedNotes_(cell) {
    var v = String(cell || '').trim();
    return v && !/^https?:\/\//i.test(v) && !/^(docs|drive)\.google\.com\//i.test(v) ? v : '';
  }

  /**
   * Notes typed into the notes cell (by an assistant, or by hand) go to the end of the project's notes Doc, made if
   * there is none, and the cell gets the Doc's link back. No Drive call when no cell holds text.
   */
  function importTyped_(ctx) {
    var projects = ctx.optional('projects', 'list', {}) || [];
    projects.forEach(function (p) {
      var text = typedNotes_(p.notes);
      if (!text) return;
      var row = rowFor_(p.id);
      var current = liveDocMeta_(row) ? readNotesDoc_(row.doc_id) : '';
      var saved = write_({ projectId: p.id, html: current + notesMarkdownToHtml_(text.replace(/\r\n?/g, '\n')) }, ctx);
      ctx.call('projects', 'setNotesLink', { id: p.id, url: saved.url });
    });
  }

  return {
    title: 'Notes',
    tables: [T],
    snapshot: function (ctx) {
      importTyped_(ctx);
      return T.all().filter(function (r) { return r.doc_id; }).map(function (r) {
        return { project_id: r.project_id, list_id: r.list_id, url: notesDocUrl_(r.doc_id), updated: r.updated, doc: notesDocUrl_(r.doc_id), show_today: r.show_today };
      });
    },
    api: {
      /**
       * The notes from the Doc: { html, text, url, updated }. a.known: the version the page holds; when the Doc is still
       * at it, { same: true } comes back without reading the Doc. An edit made in Google Docs becomes the new version.
       */
      get: function (a) {
        var row = rowFor_(keyOf_(a));
        var empty = { html: '', text: '', url: '', updated: '' };
        var meta = liveDocMeta_(row);
        if (!meta) return empty;
        var url = notesDocUrl_(row.doc_id);
        if (a.known && a.known === row.updated && meta.modifiedTime === row.updated) return { same: true, url: url, updated: row.updated };
        var html = readNotesDoc_(row.doc_id), fingerprint = notesFingerprint_(html);
        if (fingerprint !== row.written) {
          T.update(row.id, { updated: meta.modifiedTime, written: fingerprint });
          row.updated = meta.modifiedTime;
        }
        return { html: html, text: notesHtmlToMarkdown_(html), url: url, updated: row.updated };
      },

      save: function (a, ctx) {
        return write_(a, ctx);
      },

      /** Forget the link. The Doc stays in Drive. */
      removeProject: function (a) {
        T.removeWhere(function (r) { return r.project_id === a.projectId; });
        return true;
      },

      /** A note was renamed (lists.rename): its Doc takes the new name. */
      renameList: function (a) {
        var row = rowFor_(String(a.listId || ''));
        if (liveDocMeta_(row)) renameNotesDoc_(row.doc_id, clean_(a.name, 80));
        return true;
      },

      /** A note was deleted (lists.remove): its Doc goes to Drive's bin and its row goes. Undo puts the row back. */
      removeList: function (a, ctx) {
        var row = rowFor_(String(a.listId || ''));
        if (!row || !row.list_id) return true;
        if (row.doc_id) trashNotesDoc_(row.doc_id);
        T.remove(row.id);
        ctx.refresh('notes');
        return true;
      },

      /** Show a project's notes on Today as their own panel (a.on), or not. Only notes that have a Doc. */
      setShowToday: function (a, ctx) {
        var row = rowFor_(String(a.projectId || ''));
        assert_(row && row.project_id && row.doc_id, 'Write something in the project\'s notes first.');
        T.update(row.id, { show_today: a.on ? 'yes' : '' });
        ctx.refresh('notes');
        return true;
      }
    }
  };
}

// ---------- the notes Doc in Drive ----------

function notesDocUrl_(docId) {
  return docId ? 'https://docs.google.com/document/d/' + docId + '/edit' : '';
}

/** The Doc's Drive metadata, or null when it is gone (deleted or in the bin). */
function notesDocMeta_(docId) {
  try {
    var meta = Drive.Files.get(docId, { fields: 'id,modifiedTime,trashed' });
    return meta && !meta.trashed ? meta : null;
  } catch (e) { return null; }
}

/** The Doc's notes as the editor's HTML: Drive's HTML export, turned into the editor's tags and cleaned. */
function readNotesDoc_(docId) {
  return fromDocHtml_(exportDocAsHtml_(docId));
}

/**
 * Drive's HTML export of a Doc, fetched from the export address. The advanced service's Files.export throws on Google
 * ("HttpResponseException: Response code: 200") because it expects JSON back, not the page.
 */
function exportDocAsHtml_(docId) {
  var exportAddress = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(docId) + '/export?mimeType=text%2Fhtml';
  var response = UrlFetchApp.fetch(exportAddress, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  assert_(response.getResponseCode() === 200, 'Google Docs did not send the notes (error ' + response.getResponseCode() + '). Try again in a minute.');
  return response.getContentText('UTF-8');
}

function notesHtmlBlob_(name, html) {
  return Utilities.newBlob(docHtmlFor_(html), 'text/html', name + '.html');
}

/** A new notes Doc in the Notes folder, converted from the editor's HTML. Returns { id, modifiedTime }. */
function createNotesDoc_(name, html) {
  return Drive.Files.create({ name: name, mimeType: NOTES_DOC_MIME_, parents: [getSubfolder_('Notes').getId()] }, notesHtmlBlob_(name, html), { fields: 'id,modifiedTime' });
}

/** Give the Doc a new name, leaving its content. */
function renameNotesDoc_(docId, name) {
  try { Drive.Files.update({ name: name }, docId); } catch (e) { console.log('notes.renameList: ' + (e && e.message)); }
}

/** A deleted note's Doc goes to Drive's bin (restorable there for 30 days), like the old notes files in schema v5. */
function trashNotesDoc_(docId) {
  try { DriveApp.getFileById(docId).setTrashed(true); } catch (e) {}
}

/** Take a note's Doc back out of the bin (its delete was undone). Its metadata, or null when it is gone for good. */
function untrashNotesDoc_(docId) {
  try {
    var file = DriveApp.getFileById(docId);
    if (!file.isTrashed()) return null;
    file.setTrashed(false);
    return notesDocMeta_(docId);
  } catch (e) { return null; }
}

/** Replace the Doc's content (and name) with the editor's HTML. Returns { id, modifiedTime }. */
function updateNotesDoc_(docId, name, html) {
  return Drive.Files.update({ name: name }, docId, notesHtmlBlob_(name, html), { fields: 'id,modifiedTime' });
}

// ---------- converting between the editor and the Doc ----------

/** The editor's HTML as a page for Drive's HTML import: colours as styles, which Docs reads, instead of <font>. */
function docHtmlFor_(html) {
  var body = String(html || '')
    .replace(/<font\b[^>]*\bcolor="([^"]+)"[^>]*>/gi, '<span style="color: $1">')
    .replace(/<font\b[^>]*>/gi, '<span>')
    .replace(/<\/font>/gi, '</span>');
  return '<html><head><meta charset="utf-8"></head><body>' + (body || '<p></p>') + '</body></html>';
}

var NOTES_VOID_TAGS_ = { br: 1, hr: 1, img: 1, meta: 1, link: 1, col: 1, input: 1, wbr: 1 };
var NOTES_SKIPPED_TAGS_ = { head: 1, style: 1, script: 1, title: 1, img: 1, hr: 1 };
var NOTES_DEFAULT_COLORS_ = { '#000000': 1, '#000': 1, black: 1, 'rgb(0, 0, 0)': 1 };
var NOTES_NO_HIGHLIGHT_ = { transparent: 1, '#ffffff': 1, '#fff': 1, white: 1, inherit: 1 };
var NOTES_HEADING_FOR_ = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };
var NOTES_INLINE_FOR_ = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's' };

/** Google's export as a small tree: { tag, attrs, children } and strings. Its HTML is well formed. */
function parseDocHtml_(html) {
  var root = { tag: 'root', attrs: {}, children: [] }, stack = [root];
  var pattern = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  var last = 0, match;
  function top() { return stack[stack.length - 1]; }
  while ((match = pattern.exec(html))) {
    if (match.index > last) top().children.push(html.slice(last, match.index));
    last = pattern.lastIndex;
    if (!match[2]) continue;
    var tag = match[2].toLowerCase();
    if (match[1]) {
      for (var i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    var node = { tag: tag, attrs: notesAttributes_(match[3]), children: [] };
    top().children.push(node);
    if (!NOTES_VOID_TAGS_[tag] && !match[4]) stack.push(node);
  }
  if (last < html.length) top().children.push(html.slice(last));
  return root;
}

function notesAttributes_(raw) {
  var attrs = {}, pattern = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g, m;
  while ((m = pattern.exec(raw || ''))) attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  return attrs;
}

/** "a: 1; b: 2" -> { a: '1', b: '2' }. */
function notesStyleProps_(style) {
  var props = {};
  String(style || '').split(';').forEach(function (declaration) {
    var at = declaration.indexOf(':');
    if (at > 0) props[declaration.slice(0, at).trim().toLowerCase()] = declaration.slice(at + 1).trim().toLowerCase();
  });
  return props;
}

/** Google's class rules (.c3{font-weight:700;...}) by class name. */
function notesClassStyles_(css) {
  var byClass = {}, rule = /([^{}]+)\{([^{}]*)\}/g, m;
  while ((m = rule.exec(String(css || '').replace(/@import[^;]*;/g, '')))) {
    var props = notesStyleProps_(m[2]);
    m[1].split(',').forEach(function (selector) {
      var name = /^\s*\.([a-zA-Z0-9_-]+)\s*$/.exec(selector);
      if (name) byClass[name[1]] = Object.assign(byClass[name[1]] || {}, props);
    });
  }
  return byClass;
}

/** Google's links go through its redirect (https://www.google.com/url?q=<address>&sa=...): the real address. */
function notesRealLink_(href) {
  var decoded = String(href || '').replace(/&amp;/g, '&');
  var redirect = /^https?:\/\/(?:www\.)?google\.com\/url\?(?:.*&)?q=([^&]+)/i.exec(decoded);
  if (!redirect) return decoded;
  try { return decodeURIComponent(redirect[1]); } catch (e) { return redirect[1]; }
}

/** The editor's HTML from Drive's HTML export of a notes Doc: its classes become b, i, u, s, colours and highlights. */
function fromDocHtml_(exported) {
  var source = String(exported || '');
  var css = (source.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).map(function (s) { return s.replace(/<\/?style[^>]*>/gi, ''); }).join('\n');
  var classes = notesClassStyles_(css);
  var tree = parseDocHtml_(source);

  function propsOf(node) {
    var props = {};
    String(node.attrs['class'] || '').split(/\s+/).forEach(function (name) { if (classes[name]) Object.assign(props, classes[name]); });
    return Object.assign(props, notesStyleProps_(node.attrs.style));
  }
  function hasLink(node) {
    return node.children.some(function (child) { return typeof child !== 'string' && (child.tag === 'a' || hasLink(child)); });
  }
  function textOf(node) {
    return node.children.map(function (child) { return typeof child === 'string' ? child : textOf(child); }).join('');
  }
  function inner(node, context) { return node.children.map(function (child) { return render(child, context); }).join(''); }

  /** A span's styles as tags around its content. Inside a heading bold is the heading's own; a link keeps its own look. */
  function wrapped(node, context) {
    var props = propsOf(node), linked = hasLink(node), open = [], close = [];
    function add(openTag, closeTag) { open.push(openTag); close.unshift(closeTag); }
    var decoration = props['text-decoration'] || props['text-decoration-line'] || '';
    if ((props['font-weight'] === '700' || props['font-weight'] === 'bold') && !context.heading) add('<b>', '</b>');
    if (props['font-style'] === 'italic') add('<i>', '</i>');
    if (/underline/.test(decoration) && !linked) add('<u>', '</u>');
    if (/line-through/.test(decoration)) add('<s>', '</s>');
    if (props.color && !NOTES_DEFAULT_COLORS_[props.color] && !linked) add('<font color="' + props.color + '">', '</font>');
    if (props['background-color'] && !NOTES_NO_HIGHLIGHT_[props['background-color']]) add('<span style="background-color: ' + props['background-color'] + '">', '</span>');
    return open.join('') + inner(node, context) + close.join('');
  }

  function render(node, context) {
    if (typeof node === 'string') return node.replace(/&nbsp;/g, ' ');
    var tag = node.tag;
    if (NOTES_SKIPPED_TAGS_[tag]) return '';
    if (tag === 'br') return '<br>';
    if (NOTES_INLINE_FOR_[tag]) return '<' + NOTES_INLINE_FOR_[tag] + '>' + inner(node, context) + '</' + NOTES_INLINE_FOR_[tag] + '>';
    if (tag === 'font') return node.attrs.color ? '<font color="' + node.attrs.color + '">' + inner(node, context) + '</font>' : inner(node, context);
    if (tag === 'span') return wrapped(node, context);
    if (tag === 'a') return '<a href="' + notesRealLink_(node.attrs.href).replace(/"/g, '&quot;') + '">' + inner(node, context) + '</a>';
    if (NOTES_HEADING_FOR_[tag]) return '<' + NOTES_HEADING_FOR_[tag] + '>' + inner(node, { heading: true }) + '</' + NOTES_HEADING_FOR_[tag] + '>';
    if (tag === 'ul' || tag === 'ol' || tag === 'li') return '<' + tag + '>' + inner(node, context) + '</' + tag + '>';
    if (tag === 'blockquote') return '<blockquote>' + inner(node, context) + '</blockquote>';
    if (tag === 'p') {
      var content = inner(node, context);
      if (!textOf(node).replace(/&nbsp;|\s/g, '')) return '<p><br></p>';
      var indent = parseFloat(propsOf(node)['margin-left'] || '0');
      return indent > 0 ? '<blockquote>' + content + '</blockquote>' : '<p>' + content + '</p>';
    }
    return inner(node, context);
  }

  var html = render(tree, {}).replace(/<\/blockquote><blockquote>/g, '<br>');
  html = html.replace(/(<p><br><\/p>)+$/, '');
  return sanitizeRichText_(html, NOTES_HTML_MAX_LENGTH_);
}

/**
 * Markdown as the app writes it (one line per paragraph) as editor HTML: # to ### headings, - or * bullets, 1. numbers,
 * > quotes, **bold**, _italic_ or *italic*, ~~strikethrough~~ and [label](address) links. For notes typed in the sheet
 * and the old notes files.
 */
function notesMarkdownToHtml_(text) {
  var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), out = [], list = null;
  function inline(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, function (all, a, b) { return '<b>' + (a || b) + '</b>'; })
      .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\*)|(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, function (all, pre1, a, pre2, b) { return (pre1 || pre2 || '') + '<i>' + (a || b) + '</i>'; })
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/\\([\\*_`\[\]~#.\-+!>])/g, '$1');
  }
  function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
  lines.forEach(function (line) {
    var heading = /^(#{1,3})\s+(.*)$/.exec(line), bullet = /^\s*[-*]\s+(.*)$/.exec(line), number = /^\s*\d+\.\s+(.*)$/.exec(line), quote = /^>\s?(.*)$/.exec(line);
    var item = bullet ? ['ul', bullet[1]] : number ? ['ol', number[1]] : null;
    if (item) {
      if (list !== item[0]) { closeList(); out.push('<' + item[0] + '>'); list = item[0]; }
      out.push('<li>' + inline(item[1]) + '</li>');
      return;
    }
    closeList();
    if (heading) out.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>');
    else if (quote) out.push('<blockquote>' + inline(quote[1]) + '</blockquote>');
    else if (line.trim()) out.push('<p>' + inline(line) + '</p>');
  });
  closeList();
  return out.join('');
}

/**
 * The notes as markdown in the app's form (one line per block): # headings, - and 1. list items, > quotes, **bold**,
 * _italic_, ~~strikethrough~~ and [label](address) links. Underline, colours and highlights have no markdown and are
 * left out. For the `text` the server gives back (assistants and tests read it); the editor has its own (FT.htmlToMd).
 */
function notesHtmlToMarkdown_(html) {
  var lines = [];
  function decode(text) { return decodeRichEntities_(String(text).replace(/&#(\d+);/g, function (all, code) { return String.fromCharCode(Number(code)); })); }
  function inlineOf(node) {
    return node.children.map(function (child) {
      if (typeof child === 'string') return decode(child).replace(/\s+/g, ' ');
      var text = inlineOf(child);
      if (child.tag === 'br') return ' ';
      if (!text.trim()) return text;
      if (child.tag === 'b' || child.tag === 'strong') return '**' + text + '**';
      if (child.tag === 'i' || child.tag === 'em') return '_' + text + '_';
      if (child.tag === 's' || child.tag === 'strike' || child.tag === 'del') return '~~' + text + '~~';
      if (child.tag === 'a') { var href = decode(child.attrs.href || ''); return text === href ? href : '[' + text + '](' + href + ')'; }
      return text;
    }).join('');
  }
  function isBlock(node) { return typeof node !== 'string' && /^(h[1-6]|p|div|ul|ol|li|blockquote)$/.test(node.tag); }
  function blocks(node, listTag) {
    node.children.forEach(function (child) {
      if (typeof child === 'string') { if (child.trim()) lines.push(decode(child).trim()); return; }
      var tag = child.tag;
      if (/^h[1-6]$/.test(tag)) lines.push(new Array(Math.min(Number(tag[1]), 3) + 1).join('#') + ' ' + inlineOf(child).trim());
      else if (tag === 'ul' || tag === 'ol') blocks(child, tag);
      else if (tag === 'li') lines.push((listTag === 'ol' ? '1. ' : '- ') + inlineOf(child).trim());
      else if (tag === 'blockquote') lines.push('> ' + inlineOf(child).trim());
      else if ((tag === 'p' || tag === 'div') && child.children.some(isBlock)) blocks(child, listTag);
      else if (tag === 'p' || tag === 'div') lines.push(inlineOf(child).trim());
      else lines.push(inlineOf({ children: [child] }).trim());
    });
  }
  blocks(parseDocHtml_(String(html || '')), null);
  return lines.join('\n').replace(/\n+$/, '');
}

/** A short fingerprint of the notes' text (formatting and blank lines left out), to tell a real change from a moved timestamp. */
function notesFingerprint_(html) {
  var text = richTextToPlain_(String(html || '')).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+/g, '\n').trim();
  var hash = 5381;
  for (var i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return text.length + '-' + hash.toString(16);
}

// ---------- schema v5: notes move into their Docs (core/migrate.js) ----------

var NOTES_V4_HEADERS_ = ['id', 'project_id', 'file_id', 'file_url', 'updated', 'doc_id', 'doc_synced', 'doc_seen', 'html_file_id', 'html_version', 'written'];
var NOTES_IMPORTED_HEADING_ = 'Imported from old notes file';

function readOldNotesFile_(fileId) {
  try { return DriveApp.getFileById(fileId).getBlob().getDataAsString(); } catch (e) { return ''; }
}

function trashOldNotesFile_(fileId) {
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}
}

/** The old notes as editor HTML: the formatted copy when it belonged to the markdown's version, else the markdown. */
function oldNotesHtml_(row) {
  var formatted = row.html_file_id && row.html_version && row.html_version === row.updated ? readOldNotesFile_(row.html_file_id) : '';
  if (formatted) return sanitizeRichText_(formatted, NOTES_HTML_MAX_LENGTH_);
  return notesMarkdownToHtml_(row.file_id ? readOldNotesFile_(row.file_id) : '');
}

/**
 * Put one project's old notes (markdown file and formatted copy) into its Doc. No Doc (or a deleted one): the Doc is
 * made from them. A Doc with the same text: it gets the formatting the old copy had. A Doc with other text: the old
 * notes go at its end under "Imported from old notes file", so nothing is lost. Returns { id, modifiedTime, written }.
 */
function moveOldNotesIntoDoc_(row, name) {
  var html = oldNotesHtml_(row);
  var meta = row.doc_id ? notesDocMeta_(row.doc_id) : null;
  if (!meta) {
    var made = createNotesDoc_(name, html);
    return { id: made.id, modifiedTime: made.modifiedTime, written: notesFingerprint_(html) };
  }
  var docHtml = readNotesDoc_(row.doc_id);
  var sameText = notesFingerprint_(docHtml) === notesFingerprint_(html);
  var noOldText = !richTextToPlain_(html).trim();
  if (noOldText || (sameText && html === docHtml)) return { id: row.doc_id, modifiedTime: meta.modifiedTime, written: notesFingerprint_(docHtml) };
  var merged = sameText ? html : docHtml + '<h2>' + NOTES_IMPORTED_HEADING_ + '</h2>' + html;
  var updated = updateNotesDoc_(row.doc_id, name, merged);
  return { id: row.doc_id, modifiedTime: updated.modifiedTime, written: notesFingerprint_(merged) };
}

/**
 * v4 to v5: each project's notes become its Google Doc only. Rows that still have an old markdown file or formatted
 * copy are moved into the Doc one by one (the row forgets the files before they go, so a run that stops part way never
 * makes a Doc twice), the old files go to Drive's bin (setTrashed, not deleted), and the project's notes cell links
 * the Doc. Then the Notes tab is laid out as V5_NOTES_HEADERS_, keeping a person's own columns. The spreadsheet is
 * backed up first when there are files to move. Safe to run again.
 */
function migrateNotesToDocs_(ss) {
  tableCache_ = {};
  var notes = new Table('Notes', NOTES_V4_HEADERS_);
  var projects = new Table('Projects', ['id', 'name', 'notes']);
  var waiting = notes.all().filter(function (r) { return r.file_id || r.html_file_id; });
  if (waiting.length) backupBeforeMigration_(ss, 'v5');
  waiting.forEach(function (row) {
    var project = projects.get(row.project_id);
    var doc = moveOldNotesIntoDoc_(row, notesDocName_(project, null));
    notes.update(row.id, { doc_id: doc.id, updated: doc.modifiedTime || nowIso_(), written: doc.written, file_id: '', file_url: '', html_file_id: '', html_version: '', doc_synced: '', doc_seen: '' });
    [row.file_id, row.html_file_id].filter(Boolean).forEach(trashOldNotesFile_);
    var cell = project ? String(project.notes || '').trim() : '';
    if (project && (!cell || /^https?:\/\//i.test(cell))) projects.update(project.id, { notes: notesDocUrl_(doc.id) });
  });
  layOutTab_(ss, 'Notes', V5_NOTES_HEADERS_, NOTES_V4_HEADERS_);
  tableCache_ = {};
}
