/**
 * The guide for AI assistants (docs/SPEC-2026-11.md "Assistant integration"), made from the code so it never goes stale:
 * the tabs and their order come from TAB_STYLE (core/schema.js), each tab's columns from its module's Table, the allowed
 * values from the same constants the app checks rows with. GUIDE_TABS_ below adds a one-line meaning per column.
 *
 * Three outputs, one generator:
 *   guideMarkdown_()      the full guide, written as the Google Doc guideDocName_() in the root "Focus Tracker" folder
 *                         (ensureGuideDoc_) and, by scripts/write-guide.js, to docs/assistant-guide.md;
 *   guideShortLines_()    the short version, the Start here tab of every spreadsheet (writeStartHere_);
 *   assistantNote_()      the paragraph Settings → AI assistant offers to paste into an assistant's instructions.
 *
 * A new people tab needs a TAB_STYLE line and an entry here; tests/server.test.js fails while a column has no meaning.
 * The guide holds no data from the sheet (no ids, no addresses, no categories): only mode names and the Doc's address.
 */

/** "Focus Tracker – guide for AI assistants". */
function guideDocName_() {
  return APP_NAME + ' – guide for AI assistants';
}

var GUIDE_DOC_ID_KEY_ = 'GUIDE_DOC_ID';
var GUIDE_DOC_HASH_KEY_ = 'GUIDE_DOC_HASH';
var GUIDE_DOC_MIME_ = 'application/vnd.google-apps.document';

/**
 * What each people tab is for and what each of its people columns means: [who, meaning]. who is 'needed' (fill it),
 * 'optional' (fill it if you know it) or 'app' (the app fills it: leave it). Columns from `id` on are always the app's.
 * Built in a function: the constants it uses are defined in other files.
 */
