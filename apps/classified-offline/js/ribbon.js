var DOCXTOOL_RIBBON_COMMANDS = Object.freeze({
  preview: "preview_document",
  apply: "format_document",
  health: "health_check",
  panel: "toggle_taskpane"
});

function DocxtoolRibbonLog(level, event, message, data, error) {
  var payload = data || {};
  function safeError(value) {
    return { name: value && value.name ? String(value.name) : "Error", message: value && value.message ? String(value.message) : String(value) };
  }
  try {
    if (typeof window.DocxtoolDiagnosticLog === "function") { window.DocxtoolDiagnosticLog(level, "ribbon", event, message, payload, error); return; }
    if (typeof window.DocxtoolEarlyLog === "function") { window.DocxtoolEarlyLog(level, "ribbon", event, message, payload, error); return; }
    window.DocxtoolEarlyLogQueue = window.DocxtoolEarlyLogQueue || [];
    var item = { timestamp: new Date().toISOString(), level: level, component: "ribbon", event: event, message: message, data: payload };
    if (error) item.error = safeError(error);
    window.DocxtoolEarlyLogQueue.push(item);
    if (window.DocxtoolEarlyLogQueue.length > 100) window.DocxtoolEarlyLogQueue.splice(0, window.DocxtoolEarlyLogQueue.length - 100);
  } catch (diagnosticError) {
    var fallbackQueue = window.DocxtoolEarlyLogQueue = window.DocxtoolEarlyLogQueue || [];
    fallbackQueue.push({ timestamp: new Date().toISOString(), level: "WARN", component: "ribbon", event: "diagnostics.client.failed", message: "统一日志客户端执行失败", data: { error_name: safeError(diagnosticError).name } });
    if (fallbackQueue.length > 100) fallbackQueue.splice(0, fallbackQueue.length - 100);
  }
}

DocxtoolRibbonLog("INFO", "ribbon.script.loaded", "Ribbon 入口脚本已执行", { build_id: window.DocxtoolBuildInfo && window.DocxtoolBuildInfo.build_id ? window.DocxtoolBuildInfo.build_id : "unknown", application_available: Boolean(window.Application) });

function OnAddinLoad(ribbonUI) {
  var started = Date.now();
  DocxtoolRibbonLog("INFO", "ribbon.addin.load.start", "WPS 调用了 OnAddinLoad", { application_available: Boolean(window.Application), ribbon_ui_available: Boolean(ribbonUI) });
  try {
    window.Application.ribbonUI = ribbonUI;
    DocxtoolRibbonLog("INFO", "ribbon.addin.load.success", "Ribbon UI 已保存", { duration_ms: Date.now() - started });
    return true;
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "ribbon.addin.load.failed", "OnAddinLoad 执行失败", {}, error);
    throw error;
  }
}

function DocxtoolPersistHostError(callbackName, errorCode) {
  try {
    var build = window.DocxtoolBuildInfo || { build_id: "unknown", asset_hash: "" };
    DocxtoolRibbonLog("ERROR", "ribbon.callback.failed", "功能区回调无法完成", { callback_name: callbackName, stable_error_code: errorCode, build_id: build.build_id });
    window.Application.PluginStorage.setItem("docxtool_classified_host_error_v1", JSON.stringify({ schema_version: 1, build_id: build.build_id, callback_name: callbackName, error_code: errorCode, updated_at: new Date().toISOString() }));
  } catch (error) { DocxtoolRibbonLog("ERROR", "ribbon.state.persist.failed", "Ribbon 兜底状态写入失败", { callback_name: callbackName, stable_error_code: errorCode }, error); }
}

function OnAction(control) {
  var controlId = control && control.Id ? String(control.Id) : "";
  var command = DOCXTOOL_RIBBON_COMMANDS[controlId];
  DocxtoolRibbonLog("INFO", "ribbon.action.received", "收到功能区按钮点击", { control_id: controlId, command_name: command || "", local_runtime_available: typeof window.DocxtoolRunLocalCommand === "function" });
  if (!command) { DocxtoolPersistHostError("OnAction:" + controlId, "RIBBON_CALLBACK_NOT_FOUND"); return true; }
  if (typeof window.DocxtoolRunLocalCommand !== "function") { DocxtoolPersistHostError("OnAction:" + controlId, "LOCAL_APPLICATION_RUNTIME_NOT_READY"); return true; }
  try {
    DocxtoolRibbonLog("INFO", "ribbon.command.started", "开始直接执行本地功能", { control_id: controlId, command_name: command });
    Promise.resolve(window.DocxtoolRunLocalCommand(command, "ribbon")).then(function (result) {
      DocxtoolRibbonLog(result && result.status === "PASS" ? "INFO" : "ERROR", "ribbon.command.completed", "本地功能执行完成", { control_id: controlId, command_name: command, command_id: result && result.command_id ? result.command_id : "", status: result && result.status ? result.status : "UNKNOWN", error_code: result && result.error_code ? result.error_code : "" });
    }).catch(function (error) {
      DocxtoolRibbonLog("ERROR", "ribbon.command.failed", "本地功能执行失败", { control_id: controlId, command_name: command }, error);
      DocxtoolPersistHostError("OnAction:" + controlId, "LOCAL_APPLICATION_COMMAND_FAILED");
    });
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "ribbon.command.failed", "本地功能执行失败", { control_id: controlId, command_name: command }, error);
    DocxtoolPersistHostError("OnAction:" + controlId, "LOCAL_APPLICATION_COMMAND_FAILED");
  }
  return true;
}

function GetActionEnabled(control) {
  if (control && control.Id === "panel") return true;
  return !Boolean(window.DocxtoolCommandBusy);
}

window.OnAddinLoad = OnAddinLoad;
window.OnAction = OnAction;
window.GetActionEnabled = GetActionEnabled;
