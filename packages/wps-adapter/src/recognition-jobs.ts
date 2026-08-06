import { HOST_TEXT_CONTRACT_VERSION } from "./host-text.js";
import { WpsLocalFileSystem } from "./local-filesystem.js";
import type { JsonValue, RecognitionJobHandle, RecognitionJobStatus, SerializableLocalDocumentSnapshot } from "../../threading/src/protocol.js";
import type { DiagnosticReporter } from "../../diagnostics/src/index.js";

type WpsObject = Record<string, any>;
interface StoredJob { handle: RecognitionJobHandle; request_id: string; job_dir: string; terminal: RecognitionJobStatus | null; }

function joinPath(left: string, right: string): string { return left.replace(/[\\/]+$/, "") + "\\" + right.replace(/^[\\/]+/, ""); }
function parseObject(raw: string, errorCode: string): Record<string, unknown> {
  try { const value = JSON.parse(raw) as unknown; if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; }
  catch { throw new Error(errorCode); }
  throw new Error(errorCode);
}
function processError(raw: string): string {
  const payload = parseObject(raw, "LOCAL_RECOGNITION_ERROR_INVALID_JSON");
  const nested = payload.error && typeof payload.error === "object" ? (payload.error as { code?: unknown }).code : undefined;
  const value = payload.error_code ?? nested;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : "LOCAL_RECOGNITION_FAILED";
}
function randomSuffix(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().slice(0, 8);
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (value) => value.toString(16).padStart(2, "0")).join("");
}
export function quoteRecognitionArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  let result = '"'; let slashes = 0;
  for (const char of value) {
    if (char === "\\") { slashes += 1; continue; }
    if (char === '"') { result += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    result += "\\".repeat(slashes) + char; slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + '"';
}

export class WpsRecognitionJobService {
  private readonly jobs = new Map<string, StoredJob>();
  constructor(private readonly application: WpsObject, private readonly executablePath: string, private readonly maxResultBytes = 20 * 1024 * 1024, private readonly diagnostics?: DiagnosticReporter) {}

  launch(snapshot: SerializableLocalDocumentSnapshot): RecognitionJobHandle {
    if (!snapshot.localDocxPath) throw new Error("DOCUMENT_MUST_BE_SAVED");
    const fsApi = this.application.FileSystem;
    if (!fsApi) throw new Error("WPS_FILESYSTEM_UNAVAILABLE");
    const fs = new WpsLocalFileSystem(fsApi);
    if (!fs.exists(this.executablePath)) throw new Error("LOCAL_RECOGNITION_RUNTIME_NOT_FOUND");
    const tempRoot = this.application.Env?.GetTempPath?.();
    if (!tempRoot) throw new Error("WPS_TEMP_PATH_UNAVAILABLE");
    const shellExecute = this.application.OAAssist?.ShellExecute;
    if (typeof shellExecute !== "function") throw new Error("LOCAL_PROCESS_EXECUTION_BLOCKED");
    const requestId = `local-rec-${Date.now().toString(36)}-${randomSuffix()}`;
    const jobDir = joinPath(tempRoot, requestId);
    const requestPath = joinPath(jobDir, "request.json");
    const handle: RecognitionJobHandle = { recognition_job_id: requestId, started_at: new Date().toISOString(), result_path: joinPath(jobDir, "result.json"), error_path: joinPath(jobDir, "error.json"), cancel_path: joinPath(jobDir, "cancel.json") };
    const request = { schema_version: 1, request_id: requestId, source_path: snapshot.localDocxPath, result_path: handle.result_path, error_path: handle.error_path, host_snapshot: { host_type: "wps", document_identity: snapshot.documentId, document_revision: snapshot.revision, text_contract_version: HOST_TEXT_CONTRACT_VERSION, paragraphs: snapshot.paragraphs.map((item) => ({ host_paragraph_index: item.sourceParagraphIndex, raw_text: item.text, story_type: "main", is_in_table: item.isInTable })) } };
    fs.mkdir(jobDir); fs.writeText(requestPath, JSON.stringify(request));
    const argumentsText = ["--request", quoteRecognitionArgument(requestPath), "--result", quoteRecognitionArgument(handle.result_path), "--error", quoteRecognitionArgument(handle.error_path)].join(" ");
    const launchStarted = performance.now();
    this.diagnostics?.writeForComponent("wps-recognition-launcher", "INFO", "recognition.shell_execute.call.start", "准备调用 WPS ShellExecute 启动本地识别程序", { recognition_job_id: requestId });
    try {
      shellExecute.call(this.application.OAAssist, this.executablePath, argumentsText);
      this.diagnostics?.writeForComponent("wps-recognition-launcher", "INFO", "recognition.shell_execute.call.returned", "WPS ShellExecute 调用已经返回", { recognition_job_id: requestId, duration_ms: performance.now() - launchStarted });
    } catch (error) {
      this.diagnostics?.writeForComponent("wps-recognition-launcher", "ERROR", "recognition.shell_execute.call.failed", "WPS ShellExecute 调用失败", { recognition_job_id: requestId, duration_ms: performance.now() - launchStarted }, error);
      throw error;
    }
    this.jobs.set(requestId, { handle, request_id: requestId, job_dir: jobDir, terminal: null });
    return handle;
  }

  probe(recognitionJobId: string): RecognitionJobStatus {
    const job = this.jobs.get(recognitionJobId);
    if (!job) throw new Error("RECOGNITION_JOB_NOT_FOUND");
    if (job.terminal) return job.terminal;
    const fs = new WpsLocalFileSystem(this.application.FileSystem);
    if (fs.exists(job.handle.result_path)) {
      const raw = fs.readText(job.handle.result_path);
      if (new TextEncoder().encode(raw).byteLength > this.maxResultBytes) throw new Error("LOCAL_RECOGNITION_RESULT_TOO_LARGE");
      const payload = parseObject(raw, "LOCAL_RECOGNITION_INVALID_JSON");
      if (payload.request_id !== job.request_id) throw new Error("LOCAL_RECOGNITION_REQUEST_ID_MISMATCH");
      const plan = payload.recognition_plan ?? payload.data;
      if (!plan || typeof plan !== "object") throw new Error("LOCAL_RECOGNITION_INVALID_RESULT");
      job.terminal = { state: "completed", recognition_plan: plan as JsonValue };
      this.cleanup(job);
      return job.terminal;
    }
    if (fs.exists(job.handle.error_path)) {
      const code = processError(fs.readText(job.handle.error_path));
      job.terminal = { state: "failed", error: { code, message: code } };
      this.cleanup(job);
      return job.terminal;
    }
    return { state: "running" };
  }

  cancel(recognitionJobId: string): boolean {
    const job = this.jobs.get(recognitionJobId);
    if (!job || job.terminal) return false;
    new WpsLocalFileSystem(this.application.FileSystem).writeText(job.handle.cancel_path, JSON.stringify({ recognition_job_id: recognitionJobId, cancelled_at: new Date().toISOString() }));
    return true;
  }

  private cleanup(job: StoredJob): void {
    const fs = new WpsLocalFileSystem(this.application.FileSystem);
    for (const path of [job.handle.result_path, job.handle.error_path, job.handle.cancel_path, joinPath(job.job_dir, "request.json")]) { try { fs.removeFile(path); } catch { /* terminal cleanup is best effort */ } }
    try { fs.removeDirectory(job.job_dir); } catch { /* terminal cleanup is best effort */ }
  }
}
