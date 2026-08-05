import { DiagnosticRunner, type DiagnosticResult } from "../../../packages/diagnostics/src/index.js";
import { CommentPreviewCapabilityProvider, WpsFontCapabilityProvider, WpsRuntimeProbe } from "../../../packages/wps-adapter/src/index.js";
import { WpsLocalFileSystem } from "../../../packages/wps-adapter/src/local-filesystem.js";
import type { ClassifiedRuntimeConfig } from "./composition-root.js";
import { errorMessage } from "./error-messages.js";

export type HealthStatus = "PASS" | "WARN" | "FAIL";
export interface SafeHealthItem { check_id: string; title: string; status: HealthStatus; error_code: string; summary: string; }
export interface SafeHealthReport { overall: HealthStatus; items: SafeHealthItem[]; missing_fonts: string[]; first_error_code: string; text: string; }
interface BuildIdentity { build_id: string; asset_hash: string; }
interface DefaultProfile {
  page_setup?: { normal_east_asia_font_name?: string; normal_latin_font_name?: string };
  styles?: Record<string, { east_asia_font_name?: string; latin_font_name?: string }>;
}
const checks = [
  { check_id: "plugin_host", group: "wps", title: "插件宿主", dependencies: [], retryable: false },
  { check_id: "current_document", group: "wps", title: "当前文档", dependencies: [], retryable: false },
  { check_id: "document_api", group: "wps", title: "WPS 文档 API", dependencies: [], retryable: false },
  { check_id: "comment_api", group: "wps", title: "批注 API", dependencies: [], retryable: false },
  { check_id: "filesystem_api", group: "wps", title: "文件系统 API", dependencies: [], retryable: false },
  { check_id: "local_runtime", group: "runtime", title: "本地识别运行时", dependencies: [], retryable: false },
  { check_id: "runtime_manifest", group: "runtime", title: "运行时清单", dependencies: [], retryable: false },
  { check_id: "local_process_api", group: "wps", title: "本地进程调用", dependencies: [], retryable: false },
  { check_id: "required_fonts", group: "wps", title: "必需字体", dependencies: [], retryable: false },
  { check_id: "taskpane_api", group: "wps", title: "任务窗格 API", dependencies: [], retryable: false },
  { check_id: "build_identity", group: "runtime", title: "构建一致性", dependencies: [], retryable: false },
  { check_id: "local_application_runtime", group: "runtime", title: "本地应用运行时", dependencies: [], retryable: false },
];

function normalizedStatus(result: DiagnosticResult): HealthStatus {
  if (result.status === "PASS") return "PASS";
  if (result.status === "WARN" || result.status === "UNSUPPORTED") return "WARN";
  return "FAIL";
}
function requiredFonts(profile?: DefaultProfile): string[] {
  if (!profile) return [];
  const names = [profile.page_setup?.normal_east_asia_font_name, profile.page_setup?.normal_latin_font_name];
  for (const style of Object.values(profile.styles ?? {})) names.push(style.east_asia_font_name, style.latin_font_name);
  return [...new Set(names.filter((value): value is string => Boolean(value)))];
}
function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
function reportText(overall: HealthStatus, items: SafeHealthItem[], missingFonts: string[]): string {
  const lines = ["DocxTool 功能检测", "", ...items.map((item) => `${item.title}：${item.status}${item.error_code ? `（${errorMessage(item.error_code)}；错误码：${item.error_code}）` : ""}`), "", `总体结果：${overall}`];
  if (missingFonts.length) lines.push("", "缺少字体：", ...missingFonts);
  return lines.join("\n");
}

/** Read-only classified health check. It never writes, saves, selects or comments. */
export class ClassifiedHealthChecker {
  constructor(
    private readonly application: Record<string, any>, private readonly config: ClassifiedRuntimeConfig,
    private readonly currentBuild: BuildIdentity | undefined, private readonly storedBuild: BuildIdentity,
    private readonly profile: DefaultProfile | undefined, private readonly localRuntimeInstalled: boolean,
  ) {}