function guideTabs_() {
  var statuses = PROJECT_STATUSES_.join(', ');
  return {
    'Projects': {
      what: 'One row per project or goal.',
      columns: {
        name: ['needed', 'The project\'s name. No two projects share a name.'],
        category: ['needed', 'A category label from the Categories tab, for example "Coding". Never make up a category: ask.'],
        status: ['optional', 'One of: ' + statuses + '. Empty means active.'],
        next_action: ['optional', 'The next small, concrete step, one sentence. Empty means "Decide the first small step".'],
        locked_until: ['optional', 'A date (2026-11-03): the project is left out of the daily pick until then. Usually empty.'],
        last_touched: ['app', 'When work last happened. Filled by the app.'],
        notes: ['optional', 'The link to the project\'s notes Doc, filled by the app. See "Notes" for how to add notes.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app; fix the row and it clears.']
      }
    },
    'Tasks': {
      what: 'Cards on a project\'s board, and the items of a list.',
      columns: {
        title: ['needed', 'What to do, short.'],
        column: ['optional', 'The board column by name, for example "To do", "Doing" or "Done". Empty means the first column. A new project\'s board starts with ' + BOARD_COLUMNS_.join(', ') + '.'],
        project: ['needed', 'The project\'s name, exactly as in Projects. Fill project or list, not both.'],
        list: ['optional', 'The list\'s name, exactly as in Lists, for an item on a list instead of a project card. Then column is the list\'s group.'],
        note: ['optional', 'Details, plain text. Line breaks and https:// addresses are kept.'],
        color: ['optional', 'A colour number from 1 to 8, or empty.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      },
      app: {
        column_id: 'To move a card to another column, write the column\'s name in column and empty column_id. The app finds the new column.',
        note_html: 'The formatted copy of note, made by the app. To change a card\'s note, write note and empty note_html.'
      }
    },
    'Lists': {
      what: 'Lists that are not projects, such as "Read and watch". Their items are rows in Tasks with list filled in.',
      columns: {
        name: ['needed', 'The list\'s name. No two lists share a name.'],
        project: ['optional', 'A project\'s name: the list then also shows on that project\'s page.'],
        show_today: ['optional', 'yes to show the list on Today, or empty.'],
        display: ['optional', 'Empty shows the whole list; one shows one item at a time.'],
        seconds: ['optional', 'With display one: how many seconds each item shows.'],
        color: ['optional', 'A colour number from 1 to 8, or empty.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      }
    },
    'Resources': {
      what: 'Links and other things kept with a project, or shared by a whole category.',
      columns: {
        title: ['needed', 'A short name, for example "garden-irrigation repo".'],
        type: ['needed', 'One of: ' + RESOURCE_TYPES_.join(', ') + '. link: a web address; drive: a Google Drive file or folder; phone, email: a number or address; text: a short note.'],
        value: ['needed', 'The address (starting with https:// for link and drive), the phone number, the email address or the text.'],
        group: ['optional', 'Free text that groups resources on the project\'s page. Use these where they fit: ' + guideGroupNames_() + '.'],
        project: ['optional', 'The project\'s name. Empty means shared by the whole category.'],
        category: ['optional', 'A category label. Needed only when project is empty; otherwise the project\'s category is used.'],
        note: ['optional', 'One short line about it. Never the contents of the file.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      }
    },
    'Habits': {
      what: 'Things done again and again, n sessions a day or a week.',
      columns: {
        name: ['needed', 'The habit, for example "Cardio".'],
        intention: ['optional', 'Free text: how serious it is, for example "5 cardio sessions a week" or "just trying it out".'],
        sessions: ['needed', 'How many sessions, a whole number, 1 or more. Start low.'],
        per: ['needed', 'One of: ' + HABIT_PERS_.join(', ') + '.'],
        size: ['optional', 'How big one session is, for example "10 min".'],
        small_version: ['optional', 'The smallest version that still counts on a bad day.'],
        goal: ['optional', 'Where building up stops, written like "5 a week, 30 min".'],
        step_up_every: ['optional', 'How often the app asks to step up, for example "2 weeks". Empty for never.'],
        prompts: ['optional', 'on, off or at goal. Empty means off.'],
        category: ['optional', 'A category label, if the habit belongs to one.'],
        description: ['optional', 'Why, in a sentence.'],
        status: ['optional', 'One of: ' + HABIT_STATUSES_.join(', ') + '. Empty means active.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      }
    },
    'To-dos': {
      what: 'One-off small tasks, such as grocery shopping or a job interview, for a day or anytime.',
      columns: {
        title: ['needed', 'What to do.'],
        day: ['optional', 'The date it is for (2026-11-03), today or later. Empty means anytime.'],
        done: ['app', 'The date it was ticked off. Filled by the app.'],
        project: ['optional', 'A project\'s name, if it belongs to one.'],
        note: ['optional', 'Details, plain text.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      }
    },
    'Whiteboards': {
      what: 'Drawings. Only the app can make one (it makes the drawing file), so never add rows here.',
      columns: {
        name: ['app', 'The whiteboard\'s name.'],
        project: ['app', 'The project it belongs to, or empty.'],
        show_today: ['optional', 'yes to show it on Today, or empty.'],
        file: ['app', 'The drawing file in Drive.'],
        updated: ['app', 'When it was last saved.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      }
    },
    'Links': {
      what: 'Projects that depend on each other. Read a row as "<from> <type> <to>".',
      columns: {
        from: ['needed', 'A project\'s name.'],
        type: ['needed', 'blocks: from must be done before to can start (to is left out of the daily pick until then); relates: they belong together.'],
        to: ['needed', 'Another project\'s name.'],
        note: ['optional', 'Why, in a few words.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      }
    },
    'Criteria': {
      what: 'Acceptance criteria: what "done" means for a project.',
      columns: {
        text: ['needed', 'One thing that is true when the project is done.'],
        done: ['optional', 'yes when it is met, or empty.'],
        project: ['needed', 'The project\'s name.'],
        problem: ['app', 'Why the app cannot use this row. Written by the app.']
      }
    },
    'Log': {
      what: 'One row per working session. Mostly written by the app when a session ends.',
      columns: {
        date: ['optional', 'When the session was. Empty means now.'],
        project: ['needed', 'The project\'s name.'],
        where_stopped: ['needed', 'Where the work stopped, one sentence.'],
        next_action: ['optional', 'The next step that was set.'],
        minutes: ['optional', 'Minutes worked, a whole number.']
      }
    },
    'Categories': {
      what: 'The categories projects are grouped by. Change them in the app, not here.',
      columns: {
        label: ['app', 'The category\'s name. Use these labels in the category columns of other tabs.'],
        color: ['app', 'A colour number from 1 to 8.']
      }
    }
  };
}

// Resource groups the guide suggests, so assistants group the same way. [group, what goes in it].
var GUIDE_GROUPS_ = [
  ['Code', 'repositories (GitHub, GitLab), issue trackers, builds'],
  ['Docs', 'design documents, specs, manuals'],
  ['Design', 'mock-ups, drawings, colour schemes'],
  ['Suppliers', 'shops and trades: website, phone, email'],
  ['Contacts', 'people to call or write to'],
  ['Reference', 'articles, videos and other reading']
];

function guideGroupNames_() {
  return GUIDE_GROUPS_.map(function (g) { return g[0]; }).join(', ');
}

/**
 * The worked example: what a person says, and the rows an assistant following this guide adds. tests/e2e.test.js types
 * exactly these rows into a fake sheet and checks the app shows them, so the example is known to work.
 */
var GUIDE_EXAMPLE_ = {
  request: 'Save this in Focus Tracker as a new house project, "Garden irrigation". Notes: drip lines on the two back beds, ' +
    'a timer on the outside tap, the water butt as a backup. First measure the beds and choose a drip kit; I\'m already ' +
    'sketching the layout. The code for the timer is on GitHub at https://github.com/example/garden-irrigation. ' +
    'It can\'t start until the garden fence repair is done. Done means every bed gets water from the timer.',
  rows: [
    { tab: 'Projects', row: { name: 'Garden irrigation', category: 'House', next_action: 'Measure the two back beds',
      notes: '# Plan\nDrip lines on the two back beds.\n- Timer on the outside tap\n- Water butt as a backup' } },
    { tab: 'Tasks', row: { title: 'Measure the beds', column: 'To do', project: 'Garden irrigation' } },
    { tab: 'Tasks', row: { title: 'Choose a drip kit', column: 'To do', project: 'Garden irrigation', note: 'Compare two kits that fit the outside tap' } },
    { tab: 'Tasks', row: { title: 'Sketch the layout', column: 'Doing', project: 'Garden irrigation' } },
    { tab: 'Resources', row: { title: 'garden-irrigation repo', type: 'link', value: 'https://github.com/example/garden-irrigation', group: 'Code', project: 'Garden irrigation' } },
    { tab: 'Links', row: { from: 'Garden fence repair', type: 'blocks', to: 'Garden irrigation', note: 'The fence posts go in first' } },
    { tab: 'Criteria', row: { text: 'Every bed gets water from the timer', project: 'Garden irrigation' } }
  ]
};

/** Each module's tables by name: { tab: headers }. From MODULES, so a mode that leaves a module out still gets its tab described. */
function guideHeaders_() {
  var out = {};
  MODULES.forEach(function (id) {
    var factory = globalThis[id + 'Module'];
    if (typeof factory !== 'function') return;
    (factory().tables || []).forEach(function (t) { if (!out[t.name]) out[t.name] = t.headers; });
  });
  return out;
}

/** The people tabs the guide describes, in TAB_STYLE order: [{ name, headers, people (columns before id), app }]. */
function guidePeopleTabs_() {
  var headers = guideHeaders_();
  return TAB_STYLE.filter(function (spec) { return spec.people && headers[spec.name]; }).map(function (spec) {
    var h = headers[spec.name], at = h.indexOf('id');
    return { name: spec.name, headers: h, people: at === -1 ? h : h.slice(0, at), app: at === -1 ? [] : h.slice(at) };
  });
}

/** Columns with no meaning in GUIDE_TABS_ ("Tasks.note"), for the test that keeps the guide complete. */
function guideGaps_() {
  var tabs = guideTabs_(), gaps = [];
  guidePeopleTabs_().forEach(function (t) {
    var entry = tabs[t.name];
    if (!entry) { gaps.push(t.name); return; }
    t.people.forEach(function (h) { if (!entry.columns[h]) gaps.push(t.name + '.' + h); });
  });
  return gaps;
}

function guideModeLabels_() {
  return allModes_().map(function (m) { return m.label; });
}

function quoteList_(words) {
  var q = words.map(function (w) { return '"' + w + '"'; });
  return q.length > 1 ? q.slice(0, -1).join(', ') + ' or ' + q[q.length - 1] : q.join('');
}

var GUIDE_WHO_ = { needed: 'yes', optional: 'if known', app: 'no, the app does' };

function mdCell_(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, '\\n');
}

function mdTable_(head, rows) {
  return ['| ' + head.join(' | ') + ' |', '|' + head.map(function () { return '---'; }).join('|') + '|']
    .concat(rows.map(function (r) { return '| ' + r.map(mdCell_).join(' | ') + ' |'; }));
}

/** The example's rows for one tab, as a table with the tab's people columns that any row fills. */
function guideExampleTable_(tab, headers) {
  var rows = GUIDE_EXAMPLE_.rows.filter(function (r) { return r.tab === tab; }).map(function (r) { return r.row; });
  var used = headers.filter(function (h) { return rows.some(function (r) { return r[h] !== undefined; }); });
  return mdTable_(used, rows.map(function (r) { return used.map(function (h) { return r[h] === undefined ? '' : r[h]; }); }));
}

/** The full guide as markdown. */
function guideMarkdown_() {
  var tabs = guideTabs_(), people = guidePeopleTabs_(), modes = guideModeLabels_();
  var byName = {};
  people.forEach(function (t) { byName[t.name] = t; });
  var L = [];
  function p() { for (var i = 0; i < arguments.length; i++) L.push(arguments[i]); }

  p('# ' + guideDocName_(), '',
    'This guide is for any AI assistant (Claude, ChatGPT, Gemini or another) that can read and edit the owner\'s Google Drive and Google Sheets. ' +
    'It says how to add and change things in ' + APP_NAME + ' so the app can use them. The app writes this Doc from its own code and rewrites it when the app changes, so do not edit it: your changes would be lost.', '');

  p('## In short', '',
    '- ' + APP_NAME + ' keeps everything in Google Drive, in the folder "' + TRACKER_FOLDER_NAME + '". It has one subfolder per mode (' + quoteList_(modes) + '), and each subfolder holds that mode\'s spreadsheet. If the owner does not say which mode, ask.',
    '- Add things by adding rows at the bottom of a tab. Change things by changing cells. Never delete rows, never move, rename or delete columns or tabs, and never edit the grey tabs.',
    '- Fill only the columns on the left, the ones with a white header. Leave the grey-header columns (from id on) empty: the app fills them the next time it opens.',
    '- Point at other rows by their name (a card\'s project, a link\'s from and to), written exactly as in their own tab.',
    '- Never create files in Drive. The app only sees files it made itself. Notes go into the project\'s notes Doc or its notes cell (see "Notes").',
    '- Never put sensitive information in the sheet, and never copy the contents of a file into it (see "Safety rules").',
    '- If the app cannot use a row, it writes the reason in that row\'s problem column. Read the problem columns when you finish.', '');

  p('## Where things go', '');
  L.push.apply(L, mdTable_(['What to save', 'Where', 'How'], [
    ['A new project or goal', 'Projects', 'A row with name, category and next_action.'],
    ['The next step on a project', 'Projects, next_action', 'One short, concrete sentence. Replace the old one.'],
    ['Notes, ideas, research, meeting notes, decisions', 'The project\'s notes', 'See "Notes". Not in cards, not in new files.'],
    ['A task on a project', 'Tasks', 'A row with title, project and column (To do, Doing or Done).'],
    ['What "done" means for a project', 'Criteria', 'One row per criterion, with project.'],
    ['A code repository (GitHub, GitLab)', 'Resources', 'type link, value the https:// address, group Code, project.'],
    ['A web page, shop, article or video', 'Resources', 'type link, with a group that fits (' + guideGroupNames_() + ').'],
    ['A Google Drive file the owner named', 'Resources', 'type drive, value its https://docs.google.com/ or https://drive.google.com/ address.'],
    ['A phone number or an email address', 'Resources', 'type phone or email, with a title saying whose it is.'],
    ['A short fact to keep (a size, a model number)', 'Resources', 'type text, value the text.'],
    ['One project has to wait for another', 'Links', 'from the one that goes first, type blocks, to the one that waits.'],
    ['Two projects belong together', 'Links', 'type relates.'],
    ['Something to repeat (exercise, practice)', 'Habits', 'name, sessions and per, for example 3 and week. Start low.'],
    ['A one-off small task (shopping, an appointment)', 'To-dos', 'title, and day if it is for a day.'],
    ['Items that are not a project (books, films, ideas)', 'Tasks with list', 'title, list and column (the list\'s group). A new list is a row in Lists.'],
    ['A record of a work session', 'Log', 'project, where_stopped and minutes.'],
    ['A drawing', 'Nowhere', 'Whiteboards are made in the app. Describe it in the notes instead.'],
    ['Anything else, or you are not sure', 'Ask the owner', '']
  ]));
  p('', 'Resource groups: use the same group for the same kind of thing, so a project\'s page stays tidy. Use a group the project already has when one fits. Suggested groups:', '');
  L.push.apply(L, mdTable_(['Group', 'For'], GUIDE_GROUPS_));
  p('');

  p('## Notes', '',
    'Each project has notes: formatted text the owner reads and edits in the app. They are kept in a notes file and a Google Doc called "<project name> notes" in the mode\'s Notes folder. The notes cell in Projects holds the Doc\'s link.', '',
    '- **The notes cell holds a Google Docs link** (https://docs.google.com/document/...): open that Doc and add your text to it. Keep what is there. Add new text at the end, under a heading with the date, for example "## 2026-11-03". The app brings the Doc\'s text into the project the next time the project is opened.',
    '- **The notes cell is empty, or holds another link** (an older notes file): write the notes into the notes cell itself, as plain text, replacing the link. The app adds the text to the end of the project\'s notes when it next opens, makes the Doc, and puts the link back in the cell.',
    '- Notes may use simple markdown: # for a heading, - for a list item, **bold**, *italic*, and [text](https://...) for a link. One paragraph per line.',
    '- Never create a new Doc or file for notes, and never rename or move the notes Doc: the app could no longer find it.',
    '- A card has its own short note: the note column in Tasks. To change a card\'s note, write note and empty its note_html cell.', '');

  p('## Rules for every row', '',
    '- Cells are plain text. Dates look like 2026-11-03, a time like 2026-11-03T14:05:00Z. Yes/no columns hold yes or are empty.',
    '- Leave id, order, created and the other grey-header columns empty in a new row. The app fills them, and the ids next to the names (project_id, column_id and so on), the next time it opens.',
    '- A name must match exactly one row in its tab. Capital letters do not matter; spelling does. If two rows share the name, the app does not guess: it writes a problem instead.',
    '- A category is a label from the Categories tab of the same spreadsheet, for example "Coding". Read that tab first; never make up a category.',
    '- A new project and the rows that point at it can be added in the same edit, in any order.',
    '- Do not write in the problem column. When a row has a problem, change the cell it names; the app clears the problem the next time it opens.', '');

  p('## The tabs', '',
    'People tabs come first and are brightly coloured. Grey tabs (' + TAB_STYLE.filter(function (s) { return !s.people; }).map(function (s) { return s.name; }).join(', ') + ') are used by the app only: do not edit them. ' +
    'The "Start here" tab is a short version of this guide.', '');
  people.forEach(function (t) {
    var entry = tabs[t.name] || { what: '', columns: {} };
    p('### ' + t.name, '', entry.what, '');
    L.push.apply(L, mdTable_(['Column', 'You fill it', 'Meaning'], t.people.map(function (h) {
      var c = entry.columns[h] || ['optional', ''];
      return [h, GUIDE_WHO_[c[0]], c[1]];
    })));
    var appNotes = entry.app || {};
    p('', 'App columns, leave them empty: ' + t.app.join(', ') + '.');
    Object.keys(appNotes).forEach(function (h) { p('', '- ' + h + ': ' + appNotes[h]); });
    p('');
  });

  p('## Worked example: a new project', '', 'The owner says:', '', '> ' + GUIDE_EXAMPLE_.request, '',
    'The assistant reads the Categories tab (House is there) and the Projects tab (no project is called "Garden irrigation" yet; "Garden fence repair" exists), then adds these rows. Every other column stays empty.', '');
  var exampleTabs = [];
  GUIDE_EXAMPLE_.rows.forEach(function (r) { if (exampleTabs.indexOf(r.tab) === -1) exampleTabs.push(r.tab); });
  exampleTabs.forEach(function (tab) {
    p('**' + tab + '**', '');
    L.push.apply(L, guideExampleTable_(tab, byName[tab] ? byName[tab].people : []));
    p('');
  });
  p('Why: the notes go in the notes cell because the project is new and has no notes Doc yet (\\n above is a line break inside the cell). ' +
    'The cards name their columns: a new project\'s board starts with ' + BOARD_COLUMNS_.join(', ') + '. The repository is a resource of type link in the group Code. ' +
    '"Can\'t start until" is a blocks link from the project that goes first. The next time the app opens it fills every id, makes the board and the notes, and shows "Waiting on Garden fence repair".', '');

  p('## Changing an existing project safely', '',
    '- Find the project\'s row in Projects by its name. If no row or more than one row has that name, ask the owner which project is meant.',
    '- Change cells in place: next_action, status (' + PROJECT_STATUSES_.join(', ') + '), a criterion\'s done, a resource\'s value.',
    '- To move a card (for example to Done), write the column\'s name in its column cell and empty its column_id cell. To change a card\'s note, write note and empty note_html. These two are the only grey cells you may change.',
    '- Add new cards, resources, criteria and links as new rows at the bottom of their tab, pointing at the project by name.',
    '- Never delete a row, also not one you added by mistake: tell the owner, who can delete it in the app (with undo). To finish a project, set status to done; to drop it, archived.',
    '- Do not rename projects, lists or columns in the sheet: rename them in the app, which keeps the names in other tabs in step.',
    '- Never change an id or any other grey-header cell (except column_id and note_html as above), never sort a tab or move rows, and never touch the grey tabs.',
    '- Before adding a resource or a card, check it is not there already.', '');

  p('## Safety rules', '',
    '- Never put bank or card details, passwords, ID or passport numbers, tax references, health records or anything similar in the sheet or the notes.',
    '- Only link a Drive file the owner named or clearly pointed at. Never browse Drive and add links on your own.',
    '- Before linking a file, check it. If it holds sensitive material like the above, ask the owner to confirm first: a link is one click away from the contents.',
    '- Never copy the contents of a linked file into the sheet or the notes. Keep the link, a title and a short note only.',
    '- If in doubt, ask.', '');

  p('## Checklist before you finish', '',
    '- [ ] Every new row is in the right tab (see "Where things go"), at the bottom, with only white-header columns filled.',
    '- [ ] Every project, list, column and category name is spelled exactly as in its own tab.',
    '- [ ] Notes went into the project\'s notes Doc or its notes cell, and no new file was made.',
    '- [ ] No row was deleted or moved, no column or tab was changed, no grey tab was touched.',
    '- [ ] No sensitive information was added, and no file contents were copied.',
    '- [ ] You told the owner what you added and changed, and that the app finishes the rows the next time it opens. If you can, check the problem columns after the owner has opened the app.');
  return L.join('\n') + '\n';
}

/** The Start here tab: the short version, one line per row, with a pointer to the guide Doc. */
function guideShortLines_() {
  var tabs = guideTabs_();
  var lines = [
    APP_NAME + ' - start here',
    'This spreadsheet holds the ' + APP_NAME + ' app\'s data. People and AI assistants can read it and add rows.',
    'AI assistants: read the Doc "' + guideDocName_() + '" in the "' + TRACKER_FOLDER_NAME + '" Drive folder first. It is the full version of this tab.',
    '',
    'The tabs'
  ];
  guidePeopleTabs_().forEach(function (t) {
    var entry = tabs[t.name];
    if (!entry) return;
    var needed = t.people.filter(function (h) { return entry.columns[h] && entry.columns[h][0] === 'needed'; });
    lines.push(t.name + ': ' + entry.what + (needed.length ? ' Fill ' + needed.join(', ') + '.' : ''));
  });
  lines.push('Grey tabs are used by the app only. Do not edit them.');
  lines.push('');
  lines.push('Adding things by typing a row');
  lines.push('- Fill the columns on the left (the ones with a white header). Leave id, order and created empty: the app fills them the next time it opens.');
  lines.push('- Point at another row by its name: for example the project column in Tasks. The app finds the id when the name is unique.');
  lines.push('- A project: a row in Projects with name, category (a label from Categories) and next_action.');
  lines.push('- A card: a row in Tasks with title, project and column. A new project\'s board starts with ' + BOARD_COLUMNS_.join(', ') + '.');
  lines.push('- A resource: a row in Resources with title, type (' + RESOURCE_TYPES_.join(', ') + '), value, group and project. A code repository: type link, group Code.');
  lines.push('- Notes: write into the project\'s notes Doc (its link is in the notes column). No link yet: write the notes as text in the notes cell; the app moves them into the notes.');
  lines.push('- To change a card\'s note, write the new note and empty its note_html cell: the app makes the formatted copy again.');
  lines.push('- If the app cannot use a row it leaves it alone and writes the reason in its problem column. Fix the row and the problem clears.');
  lines.push('- Cells are plain text. Dates look like 2026-10-29. Yes/no columns hold yes or are empty.');
  lines.push('');
  lines.push('Safety rules');
  lines.push('- Never put bank or card details, passwords, ID or passport numbers, tax references or health records in this sheet.');
  lines.push('- Resources hold a link, a title and a short note only. Never copy the contents of a linked file here.');
  lines.push('- Only link a file the owner has named or pointed at. If a file holds sensitive material, ask the owner first.');
  lines.push('- Never delete rows, move columns or create files in Drive. A backup copy is made before the app changes the layout of this sheet.');
  return lines;
}

/** The paragraph to paste into an assistant's memory or project instructions. guideUrl: the Doc's address, if known. */
function assistantNote_(guideUrl) {
  var modes = guideModeLabels_();
  return 'I use ' + APP_NAME + ', an app that keeps my projects in Google Sheets. When I ask you to save something in ' + APP_NAME +
    ' (projects, notes, tasks, links), open my Google Drive folder "' + TRACKER_FOLDER_NAME + '" and read the Doc "' + guideDocName_() + '"' +
    (guideUrl ? ' (' + guideUrl + ')' : '') + ' first. Then edit the spreadsheet in the subfolder of the mode I mean (' + quoteList_(modes) +
    '; ask if I did not say), following the guide exactly. Never delete rows, never create new files, and never store passwords, bank details or other sensitive information.';
}

/** A short fingerprint of a text, to tell whether the guide changed without asking Drive. Not for security. */
function textHash_(text) {
  var h = 0x811c9dc5;
  var s = String(text);
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8) + ':' + s.length;
}

function guideDocUrl_(id) {
  return id ? 'https://docs.google.com/document/d/' + id + '/edit' : '';
}

/** The guide Doc's address, or '' before it is made. One property read. */
function guideUrl_() {
  return guideDocUrl_(PropertiesService.getScriptProperties().getProperty(GUIDE_DOC_ID_KEY_));
}

/**
 * Write the guide into its Doc in the root folder when the text changed since the last write (or there is no Doc yet).
 * When nothing changed: one property read and no Drive call. Uses Drive's markdown import, like the notes Docs (no new
 * permission). A Doc deleted or binned in Drive is made again on the next change. Never throws: the app works without it.
 * Returns the Doc's address, or '' when there is none.
 */
function ensureGuideDoc_() {
  var props = PropertiesService.getScriptProperties();
  var text = guideMarkdown_(), hash = textHash_(text);
  if (props.getProperty(GUIDE_DOC_ID_KEY_) && props.getProperty(GUIDE_DOC_HASH_KEY_) === hash) return guideUrl_();
  try {
    return withLock_(function () {
      var id = props.getProperty(GUIDE_DOC_ID_KEY_);
      if (id && props.getProperty(GUIDE_DOC_HASH_KEY_) === hash) return guideDocUrl_(id);
      var blob = Utilities.newBlob(text, 'text/markdown', guideDocName_() + '.md');
      var file = null;
      if (id) {
        try { file = Drive.Files.update({ name: guideDocName_() }, id, blob, { fields: 'id,trashed' }); } catch (e) { file = null; }
        if (file && file.trashed) file = null;
      }
      if (!file) file = Drive.Files.create({ name: guideDocName_(), mimeType: GUIDE_DOC_MIME_, parents: [getTrackerFolder_().getId()] }, blob, { fields: 'id' });
      props.setProperty(GUIDE_DOC_ID_KEY_, file.id);
      props.setProperty(GUIDE_DOC_HASH_KEY_, hash);
      console.log('guide Doc ' + (id === file.id ? 'updated' : 'made'));
      return guideDocUrl_(file.id);
    });
  } catch (e) {
    console.log('guide Doc not written: ' + (e && e.message ? e.message : e));
    return guideUrl_();
  }
}

/**
 * Keep the guide current: the Doc (once for all modes) and the active mode's Start here tab, each only when its text
 * changed since it was last written. Run on page load (bootstrap), after a migration and by setup(). Returns the Doc's address.
 */
function refreshGuide_() {
  var url = ensureGuideDoc_();
  try {
    var key = 'START_HERE_HASH.' + modeId_();
    if (PropertiesService.getScriptProperties().getProperty(key) !== textHash_(guideShortLines_().join('\n'))) writeStartHere_(getSpreadsheet_());
  } catch (e) {
    console.log('Start here not written: ' + (e && e.message ? e.message : e));
  }
  return url;
}
