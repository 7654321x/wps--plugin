import { getClassifiedProductionComposition, type ClassifiedRuntimeConfig } from "./composition-root.js";
import type { FormattingCommandSet, RecognitionResult } from "../../../packages/contracts/src/index.js";
import { ClassifiedHealthChecker, type SafeHealthItem } from "./health-check.js";
import { loadRealE2EPlan, runFormalRollbackProbe } from "./formal-e2e-usecase.js";
import { errorMessage } from "./error-messages.js";

type HostCommandName = "recognize_document" | "preview_document" | "clear_preview" | "format_document" | "health_check" | "open_taskpane" | "close_taskpane" | "toggle_taskpane" | "show_about";
type HostCommandStatus = "RUNNING" | "PASS" | "FAIL" | "CANCELLED";
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface TaskPaneLike { ID: number | string; Visible: boolean; Delete?: () => void; Navigate?: (url: string) => void; Width?: number; }
interface ApplicationLike { ActiveDocument?: { FullName?: string; Saved?: boolean; Save?: () => void; SaveCopyAs?: (path: string) => void; Paragraphs?: { Count?: number; Item?: (index: number) => { Range?: { Text?: string } } } }; PluginStorage: StorageLike; CreateTaskPane(url: string, title?: string): TaskPaneLike; GetTaskPane(id: number | string): TaskPaneLike; }
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
  DocxtoolDefaultProfile?: { page_setup?: { normal_east_asia_font_name?: string; normal_latin_font_name?: string }; styles?: Record<string, { east_asia_font_name?: string; latin_font_name?: string }> };
  DocxtoolTaskPanePath?: string;
  DocxtoolHostDispatch?: (name: HostCommandName, source?: "ribbon" | "taskpane" | "e2e", requestId?: string, taskpaneBuildId?: string) => Promise<CommandResult>;
  DocxtoolHostRuntime?: { router: HostCommandRouter; panes: TaskPaneManager; store: HostResultStore; build: BuildInfo; };
};
const hostWindow = globalThis as unknown as HostWindow;

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
  constructor(private readonly storage: StorageLike, private readonly build: BuildInfo, readonly hostContextId = crypto.randomUUID()) {
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
  get(): TaskPaneLike | null { if (this.pane) return this.pane; const saved = this.storage.getItem(PANE_KEY); if (!saved) return null; try { return this.pane = this.application.GetTaskPane(Number(saved)); } catch { this.storage.setItem(PANE_KEY, ""); return null; } }
  create(): TaskPaneLike { const existing = this.get(); if (existing) return existing; try { const pane = this.application.CreateTaskPane(this.url, "Docxtool 涉密版"); pane.Width = 420; this.storage.setItem(PANE_KEY, String(pane.ID)); return this.pane = pane; } catch { throw new Error("TASKPANE_CREATE_FAILED"); } }
  show(): TaskPaneLike { const pane = this.create(); try { pane.Visible = true; if (!pane.Visible) throw new Error(); return pane; } catch { this.pane = null; this.storage.setItem(PANE_KEY, ""); try { const replacement = this.create(); replacement.Visible = true; if (!replacement.Visible) throw new Error(); return replacement; } catch { throw new Error("TASKPANE_SHOW_FAILED"); } } }
  hide(): void { const pane = this.get(); if (!pane) return; try { pane.Visible = false; } catch { throw new Error("TASKPANE_HIDE_FAILED"); } }
  toggle(): TaskPaneLike | null { const pane = this.get(); if (pane?.Visible) { this.hide(); return null; } return this.show(); }
  activate(): TaskPaneLike { return this.show(); }
  refresh(): void { const pane = this.get(); if (!pane) return; try { pane.Navigate?.(this.url); } catch { /* state polling still refreshes the view */ } }
  dispose(): void { const pane = this.get(); if (pane) { try { pane.Delete?.(); } catch { /* a disposed WPS pane may throw */ } } this.pane = null; this.storage.setItem(PANE_KEY, ""); }
}

