function OnAddinLoad(ribbonUI) {
  window.Application.ribbonUI = ribbonUI;
  return true;
}
function OnAction(control) {
  if (control.Id === "taskpane") {
    const id = window.Application.PluginStorage.getItem("docxtool_online_taskpane");
    const pane = id ? window.Application.GetTaskPane(id) : window.Application.CreateTaskPane(GetUrlPath() + "/ui/taskpane.html");
    if (!id) window.Application.PluginStorage.setItem("docxtool_online_taskpane", pane.ID);
    pane.Visible = true;
    return true;
  }
  window.dispatchEvent(new CustomEvent("docxtool-ribbon-action", { detail: { action: control.Id } }));
  return true;
}
function GetUrlPath() {
  const location = decodeURI(document.location.toString());
  return location.substring(0, location.lastIndexOf("/"));
}
