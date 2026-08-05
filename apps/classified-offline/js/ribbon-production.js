var DOCXTOOL_RIBBON_COMMANDS = Object.freeze({ preview: "preview_document", apply: "format_document", health: "health_check" });

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

function DocxtoolErrorMessage(errorCode) {
  return ({ HOST_COMMAND_ROUTER_NOT_READY: "插件命令路由尚未就绪。请关闭任务窗格后重新打开，或重启 WPS。", HOST_COMMAND_FAILED: "WPS 执行命令失败。请查看功能检测结果定位原因。", RIBBON_CALLBACK_NOT_FOUND: "功能区按钮回调未找到。请关闭全部 WPS 窗口后重新打开。", TASKPANE_CREATE_FAILED: "WPS 未能创建任务窗格。请关闭全部 WPS 窗口后重试。" })[errorCode] || ("未知错误：" + errorCode);
}

function DocxtoolPersistHostError(callbackName, errorCode) {
  try {
    var build = window.DocxtoolBuildInfo || { build_id: "unknown", asset_hash: "" };
    var value = { schema_version: 1, build_id: build.build_id, asset_hash: build.asset_hash, host_context_id: "ribbon-bootstrap", document_identity_hash: "", active_command: null, command_status: "FAIL", active_view: "issues", recognition_summary: "", paragraph_recognition_models: [], formatting_preview_models: [], preview_comment_status: "", formatting_progress: "失败：" + DocxtoolErrorMessage(errorCode), formatting_result: "", latest_error: errorCode, callback_log: [{ callback_name: callbackName, build_id: build.build_id, host_context: "ribbon-bootstrap", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), status: "FAIL", stable_error_code: errorCode }], updated_at: new Date().toISOString() };
    window.Application.PluginStorage.setItem("docxtool_classified_host_result_v1", JSON.stringify(value));
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "ribbon.state.persist.failed", "Ribbon 兜底状态写入失败", { callback_name: callbackName, stable_error_code: errorCode }, error);
  }
}

function DocxtoolFallbackShowTaskPane() {
  var pane = null;
  var key = "docxtool_classified_taskpane";
  DocxtoolRibbonLog("DEBUG", "taskpane.lookup.start", "开始查找已存在的任务窗格", {});
  try {
    var saved = window.Application.PluginStorage.getItem(key);
    if (saved) {
      try {
        pane = window.Application.GetTaskPane(Number(saved));
        DocxtoolRibbonLog("DEBUG", "taskpane.lookup.success", "已完成任务窗格查找", { found: Boolean(pane) });
      } catch (error) {
        DocxtoolRibbonLog("WARN", "taskpane.lookup.failed", "读取已保存任务窗格失败", {}, error);
        pane = null;
      }
    } else {
      DocxtoolRibbonLog("DEBUG", "taskpane.lookup.success", "没有已保存的任务窗格", { found: false });
    }
    if (!pane) {
      DocxtoolRibbonLog("INFO", "taskpane.create.start", "开始创建任务窗格", {});
      try {
        pane = window.Application.CreateTaskPane(GetUrlPath() + "/ui/taskpane.html", "Docxtool 涉密版");
        if (!pane) throw new Error("TASKPANE_CREATE_RETURNED_EMPTY");
        window.Application.PluginStorage.setItem(key, String(pane.ID));
        DocxtoolRibbonLog("INFO", "taskpane.create.success", "任务窗格创建成功", { pane_id_available: pane.ID !== undefined });
      } catch (error) {
        DocxtoolRibbonLog("ERROR", "taskpane.create.failed", "任务窗格创建失败", { stable_error_code: "TASKPANE_CREATE_FAILED" }, error);
        DocxtoolPersistHostError("DocxtoolFallbackShowTaskPane", "TASKPANE_CREATE_FAILED");
        return false;
      }
    }
    try {
      pane.Visible = true;
      if (!pane.Visible) throw new Error("TASKPANE_VISIBLE_FALSE");
      DocxtoolRibbonLog("INFO", "taskpane.show.success", "任务窗格已显示", {});
      return true;
    } catch (error) {
      DocxtoolRibbonLog("ERROR", "taskpane.show.failed", "任务窗格显示失败", { stable_error_code: "TASKPANE_SHOW_FAILED" }, error);
      return false;
    }
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "taskpane.lookup.failed", "任务窗格兜底流程失败", {}, error);
    return false;
  }
}

