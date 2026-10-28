/** Web app entry points and one-time setup. */

function doGet() {
  var t = HtmlService.createTemplateFromFile('ui/index');
  t.moduleIds = MODULES;
  return t.evaluate()
    .setTitle(APP_NAME)
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
