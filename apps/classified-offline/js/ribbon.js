var DOCXTOOL_RIBBON_COMMANDS = Object.freeze({ preview: "preview_document", apply: "format_document", health: "health_check" });
function OnAddinLoad(ribbonUI) { window.Application.ribbonUI = ribbonUI; if (typeof window.DocxtoolReportBootstrapStage === "function") void window.DocxtoolReportBootstrapStage("ribbon_onload", "PASS", ""); return true; }
function DocxtoolPersistHostError(callbackName, errorCode) {
  try {
    var build = window.DocxtoolBuildInfo || { build_id: "unknown", asset_hash: "" };
    var value = { schema_version: 1, build_id: build.build_id, asset_hash: build.asset_hash, host_context_id: "ribbon-bootstrap", document_identity_hash: "", active_command: null, command_status: "FAIL", active_view: "issues", recognition_summary: "", paragraph_recognition_models: [], formatting_preview_models: [], preview_comment_status: "", formatting_progress: "失败：" + errorCode, formatting_result: "", latest_error: errorCode, callback_log: [{ callback_name: callbackName, build_id: build.build_id, host_context: "ribbon-bootstrap", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), status: "FAIL", stable_error_code: errorCode }], updated_at: new Date().toISOString() };
    window.Application.PluginStorage.setItem("docxtool_classified_host_result_v1", JSON.stringify(value));
  } catch (ignore) { /* WPS provides no safer UI before the host router exists. */ }
}
function DocxtoolFallbackShowTaskPane() {
  try {
    var pane = null, key = "docxtool_classified_taskpane", saved = window.Application.PluginStorage.getItem(key);
    if (saved) { try { pane = window.Application.GetTaskPane(Number(saved)); } catch (ignore) { pane = null; } }
    if (!pane) { pane = window.Application.CreateTaskPane(GetUrlPath() + "/ui/taskpane-development.html", "Docxtool 涉密版"); window.Application.PluginStorage.setItem(key, String(pane.ID)); }
    pane.Visible = true;
  } catch (ignore) { /* persisted callback error remains the source of truth */ }
}
function OnAction(control) {
  var command = control && DOCXTOOL_RIBBON_COMMANDS[control.Id];
  if (!command) { DocxtoolPersistHostError("OnAction:" + String(control && control.Id), "RIBBON_CALLBACK_NOT_FOUND"); DocxtoolFallbackShowTaskPane(); return true; }
  if (typeof window.DocxtoolHostDispatch !== "function") { DocxtoolPersistHostError("OnAction:" + control.Id, "HOST_COMMAND_ROUTER_NOT_READY"); DocxtoolFallbackShowTaskPane(); return true; }
  try { Promise.resolve(window.DocxtoolHostDispatch(command, "ribbon")).catch(function () { DocxtoolPersistHostError("OnAction:" + control.Id, "HOST_COMMAND_FAILED"); DocxtoolFallbackShowTaskPane(); }); }
  catch (ignore) { DocxtoolPersistHostError("OnAction:" + control.Id, "HOST_COMMAND_FAILED"); DocxtoolFallbackShowTaskPane(); }
  return true;
}
function GetUrlPath() { var location = decodeURI(document.location.toString()); return location.substring(0, location.lastIndexOf("/")); }
