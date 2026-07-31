type HostCommandName = "recognize_document" | "preview_document" | "clear_preview" | "format_document" | "health_check" | "open_taskpane" | "close_taskpane" | "toggle_taskpane" | "show_about";
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface HostState {
  build_id: string; asset_hash: string; host_context_id: string; command_status: string; active_view: "recognition" | "preview" | "execution" | "issues";
  recognition_summary: string; paragraph_recognition_models: Array<{ paragraph_index: number; recognized_type: string; confidence: number; needs_review: boolean }>;
  formatting_preview_models: Array<{ paragraph_index: number; recognized_type: string; plan: string; needs_review: boolean }>;
  preview_comment_status: string; formatting_progress: string; formatting_result: string; latest_error: string; updated_at: string;
  unresolved_block_count?: number; mixed_paragraph_count?: number;
  health_overall?: "PASS" | "WARN" | "FAIL" | ""; health_report?: string;
}
interface BuildInfo { build_id: string; plugin_version: string; asset_hash: string; }
type BridgeWindow = Window & { DocxtoolBuildInfo?: BuildInfo; Application?: { PluginStorage?: StorageLike; GetTaskPane?: (id: number) => { Visible: boolean } | undefined } };
const bridgeWindow = window as BridgeWindow;

const RESULT_KEY = "docxtool_classified_host_result_v1";
const REQUEST_KEY = "docxtool_classified_host_request_v1";
const roles: Record<string, string> = { main_title: "主标题", title_continuation: "主标题续行", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", heading4: "四级标题", body: "正文", recipient: "称呼", attachment_note: "附件说明", attachment_title: "附件正文标题", signature_org: "落款署名", signature_date: "落款日期", unknown: "未知" };
function node(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error("TASKPANE_ELEMENT_MISSING"); return value; }
function text(id: string, value: string): void { node(id).textContent = value; }
function parse<T>(value: string | null): T | null { try { return value ? JSON.parse(value) as T : null; } catch { return null; } }
function request(commandName: HostCommandName): void {
  const storage = bridgeWindow.Application?.PluginStorage; const build = bridgeWindow.DocxtoolBuildInfo;
  if (!storage || !build) { text("issues", "TASKPANE_BRIDGE_NOT_READY：主上下文通信尚未就绪。"); return; }
  storage.setItem(REQUEST_KEY, JSON.stringify({ schema_version: 1, request_id: `pane-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`, command_name: commandName, taskpane_build_id: build.build_id, created_at: new Date().toISOString() }));
  text("workflow-status", "请求已发送…");
}
function closeTaskPane(): void {
  const application = bridgeWindow.Application; const storage = application?.PluginStorage;
  if (!application?.GetTaskPane || !storage) { text("issues", "TASKPANE_BRIDGE_NOT_READY：无法取得 WPS 任务窗格 API。"); return; }
  try { const saved = storage.getItem("docxtool_classified_taskpane"); if (!saved) return; const pane = application.GetTaskPane(Number(saved)); if (!pane) { storage.setItem("docxtool_classified_taskpane", ""); return; } pane.Visible = false; }
  catch { text("issues", "TASKPANE_HIDE_FAILED：WPS 未能关闭任务窗格。"); }
}
function rows(id: string, values: string[]): void { node(id).replaceChildren(...values.map((value) => { const row = document.createElement("div"); row.className = "row"; row.textContent = value; return row; })); }
function issueText(state: HostState): string {
  if (state.latest_error === "MIXED_PARAGRAPH_REQUIRES_SPLIT") return `检测到 ${state.mixed_paragraph_count ?? 0} 个物理段落包含多个角色。预览批注已按文字范围分别标出；请先拆分这些段落，再执行一键排版。`;
  if (state.latest_error === "RECOGNITION_LOCATOR_UNVERIFIED") return `有 ${state.unresolved_block_count ?? 0} 个识别块无法证明原文位置。系统没有猜测定位，请根据预览批注复核。`;
  if (state.latest_error === "RECOGNITION_LOCATOR_AMBIGUOUS") return `有 ${state.unresolved_block_count ?? 0} 个识别块存在重复位置歧义。系统没有猜测定位，请根据预览批注复核。`;
  return state.latest_error || "暂无问题。";
}
function render(state: HostState): void {
  const build = bridgeWindow.DocxtoolBuildInfo; const expected = new URLSearchParams(location.search).get("host_build");
  if (!build || state.build_id !== build.build_id || (expected && expected !== build.build_id)) { const warning = node("context-warning"); warning.hidden = false; warning.textContent = "ADDIN_CONTEXT_STALE：当前 WPS 加载的是旧版 Docxtool，请关闭全部 WPS 窗口后重新打开。"; return; }
  text("recognition-summary", state.recognition_summary || "等待识别。");
  rows("recognition-rows", state.paragraph_recognition_models.map((item) => `段落 ${item.paragraph_index + 1} · ${roles[item.recognized_type] ?? "未知"} · 置信度 ${Math.round(item.confidence * 100)}%${item.needs_review ? " · 需要复核" : ""}`));
  text("preview-summary", state.preview_comment_status || "不会写入格式；空段落不添加批注。");
  rows("preview-rows", state.formatting_preview_models.map((item) => `段落 ${item.paragraph_index + 1} · ${roles[item.recognized_type] ?? "未知"} · ${item.plan}${item.needs_review ? " · 需要复核" : ""}`));
  text("workflow-status", state.formatting_progress || state.command_status || "就绪"); text("execution-result", state.formatting_result || ""); text("issues", issueText(state));
  text("health-summary", state.health_report || "尚未运行功能检测。");
  document.body.dataset.activeView = state.active_view;
}
let lastUpdated = "";
function poll(): void { const storage = bridgeWindow.Application?.PluginStorage; if (!storage) return; const state = parse<HostState>(storage.getItem(RESULT_KEY)); if (state && state.updated_at !== lastUpdated) { lastUpdated = state.updated_at; render(state); } }
for (const [id, command] of [["recognize-document", "recognize_document"], ["preview-document", "preview_document"], ["clear-preview", "clear_preview"], ["format-document", "format_document"], ["health-check", "health_check"]] as const) node(id).addEventListener("click", () => request(command));
node("close-taskpane").addEventListener("click", closeTaskPane);
const build = bridgeWindow.DocxtoolBuildInfo; text("plugin-version", build?.plugin_version ?? "未知"); text("build-id", build?.build_id?.slice(0, 20) ?? "未知");
window.setInterval(poll, 250); poll();
