/**
 * App configuration. This is the only core file you edit to add or remove a feature.
 *
 * MODULES lists the feature modules to load, in tab order. For each id there must be a
 * folder src/modules/<id>/ containing:
 *   server.js   defining a function named <id>Module() that returns the module definition
 *   view.html   registering the client side with FT.module({ id: '<id>', ... })
 */
var APP_NAME = 'Focus Tracker';

var MODULES = ['today', 'projects', 'kanban', 'notes', 'resources', 'log'];

// Categories used to group projects and to drive the weekly rotation.
var CATEGORIES = [
  { id: 'coding', label: 'Coding' },
  { id: 'job', label: 'Job search' },
  { id: 'house', label: 'House' }
];

// A project untouched for this many days is flagged as stale.
var STALE_DAYS = 5;

// Drive folder that holds notes files. Found or created by setup().
var TRACKER_FOLDER_NAME = 'Focus Tracker';
