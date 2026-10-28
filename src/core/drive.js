/** Drive folder helpers. Notes live in <tracker folder>/Notes as plain markdown files. */

function getTrackerFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var found = DriveApp.getFoldersByName(TRACKER_FOLDER_NAME);
  var folder = found.hasNext() ? found.next() : DriveApp.createFolder(TRACKER_FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getSubfolder_(name) {
  var parent = getTrackerFolder_();
  var found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}