  async run(): Promise<SafeHealthReport> {
    const runtime = new WpsRuntimeProbe(this.application).probe();
    const api = (name: string) => runtime.find((item) => item.api === name);
    const comments = new CommentPreviewCapabilityProvider(this.application).probe();
    const fonts = requiredFonts(this.profile);
    const fontReport = fonts.length ? new WpsFontCapabilityProvider(this.application).inspect(fonts) : [];
    const missingFonts = fontReport.filter((item) => !item.installed).map((item) => item.requested_font);
    const runner = new DiagnosticRunner(checks);
    const report = await runner.run({
      plugin_host: async () => api("Application")?.supported && api("Application.ActiveDocument")?.supported
        ? { status: "PASS", summary: "Application 与 ActiveDocument 可读" }
        : { status: "FAIL", error_code: "WPS_HOST_UNAVAILABLE", summary: "WPS 宿主或活动文档不可用" },
      current_document: async () => {
        if (!api("Application.ActiveDocument")?.supported) return { status: "FAIL", error_code: "NO_ACTIVE_DOCUMENT", summary: "没有活动文档" };
        if (!api("Document.IsDocx")?.supported) return { status: "FAIL", error_code: "DOCUMENT_NOT_DOCX", summary: "当前文档不是 DOCX" };
        if (this.application.ActiveDocument?.Saved !== true) return { status: "FAIL", error_code: "DOCUMENT_MUST_BE_SAVED", summary: "当前 DOCX 尚未保存" };
        return { status: "PASS", summary: "当前文档是已保存 DOCX" };
      },
      document_api: async () => ["Document.Paragraphs", "Paragraph.Range.Text", "Range.Font", "Range.ParagraphFormat", "Range.PageSetup"].every((name) => api(name)?.supported && api(name)?.readable)
        ? { status: "PASS", summary: "段落、字体、段落格式和页面设置可读" }
        : { status: "FAIL", error_code: "WPS_DOCUMENT_API_UNAVAILABLE", summary: "必要 WPS 文档 API 不完整" },
      comment_api: async () => api("Document.Comments")?.supported && api("Comments.Add")?.supported && comments.COMMENT_COLLECTION_READABLE && comments.COMMENT_ADD_WRITABLE
        ? { status: "PASS", summary: "批注集合可读且 Comments.Add 已暴露" }
        : { status: "FAIL", error_code: "COMMENT_PREVIEW_UNSUPPORTED", summary: "批注 API 不完整" },
      filesystem_api: async () => typeof this.application.FileSystem?.Exists === "function"
        && (typeof this.application.FileSystem?.ReadFile === "function" || typeof this.application.FileSystem?.ReadFileString === "function" || typeof this.application.FileSystem?.readFileString === "function")
        && (typeof this.application.FileSystem?.WriteFile === "function" || typeof this.application.FileSystem?.writeFileString === "function" || typeof this.application.FileSystem?.WriteFileString === "function")
        && (typeof this.application.FileSystem?.unlinkSync === "function" || typeof this.application.FileSystem?.Remove === "function")
        ? { status: "PASS", summary: "Application.FileSystem 可用" }
        : { status: "FAIL", error_code: "WPS_FILESYSTEM_UNAVAILABLE", summary: "WPS 文件系统 API 不完整" },
      local_runtime: async () => {
        const exe = this.config.recognitionExecutablePath;
        if (!exe) return { status: "FAIL", error_code: "LOCAL_RUNTIME_CONFIGURATION_REQUIRED", summary: "未配置本地识别运行时" };
        try {
          const fs = this.application.FileSystem ? new WpsLocalFileSystem(this.application.FileSystem) : null;
          return fs?.exists(exe) ? { status: "PASS", summary: "本地识别 exe 存在" } : { status: "FAIL", error_code: "LOCAL_RECOGNITION_RUNTIME_NOT_FOUND", summary: "本地识别 exe 不存在" };
        }
        catch { return { status: "FAIL", error_code: "LOCAL_RECOGNITION_RUNTIME_NOT_FOUND", summary: "无法访问本地识别 exe" }; }
      },
      runtime_manifest: async () => {
        const path = this.config.runtimeManifestPath;
        if (!path) return { status: "WARN", error_code: "LOCAL_RUNTIME_CONFIGURATION_REQUIRED", summary: "未配置 runtime 清单路径" };
        if (!this.application.FileSystem) return { status: "FAIL", error_code: "LOCAL_RUNTIME_MANIFEST_INVALID", summary: "runtime 清单不可读" };
        try {
          const fs = new WpsLocalFileSystem(this.application.FileSystem);
          if (!fs.exists(path)) return { status: "FAIL", error_code: "LOCAL_RUNTIME_MANIFEST_INVALID", summary: "runtime 清单不可读" };
          const manifest = parseJson(fs.readText(path));
          if (!manifest || manifest.schema_version !== 1 || manifest.contract_version !== 1 || typeof manifest.executable_path !== "string" || typeof manifest.executable_sha256 !== "string") {
            return { status: "FAIL", error_code: "LOCAL_RUNTIME_MANIFEST_INVALID", summary: "runtime 清单字段不完整" };
          }
          return { status: "PASS", summary: "runtime 清单可读" };
        } catch {
          return { status: "FAIL", error_code: "LOCAL_RUNTIME_MANIFEST_INVALID", summary: "runtime 清单不可读" };
        }
      },
      local_process_api: async () => typeof this.application.OAAssist?.ShellExecute === "function"
        ? { status: "PASS", summary: "OAAssist.ShellExecute 可用" }
        : { status: "FAIL", error_code: "LOCAL_PROCESS_EXECUTION_BLOCKED", summary: "WPS 未暴露本地进程调用能力" },
      required_fonts: async () => !this.profile || !fonts.length
        ? { status: "WARN", error_code: "DEFAULT_PROFILE_UNAVAILABLE", summary: "无法读取默认 Profile 字体清单" }
        : missingFonts.length ? { status: "WARN", error_code: "REQUIRED_FONT_MISSING", summary: `缺少 ${missingFonts.length} 种字体`, details_safe: { missing_font_count: missingFonts.length } }
        : { status: "PASS", summary: "默认 Profile 所需字体均可枚举" },
      taskpane_api: async () => {
        if (!api("Application.CreateTaskPane")?.supported) return { status: "FAIL", error_code: "TASKPANE_API_UNAVAILABLE", summary: "CreateTaskPane 不可用" };
        return api("Application.ApiEvent")?.supported ? { status: "PASS", summary: "任务窗格与 ApiEvent 可用" } : { status: "WARN", error_code: "API_EVENT_UNAVAILABLE", summary: "任务窗格可用，ApiEvent 未暴露" };
      },
      build_identity: async () => this.currentBuild?.build_id && this.currentBuild.build_id === this.storedBuild.build_id && this.currentBuild.asset_hash === this.storedBuild.asset_hash
        ? { status: "PASS", summary: "build_id 与 asset_hash 一致" }
        : { status: "FAIL", error_code: "ADDIN_CONTEXT_STALE", summary: "当前构建与宿主状态不一致" },
      local_application_runtime: async () => this.localRuntimeInstalled ? { status: "PASS", summary: "本地应用运行时已安装" } : { status: "FAIL", error_code: "LOCAL_APPLICATION_RUNTIME_NOT_READY", summary: "本地应用运行时未安装" },
    });
    const items = report.results.map((item) => ({ check_id: item.check_id, title: item.title, status: normalizedStatus(item), error_code: item.error_code, summary: item.summary }));
    const overall: HealthStatus = items.some((item) => item.status === "FAIL") ? "FAIL" : items.some((item) => item.status === "WARN") ? "WARN" : "PASS";
    const firstError = items.find((item) => item.status === "FAIL")?.error_code ?? items.find((item) => item.status === "WARN")?.error_code ?? "";
    return { overall, items, missing_fonts: missingFonts, first_error_code: firstError, text: reportText(overall, items, missingFonts) };
  }
}
