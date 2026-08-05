import { errorMessage, errorText } from "./error-messages.js";
import { LoopbackDiagnosticLogger, safeError, type DiagnosticEvent, type DiagnosticLevel } from "../../../packages/diagnostics/src/index.js";

type HostCommandName = "recognize_document" | "preview_document" | "clear_preview" | "format_document" | "health_check" | "open_taskpane" | "close_taskpane" | "toggle_taskpane" | "show_about";
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface HostState {
  build_id: string; asset_hash: string; host_context_id: string; command_status: string; active_view: "recognition" | "preview" | "execution" | "issues";
  active_command?: { command_id?: string; status?: string; error_code?: string } | null;
  recognition_summary: string; paragraph_recognition_models: Array<{ paragraph_index: number; recognized_type: string; confidence: number; needs_review: boolean }>;
  formatting_preview_models: Array<{ paragraph_index: number; recognized_type: string; plan: string; needs_review: boolean }>;
  preview_comment_status: string; formatting_progress: string; formatting_result: string; latest_error: string; updated_at: string;
  unresolved_block_count?: number; mixed_paragraph_count?: number;
  health_overall?: "PASS" | "WARN" | "FAIL" | ""; health_report?: string;
}
interface BuildInfo { build_id: string; plugin_version: string; asset_hash: string; }
interface RuntimeConfig { recognitionEndpoint: string; commandEndpoint: string; sessionToken: string; }
type BridgeWindow = Window & {
  DocxtoolBuildInfo?: BuildInfo;
  Application?: { PluginStorage?: StorageLike; GetTaskPane?: (id: number) => { Visible: boolean } | undefined };
  DocxtoolEarlyLogQueue?: DiagnosticEvent[];
  DocxtoolDiagnosticLogger?: LoopbackDiagnosticLogger;
  DocxtoolDiagnosticLog?: (level: DiagnosticLevel, component: string, event: string, message: string, data?: Record<string, unknown>, error?: unknown) => void;
};
const bridgeWindow = window as BridgeWindow;

