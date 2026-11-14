/**
 * Resources module: things kept with one project or shared by a whole category: links, Google Drive files, phone
 * numbers, email addresses and short texts, each with a title, an optional group and a short note.
 * Stores only the address (or the text typed in) and a title. It never opens, reads or copies a linked file:
 * searchDrive gives names and addresses only, and the owner picks the file.
 * See AGENTS.md: check for sensitive material before adding a link on someone's behalf.
 *
 * Schema v2: the address is in `value`, with a `type` (RESOURCE_TYPES_ in core/schema.js) and a free text `group`.
 * add() still takes the address as `url` from older pages and queued offline calls; with no type it is a link or a
 * Drive file, by its address.
 */

function resourcesModule() {
  var T = new Table('Resources', ['title', 'type', 'value', 'group', 'project', 'category', 'note', 'problem', 'id', 'project_id', 'added']);
  var SEARCH_MAX = 20;

  function title_(value) {
    var title = clean_(value, 120);
    assert_(title, 'Add a title.');
    return title;
  }

  /** The type and the value, checked for that type. Phone numbers keep the spacing typed; tel: links drop it. */
  function typed_(type, raw) {
    var value = clean_(raw, 500);
    if (!type) type = resourceTypeFor_(value);
    assert_(RESOURCE_TYPES_.indexOf(type) !== -1, 'Unknown type: ' + type);
    if (type === 'link' || type === 'drive') {
      assert_(/^https:\/\/\S+$/i.test(value), 'Use a full link that starts with https://');
      if (type === 'drive') assert_(resourceTypeFor_(value) === 'drive', 'A Drive file\'s link starts with https://docs.google.com/ or https://drive.google.com/');
    } else if (type === 'phone') {
      var digits = value.replace(/\D/g, '').length;
      assert_(/^\+?[0-9 ()\-.]+$/.test(value) && digits >= 3 && digits <= 20 && value.length <= 40, 'Use a phone number: digits, spaces and an optional + at the start.');
    } else if (type === 'email') {
      assert_(value.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;.]+$/.test(value), 'Use an email address like name@example.com');
    } else {
      assert_(value, 'Add the text to keep.');
    }
    return { type: type, value: value };
  }

  /** Drive's search query: a single-quoted string, so backslashes and quotes in the words are escaped. */
  function driveQuery_(q) {
    return "title contains '" + q.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and trashed = false";
  }

  return {
    title: 'Resources',
    tables: [T],
    snapshot: function () { return T.all(); },
    api: {
      add: function (a, ctx) {
        var title = title_(a.title);
        var t = typed_(a.type, a.value !== undefined ? a.value : a.url);
        assert_(ctx.call('categories', 'ids').indexOf(a.category) !== -1, 'Unknown category: ' + a.category);
        var row = T.insert({
          id: clientId_(a.id),
          title: title,
          type: t.type,
          value: t.value,
          group: clean_(a.group, 60),
          category: a.category,
          project_id: a.projectId || '',
          note: clean_(a.note, 300),
          added: nowIso_()
        });
        ctx.refresh('resources');
        return row;
      },

      /** Change the title, type, value, group or note. Only the fields sent change; type and value are checked together. */
      update: function (a, ctx) {
        var row = T.get(a.id);
        assert_(row, 'That resource has gone. Reload to see the latest.');
        var patch = {};
        if (a.title !== undefined) patch.title = title_(a.title);
        if (a.type !== undefined || a.value !== undefined) {
          var t = typed_(a.type !== undefined ? a.type : row.type, a.value !== undefined ? a.value : row.value);
          patch.type = t.type; patch.value = t.value;
        }
        if (a.group !== undefined) patch.group = clean_(a.group, 60);
        if (a.note !== undefined) patch.note = clean_(a.note, 300);
        var updated = T.update(a.id, patch);
        ctx.refresh('resources');
        return updated;
      },

      remove: function (a, ctx) {
        T.remove(a.id);
        ctx.refresh('resources');
        return true;
      },

      /**
       * Files in the owner's Drive whose name contains q, in Drive's order, at most 20: name, address, kind and
       * when it last changed. Only this metadata: no file is opened or read, and nothing is stored.
       */
      searchDrive: function (a) {
        var q = clean_(a.q, 100);
        assert_(q, 'Type part of the file name.');
        var it = DriveApp.searchFiles(driveQuery_(q)), out = [];
        while (out.length < SEARCH_MAX && it.hasNext()) {
          var f = it.next(), updated = f.getLastUpdated();
          out.push({ name: f.getName(), url: f.getUrl(), mimeType: f.getMimeType(), modified: updated ? new Date(updated).toISOString() : '' });
        }
        return out;
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
