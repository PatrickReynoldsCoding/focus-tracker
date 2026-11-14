/**
 * One-time imports into a mode, for example from Todoist. The data is not in this repository: it is a function
 * pendingImportData_() in a git-ignored file (src/private/), pushed to Apps Script only for as long as it is needed.
 * When the app first opens that mode, the data is written once and a script property records that it is done.
 *
 * Data: { id, mode,
 *   projects: [{ name, category, next_action, columns: [names], cards: [{ column, title, color, note }] }],
 *   lists:    [{ name, showToday, groups: [names], items: [{ group, title, color, note }] }] }
 * Notes are plain text; links and line breaks are kept.
 */

function runPendingImport_(ctx) {
  if (typeof pendingImportData_ !== 'function') return null;
  var data = pendingImportData_();
  if (data.mode !== modeId_()) return null;
  var doneKey = 'IMPORT_DONE.' + data.id;
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(doneKey)) return null;
  return withLock_(function () {
    if (props.getProperty(doneKey)) return null;
    var counts = importData_(ctx, data);
    props.setProperty(doneKey, nowIso_());
    return counts;
  });
}

function importCards_(card, columnKey) {
  return { column: card[columnKey], title: card.title, color: card.color, noteHtml: plainToRichText_(card.note || '') };
}

function importData_(ctx, data) {
  var counts = { projects: 0, lists: 0, cards: 0 };
  (data.projects || []).forEach(function (p) {
    var project = ctx.call('projects', 'create', { name: p.name, category: p.category, next_action: p.next_action, columns: p.columns });
    counts.cards += ctx.call('kanban', 'importCards', { projectId: project.id, cards: (p.cards || []).map(function (c) { return importCards_(c, 'column'); }) });
    counts.projects++;
  });
  (data.lists || []).forEach(function (l) {
    var list = ctx.call('lists', 'create', { name: l.name, groups: l.groups, showToday: l.showToday });
    counts.cards += ctx.call('kanban', 'importCards', { listId: list.id, cards: (l.items || []).map(function (c) { return importCards_(c, 'group'); }) });
    counts.lists++;
  });
  return counts;
}