const RESULT_KEY = "docxtool_classified_host_result_v1";
const REQUEST_KEY = "docxtool_classified_host_request_v1";
const CONFIG_KEY = "docxtool_classified_runtime_config";
const roles: Record<string, string> = { main_title: "主标题", title_continuation: "主标题续行", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", heading4: "四级标题", body: "正文", recipient: "称呼", attachment_note: "附件说明", attachment_title: "附件正文标题", signature_org: "落款署名", signature_date: "落款日期", unknown: "未知" };
let pendingRequestId = "";
let pendingStartedAt = 0;
let lastObservedRequestState = "";
let diagnosticLogger: LoopbackDiagnosticLogger | null = null;
const taskpaneEarlyQueue: DiagnosticEvent[] = [];
function taskpaneLog(level: DiagnosticLevel, event: string, message: string, data: Record<string, unknown> = {}, error?: unknown): void {
  try {
    if (diagnosticLogger) { diagnosticLogger.writeForComponent("taskpane", level, event, message, data, error); return; }
    const item: DiagnosticEvent = { timestamp: new Date().toISOString(), level, component: "taskpane", event, message, data, ...(error === undefined ? {} : { error: safeError(error) }) };
    taskpaneEarlyQueue.push(item);
    if (taskpaneEarlyQueue.length > 500) taskpaneEarlyQueue.splice(0, taskpaneEarlyQueue.length - 500);
  } catch { /* diagnostics never changes taskpane behavior */ }
}
taskpaneLog("INFO", "taskpane.module.loaded", "任务窗格工作流模块开始执行", { ready_state: document.readyState });
function node(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error("TASKPANE_ELEMENT_MISSING"); return value; }
function text(id: string, value: string): void { node(id).textContent = value; }
function parse<T>(value: string | null, label = "storage"): T | null { try { return value ? JSON.parse(value) as T : null; } catch (error) { taskpaneLog("WARN", "taskpane.storage.parse.failed", "任务窗格无法解析宿主状态", { storage_label: label }, error); return null; } }
function tryInstallTaskpaneLogger(): void {
  if (diagnosticLogger) return;
  const storage = bridgeWindow.Application?.PluginStorage;
  const build = bridgeWindow.DocxtoolBuildInfo;
  if (!storage || !build) return;
  const config = parse<RuntimeConfig>(storage.getItem(CONFIG_KEY), "runtime_config");
  if (!config) return;
  try {
    const hostContextId = new URLSearchParams(location.search).get("host_context") ?? "taskpane";
    diagnosticLogger = new LoopbackDiagnosticLogger({ endpoint: config.recognitionEndpoint, sessionToken: config.sessionToken, source: "taskpane", component: "taskpane", buildId: build.build_id, pluginVersion: build.plugin_version, hostContextId, sessionId: `pane-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`, minimumLevel: "DEBUG" });
    diagnosticLogger.adopt(taskpaneEarlyQueue);
    taskpaneEarlyQueue.splice(0, taskpaneEarlyQueue.length);
    bridgeWindow.DocxtoolDiagnosticLogger = diagnosticLogger;
    bridgeWindow.DocxtoolDiagnosticLog = (level, component, event, message, data, error) => diagnosticLogger?.writeForComponent(component, level, event, message, data, error);
    taskpaneLog("INFO", "taskpane.logger.installed", "任务窗格诊断日志客户端已安装", {});
    void diagnosticLogger.flush();
  } catch (error) { taskpaneLog("ERROR", "taskpane.logger.install.failed", "任务窗格诊断日志客户端安装失败", {}, error); }
}
function request(commandName: HostCommandName): void {
  const started = Date.now();
  tryInstallTaskpaneLogger();
  const storage = bridgeWindow.Application?.PluginStorage; const build = bridgeWindow.DocxtoolBuildInfo;
  if (!storage || !build) {
    taskpaneLog("ERROR", "taskpane.request.persist.failed", "任务窗格桥接尚未就绪", { command_name: commandName, plugin_storage_available: Boolean(storage), build_info_available: Boolean(build), stable_error_code: "TASKPANE_BRIDGE_NOT_READY", duration_ms: Date.now() - started });
    text("issues", "TASKPANE_BRIDGE_NOT_READY：主上下文通信尚未就绪。"); return;
  }
  pendingRequestId = `pane-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  pendingStartedAt = Date.now();
  lastObservedRequestState = "created";
  taskpaneLog("INFO", "taskpane.request.created", "任务窗格命令请求已创建", { command_name: commandName, request_id: pendingRequestId, correlation_id: pendingRequestId, build_id: build.build_id, plugin_storage_available: true });
  try {
    storage.setItem(REQUEST_KEY, JSON.stringify({ schema_version: 1, request_id: pendingRequestId, command_name: commandName, taskpane_build_id: build.build_id, created_at: new Date().toISOString() }));
    taskpaneLog("INFO", "taskpane.request.persisted", "任务窗格命令请求已写入 PluginStorage", { command_name: commandName, request_id: pendingRequestId, correlation_id: pendingRequestId, duration_ms: Date.now() - started });
    text("workflow-status", "命令已发送，等待 WPS 主上下文处理…");
  } catch (error) {
    taskpaneLog("ERROR", "taskpane.request.persist.failed", "任务窗格命令请求写入失败", { command_name: commandName, request_id: pendingRequestId, correlation_id: pendingRequestId, stable_error_code: "TASKPANE_REQUEST_PERSIST_FAILED", duration_ms: Date.now() - started }, error);
    text("issues", "TASKPANE_REQUEST_PERSIST_FAILED：命令未能发送到 WPS 主上下文。");
    pendingRequestId = ""; pendingStartedAt = 0;
  }
}
function closeTaskPane(): void {
  const application = bridgeWindow.Application; const storage = application?.PluginStorage;
  if (!application?.GetTaskPane || !storage) { taskpaneLog("ERROR", "taskpane.hide.failed", "无法取得 WPS 任务窗格 API", { stable_error_code: "TASKPANE_BRIDGE_NOT_READY" }); text("issues", "TASKPANE_BRIDGE_NOT_READY：无法取得 WPS 任务窗格 API。"); return; }
  try { const saved = storage.getItem("docxtool_classified_taskpane"); if (!saved) return; const pane = application.GetTaskPane(Number(saved)); if (!pane) { storage.setItem("docxtool_classified_taskpane", ""); return; } pane.Visible = false; taskpaneLog("INFO", "taskpane.hide.success", "任务窗格已隐藏", {}); }
  catch (error) { taskpaneLog("ERROR", "taskpane.hide.failed", "WPS 未能关闭任务窗格", { stable_error_code: "TASKPANE_HIDE_FAILED" }, error); text("issues", "TASKPANE_HIDE_FAILED：WPS 未能关闭任务窗格。"); }
}
function rows(id: string, values: string[]): void { node(id).replaceChildren(...values.map((value) => { const row = document.createElement("div"); row.className = "row"; row.textContent = value; return row; })); }
function issueText(state: HostState): string {
  if (state.latest_error === "MIXED_PARAGRAPH_REQUIRES_SPLIT") return `检测到 ${state.mixed_paragraph_count ?? 0} 个物理段落包含多个角色。预览批注已按文字范围分别标出；请先拆分这些段落，再执行一键排版。`;
  if (state.latest_error === "RECOGNITION_LOCATOR_UNVERIFIED") return `有 ${state.unresolved_block_count ?? 0} 个识别块无法证明原文位置。系统没有猜测定位，请根据预览批注复核。`;
  if (state.latest_error === "RECOGNITION_LOCATOR_AMBIGUOUS") return `有 ${state.unresolved_block_count ?? 0} 个识别块存在重复位置歧义。系统没有猜测定位，请根据预览批注复核。`;
  return state.latest_error ? errorText(state.latest_error) : "暂无问题。";
}
function workflowText(state: HostState): string {
  const failed = state.active_command?.status === "FAIL" ? state.active_command.error_code : "";
  if (failed) return `失败：${errorMessage(failed)}`;
  return state.formatting_progress || state.command_status || "就绪";
}
function render(state: HostState): void {
  const build = bridgeWindow.DocxtoolBuildInfo; const expected = new URLSearchParams(location.search).get("host_build");
  if (!build || state.build_id !== build.build_id || (expected && expected !== build.build_id)) { const warning = node("context-warning"); warning.hidden = false; warning.textContent = "ADDIN_CONTEXT_STALE：当前 WPS 加载的是旧版 Docxtool，请关闭全部 WPS 窗口后重新打开。"; return; }
  text("recognition-summary", state.recognition_summary || "等待识别。");
  rows("recognition-rows", state.paragraph_recognition_models.map((item) => `段落 ${item.paragraph_index + 1} · ${roles[item.recognized_type] ?? "未知"} · 置信度 ${Math.round(item.confidence * 100)}%${item.needs_review ? " · 需要复核" : ""}`));
  text("preview-summary", state.preview_comment_status || "不会写入格式；空段落不添加批注。");
  rows("preview-rows", state.formatting_preview_models.map((item) => `段落 ${item.paragraph_index + 1} · ${roles[item.recognized_type] ?? "未知"} · ${item.plan}${item.needs_review ? " · 需要复核" : ""}`));
  text("workflow-status", workflowText(state)); text("execution-result", state.formatting_result || ""); text("issues", issueText(state));
  text("health-summary", state.health_report || "尚未运行功能检测。");
  document.body.dataset.activeView = state.active_view;
}
let lastUpdated = "";
function poll(): void {
  tryInstallTaskpaneLogger();
  const storage = bridgeWindow.Application?.PluginStorage; if (!storage) return;
  const state = parse<HostState>(storage.getItem(RESULT_KEY), "host_result");
  if (state && state.updated_at !== lastUpdated) {
    lastUpdated = state.updated_at;
    taskpaneLog("DEBUG", "taskpane.host_state.changed", "任务窗格观察到 Host 状态变化", { build_id: state.build_id, command_status: state.command_status, active_view: state.active_view, stable_error_code: state.latest_error || "" });
    taskpaneLog("DEBUG", "taskpane.render.start", "开始渲染任务窗格状态", { build_id: state.build_id, command_status: state.command_status, active_view: state.active_view });
    try { render(state); taskpaneLog("DEBUG", "taskpane.render.success", "任务窗格状态渲染完成", { build_id: state.build_id, command_status: state.command_status, active_view: state.active_view }); }
    catch (error) { taskpaneLog("ERROR", "taskpane.render.failed", "任务窗格状态渲染失败", { build_id: state.build_id, stable_error_code: "TASKPANE_RENDER_FAILED" }, error); }
  }
  if (pendingRequestId) {
    const queued = parse<{ request_id?: string }>(storage.getItem(REQUEST_KEY), "host_request");
    const active = state?.active_command;
    const observed = queued?.request_id === pendingRequestId ? "queued" : active?.command_id === pendingRequestId ? `active:${active.status ?? "unknown"}` : "waiting";
    if (observed !== lastObservedRequestState) { lastObservedRequestState = observed; taskpaneLog("DEBUG", "taskpane.request.observed", "任务窗格命令状态已变化", { request_id: pendingRequestId, correlation_id: pendingRequestId, observed_state: observed }); }
    if (active?.command_id === pendingRequestId && active.status !== "RUNNING") { pendingRequestId = ""; pendingStartedAt = 0; }
    else if (Date.now() - pendingStartedAt >= 30_000) {
      taskpaneLog("ERROR", "taskpane.pending.timeout", "任务窗格命令等待 Host 消费超时", { request_id: pendingRequestId, correlation_id: pendingRequestId, stable_error_code: "HOST_COMMAND_TIMEOUT", duration_ms: Date.now() - pendingStartedAt });
      text("workflow-status", "HOST_COMMAND_TIMEOUT：WPS 主上下文未在 30 秒内处理命令。"); pendingRequestId = ""; pendingStartedAt = 0;
    } else text("workflow-status", "命令已发送，等待 WPS 主上下文处理…");
  }
}
taskpaneLog("INFO", "taskpane.dom.ready", "任务窗格 DOM 已可绑定", { ready_state: document.readyState });
for (const [elementId, command] of [["recognize-document", "recognize_document"], ["preview-document", "preview_document"], ["clear-preview", "clear_preview"], ["format-document", "format_document"], ["health-check", "health_check"]] as const) {
  node(elementId).addEventListener("click", () => { taskpaneLog("INFO", "taskpane.button.clicked", "任务窗格按钮已点击", { control_id: elementId, command_name: command }); request(command); });
  taskpaneLog("DEBUG", "taskpane.button.bound", "任务窗格按钮已绑定", { control_id: elementId, command_name: command });
}
node("close-taskpane").addEventListener("click", () => { taskpaneLog("INFO", "taskpane.button.clicked", "关闭任务窗格按钮已点击", { control_id: "close-taskpane", command_name: "close_taskpane" }); closeTaskPane(); });
taskpaneLog("DEBUG", "taskpane.button.bound", "关闭任务窗格按钮已绑定", { control_id: "close-taskpane", command_name: "close_taskpane" });
const build = bridgeWindow.DocxtoolBuildInfo; text("plugin-version", build?.plugin_version ?? "未知"); text("build-id", build?.build_id?.slice(0, 20) ?? "未知");
tryInstallTaskpaneLogger();
taskpaneLog("DEBUG", "taskpane.poll.started", "任务窗格 Host 状态轮询已启动", { interval_ms: 250 });
window.setInterval(poll, 250); poll();
