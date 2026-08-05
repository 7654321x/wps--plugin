var DOCXTOOL_RIBBON_COMMANDS = Object.freeze({
  preview: "preview_document",
  apply: "format_document",
  health: "health_check",
  panel: "toggle_taskpane"
});

function DocxtoolRibbonLog(level, event, message, data, error) {
  var payload = data || {};
  try {
    if (typeof window.DocxtoolDiagnosticLog === "function") {
      window.DocxtoolDiagnosticLog(level, "ribbon", event, message, payload, error);
      return;
    }
    if (typeof window.DocxtoolEarlyLog === "function") {
      window.DocxtoolEarlyLog(level, "ribbon", event, message, payload, error);
      return;
    }
    window.DocxtoolEarlyLogQueue = window.DocxtoolEarlyLogQueue || [];
    var item = { timestamp: new Date().toISOString(), level: level, component: "ribbon", event: event, message: message, data: payload };
    if (error) item.error = { name: error.name ? String(error.name) : "Error", message: error.message ? String(error.message) : String(error), stack: error.stack ? String(error.stack) : "" };
    window.DocxtoolEarlyLogQueue.push(item);
    if (window.DocxtoolEarlyLogQueue.length > 500) window.DocxtoolEarlyLogQueue.splice(0, window.DocxtoolEarlyLogQueue.length - 500);
  } catch (ignore) { /* diagnostics never changes a Ribbon callback */ }
}

DocxtoolRibbonLog("INFO", "ribbon.script.loaded", "生产 Ribbon 脚本已执行", { application_available: Boolean(window.Application) });

function OnAddinLoad(ribbonUI) {
  var started = Date.now();
  DocxtoolRibbonLog("INFO", "ribbon.addin.load.start", "WPS 调用了 OnAddinLoad", { application_available: Boolean(window.Application), ribbon_ui_available: Boolean(ribbonUI), build_id: window.DocxtoolBuildInfo ? window.DocxtoolBuildInfo.build_id : "unknown" });
  try {
    window.Application.ribbonUI = ribbonUI;
    DocxtoolRibbonLog("INFO", "ribbon.addin.load.success", "Ribbon UI 已保存", { duration_ms: Date.now() - started });
    return true;
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "ribbon.addin.load.failed", "OnAddinLoad 执行失败", { duration_ms: Date.now() - started }, error);
    throw error;
  }
}

function DocxtoolPersistHostError(callbackName, errorCode) {
  try {
    var build = window.DocxtoolBuildInfo || { build_id: "unknown", asset_hash: "" };
    var message = ({ HOST_COMMAND_QUEUE_NOT_READY: "本地命令队列尚未就绪", HOST_COMMAND_ENQUEUE_FAILED: "本地命令提交失败", RIBBON_CALLBACK_NOT_FOUND: "功能区按钮回调未找到" })[errorCode] || errorCode;
    var value = { schema_version: 1, build_id: build.build_id, asset_hash: build.asset_hash, host_context_id: "ribbon-bootstrap", document_identity_hash: "", active_command: null, command_status: "FAIL", active_view: "issues", recognition_summary: "", paragraph_recognition_models: [], formatting_preview_models: [], preview_comment_status: "", formatting_progress: "失败：" + message + "。", formatting_result: "", latest_error: errorCode, callback_log: [{ callback_name: callbackName, build_id: build.build_id, host_context: "ribbon-bootstrap", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), status: "FAIL", stable_error_code: errorCode }], updated_at: new Date().toISOString() };
    window.Application.PluginStorage.setItem("docxtool_classified_host_result_v1", JSON.stringify(value));
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "ribbon.state.persist.failed", "Ribbon 兜底状态写入失败", { callback_name: callbackName, stable_error_code: errorCode }, error);
  }
}

function OnAction(control) {
  var controlId = control && control.Id ? String(control.Id) : "";
  var command = DOCXTOOL_RIBBON_COMMANDS[controlId];
  DocxtoolRibbonLog("INFO", "ribbon.action.received", "收到功能区按钮点击", { control_id: controlId, command_name: command || "", host_enqueue_available: typeof window.DocxtoolHostEnqueue === "function" });
  if (!command) {
    DocxtoolPersistHostError("OnAction:" + controlId, "RIBBON_CALLBACK_NOT_FOUND");
    return true;
  }
  if (typeof window.DocxtoolHostEnqueue !== "function") {
    DocxtoolPersistHostError("OnAction:" + controlId, "HOST_COMMAND_QUEUE_NOT_READY");
    return true;
  }
  try {
    var receipt = window.DocxtoolHostEnqueue(command, "ribbon");
    DocxtoolRibbonLog("INFO", "ribbon.command.enqueued", "命令已提交到本地队列", {
      control_id: controlId,
      command_name: command,
      command_id: receipt && receipt.command_id ? receipt.command_id : "",
      accepted: Boolean(receipt && receipt.accepted),
      reason: receipt && receipt.reason ? receipt.reason : ""
    });
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "ribbon.command.enqueue.failed", "本地命令入队失败", { control_id: controlId, command_name: command }, error);
    DocxtoolPersistHostError("OnAction:" + controlId, "HOST_COMMAND_ENQUEUE_FAILED");
  }
  return true;
}

function GetActionEnabled(control) {
  if (control && control.Id === "panel") return true;
  try { return !Boolean(window.DocxtoolCommandBusy); }
  catch (ignore) { return true; }
}
