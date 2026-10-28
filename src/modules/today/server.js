/**
 * Today module: picks the day's focus project and tracks the working session.
 *
 * Rule: the category that leads today (see LEAD) gets a 100 day head start, then the project
 * untouched for longest wins. "Swap focus" skips to the next candidate for the rest of the day.
 * Session state is per user and lives in user properties, so it follows you across devices.
 *
 * A session is { projectId, start, pausedMs, pausedAt, pomodoro }. Worked time is wall time minus pauses.
 * pomodoro is null when off, else { phase: 'work' | 'break', phaseStartMs, lengthMin } where phaseStartMs is the
 * worked time when the phase began, so pausing also pauses the pomodoro. lengthMin is fixed when the phase starts,
 * so changing the settings only affects later phases. A finished phase waits for nextPhase.
 */

function todayModule() {
  var KEY = 'today.state';
  var POMODORO_KEY = 'today.pomodoro';
  var POMODORO_DEFAULTS = { work: 25, break: 5 };
  var NEXT_PHASE = { work: 'break', break: 'work' };
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

  function pomodoroSettings_() {
    var raw = PropertiesService.getUserProperties().getProperty(POMODORO_KEY);
    var saved = raw ? JSON.parse(raw) : {};
    return { work: saved.work || POMODORO_DEFAULTS.work, break: saved.break || POMODORO_DEFAULTS.break };
  }

  function minutesSetting_(value, label) {
    var minutes = Number(value);
    assert_(Math.floor(minutes) === minutes && minutes >= 1 && minutes <= 180, label + ' must be a whole number of minutes from 1 to 180.');
    return minutes;
  }

  /** Milliseconds worked in a session up to nowMs, leaving out every pause. Sessions saved before pauses existed have no pausedMs. */
  function workedMs_(session, nowMs) {
    var pausedMs = session.pausedMs || 0;
    var openPauseMs = session.pausedAt ? nowMs - new Date(session.pausedAt).getTime() : 0;
    return Math.max(0, nowMs - new Date(session.start).getTime() - pausedMs - openPauseMs);
  }

  function startPhase_(phase, session, nowMs) {
    return { phase: phase, phaseStartMs: workedMs_(session, nowMs), lengthMin: pomodoroSettings_()[phase] };
  }

  function requireSession_(s) {
    assert_(s.session, 'No session is running.');
    return s.session;
  }

  /** Load today's state, apply change(session) to the running session, save and refresh. */
  function changeSession_(ctx, change) {
    var d = dayInfo_(), s = load_(d.key);
    change(requireSession_(s), Date.now());
    save_(s);
    ctx.refresh('today');
    return s.session;
  }

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
    return { day: d.key, weekday: d.weekday, lead: lead, labels: LABELS, focusId: focusId, jobDone: s.jobDone, session: s.session,
      pomodoroSettings: pomodoroSettings_() };
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
        s.session = { projectId: a.projectId, start: nowIso_(), pausedMs: 0, pausedAt: '', pomodoro: null };
        save_(s);
        ctx.refresh('today');
        return s.session;
      },

      pause: function (a, ctx) {
        return changeSession_(ctx, function (session) {
          if (!session.pausedAt) session.pausedAt = nowIso_();
        });
      },

      resume: function (a, ctx) {
        return changeSession_(ctx, function (session, nowMs) {
          if (!session.pausedAt) return;
          session.pausedMs = (session.pausedMs || 0) + (nowMs - new Date(session.pausedAt).getTime());
          session.pausedAt = '';
        });
      },

      /** Turn the pomodoro on (starting a work period now) or off for the running session. */
      pomodoro: function (a, ctx) {
        return changeSession_(ctx, function (session, nowMs) {
          session.pomodoro = a.on ? startPhase_('work', session, nowMs) : null;
        });
      },

      /** Start the next pomodoro period (break after work, work after break). */
      nextPhase: function (a, ctx) {
        return changeSession_(ctx, function (session, nowMs) {
          assert_(session.pomodoro, 'The pomodoro is off.');
          session.pomodoro = startPhase_(NEXT_PHASE[session.pomodoro.phase], session, nowMs);
        });
      },

      pomodoroSettings: function (a, ctx) {
        var settings = { work: minutesSetting_(a.work, 'Work length'), break: minutesSetting_(a.break, 'Break length') };
        PropertiesService.getUserProperties().setProperty(POMODORO_KEY, JSON.stringify(settings));
        ctx.refresh('today');
        return settings;
      },

      finish: function (a, ctx) {
        var d = dayInfo_(), s = load_(d.key);
        var projectId = a.projectId || (s.session && s.session.projectId);
        assert_(projectId, 'No session to finish.');
        var where = clean_(a.where, 300) || 'No note';
        var next = clean_(a.next, 300);
        var ownSession = s.session && s.session.projectId === projectId;
        var minutes = ownSession ? Math.round(workedMs_(s.session, Date.now()) / 60000) : 0;
        ctx.call('log', 'add', { projectId: projectId, where: where, next: next, minutes: minutes });
        ctx.call('projects', 'touch', { id: projectId, next_action: next });
        s.session = null;
        save_(s);
        ctx.refresh('today', 'projects', 'log');
        return true;
      }
    }
  };
}
