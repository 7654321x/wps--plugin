function OnAddinLoad(ribbonUI) {
  window.Application.ribbonUI = ribbonUI;
  return true;
}
function OnAction(control) {
  if (control.Id === "taskpane") {
    const storageKey = "docxtool_classified_taskpane";
    let pane = null;
    const id = window.Application.PluginStorage.getItem(storageKey);
    // WPS keeps PluginStorage across taskpane/window disposal.  A stale pane
    // ID used to throw before CreateTaskPane ran, leaving the Ribbon button
    // apparently unresponsive after a reload or a document switch.
    if (id) {
      try { pane = window.Application.GetTaskPane(id); } catch (ignore) { pane = null; }
    }
    if (!pane) {
      pane = window.Application.CreateTaskPane(GetUrlPath() + "/ui/taskpane-development.html");
      window.Application.PluginStorage.setItem(storageKey, pane.ID);
    }
    try {
      pane.Visible = true;
      if (!pane.Visible) throw Error("TASKPANE_NOT_VISIBLE");
    } catch (ignore) {
      // Some WPS builds return a disposed pane object without throwing from
      // GetTaskPane.  Replace it rather than retaining a dead handle.
      pane = window.Application.CreateTaskPane(GetUrlPath() + "/ui/taskpane-development.html");
      window.Application.PluginStorage.setItem(storageKey, pane.ID);
      pane.Visible = true;
    }
    return true;
  }
  window.Application.PluginStorage.setItem("docxtool_classified_pending_action", control.Id);
  return true;
}
function GetUrlPath() {
  const location = decodeURI(document.location.toString());
  return location.substring(0, location.lastIndexOf("/"));
}
