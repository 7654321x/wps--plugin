window.DocxtoolLocalRuntimeConfig = {
  runtimeVersion: "local-direct",
  runtimeManifestPath: "%APPDATA%\\Docxtool\\runtime\\current.json",
  brokerStatusPath: "%APPDATA%\\Docxtool\\broker\\status.json",
  brokerJobsPath: "%APPDATA%\\Docxtool\\jobs",
  launchProbeExecutablePath: "%APPDATA%\\Docxtool\\launch-probe\\docxtool-launch-probe.exe",
  threadedPreviewEnabled: false
};
if (typeof window.DocxtoolEarlyLog === "function") {
  window.DocxtoolEarlyLog("DEBUG", "main", "bootstrap.script.loaded", "本地直连 runtime 配置脚本已执行", { asset: "ui/local-runtime-config.js" });
}
