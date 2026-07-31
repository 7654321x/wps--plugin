import { DiagnosticRunner, type DiagnosticResult } from "../../../packages/diagnostics/src/index.js";
import { CommentPreviewCapabilityProvider, WpsFontCapabilityProvider, WpsRuntimeProbe } from "../../../packages/wps-adapter/src/index.js";
import type { ClassifiedRuntimeConfig } from "./composition-root.js";

export type HealthStatus = "PASS" | "WARN" | "FAIL";
export interface SafeHealthItem { check_id: string; title: string; status: HealthStatus; error_code: string; summary: string; }
export interface SafeHealthReport { overall: HealthStatus; items: SafeHealthItem[]; missing_fonts: string[]; first_error_code: string; text: string; }
interface BuildIdentity { build_id: string; asset_hash: string; }
interface DefaultProfile {
  page_setup?: { normal_east_asia_font_name?: string; normal_latin_font_name?: string };
  styles?: Record<string, { east_asia_font_name?: string; latin_font_name?: string }>;
}
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const checks = [
  { check_id: "plugin_host", group: "wps", title: "插件宿主", dependencies: [], retryable: false },
  { check_id: "current_document", group: "wps", title: "当前文档", dependencies: [], retryable: false },
  { check_id: "document_api", group: "wps", title: "WPS 文档 API", dependencies: [], retryable: false },
  { check_id: "comment_api", group: "wps", title: "批注 API", dependencies: [], retryable: false },
  { check_id: "recognition_service", group: "service", title: "识别服务", dependencies: [], retryable: true },
  { check_id: "recognition_wheel", group: "service", title: "识别引擎", dependencies: [], retryable: true },
  { check_id: "command_service", group: "service", title: "命令服务", dependencies: [], retryable: true },
  { check_id: "session_token", group: "runtime", title: "本机会话", dependencies: [], retryable: false },
  { check_id: "required_fonts", group: "wps", title: "必需字体", dependencies: [], retryable: false },
  { check_id: "taskpane_api", group: "wps", title: "任务窗格 API", dependencies: [], retryable: false },
  { check_id: "build_identity", group: "runtime", title: "构建一致性", dependencies: [], retryable: false },
  { check_id: "host_router", group: "runtime", title: "命令路由", dependencies: [], retryable: false },
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
async function getJson(fetcher: Fetcher, base: string, path: string): Promise<Record<string, unknown>> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetcher(new URL(path, base.replace(/\/?$/, "/")), { method: "GET", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally { clearTimeout(timer); }
}
function reportText(overall: HealthStatus, items: SafeHealthItem[], missingFonts: string[]): string {
  const lines = ["DocxTool 功能检测", "", ...items.map((item) => `${item.title}：${item.status}${item.error_code ? `（${item.error_code}）` : ""}`), "", `总体结果：${overall}`];
  if (missingFonts.length) lines.push("", "缺少字体：", ...missingFonts);
  return lines.join("\n");
}

/** Read-only classified health check. It never writes, saves, selects or comments. */
export class ClassifiedHealthChecker {
  constructor(
    private readonly application: Record<string, any>, private readonly config: ClassifiedRuntimeConfig,
    private readonly currentBuild: BuildIdentity | undefined, private readonly storedBuild: BuildIdentity,
    private readonly profile: DefaultProfile | undefined, private readonly routerInstalled: boolean,
    private readonly fetcher: Fetcher = fetch,
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
      recognition_service: async () => {
        try { const value = await getJson(this.fetcher, this.config.recognitionEndpoint, "v1/health"); return value.ok === true ? { status: "PASS", summary: "本地识别服务可达" } : { status: "FAIL", error_code: "LOCAL_AGENT_UNHEALTHY", summary: "识别服务健康响应异常" }; }
        catch { return { status: "FAIL", error_code: "LOCAL_AGENT_UNAVAILABLE", summary: "本地识别服务不可达" }; }
      },
      recognition_wheel: async () => {
        try { const value = await getJson(this.fetcher, this.config.recognitionEndpoint, "v1/version"); return typeof value.recognition_sdk === "string" && value.recognition_sdk.includes("recognize_docx") ? { status: "PASS", summary: "recognition wheel 非正文握手通过" } : { status: "FAIL", error_code: "RECOGNITION_WHEEL_UNAVAILABLE", summary: "识别引擎握手未通过" }; }
        catch { return { status: "FAIL", error_code: "RECOGNITION_WHEEL_UNAVAILABLE", summary: "识别引擎握手失败" }; }
      },
      command_service: async () => {
        try { const value = await getJson(this.fetcher, this.config.commandEndpoint, "v1/health"); return value.ok === true ? { status: "PASS", summary: "本地命令服务可达" } : { status: "FAIL", error_code: "COMMAND_SERVICE_UNHEALTHY", summary: "命令服务健康响应异常" }; }
        catch { return { status: "FAIL", error_code: "COMMAND_SERVICE_UNAVAILABLE", summary: "本地命令服务不可达" }; }
      },
      session_token: async () => this.config.sessionToken.trim().length > 0 ? { status: "PASS", summary: "本机会话令牌已配置" } : { status: "FAIL", error_code: "SESSION_TOKEN_MISSING", summary: "本机会话令牌缺失" },
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
      host_router: async () => this.routerInstalled ? { status: "PASS", summary: "HostCommandRouter 已安装" } : { status: "FAIL", error_code: "HOST_COMMAND_ROUTER_NOT_READY", summary: "HostCommandRouter 未安装" },
    });
    const items = report.results.map((item) => ({ check_id: item.check_id, title: item.title, status: normalizedStatus(item), error_code: item.error_code, summary: item.summary }));
    const overall: HealthStatus = items.some((item) => item.status === "FAIL") ? "FAIL" : items.some((item) => item.status === "WARN") ? "WARN" : "PASS";
    const firstError = items.find((item) => item.status === "FAIL")?.error_code ?? items.find((item) => item.status === "WARN")?.error_code ?? "";
    return { overall, items, missing_fonts: missingFonts, first_error_code: firstError, text: reportText(overall, items, missingFonts) };
  }
}
