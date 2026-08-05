import { getClassifiedProductionComposition, type ClassifiedRuntimeConfig } from "./composition-root.js";
import type { FormattingCommandSet, RecognitionResult } from "../../../packages/contracts/src/index.js";
import { ClassifiedHealthChecker, type SafeHealthItem } from "./health-check.js";
import { errorMessage } from "./error-messages.js";
import type { DiagnosticEvent, DiagnosticLevel } from "../../../packages/diagnostics/src/index.js";
import { LocalCommandBus, type CommandReceipt, type LocalCommandName, type LocalCommandSource } from "./local-command-bus.js";

type HostCommandName = LocalCommandName | "show_about";
type HostCommandStatus = "RUNNING" | "PASS" | "FAIL" | "CANCELLED";
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface TaskPaneLike { ID: number | string; Visible: boolean; Delete?: () => void; Navigate?: (url: string) => void; Width?: number; DockPosition?: unknown; }
interface ApplicationLike { ActiveDocument?: { FullName?: string; Saved?: boolean; Save?: () => void; SaveCopyAs?: (path: string) => void; Paragraphs?: { Count?: number; Item?: (index: number) => { Range?: { Text?: string } } } }; PluginStorage: StorageLike; CreateTaskPane(url: string, title?: string): TaskPaneLike; GetTaskPane(id: number | string): TaskPaneLike; ribbonUI?: { InvalidateControl?: (id: string) => void }; Enum?: { JSKsoEnum_msoCTPDockPositionRight?: unknown }; FileSystem?: { Exists?: (path: string) => boolean; ReadFileString?: (path: string) => string; readFileString?: (path: string) => string }; Env?: { GetAppDataPath?: () => string }; }
interface BuildInfo { build_id: string; plugin_version: string; asset_hash: string; build_timestamp: string; }
interface CommandResult { command_id: string; command_name: HostCommandName; status: HostCommandStatus; stage: string; summary: string; error_code: string; started_at: string; finished_at: string; }
interface RecognitionModel { paragraph_index: number; recognized_type: string; confidence: number; needs_review: boolean; }
interface PreviewModel { paragraph_index: number; recognized_type: string; plan: string; needs_review: boolean; }
interface CallbackLog { callback_name: string; build_id: string; host_context: string; started_at: string; completed_at: string; status: "PASS" | "FAIL"; stable_error_code: string; }
interface HostState {
  schema_version: 1; build_id: string; asset_hash: string; host_context_id: string; document_identity_hash: string;
  active_command: CommandResult | null; command_status: HostCommandStatus | "IDLE"; active_view: "recognition" | "preview" | "execution" | "issues";
  recognition_summary: string; paragraph_recognition_models: RecognitionModel[]; formatting_preview_models: PreviewModel[];
  preview_comment_status: string; formatting_progress: string; formatting_result: string; latest_error: string;
  unresolved_block_count: number; mixed_paragraph_count: number;
  health_overall: "PASS" | "WARN" | "FAIL" | ""; health_report: string; health_items: SafeHealthItem[];
  callback_log: CallbackLog[]; updated_at: string;
}
interface BridgeRequest { schema_version: 1; request_id: string; command_name: HostCommandName; taskpane_build_id: string; created_at: string; }