export class HostCommandRouter {
  private readonly registry: Record<HostCommandName, (result: CommandResult) => Promise<string>>;
  constructor(private readonly app: ApplicationLike, private readonly panes: TaskPaneManager, private readonly store: HostResultStore, private readonly config: ClassifiedRuntimeConfig) {
    this.registry = { recognize_document: (result) => this.recognize(result), preview_document: (result) => this.preview(result), clear_preview: () => this.clearPreview(), format_document: (result) => this.format(result), health_check: () => this.health(), open_taskpane: async () => { this.panes.show(); return "任务窗格已打开"; }, close_taskpane: async () => { this.panes.hide(); return "任务窗格已关闭"; }, toggle_taskpane: async () => { const pane = this.panes.toggle(); return pane?.Visible ? "任务窗格已打开" : "任务窗格已关闭"; }, show_about: async () => { this.panes.show(); this.store.update({ active_view: "issues", latest_error: "Docxtool 涉密版，仅连接本机服务。" }); return "关于信息已显示"; } };
  }
  async dispatch(name: HostCommandName, source: "ribbon" | "taskpane" | "e2e" = "ribbon", requestId = id("host"), taskpaneBuildId = this.store.read().build_id): Promise<CommandResult> {
    if (!Object.prototype.hasOwnProperty.call(this.registry, name)) throw new Error("UNKNOWN_HOST_COMMAND");
    const started = now(); const view = name === "recognize_document" ? "recognition" : name === "preview_document" ? "preview" : name === "format_document" ? "execution" : name === "health_check" ? "issues" : this.store.read().active_view; const result = this.store.begin(name, requestId, view);
    try {
      if (taskpaneBuildId !== this.store.read().build_id) throw new Error("ADDIN_CONTEXT_STALE");
      if (["recognize_document", "preview_document", "format_document", "health_check"].includes(name)) this.panes.show();
      const summary = await this.registry[name](result); const done = this.store.finish(result, summary); this.store.callback({ callback_name: `${source}:${name}`, build_id: this.store.read().build_id, host_context: this.store.hostContextId, started_at: started, completed_at: now(), status: "PASS", stable_error_code: "" }); return done;
    } catch (error) { const code = stableError(error); const failed = this.store.fail(result, code); if (name !== "close_taskpane" && name !== "toggle_taskpane") { try { this.panes.show(); } catch { /* the persisted error remains visible after reopen */ } } this.store.callback({ callback_name: `${source}:${name}`, build_id: this.store.read().build_id, host_context: this.store.hostContextId, started_at: started, completed_at: now(), status: "FAIL", stable_error_code: code }); return failed; }
  }
  supports(name: string): name is HostCommandName { return Object.prototype.hasOwnProperty.call(this.registry, name); }
  async reconcileActiveDocument(): Promise<void> {
    const current = await this.documentIdentity(); const state = this.store.read();
    if (state.document_identity_hash && state.document_identity_hash !== current) {
      // A preview tracker belongs to exactly one document.  Keep the comments
      // in that document, but never carry its in-memory cleanup session into
      // another open document.
      this.composition().previewTracker.clear();
      this.store.update({ document_identity_hash: current, active_command: null, command_status: "IDLE", active_view: "recognition", recognition_summary: "", paragraph_recognition_models: [], formatting_preview_models: [], preview_comment_status: "", formatting_progress: "已切换文档，等待操作", formatting_result: "", latest_error: "", unresolved_block_count: 0, mixed_paragraph_count: 0, health_overall: "", health_report: "", health_items: [] });
    }
  }
  private composition() { return getClassifiedProductionComposition(this.config); }
  private async documentIdentity(): Promise<string> { const document = this.app.ActiveDocument; if (!document) throw new Error("ACTIVE_DOCUMENT_NOT_FOUND"); return hash(`${document.FullName ?? "unsaved"}|${document.Paragraphs?.Count ?? 0}`); }
  private async recognize(_result: CommandResult): Promise<string> { const identity = await this.documentIdentity(); const recognition = await this.composition().recognizeUseCase.execute(); const models = recognition.paragraphs.map((item) => ({ paragraph_index: item.source_paragraph_index, recognized_type: item.recognized_type, confidence: item.confidence, needs_review: item.needs_review })); const review = models.filter((item) => item.needs_review).length; this.store.update({ document_identity_hash: identity, paragraph_recognition_models: models, recognition_summary: `总段落 ${models.length}；需要复核 ${review}`, active_view: "recognition" }); return "识别完成"; }
  private async preview(_result: CommandResult): Promise<string> { const identity = await this.documentIdentity(); const value = await this.composition().previewUseCase.execute(id("preview")); const count = value.summary.preview_comment_count ?? 0; if (count === 0) throw new Error(value.summary.preview_warnings?.[0] ?? "PREVIEW_COMMENT_READBACK_FAILED"); const grouped = new Map<number, FormattingCommandSet["commands"]>(); for (const command of value.commands.commands) { const list = grouped.get(command.target.source_paragraph_index) ?? []; list.push(command); grouped.set(command.target.source_paragraph_index, list); } const models = value.recognition.paragraphs.map((item) => ({ paragraph_index: item.source_paragraph_index, recognized_type: item.recognized_type, plan: formattingPlan(grouped.get(item.source_paragraph_index) ?? []), needs_review: item.needs_review })); const mixed = value.summary.mixed_paragraph_count; const unresolved = value.summary.unresolved_block_count; const notices = [`已创建 ${count} 条临时批注`]; if (mixed) notices.push(`${mixed} 个物理段落包含多个角色，正式排版前需拆段`); if (unresolved) notices.push(`${unresolved} 个识别块无法证明位置，仅供复核`); this.store.update({ document_identity_hash: identity, formatting_preview_models: models, preview_comment_status: notices.join("；"), unresolved_block_count: unresolved, mixed_paragraph_count: mixed, active_view: "preview" }); return "预览排版完成"; }
  private async clearPreview(): Promise<string> { await this.composition().clearPreviewUseCase.execute(); this.store.update({ preview_comment_status: "预览批注已清除" }); return "预览批注已清除"; }
  private async format(_result: CommandResult): Promise<string> { const identity = await this.documentIdentity(); const value = await this.composition().formatUseCase.execute(id("format"), { onProgress: (_stage, detail) => this.store.update({ formatting_progress: detail ?? "处理中", active_view: "execution" }) }); const summary = `已执行 ${value.executed_command_ids.length} 项；跳过 ${value.skipped_command_ids.length} 项`; this.store.update({ document_identity_hash: identity, formatting_result: summary, preview_comment_status: "无 Docxtool 预览批注", active_view: "execution" }); return summary; }
  private async health(): Promise<string> {
    const state = this.store.read();
    const report = await new ClassifiedHealthChecker(
      this.app as unknown as Record<string, any>, this.config, hostWindow.DocxtoolBuildInfo,
      { build_id: state.build_id, asset_hash: state.asset_hash }, hostWindow.DocxtoolDefaultProfile,
      typeof hostWindow.DocxtoolHostDispatch === "function" && hostWindow.DocxtoolHostRuntime?.router === this,
    ).run();
    this.store.update({ health_overall: report.overall, health_report: report.text, health_items: report.items, active_view: "issues", latest_error: report.overall === "PASS" ? "" : report.first_error_code });
    if (report.overall === "FAIL") throw new Error(report.first_error_code || "HEALTH_CHECK_FAILED");
    return `功能检测完成：${report.overall}`;
  }
}

