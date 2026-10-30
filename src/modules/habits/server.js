/**
 * Habits module: things that repeat, n sessions a day or a week (docs/habits-ideas.md). Today shows a row of dots per
 * habit; a tap adds a session, taps beyond the dots count as extra.
 *
 * Habits tab: one row per habit, readable without the app. `sessions`, `per` and `size` are the level now; `goal` is
 * where the ramp-up stops, written the same way ("5 a week, 30 min"). `step_up_every` ("2 weeks") is the pace of the
 * "Want to go further?" prompt, blank for none; `prompts` is on, off or at goal; `next_prompt` the day it is next due.
 *
 * Habit log tab (app only): one row per habit per day for `done` and `plan` (count updated on each tap, not one row per
 * tap), plus `level` rows (value "4 a week, 30 min", day = the day it applies from), `prompt` rows (value yes, not now,
 * at goal, stop asking, keep asking) and `pause` / `resume` rows. Insights compare each week with the level then.
 *
 * A tap sends +1 or -1 for a day, never a total, so taps made on two devices offline add up when they reach the server
 * (the offline rule in docs/habits-ideas.md §3; nothing for core/conflicts.js to settle).
 */

function habitsModule() {
  var T = new Table('Habits', ['name', 'intention', 'sessions', 'per', 'size', 'small_version', 'goal', 'step_up_every', 'prompts', 'category',
    'description', 'status', 'problem', 'id', 'next_prompt', 'started', 'order', 'updated_at'], ['sessions', 'order']);
  var LOG = new Table('Habit log', ['id', 'habit_id', 'habit', 'day', 'kind', 'count', 'value', 'updated_at'], ['count']);
  var PERS = ['day', 'week'];
  var STATUSES = ['active', 'paused', 'ended'];
  var ANSWERS = ['yes', 'not now', 'at goal', 'stop asking', 'keep asking'];
  var MAX_SESSIONS = { day: 10, week: 21 };
  var TAP_DAYS_BACK = 7;     // a tap that waited offline may be for a day this long ago
  var MET_SHARE = 0.8;       // a level counts as met at 80 % of its sessions, so one missed session does not block a prompt
  var NOT_NOW_LIMIT = 3;     // after this many "Not now" in a row, ask once whether to stop asking

  // ---------- reading the words people write ----------

  /** "30 min" -> { n: 30, unit: 'min' }; null when it does not start with a number. */
  function parseSize_(text) {
    var m = /^\s*(\d+(?:\.\d+)?)\s*(.*?)\s*$/.exec(String(text || ''));
    return m ? { n: Number(m[1]), unit: m[2] } : null;
  }

  function sizeText_(n, unit) { return n + (unit ? ' ' + unit : ''); }

  /** "2 weeks" -> 14, "10 days" -> 10, "week" -> 7; 0 for blank or unreadable (no prompts). */
  function intervalDays_(text) {
    var m = /^\s*(\d+)?\s*(day|days|week|weeks)\s*$/i.exec(String(text || ''));
    if (!m) return 0;
    var n = m[1] ? Number(m[1]) : 1;
    return /^week/i.test(m[2]) ? n * 7 : n;
  }

  function intervalWords_(days) {
    return days % 7 === 0 ? (days === 7 ? 'a week' : days / 7 + ' weeks') : days + ' days';
  }

  function levelText_(sessions, per, size) {
    return sessions + ' a ' + per + (size ? ', ' + size : '');
  }

  /** "4 a week, 30 min" -> { sessions: 4, per: 'week', size: '30 min' }; null when unreadable. */
  function parseLevel_(text) {
    var m = /^\s*(\d+)\s*(?:x|×|times?)?\s*(?:a|per|\/)\s*(day|week)\s*(?:,\s*(.*?))?\s*$/i.exec(String(text || ''));
    return m ? { sessions: Number(m[1]), per: m[2].toLowerCase(), size: m[3] || '' } : null;
  }

  // ---------- checking what the browser sends ----------

  function name_(value) {
    var name = clean_(value, 80);
    assert_(name, 'A habit needs a name.');
    return name;
  }

  function sessions_(value, per) {
    var n = Number(value);
    assert_(Math.floor(n) === n && n >= 1 && n <= MAX_SESSIONS[per], 'Sessions must be a whole number from 1 to ' + MAX_SESSIONS[per] + ' a ' + per + '.');
    return n;
  }

  function per_(value) {
    assert_(PERS.indexOf(value) !== -1, 'A habit is per day or per week.');
    return value;
  }

  function category_(value, ctx) {
    if (!value) return '';
    assert_(ctx.call('categories', 'ids').indexOf(value) !== -1, 'Unknown category: ' + value);
    return value;
  }

  function interval_(value) {
    var text = clean_(value, 20);
    assert_(!text || intervalDays_(text), 'Ask every: say for example "2 weeks", or leave it empty for no prompts.');
    return text;
  }

  function habit_(id) {
    var h = T.get(id);
    assert_(h, 'Habit not found.');
    return h;
  }

  function sorted_() {
    return T.all().sort(function (a, b) { return a.order - b.order; });
  }

  // ---------- the log ----------

  function logFor_(habitId, kind) {
    return LOG.all().filter(function (r) { return r.habit_id === habitId && (!kind || r.kind === kind); })
      .sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
  }

  function addLog_(h, day, kind, count, value) {
    return LOG.insert({ habit_id: h.id, habit: h.name, day: day, kind: kind, count: count || 0, value: value || '' });
  }

  /** The level that applies on a day: the newest level row from that day or before; the habit row if there is none. */
  function levelOn_(h, levels, day) {
    var hit = null;
    levels.forEach(function (r) { if (r.day <= day) hit = r; });
    var parsed = hit && parseLevel_(hit.value);
    return parsed ? { sessions: parsed.sessions, size: parsed.size } : { sessions: Number(h.sessions) || 1, size: h.size };
  }

  /** A new level from `from` on. A change already waiting for a later day is replaced; a level the habit had before is kept. */
  function setLevel_(h, levels, from, text) {
    var today = todayIso_();
    if (!levels.some(function (r) { return r.day <= today; }) && from > today) addLog_(h, h.started && h.started <= today ? h.started.slice(0, 10) : today, 'level', 0, levelText_(h.sessions, h.per, h.size));
    LOG.removeWhere(function (r) { return r.habit_id === h.id && r.kind === 'level' && r.day >= from; });
    addLog_(h, from, 'level', 0, text);
  }

  /** Is the habit paused on this day? From its pause and resume rows (and its status, for days with no row). */
  function pausedOn_(pauses, day) {
    var state = null;
    pauses.forEach(function (r) { if (r.day <= day) state = r.kind; });
    return state === 'pause';
  }

  // ---------- "Want to go further?" (docs/habits-ideas.md §4) ----------

  /** Sessions a week the level asks for: n a week, or n a day on every day that is not Away in the usual rotation. */
  function weekTarget_(h, level, awayDays) {
    return h.per === 'week' ? level.sessions : level.sessions * (7 - awayDays.length);
  }

  /**
   * Earned when the level was met in the full weeks since it last changed (up to the pace, at least one), counting 80 %
   * of the sessions as met. Paused weeks are left out. Nothing is said when it is not earned: the prompt just waits.
   */
  function earned_(h, today, awayDays) {
    var levels = logFor_(h.id, 'level'), done = logFor_(h.id, 'done');
    var pauses = LOG.all().filter(function (r) { return r.habit_id === h.id && (r.kind === 'pause' || r.kind === 'resume'); })
      .sort(function (a, b) { return a.day < b.day ? -1 : 1; });
    var since = levels.filter(function (r) { return r.day <= today; }).map(function (r) { return r.day; }).pop() || String(h.started || '').slice(0, 10) || today;
    var weeks = Math.max(1, Math.round(intervalDays_(h.step_up_every) / 7));
    var monday = isoMonday_(today), target = 0, got = 0, counted = 0;
    for (var k = 1; k <= weeks; k++) {
      var start = isoAddDays_(monday, -7 * k);
      if (start < since) break;
      var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return isoAddDays_(start, i); });
      if (days.some(function (d) { return pausedOn_(pauses, d); })) continue;
      var want = weekTarget_(h, levelOn_(h, levels, start), awayDays);
      var had = done.filter(function (r) { return r.day >= days[0] && r.day <= days[6]; }).reduce(function (s, r) { return s + r.count; }, 0);
      target += want; got += Math.min(had, want); counted++;
    }
    return counted > 0 && target > 0 && got >= MET_SHARE * target ? counted : 0;
  }

  /** The one step offered: one more session, or a longer session, never past the goal. [] when there is nowhere to go. */
  function offers_(h) {
    var cur = { sessions: Number(h.sessions) || 1, size: h.size };
    var goal = parseLevel_(h.goal);
    if (goal && goal.per !== h.per) goal = null;
    var out = [];
    var maxSessions = goal ? goal.sessions : MAX_SESSIONS[h.per];
    if (cur.sessions < maxSessions) out.push({ sessions: cur.sessions + 1, size: cur.size, change: '+1 session', steps: maxSessions - cur.sessions });
    var sz = parseSize_(cur.size), goalSize = goal && parseSize_(goal.size);
    if (sz && !(goal && !goal.size)) {
      var minutes = /^min/i.test(sz.unit);
      var step = minutes ? (sz.n < 30 ? 5 : 10) : Math.max(1, Math.round(sz.n * 0.2));
      var next = sz.n + step;
      var capped = goalSize && goalSize.unit === sz.unit;
      if (capped) next = Math.min(next, goalSize.n);
      if (next > sz.n) out.push({ sessions: cur.sessions, size: sizeText_(next, sz.unit), change: '+' + (next - sz.n) + (sz.unit ? ' ' + sz.unit : ''), steps: capped ? Math.ceil((goalSize.n - sz.n) / step) : 0 });
    }
    return out;
  }

  /** Trailing "not now" answers, since the last other answer. */
  function notNowsInARow_(h) {
    var n = 0;
    logFor_(h.id, 'prompt').forEach(function (r) { n = r.value === 'not now' ? n + 1 : 0; });
    return n;
  }

  /** The prompt to show on Today, or null. One at a time and at most one a day. */
  function prompt_(habits, today, awayDays) {
    var active = habits.filter(function (h) { return h.status === 'active' && h.prompts === 'on' && intervalDays_(h.step_up_every); });
    var stop = active.filter(function (h) { return notNowsInARow_(h) >= NOT_NOW_LIMIT; })[0];
    if (stop) return { habitId: stop.id, kind: 'stop', level: levelText_(stop.sessions, stop.per, stop.size) };
    if (LOG.all().some(function (r) { return r.kind === 'prompt' && r.day === today; })) return null;
    for (var i = 0; i < active.length; i++) {
      var h = active[i];
      if (!h.next_prompt || h.next_prompt > today) continue;
      var options = offers_(h);
      if (!options.length) continue;
      var weeks = earned_(h, today, awayDays);
      if (!weeks) continue;
      var selected = options.length > 1 && options[1].steps > options[0].steps ? 1 : 0;
      return {
        habitId: h.id, kind: 'step', weeks: weeks, level: levelText_(h.sessions, h.per, h.size), goal: h.goal || '', selected: selected,
        from: h.per === 'week' ? 'Monday' : 'tomorrow', every: intervalWords_(intervalDays_(h.step_up_every)),
        options: options.map(function (o) { return { sessions: o.sessions, size: o.size, label: levelText_(o.sessions, h.per, ''), size_label: o.size, change: o.change }; })
      };
    }
    return null;
  }

  function awayDays_(ctx) {
    return ctx.optional('today', 'awayDays') || [];
  }

  // ---------- the slice ----------

  function snapshot_(ctx) {
    var today = todayIso_(), monday = isoMonday_(today), from = isoAddDays_(monday, -7), until = isoAddDays_(monday, 13);
    var habits = sorted_().filter(function (h) { return h.status !== 'ended'; });
    var log = LOG.all();
    var levelsBy = {};
    log.forEach(function (r) { if (r.kind === 'level') (levelsBy[r.habit_id] = levelsBy[r.habit_id] || []).push(r); });
    Object.keys(levelsBy).forEach(function (id) { levelsBy[id].sort(function (a, b) { return a.day < b.day ? -1 : 1; }); });
    return {
      day: today, monday: monday,
      habits: habits.map(function (h) {
        var levels = levelsBy[h.id] || [];
        var out = Object.assign({}, h, { level: levelOn_(h, levels, h.per === 'week' ? monday : today) });
        var waiting = levels.filter(function (r) { return r.day > today; })[0];
        if (waiting) out.nextLevel = { value: waiting.value, from: waiting.day };
        return out;
      }),
      log: log.filter(function (r) { return (r.kind === 'done' || r.kind === 'plan') && r.day >= from && r.day <= until; })
        .map(function (r) { return { id: r.id, habit_id: r.habit_id, day: r.day, kind: r.kind, count: r.count }; }),
      prompt: prompt_(habits, today, awayDays_(ctx))
    };
  }

  /** Add (delta > 0) or take away sessions, or set the planned count, for a habit on a day. One row per habit, day and kind. */
  function changeCount_(h, day, kind, fn) {
    return withLock_(function () {
      var row = LOG.all().filter(function (r) { return r.habit_id === h.id && r.day === day && r.kind === kind; })[0];
      var count = Math.max(0, fn(row ? row.count : 0));
      if (row && count === 0) LOG.remove(row.id);
      else if (row && count !== row.count) LOG.update(row.id, { count: count });
      else if (!row && count > 0) addLog_(h, day, kind, count);
      return count;
    });
  }

  function fields_(a, h, ctx) {
    var per = a.per !== undefined ? per_(a.per) : h.per;
    var patch = {};
    if (a.name !== undefined) patch.name = name_(a.name);
    if (a.per !== undefined) patch.per = per;
    if (a.sessions !== undefined || a.per !== undefined) patch.sessions = sessions_(a.sessions !== undefined ? a.sessions : h.sessions, per);
    ['intention', 'description'].forEach(function (k) { if (a[k] !== undefined) patch[k] = clean_(a[k], 300); });
    ['size', 'small_version', 'goal'].forEach(function (k) { if (a[k] !== undefined) patch[k] = clean_(a[k], 40); });
    if (a.category !== undefined) patch.category = category_(a.category, ctx);
    if (a.step_up_every !== undefined) patch.step_up_every = interval_(a.step_up_every);
    return patch;
  }

  return {
    title: 'Habits',
    tables: [T, LOG],
    snapshot: snapshot_,
    api: {
      /** a: name, intention, description, sessions, per, size, small_version, goal, step_up_every, category; a.id from the browser. */
      create: function (a, ctx) {
        var today = todayIso_();
        var patch = fields_(Object.assign({ per: 'week', sessions: 1 }, a), { per: 'week', sessions: 1 }, ctx);
        assert_(patch.name, 'A habit needs a name.');
        var interval = intervalDays_(patch.step_up_every);
        var row = T.insert(Object.assign({
          id: clientId_(a.id), intention: '', description: '', size: '', small_version: '', goal: '', step_up_every: '', category: '',
          prompts: interval ? 'on' : 'off', next_prompt: interval ? isoAddDays_(today, interval) : '', status: 'active', started: today,
          order: T.all().reduce(function (m, h) { return Math.max(m, h.order); }, 0) + 1
        }, patch));
        addLog_(row, today, 'level', 0, levelText_(row.sessions, row.per, row.size));
        ctx.refresh('habits');
        return row;
      },

      /** Change any field. A new level applies from today; a new pace restarts the wait for the next prompt. */
      update: function (a, ctx) {
        var h = habit_(a.id), today = todayIso_();
        var patch = fields_(a, h, ctx);
        var levelChanged = ['sessions', 'per', 'size'].some(function (k) { return patch[k] !== undefined && String(patch[k]) !== String(h[k]); });
        // A pace sent with prompts off or at goal turns them on again, also when it is the same pace as before.
        if (patch.step_up_every !== undefined && (patch.step_up_every !== h.step_up_every || h.prompts !== 'on')) {
          var interval = intervalDays_(patch.step_up_every);
          patch.prompts = interval ? 'on' : 'off';
          patch.next_prompt = interval ? isoAddDays_(today, interval) : '';
        }
        if (a.prompts !== undefined) { assert_(['on', 'off', 'at goal'].indexOf(a.prompts) !== -1, 'Prompts are on, off or at goal.'); patch.prompts = a.prompts; }
        var row = T.update(h.id, patch);
        if (levelChanged) setLevel_(row, logFor_(h.id, 'level'), today, levelText_(row.sessions, row.per, row.size));
        ctx.refresh('habits');
        return row;
      },

      /** Pause (leaves Today, not counted for those weeks), resume, or end (kept in the sheet, gone from the app). */
      setStatus: function (a, ctx) {
        var h = habit_(a.id);
        assert_(STATUSES.indexOf(a.status) !== -1, 'Unknown status: ' + a.status);
        if (a.status === h.status) return h;
        var row = T.update(h.id, { status: a.status });
        var today = todayIso_();
        if (a.status === 'paused') addLog_(row, today, 'pause');
        if (h.status === 'paused' && a.status === 'active') addLog_(row, today, 'resume');
        ctx.refresh('habits');
        return row;
      },

      /** Swap with the neighbour: a.d is -1 (earlier) or 1 (later). */
      move: function (a, ctx) {
        var list = sorted_().filter(function (h) { return h.status !== 'ended'; });
        var i = list.map(function (h) { return h.id; }).indexOf(a.id), j = i + Number(a.d);
        assert_(i !== -1, 'Habit not found.');
        if (j < 0 || j >= list.length) return false;
        var first = list[i].order, second = list[j].order;
        T.update(list[i].id, { order: second === first ? first + Number(a.d) : second });
        T.update(list[j].id, { order: first });
        ctx.refresh('habits');
        return true;
      },

      /** Delete a habit and its history (Undo puts both back). Ending it keeps the history. */
      remove: function (a, ctx) {
        T.remove(a.id);
        LOG.removeWhere(function (r) { return r.habit_id === a.id; });
        ctx.refresh('habits');
        return true;
      },

      /**
       * For Insights (ctx.optional): every habit (ended too), the done and plan rows from a.from to a.to (ISO dates,
       * inclusive), and every level, prompt, pause and resume row up to a.to, older ones too. A level row's day is the
       * first day it applies; its value reads "4 a week, 30 min".
       */
      history: function (a) {
        var from = String(a.from || ''), to = String(a.to || '9999-12-31');
        return {
          habits: sorted_().map(function (h) {
            return { id: h.id, name: h.name, sessions: h.sessions, per: h.per, size: h.size, status: h.status, started: String(h.started || '').slice(0, 10),
              prompts: h.prompts, order: h.order, intention: h.intention, goal: h.goal, category: h.category };
          }),
          log: LOG.all().filter(function (r) {
            if (r.day > to) return false;
            return r.kind === 'done' || r.kind === 'plan' ? r.day >= from : true;
          }).sort(function (x, y) { return x.day < y.day ? -1 : x.day > y.day ? 1 : 0; })
            .map(function (r) { return { habit_id: r.habit_id, day: r.day, kind: r.kind, count: r.count, value: r.value }; })
        };
      },

      /** A tap: a.delta +1 adds a session on a.day (default today), -1 takes one away. Returns that day's count. */
      tap: function (a, ctx) {
        var h = habit_(a.id), today = todayIso_();
        var day = a.day || today, delta = Number(a.delta === undefined ? 1 : a.delta);
        assert_(delta === 1 || delta === -1, 'A tap adds or takes away one session.');
        assert_(isIsoDay_(day) && day <= today && day >= isoAddDays_(today, -TAP_DAYS_BACK), 'Sessions can be added for today or the last ' + TAP_DAYS_BACK + ' days.');
        var count = changeCount_(h, day, 'done', function (n) { return n + delta; });
        ctx.refresh('habits');
        return count;
      },

      /** Plan my week: a.count sessions planned for a.day, from today to the end of next week (never further). */
      plan: function (a, ctx) {
        var h = habit_(a.id), today = todayIso_();
        var last = isoAddDays_(isoMonday_(today), 13);
        assert_(isIsoDay_(a.day) && a.day >= today && a.day <= last, 'You can plan from today to the end of next week.');
        var count = Number(a.count);
        assert_(Math.floor(count) === count && count >= 0 && count <= MAX_SESSIONS.day, 'Plan 0 to ' + MAX_SESSIONS.day + ' sessions a day.');
        changeCount_(h, a.day, 'plan', function () { return count; });
        ctx.refresh('habits');
        return count;
      },

      /**
       * Plan my week, "Copy last week's habit days": each active habit is planned on the days of a.week (this week's or
       * next week's Monday) from today on as it went the week before: the sessions done that day, or planned if it is
       * still to come.
       */
      copyWeek: function (a, ctx) {
        var today = todayIso_(), monday = isoMonday_(today);
        assert_(a.week === monday || a.week === isoAddDays_(monday, 7), 'You can plan this week or next week only.');
        var log = LOG.all();
        function count(habitId, day, kind) {
          var r = log.filter(function (x) { return x.habit_id === habitId && x.day === day && x.kind === kind; })[0];
          return r ? r.count : 0;
        }
        sorted_().filter(function (h) { return h.status === 'active'; }).forEach(function (h) {
          for (var i = 0; i < 7; i++) {
            var day = isoAddDays_(a.week, i), before = isoAddDays_(day, -7);
            if (day < today) continue;
            var want = Math.min(MAX_SESSIONS.day, before < today ? count(h.id, before, 'done') : count(h.id, before, 'plan'));
            changeCount_(h, day, 'plan', function () { return want; });
          }
        });
        ctx.refresh('habits');
        return true;
      },

      /**
       * The answer to "Want to go further?": a.answer yes (a.option: which offer), not now, at goal; and, after three
       * "Not now" in a row, stop asking or keep asking. Returns { text } for the message.
       */
      answer: function (a, ctx) {
        var h = habit_(a.id), today = todayIso_();
        assert_(ANSWERS.indexOf(a.answer) !== -1, 'Unknown answer: ' + a.answer);
        var interval = intervalDays_(h.step_up_every) || 14;
        var next = isoAddDays_(today, interval), text;
        if (a.answer === 'yes') {
          var options = offers_(h), o = options[Number(a.option) || 0];
          assert_(o, 'There is no step up to take: ' + h.name + ' is at its goal.');
          var from = h.per === 'week' ? isoAddDays_(isoMonday_(today), 7) : isoAddDays_(today, 1);
          var level = levelText_(o.sessions, h.per, o.size);
          setLevel_(h, logFor_(h.id, 'level'), from, level);
          T.update(h.id, { sessions: o.sessions, size: o.size, next_prompt: next });
          text = h.name + ' is ' + levelText_(o.sessions, h.per, o.size) + ' from ' + (h.per === 'week' ? 'Monday' : 'tomorrow') + '. Next check in ' + intervalWords_(interval) + '.';
        } else if (a.answer === 'not now') {
          T.update(h.id, { next_prompt: next });
          text = 'No change. We\'ll ask again in ' + intervalWords_(interval) + '.';
        } else if (a.answer === 'at goal') {
          var now = levelText_(h.sessions, h.per, h.size);
          T.update(h.id, { prompts: 'at goal', goal: now });
          text = h.name + ' is at your goal: ' + now + '. No more prompts.';
        } else if (a.answer === 'stop asking') {
          T.update(h.id, { prompts: 'off' });
          text = 'No more prompts for ' + h.name + '. Turn them back on in its settings.';
        } else {
          text = 'We\'ll keep asking every ' + intervalWords_(interval) + '.';
        }
        addLog_(h, today, 'prompt', 0, a.answer);
        ctx.refresh('habits');
        return { text: text };
      }
    }
  };
}