function OnAction(control) {
  var started = Date.now();
  var controlId = control && control.Id ? String(control.Id) : "";
  var command = DOCXTOOL_RIBBON_COMMANDS[controlId];
  var requestId = "ribbon-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 10);
  var buildId = window.DocxtoolBuildInfo ? window.DocxtoolBuildInfo.build_id : "unknown";
  DocxtoolRibbonLog("INFO", "ribbon.action.received", "收到功能区按钮点击", { control_id: controlId, command_name: command || "", request_id: requestId, correlation_id: requestId, application_available: Boolean(window.Application), plugin_storage_available: Boolean(window.Application && window.Application.PluginStorage), host_dispatch_available: typeof window.DocxtoolHostDispatch === "function", build_info_available: Boolean(window.DocxtoolBuildInfo), runtime_config_available: Boolean(window.DocxtoolRuntimeConfig) });
  if (!command) {
    DocxtoolRibbonLog("WARN", "ribbon.action.unknown", "收到未知功能区按钮", { control_id: controlId, request_id: requestId });
    DocxtoolPersistHostError("OnAction:" + controlId, "RIBBON_CALLBACK_NOT_FOUND");
    DocxtoolFallbackShowTaskPane();
    return true;
  }
  if (typeof window.DocxtoolHostDispatch !== "function") {
    DocxtoolRibbonLog("ERROR", "ribbon.dispatch.unavailable", "主宿主命令路由尚未就绪", { control_id: controlId, command_name: command, request_id: requestId, correlation_id: requestId, stable_error_code: "HOST_COMMAND_ROUTER_NOT_READY" });
    DocxtoolPersistHostError("OnAction:" + controlId, "HOST_COMMAND_ROUTER_NOT_READY");
    DocxtoolFallbackShowTaskPane();
    return true;
  }
  DocxtoolRibbonLog("INFO", "ribbon.dispatch.start", "开始调用主宿主命令路由", { control_id: controlId, command_name: command, request_id: requestId, correlation_id: requestId });
  try {
    Promise.resolve(window.DocxtoolHostDispatch(command, "ribbon", requestId, buildId)).then(function (result) {
      DocxtoolRibbonLog(result && result.status === "PASS" ? "INFO" : "ERROR", "ribbon.dispatch.completed", "主宿主命令路由返回", { control_id: controlId, command_name: command, request_id: requestId, correlation_id: requestId, result_status: result && result.status ? result.status : "unknown", stable_error_code: result && result.error_code ? result.error_code : "", stage: result && result.stage ? result.stage : "", duration_ms: Date.now() - started });
    }).catch(function (error) {
      DocxtoolRibbonLog("ERROR", "ribbon.dispatch.rejected", "主宿主 Promise 被拒绝", { control_id: controlId, command_name: command, request_id: requestId, correlation_id: requestId, duration_ms: Date.now() - started, stable_error_code: "HOST_COMMAND_FAILED" }, error);
      DocxtoolPersistHostError("OnAction:" + controlId, "HOST_COMMAND_FAILED");
      DocxtoolFallbackShowTaskPane();
    });
  } catch (error) {
    DocxtoolRibbonLog("ERROR", "ribbon.dispatch.threw", "主宿主命令路由同步抛出异常", { control_id: controlId, command_name: command, request_id: requestId, correlation_id: requestId, duration_ms: Date.now() - started, stable_error_code: "HOST_COMMAND_FAILED" }, error);
    DocxtoolPersistHostError("OnAction:" + controlId, "HOST_COMMAND_FAILED");
    DocxtoolFallbackShowTaskPane();
  }
  return true;
}

function GetUrlPath() { var location = decodeURI(document.location.toString()); return location.substring(0, location.lastIndexOf("/")); }
