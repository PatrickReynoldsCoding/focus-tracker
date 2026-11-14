/**
 * Layout module: where each panel sits on a page, saved per mode in the mode's Settings tab (one row per page,
 * layout.<page>), so it follows you across devices.
 * Stored as { page: { panelId: { x, y, w, removed } } } on a 12-column grid. Heights follow each panel's content.
 * A removed panel is left off the page, on every screen size, until Add feature puts it back. Layouts saved before
 * 2026-11-14 say `hidden` instead; they are read as removed and written with the new word on the next save.
 * A phone shows panels one under the other in its own order, a row of its own: layout.<page>.phone = ["id", ...],
 * which reaches the page as { '<page>.phone': [...] } next to the pages.
 * A page's view choices (the Projects tab's status filter, the project page's hidden next action, the Notes tab's Show project notes) are a row of their own
 * too: layout.<page>.view = {"status":["active"]}, reaching the page as { '<page>.view': {...} }. Reset leaves them.
 * A phone's pills (Today): layout.<page>.pills = [{ "id", "name", "icon", "panels": ["habits", "list-ab12cd34"] }], the
 * pills in order, each a name, an icon (or "") and the panels it shows, top to bottom. Saving them can be undone. Their
 * switches are view choices: focusCard (compact, full, hidden), pillCounts, pillSwipe and pillLast (on or off).
 */

