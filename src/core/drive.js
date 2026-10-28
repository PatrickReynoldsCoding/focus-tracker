/**
 * Drive folder helpers. Layout:
 *   Focus Tracker/            the tracker folder
 *     Personal/               one folder per mode: its spreadsheet, Notes/ and other files
 *     Work/
 * Data from before modes (the spreadsheet and Notes/ at the top) moves into the first mode's folder the first time it is opened.
 */

function getTrackerFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var found = DriveApp.getFoldersByName(TRACKER_FOLDER_NAME);
  var folder = found.hasNext() ? found.next() : DriveApp.createFolder(TRACKER_FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function findOrCreateFolder_(parent, name) {
  var found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

/** The active mode's folder inside the tracker folder, created (and older data moved in) on first use. */
function getModeFolder_() {
  var props = PropertiesService.getScriptProperties();
  var key = 'MODE_FOLDER_ID.' + modeId_();
  var id = props.getProperty(key);
  if (id) return DriveApp.getFolderById(id);
  return withLock_(function () {
    var again = props.getProperty(key);
    if (again) return DriveApp.getFolderById(again);
    var root = getTrackerFolder_();
    var folder = findOrCreateFolder_(root, activeMode_().label);
    moveExistingDataInto_(root, folder);
    props.setProperty(key, folder.getId());
    return folder;
  });
}

function moveExistingDataInto_(root, folder) {
  var sheetId = PropertiesService.getScriptProperties().getProperty(modeKey_('SHEET_ID'));
  if (sheetId) DriveApp.getFileById(sheetId).moveTo(folder);
  if (modeId_() !== MODES[0].id) return;
  var oldNotes = root.getFoldersByName('Notes');
  if (oldNotes.hasNext()) oldNotes.next().moveTo(folder);
}

/** A subfolder of the active mode's folder, e.g. Notes. */
function getSubfolder_(name) {
  return findOrCreateFolder_(getModeFolder_(), name);
}
