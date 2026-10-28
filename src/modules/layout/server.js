/**
 * Layout module: where each panel sits on a page, saved per user and per mode, so it follows you across devices.
 * Stored as { page: { panelId: { x, y, w, hidden } } } on a 12-column grid. Heights follow each panel's content.
 * A hidden panel is left off the page until it is shown again.
 */

function layoutModule() {
  var KEY = modeKey_('layout');
  var COLUMNS = 12;
  var MAX_PANELS = 60;

  function load_() {
    var raw = PropertiesService.getUserProperties().getProperty(KEY);
    return raw ? JSON.parse(raw) : {};
  }

  function save_(all) {
    PropertiesService.getUserProperties().setProperty(KEY, JSON.stringify(all));
  }

  function pageKey_(page) {
    assert_(/^[a-z][a-z0-9-]{0,30}$/.test(String(page || '')), 'Unknown page: ' + page);
    return page;
  }

  function whole_(value, min, max) {
    var n = Number(value);
    return Math.floor(n) === n && n >= min && n <= max;
  }

  function cleanItems_(items) {
    assert_(Array.isArray(items) && items.length <= MAX_PANELS, 'Too many panels to save.');
    var out = {};
    items.forEach(function (item) {
      var id = String(item.id || '');
      assert_(/^[a-zA-Z0-9_-]{1,60}$/.test(id), 'Bad panel id.');
      assert_(whole_(item.w, 1, COLUMNS) && whole_(item.x, 0, COLUMNS - 1) && whole_(item.y, 0, 10000), 'Bad panel position.');
      out[id] = { x: item.x, y: item.y, w: Math.min(item.w, COLUMNS - item.x) };
      if (item.hidden) out[id].hidden = true;
    });
    return out;
  }

  return {
    title: 'Layout',
    snapshot: load_,
    api: {
      save: function (a) {
        var all = load_();
        all[pageKey_(a.page)] = cleanItems_(a.items);
        save_(all);
        return true;
      },

      /** Hide or show one panel, keeping where it was. */
      setHidden: function (a, ctx) {
        var all = load_(), page = pageKey_(a.page);
        assert_(/^[a-zA-Z0-9_-]{1,60}$/.test(String(a.id || '')), 'Bad panel id.');
        var pageLayout = all[page] || {};
        var place = pageLayout[a.id] || { x: 0, y: 10000, w: 12 };
        if (a.hidden) place.hidden = true; else delete place.hidden;
        pageLayout[a.id] = place;
        all[page] = pageLayout;
        save_(all);
        ctx.refresh('layout');
        return true;
      },

      reset: function (a, ctx) {
        var all = load_();
        delete all[pageKey_(a.page)];
        save_(all);
        ctx.refresh('layout');
        return true;
      }
    }
  };
}
