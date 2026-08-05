(function bootstrap(global) {
  "use strict";
  function loadScript(source) { document.write("<script src='" + source + "'><\/script>"); }
  var nonce = Date.now().toString(36);
  loadScript("js/bootstrap-probe.js?v=" + encodeURIComponent(nonce));
  loadScript("ui/build-info.js?v=" + encodeURIComponent(nonce));
  if (typeof global.DocxtoolBootstrapLog === "function") global.DocxtoolBootstrapLog("INFO", "bootstrap.probe.loaded", "经典脚本启动探针已确认并取得当前构建号", { build_id: global.DocxtoolBuildInfo && global.DocxtoolBuildInfo.build_id ? global.DocxtoolBuildInfo.build_id : "unknown" }, undefined, "bootstrap");
  function versioned(asset) {
    var build = global.DocxtoolBuildInfo && global.DocxtoolBuildInfo.build_id ? global.DocxtoolBuildInfo.build_id : nonce;
    return asset + "?v=" + encodeURIComponent(build);
  }
  global.DocxtoolVersionedAsset = versioned;
  loadScript(versioned("ui/default-format-profile.js"));
  loadScript(versioned("ui/local-runtime-config.js"));
  loadScript(versioned("js/ribbon.js"));
  global.DocxtoolTaskPanePath = "ui/taskpane.html";
  loadScript(versioned("host-runtime.js"));
  if (typeof global.DocxtoolBootstrapLog === "function") global.DocxtoolBootstrapLog("INFO", "bootstrap.main.loaded", "主加载脚本执行完成", {}, undefined, "main");
})(window);