type HostWindow = Window & {
  Application?: ApplicationLike; DocxtoolRuntimeConfig?: ClassifiedRuntimeConfig; DocxtoolBuildInfo?: BuildInfo;
  DocxtoolLocalRuntimeConfig?: Partial<ClassifiedRuntimeConfig>;
  DocxtoolDefaultProfile?: { page_setup?: { normal_east_asia_font_name?: string; normal_latin_font_name?: string }; styles?: Record<string, { east_asia_font_name?: string; latin_font_name?: string }> };
  DocxtoolTaskPanePath?: string;
  DocxtoolHostEnqueue?: (name: LocalCommandName, source?: LocalCommandSource) => CommandReceipt;
  DocxtoolCommandBusy?: boolean;
  DocxtoolHostRuntime?: { router: HostCommandRouter; panes: TaskPaneManager; store: HostResultStore; build: BuildInfo; };
  DocxtoolEarlyLogQueue?: DiagnosticEvent[];
  DocxtoolEarlyLog?: (level: DiagnosticLevel, component: string, event: string, message: string, data?: Record<string, unknown>, error?: unknown) => void;
  DocxtoolDiagnosticLog?: (level: DiagnosticLevel, component: string, event: string, message: string, data?: Record<string, unknown>, error?: unknown) => void;
  DocxtoolDiagnosticLogger?: { writeForComponent: (component: string, level: DiagnosticLevel, event: string, message: string, data?: Record<string, unknown>, error?: unknown) => void };
};
const hostWindow = globalThis as unknown as HostWindow;
function hostLog(level: DiagnosticLevel, event: string, message: string, data: Record<string, unknown> = {}, error?: unknown): void {
  try {
    if (hostWindow.DocxtoolDiagnosticLog) { hostWindow.DocxtoolDiagnosticLog(level, "host", event, message, data, error); return; }
    if (hostWindow.DocxtoolEarlyLog) { hostWindow.DocxtoolEarlyLog(level, "host", event, message, data, error); return; }
    const queue = hostWindow.DocxtoolEarlyLogQueue ?? [];
    queue.push({ timestamp: new Date().toISOString(), level, component: "host", event, message, data });
    if (queue.length > 500) queue.splice(0, queue.length - 500);
    hostWindow.DocxtoolEarlyLogQueue = queue;
  } catch { /* diagnostics never changes WPS host behavior */ }
}
hostLog("INFO", "host.module.loaded", "Host runtime 模块开始执行", { application_available: Boolean(hostWindow.Application), build_info_available: Boolean(hostWindow.DocxtoolBuildInfo), runtime_config_available: Boolean(hostWindow.DocxtoolRuntimeConfig) });

