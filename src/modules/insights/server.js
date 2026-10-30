/**
 * Insights module: the Insights tab (it replaced the Log tab). It only reads; it has no tables of its own.
 * Sub-tabs Week, Habits and Projects are built here from one call, summary(). The Logs sub-tab is the log module's
 * (its view fills the 'insights.sub' slot), and the Log tab of the sheet is unchanged.
 *
 * Weeks run Monday to Sunday, by the date in the script's time zone. Log and Skips rows hold ISO times; Habit log and
 * To-dos rows hold plain dates.
 *
 * What it reads, and from whom (each through ctx so a missing module leaves its part empty):
 *   log.list                       every Log row (date, project_id, minutes)
 *   projects.list                  the projects
 *   categories.list                labels for the rotation's lead category
 *   today.state, today.skips       the rotation (lead and Away days) and the Skips rows
 *
 * The interface expected from the habits module (docs/habits-ideas.md §3):
 *   ctx.optional('habits', 'history', { from, to })   from and to are ISO dates, both included
 *   returns { habits: [...], log: [...] }
 *     habits  every started row of the Habits tab (never `aspiring` ones, which are ideas not started yet; read
 *             from the tabs, they are left out here): id, name, sessions, per (day | week), size, status (active | paused | ended),
 *             started (ISO date), prompts (on | off | at goal), order. Other columns are passed through and ignored.
 *     log     Habit log rows: habit_id, day, kind, count, value.
 *             done and plan rows whose day is from..to, and every level, prompt, pause and resume row up to `to`
 *             (older ones too, as they say what applied then).
 *   A level row's day is the first day the new level applies (next Monday for a weekly habit), its value the level as
 *   people write it: "4 a week, 30 min" or "1 a day, 10 min". A level row is written when a habit is made, too, so
 *   the weeks before the first step-up compare with the starting level.
 * If the habits module is not installed, or has no history api, the Habits and Habit log tabs are read directly through
 * Table with the columns above, read-only (nothing is made if they do not exist). No Habits tab means no habits.
 * To-dos the same way: ctx.optional('todos', 'history', { from, to }) returning the To-dos rows (title, day, done),
 * else the To-dos tab.
 */

/** Today's date in the script's time zone. A function of its own so the tests can set the day. */
function insightsToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Date arithmetic on ISO dates (yyyy-MM-dd), done in UTC so it never meets a clock change. */
function insightsAddDays_(day, n) {
  var p = day.split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n)).toISOString().slice(0, 10);
}

