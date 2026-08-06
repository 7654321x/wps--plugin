(function installProbe(global) {
  "use strict";
  var queue = global.DocxtoolEarlyLogQueue = global.DocxtoolEarlyLogQueue || [];
  function safeText(value) { return String(value); }
  function toError(error) { return { name: error && error.name ? safeText(error.name) : "Error", message: error && error.message ? safeText(error.message) : safeText(error) }; }
  function createEvent(level, component, eventName, message, data, error) {
    var item = { timestamp: new Date().toISOString(), level: level || "INFO", component: component || "bootstrap", event: eventName || "bootstrap.unknown", message: message || "", build_id: global.DocxtoolBuildInfo && global.DocxtoolBuildInfo.build_id ? global.DocxtoolBuildInfo.build_id : "unknown", data: data || {} };
    if (error) item.error = toError(error); return item;
  }
  function transportFailure(error) { push(createEvent("WARN", "bootstrap", "diagnostics.transport.failed", "统一日志发送失败", { error_name: toError(error).name })); }
  function sendRemote(item) {
    var body = JSON.stringify(item);
    if (global.fetch) {
      global.fetch("/__docxtool_log", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).then(function (response) {
        if (!response.ok) throw new Error("DIAGNOSTIC_HTTP_" + response.status);
      }).catch(transportFailure);
      return;
    }
    if (global.XMLHttpRequest) { var request = new global.XMLHttpRequest(); request.open("POST", "/__docxtool_log", true); request.setRequestHeader("Content-Type", "application/json"); request.send(body); return; }
    transportFailure(new Error("DIAGNOSTIC_TRANSPORT_UNAVAILABLE"));
  }
  function push(item) { queue.push(item); if (queue.length > 100) queue.splice(0, queue.length - 100); }
  global.DocxtoolBootstrapLog = function (level, eventName, message, data, error, component) { var item = createEvent(level, component || "bootstrap", eventName, message, data, error); push(item); sendRemote(item); };
  global.DocxtoolEarlyLog = function (level, component, eventName, message, data, error) { global.DocxtoolBootstrapLog(level, eventName, message, data, error, component); };
  global.DocxtoolDiagnosticLog = function (level, component, eventName, message, data, error) { global.DocxtoolBootstrapLog(level, eventName, message, data, error, component); };
  global.addEventListener("error", function (eventObject) { global.DocxtoolBootstrapLog("ERROR", "window.error", "网页出现未处理错误", { filename: eventObject.filename || "", line: eventObject.lineno || 0, column: eventObject.colno || 0 }, eventObject.error || eventObject.message); });
  global.addEventListener("unhandledrejection", function (eventObject) { global.DocxtoolBootstrapLog("ERROR", "window.unhandledrejection", "网页出现未处理 Promise 拒绝", {}, eventObject.reason); });
  global.DocxtoolBootstrapLog("INFO", "bootstrap.probe.loaded", "经典脚本启动探针已执行", { ready_state: document.readyState, application_available: Boolean(global.Application) });
})(window);