function layoutModule() {
  var PREFIX = 'layout.';
  var COLUMNS = 12;
  var MAX_PANELS = 60;
  var MAX_Y = 10000;
  // Panels that were split or renamed, by page: a saved place for the old id goes to the new ones, the first in its
  // place and each next one just below it (removed if it was removed). Today's "Small tasks" became Habits and To-dos.
  var RENAMED = { today: { smalltasks: ['habits', 'todos'] } };

  function renamed_(page, items) {
    var map = RENAMED[page] || {};
    Object.keys(map).forEach(function (old) {
      var place = items[old];
      if (!place) return;
      map[old].forEach(function (id, i) {
        if (items[id]) return;
        items[id] = { x: place.x, y: Math.min(MAX_Y, place.y + i), w: place.w };
        if (place.removed) items[id].removed = true;
      });
      delete items[old];
    });
    return items;
  }

  /** A place saved as hidden (before panels could only be removed) is a removed one. */
  function removedFromHidden_(items) {
    if (Array.isArray(items)) return items;
    Object.keys(items).forEach(function (id) {
      var place = items[id];
      if (!place || !place.hidden) return;
      delete place.hidden;
      place.removed = true;
    });
    return items;
  }

  function load_() {
    var saved = settingsWithPrefix_(PREFIX), all = {};
    Object.keys(saved).forEach(function (key) {
      var page = key.slice(PREFIX.length);
      try { all[page] = renamed_(page, removedFromHidden_(JSON.parse(saved[key]))); } catch (e) { /* a row edited by hand into something unreadable: the default layout */ }
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
  var VIEW = '.view';
  var MAX_VIEW_KEYS = 10;
  var MAX_VIEW_LIST = 10;
  var MAX_VIEW_TEXT = 60;
  var ON_OFF = ['on', 'off'];
  var VIEW_CHOICES_BY_NAME = { focusCard: ['compact', 'full', 'hidden'], pillCounts: ON_OFF, pillSwipe: ON_OFF, pillLast: ON_OFF, projectNotes: ON_OFF };

  var PILLS = '.pills';
  var MAX_PILLS = 12;
  var MAX_PILL_NAME = 24;
  var MAX_PANELS_IN_A_PILL = 40;
  var PILL_ICONS = ['☀️', '✅', '📝', '🛒', '🏠', '💼', '🎯', '🌙', '📋', '🌱'];
  var PANEL_ID = /^[a-zA-Z0-9_-]{1,60}$/;
  var PILL_ID = /^[a-zA-Z0-9_-]{1,60}$/;

  /** One pill as it is stored: a known icon or none, a name of 1 to 24 characters, each panel once. */
  function cleanPill_(pill, takenIds) {
    assert_(pill && typeof pill === 'object', 'Bad pill.');
    var id = String(pill.id || ''), name = String(pill.name || '').trim(), icon = String(pill.icon || '');
    assert_(PILL_ID.test(id) && !takenIds[id], 'Bad pill id.');
    takenIds[id] = true;
    assert_(name.length >= 1 && name.length <= MAX_PILL_NAME, 'A pill needs a name of up to ' + MAX_PILL_NAME + ' characters.');
    assert_(icon === '' || PILL_ICONS.indexOf(icon) !== -1, 'Unknown pill icon.');
    assert_(Array.isArray(pill.panels), 'Bad pill panels.');
    assert_(pill.panels.length <= MAX_PANELS_IN_A_PILL, 'Too many panels in a pill.');
    var panels = [];
    pill.panels.map(String).forEach(function (panelId) {
      assert_(PANEL_ID.test(panelId), 'Bad panel id.');
      if (panels.indexOf(panelId) === -1) panels.push(panelId);
    });
    return { id: id, name: name, icon: icon, panels: panels };
  }

  function viewChoice_(name, value) {
    var allowed = VIEW_CHOICES_BY_NAME[name];
    assert_(!allowed || value === null || allowed.indexOf(value) !== -1, 'Bad view setting: ' + name);
    return value;
  }

  function viewText_(value) {
    var text = String(value);
    assert_(text.length <= MAX_VIEW_TEXT, 'View setting too long.');
    return text;
  }

  /** A view choice: a short text, a list of short texts, or null to forget it. */
  function viewValue_(value) {
    if (value === null) return null;
    if (Array.isArray(value)) {
      assert_(value.length <= MAX_VIEW_LIST, 'View setting too long.');
      return value.map(viewText_);
    }
    return viewText_(value);
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
      assert_(whole_(item.w, 1, COLUMNS) && whole_(item.x, 0, COLUMNS - 1) && whole_(item.y, 0, MAX_Y), 'Bad panel position.');
      out[id] = { x: item.x, y: item.y, w: Math.min(item.w, COLUMNS - item.x) };
      if (item.removed || item.hidden) out[id].removed = true;
    });
    return out;
  }

  function setRemoved_(page, id, removed, ctx) {
    var all = load_(), pageKey = pageKey_(page);
    assert_(/^[a-zA-Z0-9_-]{1,60}$/.test(String(id || '')), 'Bad panel id.');
    var pageLayout = all[pageKey] || {};
    var place = pageLayout[id] || { x: 0, y: MAX_Y, w: 12 };
    if (removed) place.removed = true; else delete place.removed;
    pageLayout[id] = place;
    all[pageKey] = pageLayout;
    save_(all);
    ctx.refresh('layout');
    return true;
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

      /** Take one panel off the page, or put it back (Add feature), keeping where it was. */
      setRemoved: function (a, ctx) {
        return setRemoved_(a.page, a.id, !!a.removed, ctx);
      },

      /** The same for a page loaded before 2026-11-14, which still says hidden. */
      setHidden: function (a, ctx) {
        return setRemoved_(a.page, a.id, !!a.hidden, ctx);
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

      /** Merge a.view ({ name: value }, null forgets one) into the page's saved view choices. */
      saveView: function (a) {
        var key = pageKey_(a.page) + VIEW;
        assert_(a.view && typeof a.view === 'object' && !Array.isArray(a.view), 'Bad view settings.');
        var all = load_(), view = all[key] || {};
        Object.keys(a.view).forEach(function (name) {
          assert_(/^[a-zA-Z]{1,30}$/.test(name), 'Bad view setting: ' + name);
          var value = viewChoice_(name, viewValue_(a.view[name]));
          if (value === null) delete view[name]; else view[name] = value;
        });
        assert_(Object.keys(view).length <= MAX_VIEW_KEYS, 'Too many view settings.');
        all[key] = view;
        save_(all);
        return true;
      },

      /** The phone's pills of a page (a.pills, in order), replacing the saved ones. Recorded for undo. */
      savePills: function (a) {
        var key = PREFIX + pageKey_(a.page) + PILLS;
        assert_(Array.isArray(a.pills), 'Bad pills.');
        assert_(a.pills.length <= MAX_PILLS, 'At most ' + MAX_PILLS + ' pills.');
        var takenIds = {}, pills = a.pills.map(function (pill) { return cleanPill_(pill, takenIds); });
        var values = {};
        values[key] = JSON.stringify(pills);
        setSettingsWithUndo_(values);
        return true;
      },

      /** Back to the default layout: the grid, removed panels and the phone's order. */
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