/** 1 = Monday ... 7 = Sunday. */
function insightsWeekday_(day) {
  return (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7 + 1;
}

/** The Monday of the week a date is in. */
function insightsMonday_(day) {
  return insightsAddDays_(day, 1 - insightsWeekday_(day));
}

/** The date a cell is about: a plain date as it is, an ISO time as its date in the script's time zone. '' if neither. */
function insightsDayOf_(value) {
  var s = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = new Date(s);
  return s && !isNaN(d.getTime()) ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') : '';
}

/** A level as people write it ("4 a week, 30 min", "1 a day", "3 per week") as { sessions, per, size }. null if unreadable. */
function insightsParseLevel_(text, defaultPer) {
  var s = String(text || '');
  var size = s.indexOf(',') !== -1 ? s.slice(s.indexOf(',') + 1).trim() : '';
  var m = /(\d+)\s*(?:x|times|sessions?)?\s*(?:a|an|per|\/|each)?\s*(day|week)/i.exec(s);
  if (m) return { sessions: Number(m[1]), per: m[2].toLowerCase(), size: size };
  var lead = /^\s*(\d+)/.exec(s);
  return lead ? { sessions: Number(lead[1]), per: defaultPer, size: size } : null;
}

function insightsModule() {
  var HABIT_WEEKS = 12;        // weeks of habit history sent; the page shows the last 8 or 12
  var RANGES = [8, 12];        // the Habits sub-tab's choices
  var PROJECT_RANGES = [4, 12]; // the Projects sub-tab's choices, in weeks

  /** A module's api if it is there: undefined when the module or the function is missing. */
  function maybe_(ctx, id, fn, args) {
    try { return ctx.optional(id, fn, args); } catch (e) {
      if (/has no api function/.test(e.message)) return undefined;
      throw e;
    }
  }

  /** A tab's rows through Table, only if the tab exists: reading never makes a tab. */
  function readTab_(name, headers, numeric) {
    if (!getSpreadsheet_().getSheetByName(name)) return [];
    return new Table(name, headers, numeric).all();
  }

  function habitSource_(ctx, from, to) {
    var r = maybe_(ctx, 'habits', 'history', { from: from, to: to });
    if (r && Array.isArray(r.habits)) return { habits: r.habits, log: Array.isArray(r.log) ? r.log : [] };
    return {
      habits: readTab_('Habits', ['name', 'sessions', 'per', 'id'], ['sessions']),
      log: readTab_('Habit log', ['id', 'habit_id', 'day', 'kind', 'count', 'value'], ['count'])
    };
  }

  function todoSource_(ctx, from, to) {
    var r = maybe_(ctx, 'todos', 'history', { from: from, to: to });
    if (Array.isArray(r)) return { rows: r, known: true };
    if (!getSpreadsheet_().getSheetByName('To-dos')) return { rows: [], known: false };
    return { rows: readTab_('To-dos', ['title', 'day', 'done', 'id']), known: true };
  }

  /** The rotation: lead label and away flag per weekday, for this week (with its changes) and for other weeks (the usual). */
  function rotation_(ctx) {
    var state = maybe_(ctx, 'today', 'state', {});
    if (!state) return null;
    var categories = maybe_(ctx, 'categories', 'list', {}) || [];
    function label(plan) {
      if (plan === 'away') return 'Away';
      var c = categories.filter(function (x) { return x.id === plan; })[0];
      return c ? c.label : 'Any category';
    }
    var usual = {}, current = {};
    for (var day = 1; day <= 7; day++) {
      var u = state.usual ? state.usual[day] : null;
      var w = state.week && Object.prototype.hasOwnProperty.call(state.week, day) ? state.week[day] : u;
      usual[day] = { lead: label(u), away: u === 'away' };
      current[day] = { lead: label(w), away: w === 'away' };
    }
    return { usual: usual, current: current, focusId: state.focusId || '' };
  }

  // ---------- habits ----------

  /** Everything known about one habit over time: its levels, pauses, done and plan counts by day. */
  function habitTimeline_(h, rows) {
    var levels = [], pauses = [], prompts = [], done = {}, plan = {};
    var per = h.per === 'day' ? 'day' : 'week';
    rows.forEach(function (r) {
      var day = insightsDayOf_(r.day);
      if (!day) return;
      var count = Number(r.count) || 0;
      if (r.kind === 'done') done[day] = (done[day] || 0) + count;
      else if (r.kind === 'plan') plan[day] = (plan[day] || 0) + count;
      else if (r.kind === 'level') {
        var level = insightsParseLevel_(r.value, per);
        if (level) levels.push({ day: day, sessions: level.sessions, per: level.per, size: level.size, at: r.updated_at || '' });
      } else if (r.kind === 'prompt') prompts.push({ day: day, value: String(r.value || '') });
      else if (r.kind === 'pause' || r.kind === 'resume') pauses.push({ day: day, kind: r.kind });
    });
    levels.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : a.at < b.at ? -1 : 1; });
    pauses.sort(function (a, b) { return a.day < b.day ? -1 : 1; });
    prompts.sort(function (a, b) { return a.day < b.day ? -1 : 1; });
    var now = { sessions: Number(h.sessions) || 0, per: per, size: h.size || '' };
    // Pause intervals: from a pause (included) to the next resume (left out). A habit paused with no pause row is paused from today.
    var spans = [], open = null;
    pauses.forEach(function (p) {
      if (p.kind === 'pause' && !open) open = p.day;
      else if (p.kind === 'resume' && open) { spans.push([open, p.day]); open = null; }
    });
    if (open) spans.push([open, '9999-12-31']);
    else if (h.status === 'paused') spans.push([insightsToday_(), '9999-12-31']);
    return {
      levels: levels, prompts: prompts, done: done, plan: plan, now: now,
      /** The level that applied on a day: the newest level row on or before it; before the first, the first; with none, today's. */
      levelOn: function (day) {
        var hit = null;
        for (var i = 0; i < levels.length; i++) if (levels[i].day <= day) hit = levels[i];
        return hit || levels[0] || now;
      },
      paused: function (day) { return spans.some(function (s) { return day >= s[0] && day < s[1]; }); }
    };
  }

  /**
   * One habit's week: done, target (what applied then), extra, and whether it is a full week that counts towards
   * "on target n of m". A daily habit's target leaves out Away days, paused days and days before it started.
   * A weekly habit's week counts only if the habit was on for all of it.
   */
  function habitWeek_(h, t, monday, today, rot) {
    var started = insightsDayOf_(h.started);
    var days = [], doneSum = 0, planSum = 0, planLater = 0, target = 0, targetSoFar = 0;
    var excluded = 0, awayDays = [], pausedDays = 0, daysOnTarget = 0, daysCounted = 0;
    var first = monday < started ? started : monday;
    var per = t.levelOn(first).per;
    for (var i = 0; i < 7; i++) {
      var day = insightsAddDays_(monday, i);
      var weekday = i + 1;
      var done = t.done[day] || 0, planned = t.plan[day] || 0;
      doneSum += done; planSum += planned;
      if (day > today) planLater += planned;
      var before = started && day < started, paused = t.paused(day);
      var r = rot ? (monday === insightsMonday_(today) ? rot.current : rot.usual)[weekday] : null;
      var away = !!(r && r.away);
      if (paused) pausedDays++;
      if (before || paused) { excluded++; continue; }
      if (per === 'day') {
        if (away) { excluded++; awayDays.push(weekday); continue; }
        var want = t.levelOn(day).sessions;
        target += want;
        if (day <= today) targetSoFar += want;
        if (day < today || (day === today && done >= want)) { daysCounted++; if (done >= want) daysOnTarget++; }
      } else if (away) awayDays.push(weekday);
      days.push(day);
    }
    if (per !== 'day') {
      target = days.length ? t.levelOn(first).sessions : 0;
      targetSoFar = target;
    }
    var end = insightsAddDays_(monday, 6);
    var counted = days.length > 0 && target > 0;
    var full = counted && end < today && (per === 'day' || excluded === 0);
    return {
      start: monday, per: per, done: doneSum, target: target, targetSoFar: targetSoFar, extra: Math.max(0, doneSum - target),
      planned: planSum, planLater: planLater, onTarget: counted && doneSum >= target, full: full, counted: counted,
      current: monday <= today && today <= end, before: !!(started && end < started), pausedDays: pausedDays, awayDays: awayDays,
      daysOnTarget: daysOnTarget, daysCounted: daysCounted, size: t.levelOn(first).size || h.size || ''
    };
  }

  /** "on target n of m": full weeks for a weekly habit, days so far for a daily one. */
  function onTarget_(weeks, per) {
    if (per === 'day') {
      return weeks.reduce(function (acc, w) { return { n: acc.n + w.daysOnTarget, of: acc.of + w.daysCounted, unit: 'days' }; }, { n: 0, of: 0, unit: 'days' });
    }
    var full = weeks.filter(function (w) { return w.full; });
    return { n: full.filter(function (w) { return w.onTarget; }).length, of: full.length, unit: 'weeks' };
  }

  /** The last 4 full weeks against the 4 before them: 'up', 'level' or 'down'. null without enough weeks. */
  function trend_(weeks) {
    var full = weeks.filter(function (w) { return w.full; });
    if (full.length < 4) return null;
    var recent = full.slice(-4), before = full.slice(-8, -4);
    if (before.length < 2) return null;
    function rate(list) {
      var done = 0, target = 0;
      list.forEach(function (w) { done += w.done; target += w.target; });
      return target ? done / target : 0;
    }
    var diff = rate(recent) - rate(before);
    return diff > 0.1 ? 'up' : diff < -0.1 ? 'down' : 'level';
  }

  /**
   * Habit strength as a word, never a number (habits-ideas.md §1): a score that rises with each full week on or near
   * target and falls slowly, so one bad week after a good run costs little.
   */
  function strength_(weeks) {
    var full = weeks.filter(function (w) { return w.full; });
    if (full.length < 2) return 'Starting';
    var score = 0;
    full.forEach(function (w) { score = score * 0.7 + 0.3 * Math.min(w.done / w.target, 1); });
    return score < 0.3 ? 'Starting' : score < 0.55 ? 'Building' : score < 0.8 ? 'Steady' : 'Strong';
  }

  function levelText_(l) {
    return l.sessions + ' a ' + l.per + (l.size ? ', ' + l.size : '');
  }

  function habitsSummary_(ctx, today, rot) {
    var monday = insightsMonday_(today);
    var from = insightsAddDays_(monday, -7 * (HABIT_WEEKS - 1)), to = insightsAddDays_(monday, 6);
    var src = habitSource_(ctx, from, to);
    var byHabit = {};
    src.log.forEach(function (r) { (byHabit[r.habit_id] = byHabit[r.habit_id] || []).push(r); });
    return src.habits
      // An aspiring habit (an idea, not started) has no weeks to show; the history api leaves them out, the tabs may not.
      .filter(function (h) { return h.id && h.name && String(h.status || '').trim().toLowerCase() !== 'aspiring'; })
      .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); })
      .map(function (h) {
        var t = habitTimeline_(h, byHabit[h.id] || []);
        var weeks = [];
        for (var i = HABIT_WEEKS - 1; i >= 0; i--) weeks.push(habitWeek_(h, t, insightsAddDays_(monday, -7 * i), today, rot));
        var ranges = {};
        RANGES.forEach(function (n) { ranges[n] = onTarget_(weeks.slice(-n), t.now.per); });
        var changes = [];
        for (var c = 1; c < t.levels.length; c++) {
          var a = t.levels[c - 1], b = t.levels[c];
          if (levelText_(a) !== levelText_(b)) changes.push({ day: b.day, from: levelText_(a), to: levelText_(b) });
        }
        var lastPrompt = t.prompts.length ? t.prompts[t.prompts.length - 1] : null;
        if (h.status === 'ended' && !weeks.some(function (w) { return w.done > 0; })) return null;
        return {
          id: h.id, name: h.name, size: t.now.size, sessions: t.now.sessions, per: t.now.per, intention: h.intention || '',
          status: h.status || 'active', atGoal: h.prompts === 'at goal', started: insightsDayOf_(h.started),
          weeks: weeks, ranges: ranges, trend: trend_(weeks), strength: strength_(weeks), changes: changes, lastPrompt: lastPrompt
        };
      })
      .filter(Boolean);
  }

  // ---------- sessions, focus and projects ----------

  function sessionRows_(ctx) {
    return (maybe_(ctx, 'log', 'list', {}) || [])
      .filter(function (r) { return r.project_id; })
      .map(function (r) { return { day: insightsDayOf_(r.date), project_id: r.project_id, minutes: Number(r.minutes) || 0 }; })
      .filter(function (r) { return r.day; });
  }

  function focusWeek_(monday, today, sessions, rot, projectsById) {
    var days = [], total = { sessions: 0, minutes: 0 };
    var isCurrent = monday === insightsMonday_(today);
    for (var i = 0; i < 7; i++) {
      var day = insightsAddDays_(monday, i);
      if (day > today) break;
      var mine = sessions.filter(function (s) { return s.day === day; });
      var names = [], minutes = 0;
      mine.forEach(function (s) {
        minutes += s.minutes;
        var p = projectsById[s.project_id];
        var name = p ? p.name : 'Deleted project';
        if (names.indexOf(name) === -1) names.push(name);
      });
      if (!names.length && day === today && rot && rot.focusId && projectsById[rot.focusId]) names.push(projectsById[rot.focusId].name);
      var r = rot ? (isCurrent ? rot.current : rot.usual)[i + 1] : null;
      days.push({ day: day, weekday: i + 1, lead: r ? r.lead : '', away: !!(r && r.away), focus: names, sessions: mine.length, minutes: minutes });
      total.sessions += mine.length; total.minutes += minutes;
    }
    return { days: days, sessions: total.sessions, minutes: total.minutes };
  }

  function todosWeek_(todos, monday, today) {
    if (!todos.known) return null;
    var end = insightsAddDays_(monday, 6), isCurrent = monday === insightsMonday_(today);
    var out = { done: 0, onDay: 0, toCome: 0, anytime: 0, open: 0 };
    todos.rows.forEach(function (t) {
      var day = insightsDayOf_(t.day), done = insightsDayOf_(t.done);
      if (done) {
        if (done >= monday && done <= end) { out.done++; if (day && done <= day) out.onDay++; }
        return;
      }
      if (!isCurrent) return;
      if (!day) out.anytime++;
      else if (day >= today && day <= end) out.toCome++;
      else if (day < today) out.open++;
    });
    return out;
  }

  function projectsSummary_(ctx, today, sessions, projects) {
    var skips = (maybe_(ctx, 'today', 'skips', {}) || []).map(function (s) { return { day: insightsDayOf_(s.date), project_id: s.project_id }; });
    var monday = insightsMonday_(today), out = {};
    PROJECT_RANGES.forEach(function (n) {
      var from = insightsAddDays_(monday, -7 * (n - 1));
      var rows = {};
      projects.forEach(function (p) {
        rows[p.id] = { id: p.id, name: p.name, category: p.category, status: p.status, lastTouched: p.last_touched || '', sessions: 0, minutes: 0, skips: 0 };
      });
      sessions.forEach(function (s) {
        if (s.day < from || s.day > today || !rows[s.project_id]) return;
        rows[s.project_id].sessions++; rows[s.project_id].minutes += s.minutes;
      });
      skips.forEach(function (s) { if (s.day >= from && s.day <= today && rows[s.project_id]) rows[s.project_id].skips++; });
      out[n] = {
        from: from,
        rows: Object.keys(rows).map(function (id) { return rows[id]; })
          .filter(function (r) { return r.status === 'active' || r.sessions || r.skips; })
          .sort(function (a, b) { return b.minutes - a.minutes || b.sessions - a.sessions || (a.name < b.name ? -1 : 1); })
      };
    });
    return out;
  }

  function weekSummary_(monday, today, habits, sessions, rot, projectsById, todos) {
    var end = insightsAddDays_(monday, 6);
    var index = -1;
    if (habits.length) habits[0].weeks.forEach(function (w, i) { if (w.start === monday) index = i; });
    return {
      start: monday, end: end, current: today >= monday && today <= end,
      daysLeft: today >= monday && today <= end ? 7 - insightsWeekday_(today) : 0,
      away: rot ? [1, 2, 3, 4, 5, 6, 7].filter(function (d) { return (today >= monday && today <= end ? rot.current : rot.usual)[d].away; }) : [],
      habits: index === -1 ? [] : habits.map(function (h) {
        var w = h.weeks[index];
        return { id: h.id, name: h.name, size: w.size, per: w.per, done: w.done, target: w.target, extra: w.extra, planLater: w.planLater,
          awayDays: w.awayDays, pausedDays: w.pausedDays, before: w.before, counted: w.counted };
      }).filter(function (h) { return !h.before; }),
      focus: focusWeek_(monday, today, sessions, rot, projectsById),
      todos: todosWeek_(todos, monday, today)
    };
  }

  return {
    title: 'Insights',
    tables: [],
    api: {
      /**
       * Everything the Insights tab shows, worked out on the server in one call (opened with the tab, not at start-up).
       * Returns { today, weeks: { this, last }, habits, projects: { 4: { from, rows }, 12: { ... } } }.
       */
      summary: function (a, ctx) {
        var today = insightsToday_(), monday = insightsMonday_(today);
        var rot = rotation_(ctx);
        var projects = maybe_(ctx, 'projects', 'list', {}) || [];
        var projectsById = {};
        projects.forEach(function (p) { projectsById[p.id] = p; });
        var sessions = sessionRows_(ctx);
        var habits = habitsSummary_(ctx, today, rot);
        var lastMonday = insightsAddDays_(monday, -7);
        var todos = todoSource_(ctx, lastMonday, insightsAddDays_(monday, 6));
        return {
          today: today,
          habitsKnown: habits.length > 0,
          weeks: {
            this: weekSummary_(monday, today, habits, sessions, rot, projectsById, todos),
            last: weekSummary_(lastMonday, today, habits, sessions, rot, projectsById, todos)
          },
          habits: habits,
          projects: projectsSummary_(ctx, today, sessions, projects)
        };
      }
    }
  };
}
