/**
 * Today module: picks the day's focus project and tracks the working session.
 *
 * Rule: the category that leads today (see LEAD) gets a 100 day head start, then the project
 * untouched for longest wins. "Swap focus" skips to the next candidate for the rest of the day.
 * Session state is per user and lives in user properties, so it follows you across devices.
 */

function todayModule() {
  var KEY = 'today.state';
  // ISO weekday: 1 = Monday ... 7 = Sunday. null means any category.
  var LEAD = { 1: 'coding', 2: 'coding', 3: 'job', 4: 'coding', 5: 'house', 6: 'house', 7: null };
  var LABELS = { 1: 'Coding', 2: 'Coding', 3: 'Job search', 4: 'Coding', 5: 'House', 6: 'House', 7: 'Rest or catch up' };

  function dayInfo_() {
    var tz = Session.getScriptTimeZone();
    var now = new Date();
    return { key: Utilities.formatDate(now, tz, 'yyyy-MM-dd'), weekday: Number(Utilities.formatDate(now, tz, 'u')) };
  }

  function load_(dayKey) {
    var raw = PropertiesService.getUserProperties().getProperty(KEY);
    var s = raw ? JSON.parse(raw) : {};
    if (s.day !== dayKey) s = { day: dayKey, skipped: [], jobDone: false, session: s.session || null };
    return s;
  }

  function save_(s) { PropertiesService.getUserProperties().setProperty(KEY, JSON.stringify(s)); }

  function ranked_(ctx, lead) {
    return ctx.call('projects', 'list', {})
      .filter(function (p) { return p.status === 'active'; })
      .map(function (p) {
        return { id: p.id, score: daysSince_(p.last_touched) + (lead && p.category === lead ? 100 : 0) };
      })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (x) { return x.id; });
  }

  function compute_(ctx) {
    var d = dayInfo_(), s = load_(d.key), lead = LEAD[d.weekday];
    var ranked = ranked_(ctx, lead);
    var pool = ranked.filter(function (id) { return s.skipped.indexOf(id) === -1; });
    if (!pool.length) pool = ranked;
    var focusId = s.session ? s.session.projectId : (pool[0] || null);
    return { day: d.key, weekday: d.weekday, lead: lead, labels: LABELS, focusId: focusId, jobDone: s.jobDone, session: s.session };
  }

  return {
    title: 'Today',
    snapshot: compute_,
    api: {
      state: function (a, ctx) { return compute_(ctx); },

      swap: function (a, ctx) {
        var d = dayInfo_(), s = load_(d.key);
        assert_(!s.session, 'Finish the current session before swapping focus.');
        var snap = compute_(ctx);
        if (snap.focusId) s.skipped.push(snap.focusId);
        var ranked = ranked_(ctx, LEAD[d.weekday]);
        var everyoneSkipped = ranked.every(function (id) { return s.skipped.indexOf(id) !== -1; });
        if (everyoneSkipped) s.skipped = snap.focusId ? [snap.focusId] : [];
        save_(s);
        ctx.refresh('today');
        return true;
      },

      toggleJob: function (a, ctx) {
        var d = dayInfo_(), s = load_(d.key);
        s.jobDone = !s.jobDone;
        save_(s);
        ctx.refresh('today');
        return s.jobDone;
      },

      start: function (a, ctx) {
        assert_(a.projectId, 'No project to start.');
        var d = dayInfo_(), s = load_(d.key);
        s.session = { projectId: a.projectId, start: nowIso_() };
        save_(s);
        ctx.refresh('today');
        return s.session;
      },

      finish: function (a, ctx) {
        var d = dayInfo_(), s = load_(d.key);
        var projectId = a.projectId || (s.session && s.session.projectId);
        assert_(projectId, 'No session to finish.');
        var where = clean_(a.where, 300) || 'No note';
        var next = clean_(a.next, 300);
        ctx.call('log', 'add', { projectId: projectId, where: where, next: next });
        ctx.call('projects', 'touch', { id: projectId, next_action: next });
        s.session = null;
        save_(s);
        ctx.refresh('today', 'projects', 'log');
        return true;
      }
    }
  };
}
