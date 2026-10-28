/**
 * App configuration. This is the only core file you edit to add or remove a feature.
 *
 * MODULES lists the feature modules to load, in tab order. For each id there must be a
 * folder src/modules/<id>/ containing:
 *   server.js   defining a function named <id>Module() that returns the module definition
 *   view.html   registering the client side with FT.module({ id: '<id>', ... })
 */
var APP_NAME = 'Focus Tracker';

var MODULES = ['today', 'projects', 'categories', 'lists', 'kanban', 'notes', 'resources', 'log'];

/**
 * Modes keep their data apart: each has its own spreadsheet and its own subfolder of the tracker folder.
 *   modules      optional: the modules this mode loads, if not all of MODULES (a mode-only tab is a module listed in one mode only)
 *   categories   starting categories, written to the mode's Categories tab the first time. Edited in the app after that.
 *                color is a palette slot 1-8 (see --cat-N in ui/styles.html).
 *   rotation     lead category per ISO weekday (1 = Monday ... 7 = Sunday). null means any category.
 *   dailyMinimum category whose top project shows in Today's "daily minimum" panel, or null for no panel.
 * The first mode is the default. Its property names have no suffix, so data from before modes existed stays with it.
 */
var MODES = [
  {
    id: 'personal', label: 'Personal',
    categories: [
      { id: 'coding', label: 'Coding', color: '1' },
      { id: 'job', label: 'Job search', color: '2' },
      { id: 'house', label: 'House', color: '3' }
    ],
    rotation: { 1: 'coding', 2: 'coding', 3: 'job', 4: 'coding', 5: 'house', 6: 'house', 7: null },
    dailyMinimum: 'job'
  },
  {
    id: 'work', label: 'Work',
    categories: [
      { id: 'delivery', label: 'Delivery', color: '1' },
      { id: 'ops', label: 'Ops', color: '4' },
      { id: 'learning', label: 'Learning', color: '3' },
      { id: 'career', label: 'Career', color: '5' },
      { id: 'admin', label: 'Admin', color: '2' }
    ],
    rotation: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null },
    dailyMinimum: null
  }
];

// A project untouched for this many days is flagged as stale.
var STALE_DAYS = 5;

// Drive folder that holds everything: one subfolder per mode. Found or created by setup().
var TRACKER_FOLDER_NAME = 'Focus Tracker';
