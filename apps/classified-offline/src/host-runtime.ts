import { getClassifiedProductionComposition, type ClassifiedRuntimeConfig } from "./composition-root.js";
import type { FormattingCommandSet, RecognitionResult } from "../../../packages/contracts/src/index.js";
import { ClassifiedHealthChecker, type SafeHealthItem } from "./health-check.js";
import { errorMessage } from "./error-messages.js";
import type { DiagnosticEvent, DiagnosticLevel } from "../../../packages/diagnostics/src/index.js";
import { normalizeWpsPath, WpsLocalFileSystem, type WpsFileSystemApi } from "../../../packages/wps-adapter/src/local-filesystem.js";
import { WpsHostBridge } from "../../../packages/wps-adapter/src/host-bridge.js";
import { WpsCapabilityProvider } from "../../../packages/wps-adapter/src/official-host.js";
import { probeWorkerCapability, type WorkerCapability } from "./worker-capability.js";
import { PipelineWorkerClient, type SnapshotCommandReceipt } from "./pipeline-worker-client.js";
import type { PipelineCommand, PipelineWorkerEvent } from "../../../packages/threading/src/protocol.js";
import { safeError } from "../../../packages/diagnostics/src/index.js";
import { LocalHttpControlTransport } from "../../../packages/control-client/src/index.js";
type LocalCommandName = "recognize_document" | "preview_document" | "clear_preview" | "format_document" | "health_check" | "open_taskpane" | "close_taskpane" | "toggle_taskpane" | "probe_shell_execute_one_argument";
type LocalCommandSource = "ribbon" | "taskpane" | "test";
type LocalApplicationCommandName = LocalCommandName | "show_about";
type LocalApplicationCommandStatus = "RUNNING" | "PASS" | "FAIL" | "CANCELLED";
type PipelineCompletedEvent = Extract<PipelineWorkerEvent, { type: "pipeline.completed" }>;
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface TaskPaneLike { ID: number | string; Visible: boolean; Delete?: () => void; Navigate?: (url: string) => void; Width?: number; DockPosition?: unknown; }
interface WpsDocumentLike { FullName?: string; Saved?: boolean; Save?: () => void; SaveAs2?: (path: string, format?: number) => void; Close?: (saveChanges?: number) => void; Paragraphs?: { Count?: number; Item?: (index: number) => { Range?: { Text?: string } } }; }
interface ApplicationLike { ActiveDocument?: WpsDocumentLike; Documents?: { Open?: (path: string) => void }; PluginStorage: StorageLike; CreateTaskPane(url: string, title?: string): TaskPaneLike; GetTaskPane(id: number | string): TaskPaneLike; ribbonUI?: { InvalidateControl?: (id: string) => void }; Enum?: { JSKsoEnum_msoCTPDockPositionRight?: unknown }; FileSystem?: WpsFileSystemApi; Env?: { GetAppDataPath?: () => string }; }
interface BuildInfo { build_id: string; plugin_version: string; asset_hash: string; build_timestamp: string; }
interface CommandResult { command_id: string; command_name: LocalApplicationCommandName; status: LocalApplicationCommandStatus; stage: string; summary: string; error_code: string; started_at: string; finished_at: string; }
type ReviewLevel = RecognitionResult["paragraphs"][number]["review_level"];
interface RecognitionModel { paragraph_index: number; recognized_type: string; confidence: number; needs_review: boolean; review_level: ReviewLevel; mixed_structure: boolean; formatting_disposition: "apply" | "review_only"; }
interface PreviewModel { paragraph_index: number; recognized_type: string; plan: string; needs_review: boolean; review_level: ReviewLevel; mixed_structure: boolean; formatting_disposition: "apply" | "review_only"; }
interface CallbackLog { callback_name: string; build_id: string; host_context: string; started_at: string; completed_at: string; status: "PASS" | "FAIL"; stable_error_code: string; }
interface HostState {
  schema_version: 1; build_id: string; asset_hash: string; host_context_id: string; document_identity_hash: string;
  active_command: CommandResult | null; command_status: LocalApplicationCommandStatus | "IDLE"; active_view: "recognition" | "preview" | "execution" | "issues";
  recognition_summary: string; paragraph_recognition_models: RecognitionModel[]; formatting_preview_models: PreviewModel[];
  preview_comment_status: string; formatting_progress: string; formatting_result: string; latest_error: string;
  unresolved_block_count: number; mixed_paragraph_count: number;
  health_overall: "PASS" | "WARN" | "FAIL" | ""; health_report: string; health_items: SafeHealthItem[];
  callback_log: CallbackLog[]; updated_at: string;
}
interface BridgeRequest { schema_version: 1; request_id: string; command_name: LocalApplicationCommandName; taskpane_build_id: string; created_at: string; }

