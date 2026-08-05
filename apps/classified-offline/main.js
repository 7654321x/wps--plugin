(function installEarlyDiagnosticQueue(global) {
  if (!Array.isArray(global.DocxtoolEarlyLogQueue)) global.DocxtoolEarlyLogQueue = [];
  if (typeof global.DocxtoolEarlyLog !== "function") {
    global.DocxtoolEarlyLog = function (level, component, event, message, data, error) {
      try {
        var item = { timestamp: new Date().toISOString(), level: level || "INFO", component: component || "main", event: event || "bootstrap.unknown", message: message || "", data: data || {} };
        if (error) item.error = { name: error.name ? String(error.name) : "Error", message: error.message ? String(error.message) : String(error), stack: error.stack ? String(error.stack) : "" };
        global.DocxtoolEarlyLogQueue.push(item);
        if (global.DocxtoolEarlyLogQueue.length > 500) global.DocxtoolEarlyLogQueue.splice(0, global.DocxtoolEarlyLogQueue.length - 500);
      } catch (ignore) { /* the main script must continue even when diagnostics fail */ }
    };
  }
  global.DocxtoolEarlyLog("INFO", "main", "bootstrap.main.loaded", "开发主脚本开始执行", { origin: global.location ? global.location.origin : "", application_available: Boolean(global.Application) });
})(window);
var DOCXTOOL_BOOTSTRAP_NONCE = Date.now().toString(36);
window.DocxtoolEarlyLog("DEBUG", "main", "bootstrap.script.requested", "请求加载脚本", { asset: "ui/build-info.js" });
document.write("<script src='ui/build-info.js?v=" + encodeURIComponent(DOCXTOOL_BOOTSTRAP_NONCE) + "'></script>");
window.DocxtoolVersionedAsset = function (asset) { var build = window.DocxtoolBuildInfo && window.DocxtoolBuildInfo.build_id ? window.DocxtoolBuildInfo.build_id : DOCXTOOL_BOOTSTRAP_NONCE; return asset + "?v=" + encodeURIComponent(build); };
window.DocxtoolEarlyLog("DEBUG", "main", "bootstrap.script.requested", "请求加载脚本", { asset: "ui/default-format-profile.js" });
document.write("<script src='" + window.DocxtoolVersionedAsset("ui/default-format-profile.js") + "'></script>");
window.DocxtoolEarlyLog("DEBUG", "main", "bootstrap.script.requested", "请求加载脚本", { asset: "ui/e2e-session.js" });
document.write("<script src='" + window.DocxtoolVersionedAsset("ui/e2e-session.js") + "'></script>");
window.DocxtoolEarlyLog("DEBUG", "main", "bootstrap.script.requested", "请求加载脚本", { asset: "js/ribbon.js" });
document.write("<script src='" + window.DocxtoolVersionedAsset("js/ribbon.js") + "'></script>");
window.DocxtoolReportBootstrapStage = async function(stage, status, errorCode) {
  try {
    var session = await fetch("http://127.0.0.1:9528/v1/e2e/session").then(function(response) { return response.json(); });
    if (session.session_id) await fetch("http://127.0.0.1:9528/v1/e2e/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id, stage: stage, status: status || "PASS", error_code: errorCode || "" }) });
  } catch (ignore) {}
};
void window.DocxtoolReportBootstrapStage("main_script_loaded", "PASS", "");
window.DocxtoolTaskPanePath = "ui/taskpane-development.html";
window.DocxtoolEarlyLog("DEBUG", "main", "bootstrap.script.requested", "请求加载脚本", { asset: "dist/host-runtime.js", script_type: "module" });
document.write("<script type='module' src='" + window.DocxtoolVersionedAsset("dist/host-runtime.js") + "'></script>");