const RESULT_KEY = "docxtool_classified_host_result_v1";
const REQUEST_KEY = "docxtool_classified_host_request_v1";
const CONFIG_KEY = "docxtool_classified_runtime_config";
const PANE_KEY = "docxtool_classified_taskpane";
const roles: Record<string, string> = { main_title: "主标题", title_continuation: "主标题续行", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", heading4: "四级标题", body: "正文", recipient: "称呼", attachment_note: "附件说明", attachment_title: "附件正文标题", signature_org: "落款署名", signature_date: "落款日期", unknown: "未知" };
function now(): string { return new Date().toISOString(); }
function id(prefix: string): string { return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`; }
function stableError(error: unknown): string { const raw = error instanceof Error ? error.message : "HOST_COMMAND_FAILED"; if (/fetch|network/i.test(raw)) return "LOCAL_AGENT_UNAVAILABLE"; return /^[A-Z0-9_:.-]+$/.test(raw) ? raw : "HOST_COMMAND_FAILED"; }
async function hash(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join(""); }
function parse<T>(value: string | null): T | null { try { return value ? JSON.parse(value) as T : null; } catch { return null; } }
function formattingPlan(commands: FormattingCommandSet["commands"]): string {
  const font = commands.find((item) => item.kind === "paragraph.set_font"); const alignment = commands.find((item) => item.kind === "paragraph.set_alignment"); const indent = commands.find((item) => item.kind === "paragraph.set_indent"); const spacing = commands.find((item) => item.kind === "paragraph.set_spacing"); const values: string[] = [];
  if (font?.kind === "paragraph.set_font") values.push(`${font.arguments.east_asia_font_name}/${font.arguments.latin_font_name} ${font.arguments.font_size_pt}pt ${font.arguments.bold ? "粗体" : ""}`);
  if (alignment?.kind === "paragraph.set_alignment") values.push(`对齐:${alignment.arguments.alignment}`);
  if (indent?.kind === "paragraph.set_indent") values.push(`缩进:${indent.arguments.first_line_indent_chars}/${indent.arguments.left_indent_chars}/${indent.arguments.right_indent_chars}字符`);
  if (spacing?.kind === "paragraph.set_spacing") values.push(`段前后:${spacing.arguments.space_before_lines}/${spacing.arguments.space_after_lines}行 固定:${spacing.arguments.line_spacing_pt}pt`);
  return values.join("；") || "无可应用命令";
}

export class HostResultStore {
  private state: HostState;
  constructor(private readonly storage: StorageLike, private readonly build: BuildInfo, readonly hostContextId: string = crypto.randomUUID()) {
    const stored = parse<HostState>(storage.getItem(RESULT_KEY));
    this.state = stored?.build_id === build.build_id ? { ...stored, host_context_id: hostContextId, unresolved_block_count: stored.unresolved_block_count ?? 0, mixed_paragraph_count: stored.mixed_paragraph_count ?? 0, health_overall: stored.health_overall ?? "", health_report: stored.health_report ?? "", health_items: stored.health_items ?? [] } : { schema_version: 1, build_id: build.build_id, asset_hash: build.asset_hash, host_context_id: hostContextId, document_identity_hash: "", active_command: null, command_status: "IDLE", active_view: "execution", recognition_summary: "", paragraph_recognition_models: [], formatting_preview_models: [], preview_comment_status: "", formatting_progress: "就绪", formatting_result: "", latest_error: stored ? "ADDIN_CONTEXT_STALE" : "", unresolved_block_count: 0, mixed_paragraph_count: 0, health_overall: "", health_report: "", health_items: [], callback_log: [], updated_at: now() };
    this.save();
  }
  read(): HostState { return structuredClone(this.state); }
  update(patch: Partial<HostState>): void { this.state = { ...this.state, ...patch, updated_at: now() }; this.save(); }
  begin(name: HostCommandName, commandId: string, view: HostState["active_view"]): CommandResult { const result: CommandResult = { command_id: commandId, command_name: name, status: "RUNNING", stage: "started", summary: "", error_code: "", started_at: now(), finished_at: "" }; this.update({ active_command: result, command_status: "RUNNING", active_view: view, latest_error: "" }); return result; }
  finish(result: CommandResult, summary: string): CommandResult { const done = { ...result, status: "PASS" as const, stage: "completed", summary, finished_at: now() }; this.update({ active_command: done, command_status: "PASS", formatting_progress: summary }); return done; }
  fail(result: CommandResult, code: string): CommandResult { const done = { ...result, status: "FAIL" as const, stage: "failed", error_code: code, finished_at: now() }; this.update({ active_command: done, command_status: "FAIL", active_view: "issues", latest_error: code, formatting_progress: `失败：${errorMessage(code)}` }); return done; }
  callback(entry: CallbackLog): void { this.update({ callback_log: [...this.state.callback_log, entry].slice(-20) }); }
  private save(): void { this.storage.setItem(RESULT_KEY, JSON.stringify(this.state)); }
}

export class TaskPaneManager {
  private pane: TaskPaneLike | null = null;
  constructor(private readonly application: ApplicationLike, private readonly storage: StorageLike, private readonly url: string) {}
  get(): TaskPaneLike | null {
    if (this.pane) return this.pane;
    const saved = this.storage.getItem(PANE_KEY);
    if (!saved) return null;
    try { return this.pane = this.application.GetTaskPane(Number(saved)); }
    catch (error) { hostLog("WARN", "taskpane.lookup.failed", "Host runtime 读取已保存任务窗格失败", {}, error); this.storage.setItem(PANE_KEY, ""); return null; }
  }
  create(): TaskPaneLike {
    const existing = this.get();
    if (existing) return existing;
    try {
      const pane = this.application.CreateTaskPane(this.url, "Docxtool 涉密版");
      if (!pane) throw new Error("TASKPANE_CREATE_RETURNED_EMPTY");
      if (this.application.Enum?.JSKsoEnum_msoCTPDockPositionRight !== undefined) pane.DockPosition = this.application.Enum.JSKsoEnum_msoCTPDockPositionRight;
      pane.Width = 360;
      this.storage.setItem(PANE_KEY, String(pane.ID));
      return this.pane = pane;
    } catch (error) { hostLog("ERROR", "taskpane.create.failed", "Host runtime 创建任务窗格失败", { stable_error_code: "TASKPANE_CREATE_FAILED" }, error); throw new Error("TASKPANE_CREATE_FAILED"); }
  }
  show(): TaskPaneLike {
    const pane = this.create();
    try { pane.Visible = true; if (!pane.Visible) throw new Error("TASKPANE_VISIBLE_FALSE"); return pane; }
    catch (error) {
      hostLog("WARN", "taskpane.show.failed", "首次显示任务窗格失败，准备重建", {}, error);
      this.pane = null; this.storage.setItem(PANE_KEY, "");
      try { const replacement = this.create(); replacement.Visible = true; if (!replacement.Visible) throw new Error("TASKPANE_VISIBLE_FALSE"); return replacement; }
      catch (replacementError) { hostLog("ERROR", "taskpane.show.failed", "重建后仍无法显示任务窗格", { stable_error_code: "TASKPANE_SHOW_FAILED" }, replacementError); throw new Error("TASKPANE_SHOW_FAILED"); }
    }
  }
  hide(): void { const pane = this.get(); if (!pane) return; try { pane.Visible = false; } catch (error) { hostLog("ERROR", "taskpane.hide.failed", "隐藏任务窗格失败", { stable_error_code: "TASKPANE_HIDE_FAILED" }, error); throw new Error("TASKPANE_HIDE_FAILED"); } }
  toggle(): TaskPaneLike | null { const pane = this.get(); if (pane?.Visible) { this.hide(); return null; } return this.show(); }
  activate(): TaskPaneLike { return this.show(); }
  refresh(): void { const pane = this.get(); if (!pane) return; try { pane.Navigate?.(this.url); } catch (error) { hostLog("WARN", "taskpane.navigate.failed", "任务窗格导航失败，状态轮询继续工作", {}, error); } }
  dispose(): void { const pane = this.get(); if (pane) { try { pane.Delete?.(); } catch (error) { hostLog("DEBUG", "taskpane.dispose.failed", "WPS 已释放的任务窗格拒绝删除", {}, error); } } this.pane = null; this.storage.setItem(PANE_KEY, ""); }
}

export class HostCommandRouter {
  private readonly registry: Record<HostCommandName, (result: CommandResult) => Promise<string>>;
  constructor(private readonly app: ApplicationLike, private readonly panes: TaskPaneManager, private readonly store: HostResultStore, private readonly config: ClassifiedRuntimeConfig) {
    this.registry = { recognize_document: (result) => this.recognize(result), preview_document: (result) => this.preview(result), clear_preview: () => this.clearPreview(), format_document: (result) => this.format(result), health_check: () => this.health(), open_taskpane: async () => { this.panes.show(); return "任务窗格已打开"; }, close_taskpane: async () => { this.panes.hide(); return "任务窗格已关闭"; }, toggle_taskpane: async () => { const pane = this.panes.toggle(); return pane?.Visible ? "任务窗格已打开" : "任务窗格已关闭"; }, show_about: async () => { this.panes.show(); this.store.update({ active_view: "issues", latest_error: "Docxtool 涉密版，仅连接本机服务。" }); return "关于信息已显示"; } };
  }
  async dispatch(name: HostCommandName, source: LocalCommandSource | "e2e" = "ribbon", requestId = id("host"), taskpaneBuildId = this.store.read().build_id): Promise<CommandResult> {
    const started = now(); const startedMs = Date.now();
    const context = { correlation_id: requestId, request_id: requestId, command_id: requestId, command_name: name, source };
    hostLog("INFO", "host.router.dispatch.received", "HostCommandRouter 收到命令", context);
    if (!Object.prototype.hasOwnProperty.call(this.registry, name)) {
      const error = new Error("UNKNOWN_HOST_COMMAND");
      hostLog("ERROR", "host.router.dispatch.failed", "HostCommandRouter 拒绝未知命令", { ...context, stable_error_code: "UNKNOWN_HOST_COMMAND", duration_ms: Date.now() - startedMs }, error);
      throw error;
    }
    hostLog("DEBUG", "host.router.command.validated", "Host 命令名称验证通过", context);
    const view = name === "recognize_document" ? "recognition" : name === "preview_document" ? "preview" : name === "format_document" ? "execution" : name === "health_check" ? "issues" : this.store.read().active_view;
    const result = this.store.begin(name, requestId, view);
    try {
      if (taskpaneBuildId !== this.store.read().build_id) throw new Error("ADDIN_CONTEXT_STALE");
      hostLog("DEBUG", "host.router.build.checked", "任务窗格与 Host build 一致", { ...context, build_id: this.store.read().build_id });
      hostLog("INFO", "host.router.handler.start", "开始执行正式应用用例", context);
      const summary = await this.registry[name](result);
      hostLog("INFO", "host.router.handler.success", "正式应用用例执行完成", { ...context, duration_ms: Date.now() - startedMs });
      const done = this.store.finish(result, summary);
      this.store.callback({ callback_name: `${source}:${name}`, build_id: this.store.read().build_id, host_context: this.store.hostContextId, started_at: started, completed_at: now(), status: "PASS", stable_error_code: "" });
      hostLog("INFO", "host.router.dispatch.success", "HostCommandRouter 命令完成", { ...context, duration_ms: Date.now() - startedMs });
      return done;
    } catch (error) {
      const code = stableError(error); const failed = this.store.fail(result, code);
      this.store.callback({ callback_name: `${source}:${name}`, build_id: this.store.read().build_id, host_context: this.store.hostContextId, started_at: started, completed_at: now(), status: "FAIL", stable_error_code: code });
      hostLog("ERROR", "host.router.dispatch.failed", "HostCommandRouter 命令失败", { ...context, stable_error_code: code, duration_ms: Date.now() - startedMs }, error);
      return failed;
    }
  }
  supports(name: string): name is HostCommandName { return Object.prototype.hasOwnProperty.call(this.registry, name); }
  async reconcileActiveDocument(): Promise<void> {
    const current = await this.documentIdentity(); const state = this.store.read();
    if (state.document_identity_hash && state.document_identity_hash !== current) {
      // A preview tracker belongs to exactly one document.  Keep the comments
      // in that document, but never carry its in-memory cleanup session into
      // another open document.
      try { this.composition().previewTracker.clear(); }
      catch { /* document-switch cleanup must not require a ready formatting profile */ }
      this.store.update({ document_identity_hash: current, active_command: null, command_status: "IDLE", active_view: "recognition", recognition_summary: "", paragraph_recognition_models: [], formatting_preview_models: [], preview_comment_status: "", formatting_progress: "已切换文档，等待操作", formatting_result: "", latest_error: "", unresolved_block_count: 0, mixed_paragraph_count: 0, health_overall: "", health_report: "", health_items: [] });
    }
  }
  private composition() { return getClassifiedProductionComposition(this.config, hostWindow.DocxtoolDiagnosticLogger); }
  private async documentIdentity(): Promise<string> { const document = this.app.ActiveDocument; if (!document) throw new Error("ACTIVE_DOCUMENT_NOT_FOUND"); return hash(`${document.FullName ?? "unsaved"}|${document.Paragraphs?.Count ?? 0}`); }
  private async recognize(_result: CommandResult): Promise<string> { const identity = await this.documentIdentity(); const recognition = await this.composition().recognizeUseCase.execute(); const models = recognition.paragraphs.map((item) => ({ paragraph_index: item.source_paragraph_index, recognized_type: item.recognized_type, confidence: item.confidence, needs_review: item.needs_review })); const review = models.filter((item) => item.needs_review).length; this.store.update({ document_identity_hash: identity, paragraph_recognition_models: models, recognition_summary: `总段落 ${models.length}；需要复核 ${review}`, active_view: "recognition" }); return "识别完成"; }
  private async preview(result: CommandResult): Promise<string> {
    const started = Date.now();
    const context = { correlation_id: result.command_id, request_id: result.command_id, command_id: result.command_id, command_name: result.command_name };
    const document = this.app.ActiveDocument;
    const fullName = String(document?.FullName ?? "");
    const extension = fullName.match(/(\.[^./\\]+)$/)?.[1]?.toLowerCase() ?? "";
    const base = { ...context, document_available: Boolean(document), document_saved: Boolean(document?.Saved), document_extension: extension, paragraph_count: Number(document?.Paragraphs?.Count ?? 0) };
    hostLog("INFO", "preview.start", "预览排版流程开始", base);
    try {
      hostLog("DEBUG", "document.identity.start", "开始计算当前文档脱敏身份", base);
      const identity = await this.documentIdentity();
      hostLog("DEBUG", "document.identity.success", "当前文档脱敏身份计算完成", { ...base, document_identity_hash: identity });
      const useCaseRequestId = id("preview");
      hostLog("INFO", "preview.use_case.start", "开始调用 PreviewDocumentUseCase", { ...context, request_id: useCaseRequestId });
      const value = await this.composition().previewUseCase.execute(useCaseRequestId);
      hostLog("INFO", "preview.use_case.success", "PreviewDocumentUseCase 返回", { ...context, request_id: useCaseRequestId, recognition_paragraph_count: value.recognition.paragraphs.length, formatting_command_count: value.commands.commands.length, duration_ms: Date.now() - started });
      const count = value.summary.preview_comment_count ?? 0;
      const warningCount = value.summary.preview_warnings?.length ?? 0;
      hostLog(count > 0 ? "INFO" : "ERROR", "preview.comment.readback", "预览批注即时读回完成", { ...context, preview_comment_count: count, preview_warning_count: warningCount });
      if (count === 0) throw new Error(value.summary.preview_warnings?.[0] ?? "PREVIEW_COMMENT_READBACK_FAILED");
      const grouped = new Map<number, FormattingCommandSet["commands"]>();
      for (const command of value.commands.commands) {
        const list = grouped.get(command.target.source_paragraph_index) ?? [];
        list.push(command); grouped.set(command.target.source_paragraph_index, list);
      }
      hostLog("DEBUG", "preview.commands.grouped", "格式命令已按物理段落分组", { ...context, formatting_command_count: value.commands.commands.length, target_paragraph_count: grouped.size });
      const models = value.recognition.paragraphs.map((item) => ({ paragraph_index: item.source_paragraph_index, recognized_type: item.recognized_type, plan: formattingPlan(grouped.get(item.source_paragraph_index) ?? []), needs_review: item.needs_review }));
      const mixed = value.summary.mixed_paragraph_count;
      const unresolved = value.summary.unresolved_block_count;
      const notices = [`已创建 ${count} 条临时批注`];
      if (mixed) notices.push(`${mixed} 个物理段落包含多个角色，正式排版前需拆段`);
      if (unresolved) notices.push(`${unresolved} 个识别块无法证明位置，仅供复核`);
      this.store.update({ document_identity_hash: identity, formatting_preview_models: models, preview_comment_status: notices.join("；"), unresolved_block_count: unresolved, mixed_paragraph_count: mixed, active_view: "preview" });
      hostLog("DEBUG", "preview.store.updated", "预览结果已写入任务窗格状态", { ...context, preview_comment_count: count, mixed_paragraph_count: mixed, unresolved_block_count: unresolved });
      hostLog("INFO", "preview.success", "预览排版流程完成", { ...context, document_identity_hash: identity, recognition_paragraph_count: value.recognition.paragraphs.length, formatting_command_count: value.commands.commands.length, preview_comment_count: count, preview_warning_count: warningCount, mixed_paragraph_count: mixed, unresolved_block_count: unresolved, duration_ms: Date.now() - started });
      return "预览排版完成";
    } catch (error) {
      hostLog("ERROR", "preview.failed", "预览排版流程失败", { ...context, stable_error_code: stableError(error), duration_ms: Date.now() - started }, error);
      throw error;
    }
  }
  private async clearPreview(): Promise<string> { await this.composition().clearPreviewUseCase.execute(); this.store.update({ preview_comment_status: "预览批注已清除" }); return "预览批注已清除"; }
  private async format(_result: CommandResult): Promise<string> { const identity = await this.documentIdentity(); const value = await this.composition().formatUseCase.execute(id("format"), { onProgress: (_stage, detail) => this.store.update({ formatting_progress: detail ?? "处理中", active_view: "execution" }) }); const summary = `已执行 ${value.executed_command_ids.length} 项；跳过 ${value.skipped_command_ids.length} 项`; this.store.update({ document_identity_hash: identity, formatting_result: summary, preview_comment_status: "无 Docxtool 预览批注", active_view: "execution" }); return summary; }
  private async health(): Promise<string> {
    const state = this.store.read();
    const report = await new ClassifiedHealthChecker(
      this.app as unknown as Record<string, any>, this.config, hostWindow.DocxtoolBuildInfo,
      { build_id: state.build_id, asset_hash: state.asset_hash }, hostWindow.DocxtoolDefaultProfile,
      typeof hostWindow.DocxtoolHostEnqueue === "function" && hostWindow.DocxtoolHostRuntime?.router === this,
    ).run();
    this.store.update({ health_overall: report.overall, health_report: report.text, health_items: report.items, active_view: "issues", latest_error: report.overall === "PASS" ? "" : report.first_error_code });
    if (report.overall === "FAIL") throw new Error(report.first_error_code || "HEALTH_CHECK_FAILED");
    return `功能检测完成：${report.overall}`;
  }
}

function expandAppDataPath(application: ApplicationLike, value: string | undefined): string {
  if (!value) return "";
  const appData = application.Env?.GetAppDataPath?.();
  if (value.toUpperCase().startsWith("%APPDATA%") && appData) return appData.replace(/[\\/]+$/, "") + value.slice("%APPDATA%".length);
  return value;
}
function readRuntimeManifest(application: ApplicationLike, manifestPath: string): ClassifiedRuntimeConfig | null {
  const fs = application.FileSystem;
  const exists = fs?.Exists;
  const read = fs?.ReadFileString ?? fs?.readFileString;
  if (typeof exists !== "function" || typeof read !== "function" || !exists.call(fs, manifestPath)) return null;
  const manifest = parse<Record<string, unknown>>(read.call(fs, manifestPath));
  if (!manifest || typeof manifest.executable_path !== "string") return null;
  return {
    recognitionExecutablePath: expandAppDataPath(application, manifest.executable_path),
    runtimeVersion: typeof manifest.runtime_version === "string" ? manifest.runtime_version : "unknown",
    runtimeSha256: typeof manifest.sha256 === "string" ? manifest.sha256 : "",
    runtimeManifestPath: manifestPath,
  };
}
function runtimeConfig(application: ApplicationLike): ClassifiedRuntimeConfig {
  const stored = parse<ClassifiedRuntimeConfig>(application.PluginStorage.getItem(CONFIG_KEY));
  const direct = hostWindow.DocxtoolRuntimeConfig ?? hostWindow.DocxtoolLocalRuntimeConfig ?? stored;
  if (!direct) throw new Error("PRODUCTION_COMPOSITION_NOT_READY");
  const manifestPath = expandAppDataPath(application, direct.runtimeManifestPath);
  if (manifestPath) {
    const manifest = readRuntimeManifest(application, manifestPath);
    if (manifest) {
      application.PluginStorage.setItem(CONFIG_KEY, JSON.stringify(manifest));
      return manifest;
    }
  }
  if (typeof direct.recognitionExecutablePath === "string" && direct.recognitionExecutablePath) {
    const value = {
      recognitionExecutablePath: expandAppDataPath(application, direct.recognitionExecutablePath),
      runtimeVersion: direct.runtimeVersion || "unknown",
      runtimeSha256: direct.runtimeSha256 || "",
      runtimeManifestPath: manifestPath || direct.runtimeManifestPath,
    };
    application.PluginStorage.setItem(CONFIG_KEY, JSON.stringify(value));
    return value;
  }
  throw new Error("LOCAL_RUNTIME_CONFIGURATION_REQUIRED");
}
async function reportHostAcceptance(stage: string, status: "PASS" | "FAIL", errorCode = ""): Promise<void> {
  hostLog("DEBUG", "host.acceptance.local_only", "本地直连模式不向 9528 上报 E2E 状态", { stage, status, stable_error_code: errorCode });
}
async function runAutomaticHostAcceptance(application: ApplicationLike, router: HostCommandRouter, build: BuildInfo): Promise<void> {
  void application; void router; void build;
}
function installDiagnosticLogger(_config: ClassifiedRuntimeConfig, build: BuildInfo, hostContextId: string): void {
  const logger = {
    writeForComponent(component: string, level: DiagnosticLevel, event: string, message: string, data: Record<string, unknown> = {}, error?: unknown): void {
      const queue = hostWindow.DocxtoolEarlyLogQueue ?? [];
      queue.push({ timestamp: new Date().toISOString(), level, component, event, message, data, ...(error === undefined ? {} : { error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack ?? "" : "" } }) });
      if (queue.length > 500) queue.splice(0, queue.length - 500);
      hostWindow.DocxtoolEarlyLogQueue = queue;
    },
  };
  hostWindow.DocxtoolDiagnosticLogger = logger;
  hostWindow.DocxtoolDiagnosticLog = (level, component, event, message, data, error) => logger.writeForComponent(component, level, event, message, data, error);
  hostLog("INFO", "host.logger.installed", "本地直连诊断队列已安装", { build_id: build.build_id, host_context_id: hostContextId });
}
function install(application: ApplicationLike, build: BuildInfo, config: ClassifiedRuntimeConfig, hostContextId: string): void {
  installDiagnosticLogger(config, build, hostContextId);
  const store = new HostResultStore(application.PluginStorage, build, hostContextId); const paneUrl = `${new URL(hostWindow.DocxtoolTaskPanePath ?? "ui/taskpane.html", hostWindow.location.href)}?host_build=${encodeURIComponent(build.build_id)}&host_context=${encodeURIComponent(store.hostContextId)}`; const panes = new TaskPaneManager(application, application.PluginStorage, paneUrl); const router = new HostCommandRouter(application, panes, store, config);
  const bus = new LocalCommandBus(
    async (queued) => {
      await router.dispatch(queued.command_name, queued.source, queued.command_id, build.build_id);
    },
    (busy) => {
      hostWindow.DocxtoolCommandBusy = busy;
      const ribbon = application.ribbonUI as { InvalidateControl?: (id: string) => void } | undefined;
      ribbon?.InvalidateControl?.("preview");
      ribbon?.InvalidateControl?.("apply");
      ribbon?.InvalidateControl?.("health");
    },
  );
  hostWindow.DocxtoolHostRuntime = { router, panes, store, build };
  hostWindow.DocxtoolHostEnqueue = (name, source = "ribbon") => bus.enqueue(name, source);
  void reportHostAcceptance("host_router_installed", "PASS");
  hostWindow.setInterval(() => { const request = parse<BridgeRequest>(application.PluginStorage.getItem(REQUEST_KEY)); if (!request) return; application.PluginStorage.setItem(REQUEST_KEY, ""); if (request.schema_version !== 1 || !router.supports(request.command_name) || request.command_name === "show_about") { store.update({ latest_error: "TASKPANE_MESSAGE_REJECTED", active_view: "issues" }); return; } bus.enqueue(request.command_name, "taskpane", request.request_id); }, 200);
  hostWindow.setInterval(() => { void router.reconcileActiveDocument().catch(() => { /* no active document is normal during WPS transitions */ }); }, 750);
  void runAutomaticHostAcceptance(application, router, build);
}
let installDone = false;
let installAttempt = 0;
let hostModuleReported = false;
let installTimer: number | undefined;
function tryInstall(): void {
  if (installDone) return;
  installAttempt += 1;
  const application = hostWindow.Application; const build = hostWindow.DocxtoolBuildInfo;
  let config: ClassifiedRuntimeConfig | null = null;
  if (application) {
    try { config = runtimeConfig(application); }
    catch (error) { if (stableError(error) !== "PRODUCTION_COMPOSITION_NOT_READY") hostLog("WARN", "host.install.config.failed", "读取 Host 运行时配置失败", { attempt: installAttempt, stable_error_code: stableError(error) }, error); }
  }
  const readiness = { attempt: installAttempt, application_available: Boolean(application), build_info_available: Boolean(build), runtime_config_available: Boolean(config), plugin_storage_available: Boolean(application?.PluginStorage), active_document_available: Boolean(application?.ActiveDocument), host_enqueue_before_install: typeof hostWindow.DocxtoolHostEnqueue === "function" };
  hostLog(installAttempt === 1 ? "INFO" : "DEBUG", "host.install.attempt", "检查 Host runtime 安装条件", readiness);
  if (!hostModuleReported) { hostModuleReported = true; void reportHostAcceptance("host_module_loaded", "PASS"); }
  if (!application || !build || !config) {
    if ([1, 20, 40, 60].includes(installAttempt)) hostLog(installAttempt === 1 ? "INFO" : "DEBUG", "host.install.waiting", "等待 WPS Application、构建信息和运行时配置", readiness);
    return;
  }
  const started = Date.now();
  try {
    hostLog("INFO", "host.install.start", "开始安装 HostCommandRouter", readiness);
    const hostContextId = crypto.randomUUID();
    install(application, build, config, hostContextId);
    installDone = true;
    if (installTimer !== undefined) hostWindow.clearInterval(installTimer);
    hostLog("INFO", "host.install.success", "HostCommandRouter 安装成功", { ...readiness, host_context_id: hostContextId, duration_ms: Date.now() - started });
  } catch (error) {
    const code = stableError(error);
    installDone = true;
    if (installTimer !== undefined) hostWindow.clearInterval(installTimer);
    hostLog("ERROR", "host.install.failed", "HostCommandRouter 安装失败", { ...readiness, stable_error_code: code, duration_ms: Date.now() - started }, error);
    void reportHostAcceptance("host_install", "FAIL", code);
    try { new HostResultStore(application.PluginStorage, build).update({ latest_error: code, active_view: "issues" }); }
    catch (storeError) { hostLog("ERROR", "host.install.state.failed", "Host 安装失败状态无法写入 PluginStorage", { stable_error_code: code }, storeError); }
  }
}
tryInstall();
installTimer = hostWindow.setInterval(tryInstall, 250);
(installTimer as unknown as { unref?: () => void }).unref?.();
