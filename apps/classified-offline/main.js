document.write("<script src='ui/build-info.js'></script>");
document.write("<script src='ui/default-format-profile.js'></script>");
document.write("<script src='ui/e2e-session.js'></script>");
document.write("<script src='js/ribbon.js'></script>");
window.DocxtoolReportBootstrapStage = async function(stage, status, errorCode) {
  try {
    var session = await fetch("http://127.0.0.1:9528/v1/e2e/session").then(function(response) { return response.json(); });
    if (session.session_id) await fetch("http://127.0.0.1:9528/v1/e2e/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id, stage: stage, status: status || "PASS", error_code: errorCode || "" }) });
  } catch (ignore) {}
};
void window.DocxtoolReportBootstrapStage("main_script_loaded", "PASS", "");
window.DocxtoolTaskPanePath = "ui/taskpane-development.html";
document.write("<script src='dist/host-runtime.js'></script>");
