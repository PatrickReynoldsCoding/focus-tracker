/**
 * Today module: picks the day's focus project and tracks the working session.
 *
 * Rule: the category that leads today gets a 100 day head start, then the project untouched for longest wins.
 * "Swap focus" moves to a project you pick (or the next candidate). The project swapped away from is skipped for the
 * day, never counted as worked on, so it keeps its neglect and comes back. Every skip is logged in the Skips tab,
 * and "remind me" adds a row to the Reminders tab that shows as a banner when due.
 *
 * The weekly rotation (a lead category, "any", or away for each weekday) is the mode's default until edited.
 * "This week" changes are saved with the week's Monday and stop applying when a new week starts.
 * Session, rotation and week state are per user and per mode and live in user properties, so they follow you across devices.
 *
 * A session is { projectId, start, pausedMs, pausedAt, pomodoro }. Worked time is wall time minus pauses.
 * pomodoro is null when off, else { phase: 'work' | 'break', phaseStartMs, lengthMin } where phaseStartMs is the
 * worked time when the phase began, so pausing also pauses the pomodoro. lengthMin is fixed when the phase starts,
 * so changing the settings only affects later phases. A finished phase waits for nextPhase.
 */

function todayModule() {
  var KEY = modeKey_('today.state');
  var POMODORO_KEY = 'today.pomodoro';
  var POMODORO_DEFAULTS = { work: 25, break: 5 };
  var NEXT_PHASE = { work: 'break', break: 'work' };
  var ROTATION_KEY = modeKey_('today.rotation');
  var WEEK_KEY = modeKey_('today.week');
  var ANY_LABEL = 'Any category';
  var AWAY = 'away';
  var AWAY_LABEL = 'Away';
  var WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
  var REMIND_DAYS = [0, 1, 3, 7];
  var DAY_MS = 86400000;
  var SKIPS = new Table('Skips', ['id', 'project_id', 'to_project_id', 'date']);
  var REMINDERS = new Table('Reminders', ['id', 'project_id', 'due', 'created', 'done']);

  /** Today's date key, ISO weekday and the date of this week's Monday, in the script's time zone. */
  function dayInfo_() {
    var tz = Session.getScriptTimeZone();
    var now = new Date();
    var weekday = Number(Utilities.formatDate(now, tz, 'u'));
    return {
      key: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
      weekday: weekday,
      weekKey: Utilities.formatDate(new Date(now.getTime() - (weekday - 1) * DAY_MS), tz, 'yyyy-MM-dd')
    };
  }

  function dateInDays_(days) {
    return Utilities.formatDate(new Date(Date.now() + days * DAY_MS), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  function readJson_(key) {
    var raw = PropertiesService.getUserProperties().getProperty(key);
    return raw ? JSON.parse(raw) : null;
  }

  function writeJson_(key, value) {
    PropertiesService.getUserProperties().setProperty(key, JSON.stringify(value));
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

  /** End an open pause: its length is added to the paused total. Does nothing when not paused. */
  function resumeSession_(session, nowMs) {
    if (!session.pausedAt) return;
    session.pausedMs = (session.pausedMs || 0) + (nowMs - new Date(session.pausedAt).getTime());
    session.pausedAt = '';
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

  /** A saved day plan as it applies now: a category id, AWAY, or null (any). A deleted category counts as any. */
  function dayPlan_(value, ids) {
    return value === AWAY || ids.indexOf(value) !== -1 ? value : null;
  }

  /** A day plan sent from the browser: '' means any category. Throws on an unknown category. */
  function planFromInput_(value, ids) {
    if (value === '' || value === null || value === undefined) return null;
    if (value === AWAY) return AWAY;
    assert_(ids.indexOf(value) !== -1, 'Unknown category: ' + value);
    return value;
  }

  /** The usual rotation: the user's own once saved, else the mode's default. */
  function usual_(ids) {
    var saved = readJson_(ROTATION_KEY);
    var days = saved && saved.days ? saved.days : activeMode_().rotation;
    var usual = {};
    WEEKDAYS.forEach(function (day) { usual[day] = dayPlan_(days[day], ids); });
    return usual;
  }

  /** This week's changes by weekday. Empty once the saved week is over, so they reset on Monday. */
  function weekChanges_(weekKey, ids) {
    var saved = readJson_(WEEK_KEY);
    var changes = {};
    if (!saved || saved.week !== weekKey) return changes;
    Object.keys(saved.days || {}).forEach(function (day) { changes[day] = dayPlan_(saved.days[day], ids); });
    return changes;
  }

  function plan_(usual, week) {
    var plan = {};
    WEEKDAYS.forEach(function (day) { plan[day] = Object.prototype.hasOwnProperty.call(week, day) ? week[day] : usual[day]; });
    return plan;
  }

  function labels_(plan, categories) {
    var labels = {};
    WEEKDAYS.forEach(function (day) {
      var category = categories.filter(function (c) { return c.id === plan[day]; })[0];
      labels[day] = plan[day] === AWAY ? AWAY_LABEL : category ? category.label : ANY_LABEL;
    });
    return labels;
  }

  /** The daily-minimum category: the user's choice once saved, else the mode's. null when none or deleted. */
  function dailyMinimum_(ids) {
    var saved = readJson_(ROTATION_KEY);
    var id = saved && Object.prototype.hasOwnProperty.call(saved, 'dailyMinimum') ? saved.dailyMinimum : activeMode_().dailyMinimum;
    return ids.indexOf(id) !== -1 ? id : null;
  }

  function skipCounts_() {
    var counts = {};
    SKIPS.all().forEach(function (r) { counts[r.project_id] = (counts[r.project_id] || 0) + 1; });
    return counts;
  }

  function dueReminders_(dayKey) {
    return REMINDERS.all()
      .filter(function (r) { return !r.done && r.due <= dayKey; })
      .sort(function (a, b) { return a.due < b.due ? -1 : 1; })
      .map(function (r) { return { id: r.id, project_id: r.project_id, due: r.due, created: r.created }; });
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
    var d = dayInfo_(), s = load_(d.key);
    var categories = ctx.call('categories', 'list');
    var ids = categories.map(function (c) { return c.id; });
    var usual = usual_(ids), week = weekChanges_(d.weekKey, ids), plan = plan_(usual, week);
    var lead = plan[d.weekday] === AWAY ? null : plan[d.weekday];
    var ranked = ranked_(ctx, lead);
    var pool = ranked.filter(function (id) { return s.skipped.indexOf(id) === -1; });
    if (!pool.length) pool = ranked;
    var picked = s.focusPick && ranked.indexOf(s.focusPick) !== -1 ? s.focusPick : null;
    var focusId = s.session ? s.session.projectId : (picked || pool[0] || null);
    return {
      day: d.key, weekday: d.weekday, lead: lead, away: plan[d.weekday] === AWAY, usual: usual, week: week,
      labels: labels_(plan, categories), focusId: focusId, ranked: ranked, dailyMinimum: dailyMinimum_(ids), jobDone: s.jobDone,
      session: s.session, pomodoroSettings: pomodoroSettings_(), skipCounts: skipCounts_(), reminders: dueReminders_(d.key)
    };
  }

  return {
    title: 'Today',
    tables: [SKIPS, REMINDERS],
    snapshot: compute_,
    api: {
      state: function (a, ctx) { return compute_(ctx); },

      /**
       * Skip today's focus. a.toId: the project to switch to (optional; the next candidate if left out).
       * a.remindDays: 0 (no reminder), 1, 3 or 7 days until a reminder about the skipped project.
       */
      swap: function (a, ctx) {
        var d = dayInfo_(), s = load_(d.key);
        assert_(!s.session, 'Finish the current session before swapping focus.');
        var remindDays = Number(a.remindDays || 0);
        assert_(REMIND_DAYS.indexOf(remindDays) !== -1, 'Unknown reminder: ' + a.remindDays);
        var snap = compute_(ctx), fromId = snap.focusId;
        if (a.toId) {
          assert_(snap.ranked.indexOf(a.toId) !== -1, 'Pick an active project to switch to.');
          assert_(a.toId !== fromId, 'That project is already today\'s focus.');
        }
        if (fromId) {
          s.skipped.push(fromId);
          SKIPS.insert({ project_id: fromId, to_project_id: a.toId || '', date: nowIso_() });
          if (remindDays) REMINDERS.insert({ project_id: fromId, due: dateInDays_(remindDays), created: nowIso_(), done: '' });
        }
        s.focusPick = a.toId || null;
        var everyoneSkipped = snap.ranked.every(function (id) { return s.skipped.indexOf(id) !== -1; });
        if (!a.toId && everyoneSkipped) s.skipped = fromId ? [fromId] : [];
        save_(s);
        ctx.refresh('today');
        return true;
      },

      /** Make a reminded project today's focus and close the reminder. */
      focusReminder: function (a, ctx) {
        var reminder = REMINDERS.get(a.id);
        assert_(reminder, 'Reminder not found.');
        var d = dayInfo_(), s = load_(d.key);
        assert_(!s.session, 'Finish the current session first.');
        assert_(compute_(ctx).ranked.indexOf(reminder.project_id) !== -1, 'That project is not active any more.');
        s.focusPick = reminder.project_id;
        save_(s);
        REMINDERS.update(a.id, { done: nowIso_() });
        ctx.refresh('today');
        return true;
      },

      dismissReminder: function (a, ctx) {
        REMINDERS.update(a.id, { done: nowIso_() });
        ctx.refresh('today');
        return true;
      },

      /**
       * Save the rotation. a.usual: { weekday: categoryId | 'away' | '' } for every day; a.week: the same for days
       * that differ this week only; a.dailyMinimum: a category id or '' for none.
       */
      saveRotation: function (a, ctx) {
        var ids = ctx.call('categories', 'ids'), d = dayInfo_();
        var days = {}, week = {};
        WEEKDAYS.forEach(function (day) { days[day] = planFromInput_((a.usual || {})[day], ids); });
        Object.keys(a.week || {}).forEach(function (day) {
          assert_(WEEKDAYS.indexOf(Number(day)) !== -1, 'Unknown weekday: ' + day);
          week[day] = planFromInput_(a.week[day], ids);
        });
        assert_(!a.dailyMinimum || ids.indexOf(a.dailyMinimum) !== -1, 'Unknown category: ' + a.dailyMinimum);
        writeJson_(ROTATION_KEY, { days: days, dailyMinimum: a.dailyMinimum || null });
        writeJson_(WEEK_KEY, { week: d.weekKey, days: week });
        ctx.refresh('today');
        return true;
      },

      removeProject: function (a) {
        SKIPS.removeWhere(function (r) { return r.project_id === a.projectId || r.to_project_id === a.projectId; });
        REMINDERS.removeWhere(function (r) { return r.project_id === a.projectId; });
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
        return changeSession_(ctx, resumeSession_);
      },

      /**
       * Turn the pomodoro on (starting a work period now) or off for the running session.
       * Turning it on means "I am working now", so a paused session resumes; otherwise the countdown would sit still.
       */
      pomodoro: function (a, ctx) {
        return changeSession_(ctx, function (session, nowMs) {
          if (a.on) resumeSession_(session, nowMs);
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