type HostWindow = Window & {
  Application?: ApplicationLike; DocxtoolRuntimeConfig?: ClassifiedRuntimeConfig; DocxtoolBuildInfo?: BuildInfo;
  DocxtoolLocalRuntimeConfig?: Partial<ClassifiedRuntimeConfig>;
  DocxtoolDefaultProfile?: { page_setup?: { normal_east_asia_font_name?: string; normal_latin_font_name?: string }; styles?: Record<string, { east_asia_font_name?: string; latin_font_name?: string }> };
  DocxtoolTaskPanePath?: string;
  DocxtoolVersionedAsset?: (asset: string) => string;
  DocxtoolWorkerCapability?: WorkerCapability;
  DocxtoolRunLocalCommand?: (name: LocalCommandName, source?: LocalCommandSource, requestId?: string) => Promise<CommandResult>;
  DocxtoolCommandBusy?: boolean;
  DocxtoolLocalApplication?: { runtime: LocalApplicationRuntime; panes: TaskPaneManager; store: HostResultStore; build: BuildInfo; pipeline: PipelineWorkerClient; };
  DocxtoolRunSnapshotShadow?: () => SnapshotCommandReceipt;
  DocxtoolCancelSnapshotShadow?: () => boolean;
  DocxtoolDevelopmentE2E?: { command: "preview_document" | "format_document" | "recognition_launch_probe" | "shell_execute_one_argument"; nonce: string };
  DocxtoolNativeLaunchProbe?: () => Promise<{ returned_in_ms: number }>;
  DocxtoolEarlyLogQueue?: DiagnosticEvent[];
  DocxtoolEarlyLog?: (level: DiagnosticLevel, component: string, event: string, message: string, data?: Record<string, unknown>, error?: unknown) => void;
  DocxtoolBootstrapLog?: (level: DiagnosticLevel, event: string, message: string, data?: Record<string, unknown>, error?: unknown, component?: string) => void;
  DocxtoolDiagnosticLog?: (level: DiagnosticLevel, component: string, event: string, message: string, data?: Record<string, unknown>, error?: unknown) => void;
  DocxtoolDiagnosticLogger?: { writeForComponent: (component: string, level: DiagnosticLevel, event: string, message: string, data?: Record<string, unknown>, error?: unknown) => void };
  confirm?: (message: string) => boolean;
};
const hostWindow = globalThis as unknown as HostWindow;
hostWindow.DocxtoolBootstrapLog?.("INFO", "host.module.loaded", "Host Runtime 经典脚本已执行", { application_available: Boolean(hostWindow.Application) }, undefined, "host");
let fallbackIdCounter = 0;
function diagnosticError(error: unknown): { name: string; message: string } {
  if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as { name?: unknown }).name === "string" && typeof (error as { message?: unknown }).message === "string" && !("stack" in error)) return error as { name: string; message: string };
  return safeError(error);
}
function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues === "function") { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }
  fallbackIdCounter += 1; return `${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}
function hostLog(level: DiagnosticLevel, event: string, message: string, data: Record<string, unknown> = {}, error?: unknown): void {
  try {
    const safe = error === undefined ? undefined : diagnosticError(error);
    if (hostWindow.DocxtoolDiagnosticLog) { hostWindow.DocxtoolDiagnosticLog(level, "host", event, message, data, safe); return; }
    if (hostWindow.DocxtoolEarlyLog) { hostWindow.DocxtoolEarlyLog(level, "host", event, message, data, safe); return; }
    const queue = hostWindow.DocxtoolEarlyLogQueue ?? [];
    const item: DiagnosticEvent = { timestamp: new Date().toISOString(), level, component: "host", event, message, data, ...(safe === undefined ? {} : { error: safe }) };
    queue.push(item);
    if (queue.length > 100) queue.splice(0, queue.length - 100);
    hostWindow.DocxtoolEarlyLogQueue = queue;
  } catch { /* diagnostics never changes WPS host behavior */ }
}
function controlFailureDetail(error: unknown): Record<string, unknown> {
  const transport = safeError(error);
  const cause = error instanceof Error && "cause" in error ? safeError((error as Error & { cause?: unknown }).cause) : null;
  const details = error instanceof Error && "details" in error && typeof (error as Error & { details?: unknown }).details === "object" ? (error as Error & { details: Record<string, unknown> }).details : {};
  const technical = [
    `transport=${transport.name}`,
    `message=${transport.message}`,
    ...Object.entries(details).map(([key, value]) => `${key}=${String(value)}`),
  ].filter(Boolean).join("; ");
  return { transport_error_name: transport.name, transport_error_message: transport.message, ...(cause ? { transport_cause_name: cause.name, transport_cause_message: cause.message } : {}), ...details, ...(details.stage ? { stage_cn: `服务端 DOCX 阶段：${String(details.stage)}` } : {}), ...(details.reason ? { reason_cn: `服务端诊断：${String(details.reason)}` } : {}), action_cn: "根据技术详情中的服务端阶段修复真实 DOCX 结构后重试", technical_detail: technical };
}
hostLog("INFO", "host.module.loaded", "Host runtime 模块开始执行", { application_available: Boolean(hostWindow.Application), build_info_available: Boolean(hostWindow.DocxtoolBuildInfo), runtime_config_available: Boolean(hostWindow.DocxtoolRuntimeConfig) });

const RESULT_KEY = "docxtool_classified_host_result_v1";
const REQUEST_KEY = "docxtool_classified_host_request_v1";
const CONFIG_KEY = "docxtool_classified_runtime_config";
const PANE_KEY = "docxtool_classified_taskpane";
const roles: Record<string, string> = { main_title: "主标题", title_continuation: "主标题续行", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", heading4: "四级标题", body: "正文", recipient: "称呼", role_name: "职务姓名", attachment_note: "附件说明", attachment_note_item: "附件说明续项", attachment_title: "附件正文标题", attachment_page_mark: "附件正文标记", attachment_body: "附件正文", caption: "对象标题", signature_org: "落款署名", signature_date: "落款日期", unknown: "未知" };
function now(): string { return new Date().toISOString(); }
function id(prefix: string): string { return `${prefix}-${Date.now().toString(36)}-${randomId().slice(0, 8)}`; }
function stableError(error: unknown): string { const raw = error instanceof Error ? error.message : "HOST_COMMAND_FAILED"; if (/path cannot contains/i.test(raw)) return "WPS_FILESYSTEM_PATH_REJECTED"; if (/fetch|network/i.test(raw)) return "LOCAL_AGENT_UNAVAILABLE"; return /^[A-Z0-9_:.-]+$/.test(raw) ? raw : "HOST_COMMAND_FAILED"; }
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
function recognitionModel(item: RecognitionResult["paragraphs"][number]): RecognitionModel {
  return { paragraph_index: item.source_paragraph_index, recognized_type: item.recognized_type, confidence: item.confidence, needs_review: item.needs_review, review_level: item.review_level, mixed_structure: item.mixed_structure, formatting_disposition: item.formatting_disposition };
}
function previewModel(item: RecognitionResult["paragraphs"][number], plan: string): PreviewModel {
  return { ...recognitionModel(item), plan };
}
function recognitionSummary(recognition: RecognitionResult): string {
  const unresolved = recognition.unresolved_blocks?.length ?? 0;
  const applicable = recognition.paragraphs.filter((item) => item.locator_verified && item.segment_count_total === item.segment_count_located).length;
  const mixed = new Set(recognition.paragraphs.filter((item) => item.mixed_structure).map((item) => item.physical_paragraph_index)).size;
  const review = recognition.paragraphs.filter((item) => item.review_level === "review" || item.review_level === "critical_review").length;
  return `总识别项 ${recognition.paragraphs.length + unresolved}；可应用 ${applicable}；其中混合结构 ${mixed}；识别建议复核 ${review}；未定位 ${unresolved}`;
}
export async function saveActiveDocument(application: Pick<ApplicationLike, "ActiveDocument">, force: boolean, phase: "before_format" | "after_format"): Promise<void> {
  const document = application.ActiveDocument;
  const fullName = String(document?.FullName ?? "");
  if (!document || !fullName.toLowerCase().endsWith(".docx")) throw new Error("DOCUMENT_MUST_BE_SAVED");
  if (!force && document.Saved === true) return;
  if (typeof document.Save !== "function") { hostLog("ERROR", "document.save.failed", "WPS 未提供当前文档保存方法", { phase, stable_error_code: "DOCUMENT_SAVE_FAILED" }); throw new Error("DOCUMENT_SAVE_FAILED"); }
  hostLog("INFO", "document.save.start", "开始保存当前 WPS 文档", { phase });
  try { document.Save(); }
  catch (error) { hostLog("ERROR", "document.save.failed", "WPS 文档保存失败", { phase, stable_error_code: "DOCUMENT_SAVE_FAILED" }, error); throw new Error("DOCUMENT_SAVE_FAILED", { cause: error }); }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (document.Saved === true) { hostLog("INFO", "document.save.completed", "当前 WPS 文档已保存", { phase }); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  hostLog("ERROR", "document.save.failed", "等待 WPS 文档保存完成超时", { phase, stable_error_code: "DOCUMENT_SAVE_FAILED" });
  throw new Error("DOCUMENT_SAVE_FAILED");
}

export class HostResultStore {
  private state: HostState;
  constructor(private readonly storage: StorageLike, private readonly build: BuildInfo, readonly hostContextId: string = randomId()) {
    const stored = parse<HostState>(storage.getItem(RESULT_KEY));
    this.state = stored?.build_id === build.build_id ? { ...stored, host_context_id: hostContextId, unresolved_block_count: stored.unresolved_block_count ?? 0, mixed_paragraph_count: stored.mixed_paragraph_count ?? 0, health_overall: stored.health_overall ?? "", health_report: stored.health_report ?? "", health_items: stored.health_items ?? [] } : { schema_version: 1, build_id: build.build_id, asset_hash: build.asset_hash, host_context_id: hostContextId, document_identity_hash: "", active_command: null, command_status: "IDLE", active_view: "execution", recognition_summary: "", paragraph_recognition_models: [], formatting_preview_models: [], preview_comment_status: "", formatting_progress: "就绪", formatting_result: "", latest_error: stored ? "ADDIN_CONTEXT_STALE" : "", unresolved_block_count: 0, mixed_paragraph_count: 0, health_overall: "", health_report: "", health_items: [], callback_log: [], updated_at: now() };
    this.save();
  }
  read(): HostState { return structuredClone(this.state); }
  update(patch: Partial<HostState>): void { this.state = { ...this.state, ...patch, updated_at: now() }; this.save(); }
  begin(name: LocalApplicationCommandName, commandId: string, view: HostState["active_view"]): CommandResult { const result: CommandResult = { command_id: commandId, command_name: name, status: "RUNNING", stage: "started", summary: "", error_code: "", started_at: now(), finished_at: "" }; this.update({ active_command: result, command_status: "RUNNING", active_view: view, latest_error: "" }); return result; }
  finish(result: CommandResult, summary: string): CommandResult { const done = { ...result, status: "PASS" as const, stage: "completed", summary, finished_at: now() }; this.update({ active_command: done, command_status: "PASS", formatting_progress: summary }); return done; }
  fail(result: CommandResult, code: string): CommandResult { const done = { ...result, status: "FAIL" as const, stage: "failed", error_code: code, finished_at: now() }; this.update({ active_command: done, command_status: "FAIL", active_view: "issues", latest_error: code, formatting_progress: `失败：${errorMessage(code)}` }); return done; }
  cancel(result: CommandResult, summary: string): CommandResult { const done = { ...result, status: "CANCELLED" as const, stage: "cancelled", summary, error_code: "", finished_at: now() }; this.update({ active_command: done, command_status: "CANCELLED", formatting_progress: summary, latest_error: "" }); return done; }
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

export class LocalApplicationRuntime {
  private readonly registry: Record<LocalApplicationCommandName, (result: CommandResult) => Promise<string>>;
  private pipelineStart?: (command: PipelineCommand) => SnapshotCommandReceipt;
  private pipelineRun?: (command: PipelineCommand) => Promise<PipelineCompletedEvent>;
  private threadedPreviewCleanup?: () => Promise<void>;
  constructor(private readonly app: ApplicationLike, private readonly panes: TaskPaneManager, private readonly store: HostResultStore, private readonly config: ClassifiedRuntimeConfig) {
    this.registry = { recognize_document: (result) => this.recognize(result), preview_document: (result) => this.preview(result), clear_preview: () => this.clearPreview(), format_document: (result) => this.format(result), health_check: () => this.health(), probe_shell_execute_one_argument: async () => { const value = await hostWindow.DocxtoolNativeLaunchProbe?.(); if (!value) throw new Error("LOCAL_LAUNCH_PROBE_UNAVAILABLE"); return `单参数 ShellExecute 返回 ${Math.round(value.returned_in_ms)} ms`; }, open_taskpane: async () => { this.panes.show(); return "任务窗格已打开"; }, close_taskpane: async () => { this.panes.hide(); return "任务窗格已关闭"; }, toggle_taskpane: async () => { const pane = this.panes.toggle(); return pane?.Visible ? "任务窗格已打开" : "任务窗格已关闭"; }, show_about: async () => { this.panes.show(); this.store.update({ active_view: "issues", latest_error: "Docxtool 涉密版，仅连接本机服务。" }); return "关于信息已显示"; } };
  }
  attachPipelineStarter(start: (command: PipelineCommand) => SnapshotCommandReceipt): void { this.pipelineStart = start; }
  attachPipelineRunner(run: (command: PipelineCommand) => Promise<PipelineCompletedEvent>): void { this.pipelineRun = run; }
  attachThreadedPreviewCleanup(cleanup: () => Promise<void>): void { this.threadedPreviewCleanup = cleanup; }
  async run(name: LocalApplicationCommandName, source: LocalCommandSource | "e2e" = "ribbon", requestId = id("local"), taskpaneBuildId = this.store.read().build_id): Promise<CommandResult> {
    const started = now(); const startedMs = Date.now();
    const context = { correlation_id: requestId, request_id: requestId, command_id: requestId, command_name: name, source };
    hostLog("INFO", "application.runtime.run.received", "本地应用运行时收到命令", context);
    if (!Object.prototype.hasOwnProperty.call(this.registry, name)) {
      const error = new Error("UNKNOWN_LOCAL_COMMAND");
      hostLog("ERROR", "application.runtime.run.failed", "本地应用运行时拒绝未知命令", { ...context, stable_error_code: "UNKNOWN_LOCAL_COMMAND", duration_ms: Date.now() - startedMs }, error);
      throw error;
    }
    hostLog("DEBUG", "application.runtime.command.validated", "本地命令名称验证通过", context);
    const view = name === "recognize_document" ? "recognition" : name === "preview_document" ? "preview" : name === "format_document" ? "execution" : name === "health_check" ? "issues" : this.store.read().active_view;
    const result = this.store.begin(name, requestId, view);
    try {
      if (taskpaneBuildId !== this.store.read().build_id) throw new Error("ADDIN_CONTEXT_STALE");
      hostLog("DEBUG", "application.runtime.build.checked", "调用方与本地运行时 build 一致", { ...context, build_id: this.store.read().build_id });
      hostLog("INFO", "application.runtime.use_case.start", "开始直接执行正式应用用例", context);
      const summary = await this.registry[name](result);
      hostLog("INFO", "application.runtime.use_case.success", "正式应用用例执行完成", { ...context, duration_ms: Date.now() - startedMs });
      const done = this.store.finish(result, summary);
      this.store.callback({ callback_name: `${source}:${name}`, build_id: this.store.read().build_id, host_context: this.store.hostContextId, started_at: started, completed_at: now(), status: "PASS", stable_error_code: "" });
      hostLog("INFO", "application.runtime.run.success", "本地应用命令执行完成", { ...context, duration_ms: Date.now() - startedMs });
      return done;
    } catch (error) {
      const code = stableError(error);
      if (code === "DOCUMENT_REPAIR_CANCELLED") {
        const cancelled = this.store.cancel(result, "用户取消文档修复，未执行排版");
        hostLog("INFO", "application.runtime.run.cancelled", "用户取消文档修复，当前排版操作已终止", { ...context, duration_ms: Date.now() - startedMs });
        return cancelled;
      }
      const failed = this.store.fail(result, code);
      this.store.callback({ callback_name: `${source}:${name}`, build_id: this.store.read().build_id, host_context: this.store.hostContextId, started_at: started, completed_at: now(), status: "FAIL", stable_error_code: code });
      hostLog("ERROR", "application.runtime.run.failed", "本地应用命令执行失败", { ...context, stable_error_code: code, duration_ms: Date.now() - startedMs }, error);
      return failed;
    }
  }
  supports(name: string): name is LocalApplicationCommandName { return Object.prototype.hasOwnProperty.call(this.registry, name); }
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
  private async recognize(_result: CommandResult): Promise<string> {
    this.panes.show();
    if (!this.pipelineRun) throw new Error("PIPELINE_RUNNER_NOT_READY");
    const event = await this.pipelineRun("recognize");
    if (!event.recognition_result) throw new Error("RECOGNITION_RESULT_MISSING");
    const identity = await this.documentIdentity();
    this.store.update({ document_identity_hash: identity, paragraph_recognition_models: event.recognition_result.paragraphs.map(recognitionModel), recognition_summary: recognitionSummary(event.recognition_result), active_view: "recognition", formatting_progress: "识别完成" });
    return "识别完成";
  }
  private async preview(_result: CommandResult): Promise<string> {
    const mode = this.config.threadedPreviewMode ?? (this.config.threadedPreviewEnabled === true ? "enabled" : "disabled");
    if (mode === "disabled") throw new Error("THREADED_PREVIEW_RECOGNITION_LAUNCH_BLOCKED");
    const command = mode === "diagnostic" ? "diagnostic" : "preview";
    const receipt = mode === "diagnostic" ? this.pipelineStart?.("diagnostic") : this.pipelineStart?.("preview");
    if (!receipt) throw new Error("PIPELINE_WORKER_NOT_READY");
    if (!receipt.accepted) throw new Error(receipt.reason ?? "PIPELINE_START_REJECTED");
    this.store.update({ active_view: mode === "diagnostic" ? "recognition" : "preview", formatting_progress: mode === "diagnostic" ? "诊断识别任务已提交，后台仅读取不写入" : "预览任务已提交，正在后台处理", preview_comment_status: mode === "diagnostic" ? "诊断模式：不会写入批注或格式" : "等待后台识别和批注", latest_error: "" });
    return mode === "diagnostic" ? "诊断识别任务已提交" : "预览任务已提交";
  }
  /** @deprecated Retained only for legacy equivalence tests; production routing never calls it. */
  private async legacyPreview(result: CommandResult): Promise<string> {
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
      const models = value.recognition.paragraphs.map((item) => previewModel(item, formattingPlan(grouped.get(item.source_paragraph_index) ?? [])));
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
  private async clearPreview(): Promise<string> { await this.composition().clearPreviewUseCase.execute(); await this.threadedPreviewCleanup?.(); this.store.update({ preview_comment_status: "预览批注已清除" }); return "预览批注已清除"; }
  private async format(_result: CommandResult): Promise<string> {
    let identity = await this.documentIdentity();
    let phase = "preview_preserved";
    hostLog("INFO", "format.lifecycle.start", "一键排版保存生命周期开始，保留现有预览批注", { phase, document_identity_hash: identity, preview_comments_policy: "preserve" });
    try {
      this.panes.show();
      phase = "save_before_format";
      await saveActiveDocument(this.app, false, "before_format");
      phase = "document_repair_preflight";
      if (await this.repairActiveDocument(identity)) identity = await this.documentIdentity();
      phase = "worker_format";
      hostLog("INFO", "format.worker.start", "开始执行 Worker 正式排版", { phase });
      if (!this.pipelineRun) throw new Error("PIPELINE_RUNNER_NOT_READY");
      const event = await this.pipelineRun("format");
      if (!event.format_result) throw new Error("FORMAT_RESULT_MISSING");
      phase = "save_after_format";
      await saveActiveDocument(this.app, true, "after_format");
      const splitSummary = event.format_result.created_paragraph_count ? `已拆分 ${event.format_result.split_source_paragraph_count} 个物理段落，新增 ${event.format_result.created_paragraph_count} 个结构段落；` : "";
      const normalizationSummary = event.format_result.trimmed_boundary_count || event.format_result.removed_empty_paragraph_count ? `清理 ${event.format_result.trimmed_boundary_count} 处结构边界，删除 ${event.format_result.removed_empty_paragraph_count} 个冗余空段；` : "";
      const summary = `${splitSummary}${normalizationSummary}已应用 ${event.format_result.executed_command_count} 条格式命令；跳过 ${event.format_result.skipped_command_count} 个识别项（未定位 ${event.format_result.skipped_unresolved_count}）`;
      hostLog("INFO", "format.lifecycle.completed", "一键排版保存生命周期完成，预览批注已保留", { phase, executed_command_count: event.format_result.executed_command_count, skipped_command_count: event.format_result.skipped_command_count, skipped_review_count: event.format_result.skipped_review_count, skipped_mixed_count: event.format_result.skipped_mixed_count, skipped_unresolved_count: event.format_result.skipped_unresolved_count, split_source_paragraph_count: event.format_result.split_source_paragraph_count, created_paragraph_count: event.format_result.created_paragraph_count, trimmed_boundary_count: event.format_result.trimmed_boundary_count, removed_empty_paragraph_count: event.format_result.removed_empty_paragraph_count, format_batch_count: event.format_result.batch_count, preview_comments_policy: "preserve" });
      this.store.update({ document_identity_hash: identity, formatting_result: summary, preview_comment_status: "预览批注已保留；如需删除请点击清除预览", active_view: "execution" });
      return summary;
    } catch (error) {
      hostLog("ERROR", "format.lifecycle.failed", "一键排版保存生命周期失败", { phase, stable_error_code: stableError(error), document_identity_hash: identity }, error);
      throw error;
    }
  }
  private async repairActiveDocument(documentIdentity: string): Promise<boolean> {
    const endpoint = this.config.controlEndpointManifest;
    if (!this.config.controlServerEnabled || !endpoint) {
      hostLog("ERROR", "document.repair.control_config.missing", "文档修复无法连接 WPS Control Server：当前 WPS 构建未收到控制服务配置", {
        stable_error_code: "CONTROL_SERVER_NOT_RUNNING",
        control_server_enabled: this.config.controlServerEnabled === true,
        control_endpoint_present: Boolean(endpoint),
        control_endpoint_port: endpoint?.port ?? 0,
        control_endpoint_instance_suffix: endpoint?.instance_id.slice(-8) ?? "",
      });
      throw new Error("CONTROL_SERVER_NOT_RUNNING");
    }
    const document = this.app.ActiveDocument;
    const sourcePath = String(document?.FullName ?? "");
    if (!document || !sourcePath.toLocaleLowerCase().endsWith(".docx")) {
      hostLog("ERROR", "document.repair.preflight.failed", "当前活动文档不满足自动修复条件", { stable_error_code: "DOCUMENT_MUST_BE_SAVED", stage_cn: "检查活动 DOCX", reason_cn: "活动文档不存在或尚未保存为本地 DOCX", active_document_available: Boolean(document), docx_extension_confirmed: sourcePath.toLocaleLowerCase().endsWith(".docx") });
      throw new Error("DOCUMENT_MUST_BE_SAVED");
    }
    const transport = new LocalHttpControlTransport(endpoint, { requestTimeoutMs: 30_000, maxHeartbeatAgeMs: Number.MAX_SAFE_INTEGER });
    hostLog("INFO", "document.repair.preflight.completed", "当前活动 DOCX 已通过自动修复前置检查", { result_cn: "成功", document_identity_hash: documentIdentity, document_saved: document.Saved === true, control_endpoint_port: endpoint.port, control_endpoint_instance_suffix: endpoint.instance_id.slice(-8) });
    hostLog("INFO", "document.repair.inspect.start", "开始向 Control Server 提交 DOCX 关系完整性检查", { document_identity_hash: documentIdentity, control_endpoint_port: endpoint.port, control_endpoint_instance_suffix: endpoint.instance_id.slice(-8) });
    let inspection;
    try {
      inspection = await transport.inspectDocumentRepair(sourcePath, documentIdentity);
    } catch (error) {
      hostLog("ERROR", "document.repair.inspect.failed", "当前 DOCX 关系完整性检查请求失败", { stable_error_code: stableError(error), control_endpoint_port: endpoint.port, control_endpoint_instance_suffix: endpoint.instance_id.slice(-8), ...controlFailureDetail(error) }, error);
      throw error;
    }
    hostLog("INFO", "document.repair.inspect.response", "Control Server 已返回 DOCX 关系检查结果", { result_cn: "成功", inspection_status: inspection.status, package_member_count: inspection.package_member_count, document_relationship_count: inspection.document_relationship_count, null_relationship_count: inspection.null_relationship_count, dangling_drawing_count: inspection.dangling_drawing_count, broken_relationship_count: inspection.status === "repair_required" ? inspection.broken_relationship_count : 0 });
    if (inspection.status === "clean") {
      hostLog("INFO", "document.repair.inspect.completed", "当前 DOCX 关系完整，无需修复", { result_cn: "成功", package_member_count: inspection.package_member_count, document_relationship_count: inspection.document_relationship_count });
      return false;
    }
    hostLog("WARN", "document.repair.required", "检测到当前 DOCX 存在可自动修复的损坏关系或悬空图片对象", { broken_relationship_count: inspection.broken_relationship_count, null_relationship_count: inspection.null_relationship_count, dangling_drawing_count: inspection.dangling_drawing_count, package_member_count: inspection.package_member_count, document_relationship_count: inspection.document_relationship_count });
    if (typeof hostWindow.confirm !== "function") {
      hostLog("ERROR", "document.repair.confirm.unavailable", "WPS 当前上下文无法显示文档修复确认框", { stable_error_code: "DOCUMENT_REPAIR_FAILED", stage_cn: "确认文档修复", reason_cn: "当前 WPS Host 没有提供 confirm 接口" });
      throw new Error("DOCUMENT_REPAIR_FAILED");
    }
    const accepted = hostWindow.confirm("检测到当前 DOCX 存在损坏关系。继续排版将保存、修复并重新打开当前文件。是否继续？");
    hostLog("INFO", accepted ? "document.repair.confirm.accepted" : "document.repair.confirm.cancelled", accepted ? "用户已确认修复当前 DOCX" : "用户已取消修复当前 DOCX", { broken_relationship_count: inspection.broken_relationship_count });
    if (!accepted) throw new Error("DOCUMENT_REPAIR_CANCELLED");
    if (typeof document.SaveAs2 !== "function" || typeof document.Close !== "function" || typeof this.app.Documents?.Open !== "function") {
      hostLog("ERROR", "document.repair.host_api.missing", "WPS 文档修复所需宿主接口不完整", { stable_error_code: "DOCUMENT_REPAIR_FAILED", stage_cn: "检查 WPS 文档切换接口", reason_cn: "SaveAs2、Close 或 Documents.Open 不可用", save_as_available: typeof document.SaveAs2 === "function", close_available: typeof document.Close === "function", open_available: typeof this.app.Documents?.Open === "function" });
      throw new Error("DOCUMENT_REPAIR_FAILED");
    }
    const bridgePath = sourcePath.replace(/\.docx$/i, `.docxtool-repairing-${inspection.repair_id.replaceAll("-", "").slice(0, 12)}.docx`);
    let bridged = false; let applied = false; let reopening = false; let repairPhase = "bridge_save";
    hostLog("INFO", "document.repair.bridge.start", "开始切换文档以释放原文件", { document_identity_hash: documentIdentity });
    try {
      hostLog("INFO", "document.repair.bridge.save.start", "开始将当前文档切换到临时桥接文件", { repair_id_suffix: inspection.repair_id.slice(-8) });
      try { document.SaveAs2(bridgePath, 12); }
      catch (error) { throw new Error("DOCUMENT_REPAIR_FAILED", { cause: error }); }
      bridged = true;
      hostLog("INFO", "document.repair.bridge.save.completed", "当前文档已另存为桥接文件", { result_cn: "成功", repair_id_suffix: inspection.repair_id.slice(-8) });
      repairPhase = "bridge_activate";
      try { await this.waitForActiveDocument(bridgePath); }
      catch (error) { throw new Error("DOCUMENT_REPAIR_FAILED", { cause: error }); }
      hostLog("INFO", "document.repair.bridge.active", "WPS 当前活动文档已切换到桥接文件", { result_cn: "成功" });
      repairPhase = "server_apply";
      hostLog("INFO", "document.repair.apply.start", "开始原子修复当前 DOCX", { broken_relationship_count: inspection.broken_relationship_count });
      const repair = await transport.applyDocumentRepair(inspection.repair_id);
      applied = true;
      hostLog("INFO", "document.repair.apply.completed", "Control Server 已完成 DOCX 原子修复", { result_cn: "成功", removed_relationship_count: repair.removed_relationship_count, removed_drawing_count: repair.removed_drawing_count });
      repairPhase = "source_reopen";
      reopening = true;
      hostLog("INFO", "document.repair.reopen.start", "开始重新打开修复后的原 DOCX", { repair_id_suffix: inspection.repair_id.slice(-8) });
      this.app.Documents.Open(sourcePath);
      await this.waitForActiveDocument(sourcePath);
      reopening = false;
      hostLog("INFO", "document.repair.reopen.completed", "修复后的原 DOCX 已重新打开", { result_cn: "成功" });
      repairPhase = "bridge_cleanup";
      document.Close(0);
      this.removeBridgeFile(bridgePath);
      hostLog("INFO", "document.repair.bridge.cleanup.completed", "桥接文档已关闭并清理", { result_cn: "成功" });
      repairPhase = "server_commit";
      hostLog("INFO", "document.repair.commit.start", "开始提交 DOCX 修复事务", { repair_id_suffix: inspection.repair_id.slice(-8) });
      await transport.completeDocumentRepair(inspection.repair_id, "commit");
      hostLog("INFO", "document.repair.commit.completed", "DOCX 修复事务已提交", { result_cn: "成功" });
      hostLog("INFO", "document.repair.completed", "当前 DOCX 已修复并重新打开", { result_cn: "成功", removed_relationship_count: repair.removed_relationship_count, removed_drawing_count: repair.removed_drawing_count });
      return true;
    } catch (error) {
      hostLog("ERROR", "document.repair.lifecycle.failed", "DOCX 修复生命周期在当前阶段失败", { repair_phase: repairPhase, stage_cn: `DOCX 修复阶段：${repairPhase}`, stable_error_code: stableError(error), bridged, applied, reopening, ...controlFailureDetail(error) }, error);
      if (applied) {
        try {
          hostLog("WARN", "document.repair.recovery.start", "开始恢复文档修复前的原文件", { failed_phase: repairPhase });
          if (normalizeWpsPath(String(this.app.ActiveDocument?.FullName ?? "")).toLocaleLowerCase() === normalizeWpsPath(sourcePath).toLocaleLowerCase()) this.app.ActiveDocument?.Close?.(0);
          await transport.completeDocumentRepair(inspection.repair_id, "restore");
          this.app.Documents.Open(sourcePath);
          await this.waitForActiveDocument(sourcePath);
          document.Close(0);
          this.removeBridgeFile(bridgePath);
          hostLog("INFO", "document.repair.recovery.completed", "文档修复失败后已恢复原文件并重新打开", { result_cn: "成功", failed_phase: repairPhase });
        } catch (recoveryError) {
          hostLog("ERROR", "document.repair.recovery.failed", "文档修复失败且自动恢复未完成", { stable_error_code: "DOCUMENT_REPAIR_RECOVERY_REQUIRED", failed_phase: repairPhase, ...controlFailureDetail(recoveryError) }, recoveryError);
          throw new Error("DOCUMENT_REPAIR_RECOVERY_REQUIRED", { cause: recoveryError });
        }
        const failureCode = reopening ? "DOCUMENT_REPAIR_REOPEN_FAILED" : stableError(error);
        throw new Error(failureCode.startsWith("DOCUMENT_REPAIR_") ? failureCode : "DOCUMENT_REPAIR_FAILED", { cause: error });
      }
      if (bridged) {
        try {
          hostLog("WARN", "document.repair.bridge.recovery.start", "修复尚未覆盖原文件，开始重新打开原 DOCX", { failed_phase: repairPhase });
          this.app.Documents.Open(sourcePath);
          await this.waitForActiveDocument(sourcePath);
          document.Close(0);
          this.removeBridgeFile(bridgePath);
          hostLog("INFO", "document.repair.bridge.recovery.completed", "原 DOCX 已重新打开，桥接文件已清理", { result_cn: "成功", failed_phase: repairPhase });
        } catch (recoveryError) {
          hostLog("ERROR", "document.repair.bridge.recovery.failed", "原文件未被覆盖，但 WPS 未能自动切回；桥接文件已保留", { stable_error_code: stableError(recoveryError), failed_phase: repairPhase, ...controlFailureDetail(recoveryError) }, recoveryError);
        }
      }
      throw error;
    }
  }
  private async waitForActiveDocument(expectedPath: string): Promise<void> {
    const expected = normalizeWpsPath(expectedPath).toLocaleLowerCase();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (normalizeWpsPath(String(this.app.ActiveDocument?.FullName ?? "")).toLocaleLowerCase() === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("DOCUMENT_REPAIR_REOPEN_FAILED");
  }
  private removeBridgeFile(path: string): void {
    if (!this.app.FileSystem) throw new Error("DOCUMENT_REPAIR_FAILED");
    const fs = new WpsLocalFileSystem(this.app.FileSystem);
    if (!fs.exists(path)) return;
    fs.removeFile(path);
    if (fs.exists(path)) throw new Error("DOCUMENT_REPAIR_FAILED");
  }
  private async health(): Promise<string> {
    const state = this.store.read();
    const report = await new ClassifiedHealthChecker(
      this.app as unknown as Record<string, any>, this.config, hostWindow.DocxtoolBuildInfo,
      { build_id: state.build_id, asset_hash: state.asset_hash }, hostWindow.DocxtoolDefaultProfile,
      typeof hostWindow.DocxtoolRunLocalCommand === "function" && hostWindow.DocxtoolLocalApplication?.runtime === this,
    ).run();
    this.store.update({ health_overall: report.overall, health_report: report.text, health_items: report.items, active_view: "issues", latest_error: report.overall === "PASS" ? "" : report.first_error_code });
    if (report.overall === "FAIL") throw new Error(report.first_error_code || "HEALTH_CHECK_FAILED");
    return `功能检测完成：${report.overall}`;
  }
}

function expandAppDataPath(application: ApplicationLike, value: string | undefined): string {
  if (!value) return "";
  const appData = application.Env?.GetAppDataPath?.();
  if (value.toUpperCase().startsWith("%APPDATA%") && appData) return normalizeWpsPath(appData.replace(/[\\/]+$/, "") + value.slice("%APPDATA%".length));
  return normalizeWpsPath(value);
}
function readRuntimeManifest(application: ApplicationLike, manifestPath: string): ClassifiedRuntimeConfig | null {
  const fs = application.FileSystem;
  if (!fs) return null;
  const adapter = new WpsLocalFileSystem(fs);
  const normalizedManifestPath = normalizeWpsPath(manifestPath);
  if (!adapter.exists(normalizedManifestPath)) return null;
  const manifest = parse<Record<string, unknown>>(adapter.readText(normalizedManifestPath));
  if (!manifest) return null;
  const currentPath = expandAppDataPath(application, "%APPDATA%\\Docxtool\\runtime\\current.json");
  const current = currentPath && adapter.exists(currentPath) ? parse<Record<string, unknown>>(adapter.readText(currentPath)) : null;
  const executablePath = typeof manifest.executable_path === "string"
    ? manifest.executable_path
    : typeof manifest.executable === "string" && manifest.executable.includes("\\")
      ? manifest.executable
      : "";
  if (!executablePath) return null;
  return {
    recognitionExecutablePath: expandAppDataPath(application, executablePath),
    brokerStatusPath: expandAppDataPath(application, typeof manifest.broker_status_path === "string" ? manifest.broker_status_path : "%APPDATA%\\Docxtool\\broker\\status.json"),
    brokerJobsPath: expandAppDataPath(application, typeof manifest.jobs_path === "string" ? manifest.jobs_path : "%APPDATA%\\Docxtool\\jobs"),
    runtimeVersion: typeof manifest.runtime_version === "string" ? manifest.runtime_version : typeof manifest.runtimeVersion === "string" ? manifest.runtimeVersion : "unknown",
    runtimeSha256: typeof manifest.executable_sha256 === "string" ? manifest.executable_sha256 : typeof manifest.sha256 === "string" ? manifest.sha256 : "",
    recognitionPackageVersion: typeof manifest.recognition_package_version === "string" ? manifest.recognition_package_version : typeof manifest.recognitionPackageVersion === "string" ? manifest.recognitionPackageVersion : undefined,
    contractVersion: typeof manifest.contract_version === "number" ? manifest.contract_version : typeof manifest.contractVersion === "number" ? manifest.contractVersion : undefined,
    brokerVersion: typeof current?.broker_version === "string" ? current.broker_version : typeof manifest.broker_version === "string" ? manifest.broker_version : undefined,
    brokerExecutablePathHash: typeof current?.broker_executable_path_hash === "string" ? current.broker_executable_path_hash : undefined,
    brokerExecutableSha256: typeof current?.broker_sha256 === "string" ? current.broker_sha256 : typeof manifest.broker_sha256 === "string" ? manifest.broker_sha256 : undefined,
    queueContractVersion: typeof current?.queue_contract_version === "number" ? current.queue_contract_version : typeof manifest.queue_contract_version === "number" ? manifest.queue_contract_version : typeof manifest.broker_contract_version === "number" ? manifest.broker_contract_version : undefined,
    runtimeManifestPath: normalizedManifestPath,
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
      const directMode = direct.threadedPreviewMode;
      manifest.threadedPreviewMode = directMode === "disabled" || directMode === "diagnostic" || directMode === "enabled" ? directMode : direct.threadedPreviewEnabled === true ? "enabled" : "disabled";
      manifest.threadedPreviewEnabled = manifest.threadedPreviewMode === "enabled";
      manifest.launchProbeExecutablePath = typeof direct.launchProbeExecutablePath === "string" ? expandAppDataPath(application, direct.launchProbeExecutablePath) : undefined;
      manifest.brokerStatusPath = typeof direct.brokerStatusPath === "string" ? expandAppDataPath(application, direct.brokerStatusPath) : manifest.brokerStatusPath;
      manifest.brokerJobsPath = typeof direct.brokerJobsPath === "string" ? expandAppDataPath(application, direct.brokerJobsPath) : manifest.brokerJobsPath;
      manifest.controlServerEnabled = direct.controlServerEnabled === true;
      manifest.controlEndpointManifest = direct.controlEndpointManifest;
      application.PluginStorage.setItem(CONFIG_KEY, JSON.stringify(manifest));
      return manifest;
    }
  }
  if (typeof direct.recognitionExecutablePath === "string" && direct.recognitionExecutablePath) {
    const value = {
      recognitionExecutablePath: expandAppDataPath(application, direct.recognitionExecutablePath),
      brokerStatusPath: typeof direct.brokerStatusPath === "string" ? expandAppDataPath(application, direct.brokerStatusPath) : undefined,
      brokerJobsPath: typeof direct.brokerJobsPath === "string" ? expandAppDataPath(application, direct.brokerJobsPath) : undefined,
      launchProbeExecutablePath: typeof direct.launchProbeExecutablePath === "string" ? expandAppDataPath(application, direct.launchProbeExecutablePath) : undefined,
      runtimeVersion: direct.runtimeVersion || "unknown",
      runtimeSha256: direct.runtimeSha256 || "",
      recognitionPackageVersion: direct.recognitionPackageVersion,
      contractVersion: direct.contractVersion,
      runtimeManifestPath: manifestPath || direct.runtimeManifestPath,
      threadedPreviewEnabled: direct.threadedPreviewEnabled === true,
      threadedPreviewMode: direct.threadedPreviewMode === "disabled" || direct.threadedPreviewMode === "diagnostic" || direct.threadedPreviewMode === "enabled" ? direct.threadedPreviewMode : direct.threadedPreviewEnabled === true ? "enabled" : "disabled",
      brokerVersion: direct.brokerVersion,
      brokerExecutablePathHash: direct.brokerExecutablePathHash,
      brokerExecutableSha256: direct.brokerExecutableSha256,
      queueContractVersion: direct.queueContractVersion,
      controlServerEnabled: direct.controlServerEnabled === true,
      controlEndpointManifest: direct.controlEndpointManifest,
    };
    application.PluginStorage.setItem(CONFIG_KEY, JSON.stringify(value));
    return value;
  }
  throw new Error("LOCAL_RUNTIME_CONFIGURATION_REQUIRED");
}
async function reportHostAcceptance(stage: string, status: "PASS" | "FAIL", errorCode = ""): Promise<void> {
  hostLog("DEBUG", "host.acceptance.local_only", "本地直连模式不向 9528 上报 E2E 状态", { stage, status, stable_error_code: errorCode });
}
async function runAutomaticHostAcceptance(application: ApplicationLike, runtime: LocalApplicationRuntime, build: BuildInfo): Promise<void> {
  void application; void runtime;
  const workerUrl = hostWindow.DocxtoolVersionedAsset?.("pipeline-worker-probe.js") ?? new URL("pipeline-worker-probe.js", hostWindow.location.href).toString();
  hostLog("INFO", "pipeline.worker.probe.start", "开始检测 WPS classic Worker 能力", { worker_url: "pipeline-worker-probe.js", build_id: build.build_id });
  const result = await probeWorkerCapability(workerUrl);
  hostWindow.DocxtoolWorkerCapability = result;
  hostLog(result.supported ? "INFO" : "ERROR", "pipeline.worker.probe.complete", result.supported ? "WPS classic Worker 能力检测通过" : "WPS classic Worker 能力检测失败", { worker_url: "pipeline-worker-probe.js", supported: result.supported, classic_worker: result.classic_worker, roundtrip_ms: result.roundtrip_ms, stable_error_code: result.error_code ?? "" });
  if (!result.supported) hostWindow.DocxtoolLocalApplication?.store.update({ latest_error: result.error_code ?? "WEB_WORKER_UNSUPPORTED", active_view: "issues" });
}
function installDiagnosticLogger(_config: ClassifiedRuntimeConfig, build: BuildInfo, hostContextId: string): void {
  const bootstrapLog = hostWindow.DocxtoolBootstrapLog;
  const logger = {
    writeForComponent(component: string, level: DiagnosticLevel, event: string, message: string, data: Record<string, unknown> = {}, error?: unknown): void {
      if (bootstrapLog) {
        bootstrapLog(level, event, message, data, error, component);
        return;
      }
      const queue = hostWindow.DocxtoolEarlyLogQueue ?? [];
      const item: DiagnosticEvent = { timestamp: new Date().toISOString(), level, component, event, message, build_id: build.build_id, data, ...(error === undefined ? {} : { error: diagnosticError(error) }) };
      queue.push(item);
      if (queue.length > 100) queue.splice(0, queue.length - 100);
      hostWindow.DocxtoolEarlyLogQueue = queue;
    },
  };
  hostWindow.DocxtoolDiagnosticLogger = logger;
  hostWindow.DocxtoolDiagnosticLog = (level, component, event, message, data, error) => logger.writeForComponent(component, level, event, message, data, error);
  hostLog("INFO", "host.logger.installed", "本地直连诊断队列已安装", { build_id: build.build_id, host_context_id: hostContextId });
}
function install(application: ApplicationLike, build: BuildInfo, config: ClassifiedRuntimeConfig, hostContextId: string): void {
  installDiagnosticLogger(config, build, hostContextId);
  const store = new HostResultStore(application.PluginStorage, build, hostContextId); application.PluginStorage.setItem("docxtool_classified_host_error_v1", ""); const paneUrl = `${new URL(hostWindow.DocxtoolTaskPanePath ?? "ui/taskpane.html", hostWindow.location.href)}?host_build=${encodeURIComponent(build.build_id)}&host_context=${encodeURIComponent(store.hostContextId)}`; const panes = new TaskPaneManager(application, application.PluginStorage, paneUrl); const runtime = new LocalApplicationRuntime(application, panes, store, config);
  let heartbeatTimer: number | undefined; let heartbeatExpected = 0; let heartbeatMaxDrift = 0;
  let running = false; let pipelineBusy = false; let activePipelineCommand: PipelineCommand | null = null;
  const pipelineWaiters = new Map<string, { resolve: (event: PipelineCompletedEvent) => void; reject: (error: Error) => void }>();
  const invalidate = () => { const ribbon = application.ribbonUI as { InvalidateControl?: (id: string) => void } | undefined; ribbon?.InvalidateControl?.("preview"); ribbon?.InvalidateControl?.("apply"); ribbon?.InvalidateControl?.("health"); };
  const startHeartbeat = () => { heartbeatMaxDrift = 0; heartbeatExpected = performance.now() + 50; if (heartbeatTimer !== undefined) hostWindow.clearInterval(heartbeatTimer); heartbeatTimer = hostWindow.setInterval(() => { const current = performance.now(); heartbeatMaxDrift = Math.max(heartbeatMaxDrift, Math.max(0, current - heartbeatExpected)); heartbeatExpected = current + 50; }, 50); };
  const stopHeartbeat = () => { if (heartbeatTimer !== undefined) hostWindow.clearInterval(heartbeatTimer); heartbeatTimer = undefined; return heartbeatMaxDrift; };
  const onPipelineEvent = (event: PipelineWorkerEvent) => {
    if (event.type === "pipeline.ready") { hostLog("INFO", "pipeline.worker.ready", "后台线程状态机已就绪", { build_id: event.build_id }); return; }
    if (event.type === "pipeline.diagnostic") {
      const failed = event.event.endsWith(".failed"); const control = event.event.startsWith("control.");
      const technical = failed ? Object.entries(event.data).map(([key, value]) => `${key}=${String(value)}`).join("; ") : "";
      hostLog(failed ? "ERROR" : control ? "INFO" : "DEBUG", event.event, failed ? "后台线程控制服务请求失败" : control ? "后台线程控制服务阶段完成" : "后台线程快照阶段事件", { ...event.data, ...(technical ? { technical_detail: technical } : {}) }); return;
    }
    if (event.type === "pipeline.progress") { store.update({ formatting_progress: event.detail }); hostLog("DEBUG", activePipelineCommand === "preview" ? "pipeline.preview.progress" : activePipelineCommand === "format" ? "pipeline.format.progress" : activePipelineCommand === "diagnostic" ? "pipeline.diagnostic.progress" : "worker.snapshot.shadow.progress", event.detail, { stage: event.stage, completed: event.completed, total: event.total, batch_size: event.batch_size }); return; }
    const mainThreadMaxDrift = stopHeartbeat();
    pipelineBusy = false; hostWindow.DocxtoolCommandBusy = running; invalidate();
    const current = store.read().active_command;
    if (event.type === "pipeline.completed" && event.command === "diagnostic" && event.recognition_result) {
      const recognition = event.recognition_result;
      const recognitionModels = recognition.paragraphs.map(recognitionModel);
      const unresolved = recognition.unresolved_blocks?.length ?? 0;
      const mixed = new Set(recognition.paragraphs.filter((item) => item.mixed_structure).map((item) => item.source_paragraph_index)).size;
      store.update({ command_status: "PASS", active_command: current ? { ...current, status: "PASS", stage: "completed", summary: "诊断识别完成（未写入）", finished_at: now() } : null, active_view: "recognition", recognition_summary: recognitionSummary(recognition), paragraph_recognition_models: recognitionModels, formatting_preview_models: [], preview_comment_status: "诊断模式：未写入批注或格式", formatting_progress: "诊断识别完成", formatting_result: "诊断模式未生成格式命令", latest_error: "", unresolved_block_count: unresolved, mixed_paragraph_count: mixed });
      hostLog("INFO", "pipeline.diagnostic.complete", "后台线程诊断识别完成（未写入）", { ...event.snapshot_summary, recognized_paragraph_count: recognition.paragraphs.length, unresolved_block_count: unresolved, mixed_paragraph_count: mixed, main_thread_max_drift_ms: mainThreadMaxDrift });
    } else if (event.type === "pipeline.completed" && event.command === "recognize" && event.recognition_result) {
      const recognition = event.recognition_result;
      store.update({ command_status: "PASS", active_command: current ? { ...current, status: "PASS", stage: "completed", summary: "识别完成", finished_at: now() } : null, active_view: "recognition", recognition_summary: recognitionSummary(recognition), paragraph_recognition_models: recognition.paragraphs.map(recognitionModel), formatting_progress: "识别完成", latest_error: "" });
      hostLog("INFO", "pipeline.recognition.complete", "后台线程识别完成", { ...event.snapshot_summary, recognized_paragraph_count: recognition.paragraphs.length, main_thread_max_drift_ms: mainThreadMaxDrift });
    } else if (event.type === "pipeline.completed" && event.command === "preview" && event.recognition_result && event.formatting_commands && event.preview_result) {
      const recognition = event.recognition_result; const commands = event.formatting_commands; const grouped = new Map<number, FormattingCommandSet["commands"]>();
      for (const command of commands.commands) { const values = grouped.get(command.target.source_paragraph_index) ?? []; values.push(command); grouped.set(command.target.source_paragraph_index, values); }
      const recognitionModels = recognition.paragraphs.map(recognitionModel);
      const previewModels = recognition.paragraphs.map((item) => previewModel(item, formattingPlan(grouped.get(item.source_paragraph_index) ?? [])));
      const unresolved = recognition.unresolved_blocks?.length ?? 0; const mixed = new Set(recognition.paragraphs.filter((item) => item.mixed_structure).map((item) => item.source_paragraph_index)).size;
      store.update({ command_status: "PASS", active_command: current ? { ...current, status: "PASS", stage: "completed", summary: "预览排版完成", finished_at: now() } : null, active_view: "preview", recognition_summary: recognitionSummary(recognition), paragraph_recognition_models: recognitionModels, formatting_preview_models: previewModels, preview_comment_status: `已创建 ${event.preview_result.comment_count} 条临时批注`, formatting_progress: "预览排版完成", formatting_result: `后台线程生成 ${commands.commands.length} 条格式命令`, latest_error: "", unresolved_block_count: unresolved, mixed_paragraph_count: mixed });
      hostLog("INFO", "pipeline.preview.complete", "后台线程正式预览完成", { ...event.snapshot_summary, preview_comment_count: event.preview_result.comment_count, formatting_command_count: commands.commands.length, main_thread_max_drift_ms: mainThreadMaxDrift });
    } else if (event.type === "pipeline.completed" && event.command === "format" && event.format_result) {
      store.update({ formatting_progress: "格式写入完成，正在保存", active_view: "execution", latest_error: "" });
      hostLog("INFO", "pipeline.format.complete", "后台线程正式排版写入完成", { ...event.snapshot_summary, executed_command_count: event.format_result.executed_command_count, skipped_command_count: event.format_result.skipped_command_count, skipped_review_count: event.format_result.skipped_review_count, skipped_mixed_count: event.format_result.skipped_mixed_count, skipped_unresolved_count: event.format_result.skipped_unresolved_count, split_source_paragraph_count: event.format_result.split_source_paragraph_count, created_paragraph_count: event.format_result.created_paragraph_count, trimmed_boundary_count: event.format_result.trimmed_boundary_count, removed_empty_paragraph_count: event.format_result.removed_empty_paragraph_count, format_batch_count: event.format_result.batch_count, main_thread_max_drift_ms: mainThreadMaxDrift });
    } else if (event.type === "pipeline.completed") { store.update({ formatting_progress: `后台线程快照完成：${event.snapshot_summary.paragraph_count} 段`, formatting_result: `快照 ${event.snapshot_summary.source_sha256_prefix}；Host RPC P95 ${event.snapshot_summary.p95_host_rpc_ms.toFixed(1)} ms` }); hostLog("INFO", "worker.snapshot.shadow.complete", "后台线程影子快照完成", { ...event.snapshot_summary, main_thread_max_drift_ms: mainThreadMaxDrift }); }
    else if (event.type === "pipeline.cancelled") { store.update({ command_status: "CANCELLED", active_command: current ? { ...current, status: "CANCELLED", stage: "cancelled", summary: "后台任务已取消", finished_at: now() } : null, formatting_progress: "后台任务已取消" }); hostLog("WARN", "pipeline.job.cancelled", "后台线程任务已取消", { command: activePipelineCommand ?? "", main_thread_max_drift_ms: mainThreadMaxDrift }); }
    else { store.update({ command_status: "FAIL", active_command: current ? { ...current, status: "FAIL", stage: "failed", summary: "后台任务失败", error_code: event.error.code, finished_at: now() } : null, formatting_progress: "后台线程任务失败", latest_error: event.error.code, active_view: "issues" }); hostLog("ERROR", "pipeline.job.failed", "后台线程任务失败", { command: activePipelineCommand ?? "", stable_error_code: event.error.code, main_thread_max_drift_ms: mainThreadMaxDrift }); }
    const waiter = "job_id" in event ? pipelineWaiters.get(event.job_id) : undefined;
    if (waiter && "job_id" in event) {
      pipelineWaiters.delete(event.job_id);
      if (event.type === "pipeline.completed") waiter.resolve(event);
      else waiter.reject(new Error(event.type === "pipeline.failed" ? event.error.code : "PIPELINE_CANCELLED"));
    }
    activePipelineCommand = null;
  };
  const debugProbeEnabled = ["127.0.0.1", "localhost"].includes(hostWindow.location.hostname);
  const hostBridge = new WpsHostBridge(application as unknown as Record<string, any>, hostWindow.DocxtoolDiagnosticLogger, { recognitionExecutablePath: config.recognitionExecutablePath, recognitionContractVersion: config.contractVersion ?? 1, brokerStatusPath: config.brokerStatusPath, brokerJobsPath: config.brokerJobsPath, brokerRuntimeVersion: config.runtimeVersion, brokerRuntimeSha256: config.runtimeSha256, brokerVersion: config.brokerVersion, brokerExecutablePathHash: config.brokerExecutablePathHash, brokerExecutableSha256: config.brokerExecutableSha256, brokerQueueContractVersion: config.queueContractVersion, probeExecutablePath: config.launchProbeExecutablePath, enableDebugProbes: debugProbeEnabled });
  runtime.attachThreadedPreviewCleanup(async () => { const result = await hostBridge.clearPreviewForCurrentDocument(); hostLog("INFO", "preview.cleanup.completed", "Worker 预览批注已清理", { deleted_count: result.deleted_count, user_comment_integrity: result.user_comment_integrity }); });
  hostWindow.DocxtoolNativeLaunchProbe = async () => {
    if (!debugProbeEnabled) throw new Error("HOST_DEBUG_PROBE_DISABLED");
    const response = await hostBridge.handle({ type: "host.rpc.request", operation: "host.probe_shell_execute_one_argument", rpc_id: id("launch-probe"), job_id: id("launch-probe-job"), build_id: build.build_id, payload: {} });
    if (!response.ok) throw new Error(response.error?.code ?? "LOCAL_LAUNCH_PROBE_FAILED");
    return response.value as { returned_in_ms: number };
  };
  const pipeline = new PipelineWorkerClient({ workerUrl: hostWindow.DocxtoolVersionedAsset?.("pipeline-worker.js") ?? new URL("pipeline-worker.js", hostWindow.location.href).toString(), bridge: hostBridge, buildId: build.build_id, workerConfig: { profile: hostWindow.DocxtoolDefaultProfile as unknown as import("../../../packages/threading/src/protocol.js").JsonValue, client_capabilities: new WpsCapabilityProvider().capabilities(), authorization_scope: "classified-offline" }, diagnostics: hostWindow.DocxtoolDiagnosticLogger, onEvent: onPipelineEvent });
  const startPipeline = (command: PipelineCommand) => { const receipt = pipeline.start(command); if (receipt.accepted) { activePipelineCommand = command; pipelineBusy = true; hostWindow.DocxtoolCommandBusy = true; startHeartbeat(); invalidate(); hostWindow.setTimeout(() => { const active = store.read().active_command; if (active) store.update({ command_status: "RUNNING", active_command: { ...active, status: "RUNNING", stage: "pipeline", summary: "后台线程处理中", finished_at: "" } }); }, 0); } return receipt; };
  runtime.attachPipelineStarter(startPipeline);
  runtime.attachPipelineRunner((command) => {
    const receipt = startPipeline(command);
    if (!receipt.accepted) return Promise.reject(new Error(receipt.reason ?? "PIPELINE_START_REJECTED"));
    return new Promise<PipelineCompletedEvent>((resolve, reject) => { pipelineWaiters.set(receipt.command_id, { resolve, reject }); });
  });
  hostWindow.DocxtoolLocalApplication = { runtime, panes, store, build, pipeline };
  hostWindow.DocxtoolRunSnapshotShadow = () => { const receipt = startPipeline("snapshot_shadow"); if (receipt.accepted) store.update({ formatting_progress: "后台线程快照：运行中" }); return receipt; };
  hostWindow.DocxtoolCancelSnapshotShadow = () => pipeline.cancelActiveJob();
  hostWindow.DocxtoolRunLocalCommand = async (name, source = "ribbon", requestId) => {
    const conflictsWithPipeline = ["recognize_document", "preview_document", "clear_preview", "format_document"].includes(name);
    if (running || (pipelineBusy && conflictsWithPipeline)) throw new Error("LOCAL_COMMAND_BUSY");
    running = true; hostWindow.DocxtoolCommandBusy = true; invalidate();
    try { return await runtime.run(name, source, requestId, build.build_id); }
    finally { running = false; hostWindow.DocxtoolCommandBusy = pipelineBusy; invalidate(); }
  };
  void reportHostAcceptance("local_application_runtime_installed", "PASS");
  hostWindow.setInterval(() => { const request = parse<BridgeRequest>(application.PluginStorage.getItem(REQUEST_KEY)); if (!request) return; application.PluginStorage.setItem(REQUEST_KEY, ""); if (request.schema_version !== 1 || !runtime.supports(request.command_name) || request.command_name === "show_about") { store.update({ latest_error: "TASKPANE_MESSAGE_REJECTED", active_view: "issues" }); return; } void hostWindow.DocxtoolRunLocalCommand?.(request.command_name, "taskpane", request.request_id).catch((error) => hostLog("ERROR", "application.runtime.taskpane.failed", "任务窗格本地命令执行失败", { stable_error_code: stableError(error) }, error)); }, 200);
  hostWindow.setInterval(() => { void runtime.reconcileActiveDocument().catch(() => { /* no active document is normal during WPS transitions */ }); }, 750);
  const developmentE2E = hostWindow.DocxtoolDevelopmentE2E;
  if (developmentE2E && ["127.0.0.1", "localhost"].includes(hostWindow.location.hostname)) hostWindow.setTimeout(() => {
    hostLog("INFO", "development.e2e.start", "受控开发 E2E 正在调用正式线程入口", { command: developmentE2E.command, nonce: developmentE2E.nonce });
    if (developmentE2E.command === "recognition_launch_probe") {
      const receipt = startPipeline("recognize");
      if (!receipt.accepted) hostLog("ERROR", "development.e2e.failed", "识别启动探针未能提交", { command: developmentE2E.command, stable_error_code: receipt.reason ?? "PIPELINE_START_REJECTED" });
      return;
    }
    if (developmentE2E.command === "shell_execute_one_argument") {
      void hostWindow.DocxtoolRunLocalCommand?.("probe_shell_execute_one_argument", "test", developmentE2E.nonce).catch((error) => hostLog("ERROR", "development.e2e.failed", "单参数 ShellExecute 探针执行失败", { command: developmentE2E.command, stable_error_code: stableError(error) }, error));
      return;
    }
    void hostWindow.DocxtoolRunLocalCommand?.(developmentE2E.command, "test", developmentE2E.nonce).catch((error) => hostLog("ERROR", "development.e2e.failed", "受控开发 E2E 调用失败", { command: developmentE2E.command, stable_error_code: stableError(error) }, error));
  }, 500);
  void runAutomaticHostAcceptance(application, runtime, build);
}
type InstallState = "waiting" | "installing" | "ready" | "retryable_failed" | "fatal";
const FATAL_INSTALL_ERROR_CODES = new Set(["LOCAL_RUNTIME_CONFIGURATION_REQUIRED", "PRODUCTION_COMPOSITION_CONFIG_MISMATCH"]);
let installAttempt = 0;
let hostModuleReported = false;
let installTimer: number | undefined;
let installState: InstallState = "waiting";
let lastConfigError = "";
let lastConfigErrorAt = 0;
function isFatalInstallError(errorCode: string): boolean { return FATAL_INSTALL_ERROR_CODES.has(errorCode); }
function stopInstallRetry(): void {
  if (installTimer === undefined) return;
  hostWindow.clearInterval(installTimer);
  installTimer = undefined;
}
function recordInstallFailure(application: ApplicationLike | undefined, build: BuildInfo | undefined, context: Record<string, unknown>, code: string, error: unknown): void {
  const fatal = isFatalInstallError(code);
  installState = fatal ? "fatal" : "retryable_failed";
  if (fatal) stopInstallRetry();
  hostLog("ERROR", fatal ? "application.install.fatal" : "application.install.failed", fatal ? "本地应用运行时存在不可恢复配置错误" : "本地应用运行时安装失败，将继续重试", { ...context, stable_error_code: code, install_state: installState, retry_scheduled: !fatal }, error);
  void reportHostAcceptance("host_install", "FAIL", code);
  if (!application || !build) return;
  try { new HostResultStore(application.PluginStorage, build).update({ latest_error: code, active_view: "issues" }); }
  catch (storeError) { hostLog("ERROR", "application.install.state.failed", "本地运行时失败状态无法写入 PluginStorage", { stable_error_code: code }, storeError); }
}
function tryInstall(): void {
  if (installState === "ready" || installState === "fatal" || installState === "installing") return;
  installAttempt += 1;
  const application = hostWindow.Application; const build = hostWindow.DocxtoolBuildInfo;
  let config: ClassifiedRuntimeConfig | null = null;
  if (application) {
    try { config = runtimeConfig(application); }
    catch (error) {
      const code = stableError(error);
      const nowMs = Date.now();
      if (code !== "PRODUCTION_COMPOSITION_NOT_READY" && (code !== lastConfigError || nowMs - lastConfigErrorAt >= 5_000)) {
        hostLog("WARN", "application.install.config.failed", "读取本地运行时配置失败", { attempt: installAttempt, stable_error_code: code }, error);
        lastConfigError = code;
        lastConfigErrorAt = nowMs;
      }
      if (isFatalInstallError(code)) {
        recordInstallFailure(application, build, { attempt: installAttempt, application_available: Boolean(application), build_info_available: Boolean(build), runtime_config_available: false }, code, error);
        return;
      }
    }
  }
  const readiness = { attempt: installAttempt, application_available: Boolean(application), build_info_available: Boolean(build), runtime_config_available: Boolean(config), plugin_storage_available: Boolean(application?.PluginStorage), active_document_available: Boolean(application?.ActiveDocument), local_runtime_before_install: typeof hostWindow.DocxtoolRunLocalCommand === "function", install_state: installState };
  if (installAttempt === 1 || installAttempt % 20 === 0) hostLog(installAttempt === 1 ? "INFO" : "DEBUG", "application.install.attempt", "检查本地应用运行时安装条件", readiness);
  if (!hostModuleReported) { hostModuleReported = true; void reportHostAcceptance("host_module_loaded", "PASS"); }
  if (!application || !build || !config) {
    installState = "waiting";
    if ([1, 20, 40, 60].includes(installAttempt)) hostLog(installAttempt === 1 ? "INFO" : "DEBUG", "application.install.waiting", "等待 WPS Application、构建信息和本地运行时配置", { ...readiness, install_state: installState });
    return;
  }
  installState = "installing";
  const installingReadiness = { ...readiness, install_state: installState };
  const started = Date.now();
  try {
    const endpoint = config.controlEndpointManifest;
    const controlReadiness = { control_server_enabled: config.controlServerEnabled === true, control_endpoint_present: Boolean(endpoint), control_endpoint_port: endpoint?.port ?? 0, control_endpoint_instance_suffix: endpoint?.instance_id.slice(-8) ?? "" };
    hostLog("INFO", "application.install.start", "开始安装本地应用运行时", { ...installingReadiness, ...controlReadiness });
    const hostContextId = randomId();
    install(application, build, config, hostContextId);
    installState = "ready";
    stopInstallRetry();
    hostLog("INFO", "application.install.success", "本地应用运行时安装成功", { ...installingReadiness, ...controlReadiness, install_state: installState, host_context_id: hostContextId, duration_ms: Date.now() - started });
  } catch (error) {
    recordInstallFailure(application, build, { ...installingReadiness, duration_ms: Date.now() - started }, stableError(error), error);
  }
}
function scheduleInstallRetry(): void {
  if (installTimer !== undefined || installState === "ready" || installState === "fatal") return;
  installTimer = hostWindow.setInterval(tryInstall, 250);
  (installTimer as unknown as { unref?: () => void }).unref?.();
}
tryInstall();
scheduleInstallRetry();
