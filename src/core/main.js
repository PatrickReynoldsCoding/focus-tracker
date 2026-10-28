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
 * Remembers the spreadsheet, creates every module's tab and finds or creates the Drive folder.
 */
function setup() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) PropertiesService.getScriptProperties().setProperty('SHEET_ID', active.getId());
  var mods = loadModules_();
  Object.keys(mods).forEach(function (id) {
    (mods[id].tables || []).forEach(function (t) { t.ensure(); });
  });
  var folder = getTrackerFolder_();
  Logger.log('Ready. Spreadsheet: ' + getSpreadsheet_().getUrl() + ' | Drive folder: ' + folder.getUrl());
}
