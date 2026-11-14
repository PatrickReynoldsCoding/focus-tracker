/**
 * Optional starter data. Run seedStarterData() once from the Apps Script editor to fill an empty tracker
 * with the projects, tasks, notes and log lines from the design preview. It refuses to run if any project exists.
 * Resource links are not seeded: add the Drive files you want from the Resources panels.
 */
function seedStarterData() {
  setMode_(MODES[0].id);
  ensureSchema_();
  var mods = loadModules_();
  var ctx = makeCtx_(mods);
  Object.keys(mods).forEach(function (id) { (mods[id].tables || []).forEach(function (t) { t.ensure(); }); });
  assert_(ctx.call('projects', 'list', {}).length === 0, 'The tracker already has projects, so nothing was seeded.');

  var starter = [
    { name: 'Android MIDI instrument', category: 'coding', next: 'Send touch pad events as MIDI note-on messages',
      notes: 'Idea: per-finger pitch bend (MPE).\nLook at Faust instrument repos for starting points.\nDAW companion app later, not now.',
      tasks: [['Create Android project', 2], ['Draw touch pad grid', 2], ['Send MIDI note-on from touch', 1], ['Scale lock option', 0], ['Message Faust community', 0]],
      log: 'Touch pad now draws on screen' },
    { name: 'Focus Tracker', category: 'coding', next: 'Use it for a week and note what is missing',
      notes: 'Next: Excalidraw whiteboard saved to Drive per project.',
      tasks: [['HTML preview', 2], ['Apps Script version', 1], ['Excalidraw whiteboard', 0]],
      log: 'Agreed the views and features' },
    { name: 'Shopping tracker', category: 'coding', next: 'Make Insights panels clickable',
      notes: 'Code lives in the shopping-tracker repo on GitHub.',
      tasks: [['Clickable Insights panels', 0], ['Item breakdown view', 0]],
      log: 'Dashboard totals now match' },
    { name: 'CV and portfolio', category: 'job', next: 'Rewrite the summary paragraph',
      notes: 'Aim: three applications a week.',
      tasks: [['Rewrite summary', 1], ['Pick five target companies', 0], ['Refresh LinkedIn headline', 0]],
      log: 'Drafted two summary options' },
    { name: 'Applications this week', category: 'job', next: 'Shortlist two roles to apply for',
      notes: '',
      tasks: [['Shortlist roles', 0], ['Tailor cover note', 0]],
      log: 'Found four possible roles' },
    { name: 'Bathroom extractor fan', category: 'house', next: 'Measure the duct opening',
      notes: 'Replacement needs to be 100mm.',
      tasks: [['Measure duct', 0], ['Order fan', 0], ['Fit fan', 0]],
      log: 'Took the old fan cover off' },
    { name: 'Garden fence repair', category: 'house', next: 'Get quotes for new panels', status: 'paused',
      notes: '',
      tasks: [['Get three quotes', 0]],
      log: '' }
  ];

  starter.forEach(function (p) {
    var project = ctx.call('projects', 'create', { name: p.name, category: p.category, next_action: p.next });
    if (p.status) ctx.call('projects', 'update', { id: project.id, status: p.status });
    var cols = ctx.call('kanban', 'initProject', { projectId: project.id }) && mods.kanban.snapshot(ctx).columns
      .filter(function (c) { return c.project_id === project.id; });
    p.tasks.forEach(function (t) {
      ctx.call('kanban', 'addTask', { projectId: project.id, title: t[0], columnId: cols[t[1]].id });
    });
    if (p.notes) ctx.call('notes', 'save', { projectId: project.id, text: p.notes });
    if (p.log) ctx.call('log', 'add', { projectId: project.id, where: p.log, next: p.next });
  });
  // What the daily minimum became (docs/habits-ideas.md §5), and a to-do for today.
  ctx.optional('habits', 'create', { name: 'Job search', intention: 'Daily minimum', sessions: 1, per: 'day', size: '10 min', category: 'job' });
  ctx.optional('todos', 'add', { title: 'Grocery shopping', day: todayIso_() });
  Logger.log('Seeded ' + starter.length + ' projects.');
}
