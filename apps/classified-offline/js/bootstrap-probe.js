(function installProbe(global) {
  "use strict";
  var queue = global.DocxtoolEarlyLogQueue = global.DocxtoolEarlyLogQueue || [];
  function safeText(value) { try { return String(value); } catch (ignore) { return "[unprintable]"; } }
  function toError(error) { return { name: error && error.name ? safeText(error.name) : "Error", message: error && error.message ? safeText(error.message) : safeText(error), stack: error && error.stack ? safeText(error.stack) : "" }; }
  function createEvent(level, component, eventName, message, data, error) {
    var item = { timestamp: new Date().toISOString(), level: level || "INFO", component: component || "bootstrap", event: eventName || "bootstrap.unknown", message: message || "", build_id: global.DocxtoolBuildInfo && global.DocxtoolBuildInfo.build_id ? global.DocxtoolBuildInfo.build_id : "unknown", href: global.location ? safeText(global.location.href) : "", data: data || {} };
    if (error) item.error = toError(error); return item;
  }
  function remoteError(error) { return error ? { name: error.name ? safeText(error.name) : "Error", message: error.message ? safeText(error.message) : safeText(error), stack: error.stack ? safeText(error.stack) : "" } : undefined; }
  function sendRemote(item) {
    try {
      var body = JSON.stringify(item);
      if (global.fetch) { global.fetch("/__docxtool_log", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {}); return; }
      if (global.XMLHttpRequest) { var request = new global.XMLHttpRequest(); request.open("POST", "/__docxtool_log", true); request.setRequestHeader("Content-Type", "application/json"); request.send(body); }
    } catch (ignore) { /* remote diagnostics never affect WPS actions */ }
  }
  function push(item) { queue.push(item); if (queue.length > 500) queue.splice(0, queue.length - 500); }
  global.DocxtoolBootstrapLog = function (level, eventName, message, data, error, component) { var item = createEvent(level, component || "bootstrap", eventName, message, data, error); push(item); sendRemote(item); };
  global.DocxtoolEarlyLog = function (level, component, eventName, message, data, error) { global.DocxtoolBootstrapLog(level, eventName, message, data, error, component); };
  global.DocxtoolDiagnosticLog = function (level, component, eventName, message, data, error) { global.DocxtoolBootstrapLog(level, eventName, message, data, error, component); };
  global.addEventListener("error", function (eventObject) { global.DocxtoolBootstrapLog("ERROR", "window.error", "网页出现未处理错误", { filename: eventObject.filename || "", line: eventObject.lineno || 0, column: eventObject.colno || 0 }, eventObject.error || eventObject.message); });
  global.addEventListener("unhandledrejection", function (eventObject) { global.DocxtoolBootstrapLog("ERROR", "window.unhandledrejection", "网页出现未处理 Promise 拒绝", {}, eventObject.reason); });
  global.DocxtoolBootstrapLog("INFO", "bootstrap.probe.loaded", "经典脚本启动探针已执行", { ready_state: document.readyState, application_available: Boolean(global.Application) });
})(window);
