/**
 * Layout module: where each panel sits on a page, saved per mode in the mode's Settings tab (one row per page,
 * layout.<page>), so it follows you across devices.
 * Stored as { page: { panelId: { x, y, w, hidden } } } on a 12-column grid. Heights follow each panel's content.
 * A hidden panel is left off the page, on every screen size, until it is shown again.
 * A phone shows panels one under the other in its own order, a row of its own: layout.<page>.phone = ["id", ...],
 * which reaches the page as { '<page>.phone': [...] } next to the pages.
 */

function layoutModule() {
  var PREFIX = 'layout.';
  var COLUMNS = 12;
  var MAX_PANELS = 60;
  var MAX_Y = 10000;
  // Panels that were split or renamed, by page: a saved place for the old id goes to the new ones, the first in its
  // place and each next one just below it (hidden if it was hidden). Today's "Small tasks" became Habits and To-dos.
  var RENAMED = { today: { smalltasks: ['habits', 'todos'] } };

  function renamed_(page, items) {
    var map = RENAMED[page] || {};
    Object.keys(map).forEach(function (old) {
      var place = items[old];
      if (!place) return;
      map[old].forEach(function (id, i) {
        if (items[id]) return;
        items[id] = { x: place.x, y: Math.min(MAX_Y, place.y + i), w: place.w };
        if (place.hidden) items[id].hidden = true;
      });
      delete items[old];
    });
    return items;
  }

  function load_() {
    var saved = settingsWithPrefix_(PREFIX), all = {};
    Object.keys(saved).forEach(function (key) {
      var page = key.slice(PREFIX.length);
      try { all[page] = renamed_(page, JSON.parse(saved[key])); } catch (e) { /* a row edited by hand into something unreadable: the default layout */ }
    });
    return all;
  }

  /** Write the pages in `all`; a page left out of `all` that was saved before is cleared. */
  function save_(all) {
    var values = {};
    Object.keys(settingsWithPrefix_(PREFIX)).forEach(function (key) { values[key] = ''; });
    Object.keys(all).forEach(function (page) { values[PREFIX + page] = JSON.stringify(all[page]); });
    setSettings_(values);
  }

  var PHONE = '.phone';

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
      assert_(whole_(item.w, 1, COLUMNS) && whole_(item.x, 0, COLUMNS - 1) && whole_(item.y, 0, MAX_Y), 'Bad panel position.');
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
        var place = pageLayout[a.id] || { x: 0, y: MAX_Y, w: 12 };
        if (a.hidden) place.hidden = true; else delete place.hidden;
        pageLayout[a.id] = place;
        all[page] = pageLayout;
        save_(all);
        ctx.refresh('layout');
        return true;
      },

      /** The phone's order of a page's panels: a.order, panel ids from top to bottom. */
      saveOrder: function (a) {
        var page = pageKey_(a.page);
        assert_(Array.isArray(a.order) && a.order.length <= MAX_PANELS, 'Too many panels to save.');
        var seen = {}, order = a.order.map(String).filter(function (id) {
          assert_(/^[a-zA-Z0-9_-]{1,60}$/.test(id), 'Bad panel id.');
          if (seen[id]) return false;
          seen[id] = true;
          return true;
        });
        var all = load_();
        all[page + PHONE] = order;
        save_(all);
        return true;
      },

      /** Back to the default layout: the grid, hidden panels and the phone's order. */
      reset: function (a, ctx) {
        var all = load_();
        delete all[pageKey_(a.page)];
        delete all[a.page + PHONE];
        save_(all);
        ctx.refresh('layout');
        return true;
      }
    }
  };
}