function runtimeConfig(application: ApplicationLike): ClassifiedRuntimeConfig { const stored = parse<ClassifiedRuntimeConfig>(application.PluginStorage.getItem(CONFIG_KEY)); const value = hostWindow.DocxtoolRuntimeConfig ?? stored; if (!value) throw new Error("PRODUCTION_COMPOSITION_NOT_READY"); application.PluginStorage.setItem(CONFIG_KEY, JSON.stringify(value)); return value; }
async function reportHostAcceptance(stage: string, status: "PASS" | "FAIL", errorCode = ""): Promise<void> {
  try { const session = await fetch("http://127.0.0.1:9528/v1/e2e/session").then((response) => response.ok ? response.json() as Promise<{ session_id?: string }> : Promise.reject()); if (session.session_id) await fetch("http://127.0.0.1:9528/v1/e2e/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id, stage, status, error_code: errorCode }) }); } catch { /* acceptance reporting never changes a host command */ }
}
async function runAutomaticHostAcceptance(application: ApplicationLike, router: HostCommandRouter, build: BuildInfo): Promise<void> {
  const first = String(application.ActiveDocument?.Paragraphs?.Item?.(1)?.Range?.Text ?? ""); if (!first.startsWith("Docxtool 一键排版自动验收")) return;
  const document = application.ActiveDocument;
  const sessionId = await fetch("http://127.0.0.1:9528/v1/e2e/session").then((response) => response.ok ? response.json() as Promise<{ session_id: string }> : Promise.reject(new Error("E2E_SESSION_NOT_FOUND"))).then((value) => value.session_id);
  if (!document?.Saved) { document?.Save?.(); for (let attempt = 0; attempt < 30 && !document?.Saved; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100)); }
  if (!document?.Saved) { await reportHostAcceptance("health_check", "FAIL", "E2E_DOCUMENT_SAVE_FAILED"); return; }
  try { const plan = await loadRealE2EPlan(); await runFormalRollbackProbe(plan); await reportHostAcceptance("rollback", "PASS"); }
  catch (error) { await reportHostAcceptance("rollback", "FAIL", stableError(error)); return; }
  const steps: Array<[string, HostCommandName]> = [["health_check", "health_check"], ["preview_document", "preview_document"], ["one_click_format", "format_document"]];
  for (const [stage, command] of steps) {
    const result = await router.dispatch(command, "e2e", `e2e-${stage}-${Date.now().toString(36)}`, build.build_id);
    if (stage === "preview_document" && result.status === "PASS") {
      document.Saved = false;
      document.Save?.();
      // WPS may report Saved=true before the DOCX package has finished being
      // replaced on disk.  The acceptance runner copies that package as its
      // preview evidence, so wait for the asynchronous file flush to settle
      // before publishing PREVIEW PASS to the local driver.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (let attempt = 0; attempt < 30 && !document.Saved; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const fullName = String(document.FullName ?? "").replaceAll("/", "\\"); const boundary = fullName.toLowerCase().lastIndexOf("\\tests\\e2e-work\\");
      if (boundary < 0 || typeof document.SaveCopyAs !== "function") throw new Error("E2E_SAVE_COPY_UNSUPPORTED");
      document.SaveCopyAs(`${fullName.slice(0, boundary)}\\.runtime\\reports\\${sessionId}\\02-preview-comments.docx`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await reportHostAcceptance(stage, result.status === "PASS" ? "PASS" : "FAIL", result.error_code);
    if (result.status !== "PASS") return;
    if (stage === "preview_document") await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  document.Saved = false;
  document.Save?.();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (let attempt = 0; attempt < 30 && !document.Saved; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  await reportHostAcceptance("host_command_router", "PASS");
}
function install(): void {
  const application = hostWindow.Application; const build = hostWindow.DocxtoolBuildInfo;
  void reportHostAcceptance("host_module_loaded", "PASS");
  if (!application || !build) { void reportHostAcceptance("host_install", "FAIL", !application ? "WPS_APPLICATION_UNAVAILABLE" : "BUILD_INFO_UNAVAILABLE"); return; }
  const store = new HostResultStore(application.PluginStorage, build); const paneUrl = `${new URL(hostWindow.DocxtoolTaskPanePath ?? "ui/taskpane.html", hostWindow.location.href)}?host_build=${encodeURIComponent(build.build_id)}&host_context=${encodeURIComponent(store.hostContextId)}`; const panes = new TaskPaneManager(application, application.PluginStorage, paneUrl); const router = new HostCommandRouter(application, panes, store, runtimeConfig(application));
  hostWindow.DocxtoolHostRuntime = { router, panes, store, build }; hostWindow.DocxtoolHostDispatch = (name, source, requestId, taskpaneBuildId) => router.dispatch(name, source, requestId, taskpaneBuildId);
  void reportHostAcceptance("host_router_installed", "PASS");
  hostWindow.setInterval(() => { const request = parse<BridgeRequest>(application.PluginStorage.getItem(REQUEST_KEY)); if (!request) return; application.PluginStorage.setItem(REQUEST_KEY, ""); if (request.schema_version !== 1 || !router.supports(request.command_name)) { store.update({ latest_error: "TASKPANE_MESSAGE_REJECTED", active_view: "issues" }); return; } void router.dispatch(request.command_name, "taskpane", request.request_id, request.taskpane_build_id); }, 200);
  hostWindow.setInterval(() => { void router.reconcileActiveDocument().catch(() => { /* no active document is normal during WPS transitions */ }); }, 750);
  void runAutomaticHostAcceptance(application, router, build);
}
let installAttempted = false;
let installDone = false;
let installTimer: number | undefined;
function tryInstall(): void {
  if (installDone) return;
  const application = hostWindow.Application; const build = hostWindow.DocxtoolBuildInfo;
  if (!application || !build) {
    if (!installAttempted) {
      installAttempted = true;
      void reportHostAcceptance("host_module_loaded", "PASS");
    }
    return;
  }
  try {
    installDone = true;
    if (installTimer !== undefined) hostWindow.clearInterval(installTimer);
    install();
  } catch (error) {
    const code = stableError(error);
    void reportHostAcceptance("host_install", "FAIL", code);
    new HostResultStore(application.PluginStorage, build).update({ latest_error: code, active_view: "issues" });
  }
}
tryInstall();
installTimer = hostWindow.setInterval(tryInstall, 250);
(installTimer as unknown as { unref?: () => void }).unref?.();
