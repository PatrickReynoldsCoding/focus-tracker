/** Web app entry points and one-time setup. */

/**
 * The tab icon, and what Chrome on Android uses for "Add to Home screen". It must be a public https URL, so it is the 192 px PNG in this public repo
 * (assets/icons, regenerate with scripts/make-icons.js). It only shows once the file is pushed to the main branch on GitHub.
 */
var FAVICON_URL = 'https://raw.githubusercontent.com/PatrickReynoldsCoding/focus-tracker/main/assets/icons/icon-192.png';

function doGet() {
  var t = HtmlService.createTemplateFromFile('ui/index');
  t.moduleIds = MODULES;
  return t.evaluate()
    .setTitle(APP_NAME)
    .setFaviconUrl(FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used by templates: <?!= include('ui/styles') ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Run once from the Apps Script editor after pushing the code.
 * Remembers the spreadsheet as the first mode's, creates every module's tab and finds or creates the Drive folders.
 * Other modes need no setup: their spreadsheet and folder are created the first time the app opens them.
 */
function setup() {
  setMode_(MODES[0].id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active && !PropertiesService.getScriptProperties().getProperty('SHEET_ID')) {
    PropertiesService.getScriptProperties().setProperty('SHEET_ID', active.getId());
  }
  var mods = loadModules_();
  Object.keys(mods).forEach(function (id) {
    (mods[id].tables || []).forEach(function (t) { t.ensure(); });
  });
  var folder = getModeFolder_();
  Logger.log('Ready. Spreadsheet: ' + getSpreadsheet_().getUrl() + ' | Drive folder: ' + folder.getUrl());
}
