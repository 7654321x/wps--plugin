function OnAddinLoad(ribbonUI) { window.Application.ribbonUI = ribbonUI; return true; }
function OnAction(control) {
  if (control.Id === "taskpane") {
    const storageKey = "docxtool_classified_taskpane";
    let pane = null;
    const id = window.Application.PluginStorage.getItem(storageKey);
    if (id) {
      try { pane = window.Application.GetTaskPane(id); } catch (ignore) { pane = null; }
    }
    if (!pane) {
      pane = window.Application.CreateTaskPane(GetUrlPath() + "/ui/taskpane.html");
      window.Application.PluginStorage.setItem(storageKey, pane.ID);
    }
    try {
      pane.Visible = true;
      if (!pane.Visible) throw Error("TASKPANE_NOT_VISIBLE");
    } catch (ignore) {
      pane = window.Application.CreateTaskPane(GetUrlPath() + "/ui/taskpane.html");
      window.Application.PluginStorage.setItem(storageKey, pane.ID);
      pane.Visible = true;
    }
  }
  return true;
}
function GetUrlPath() { const location = decodeURI(document.location.toString()); return location.substring(0, location.lastIndexOf("/")); }
