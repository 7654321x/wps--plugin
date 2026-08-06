import { HOST_TEXT_CONTRACT_VERSION } from "./host-text.js";
import { WpsLocalFileSystem } from "./local-filesystem.js";
import type { JsonValue, RecognitionJobHandle, RecognitionJobStatus, SerializableLocalDocumentSnapshot } from "../../threading/src/protocol.js";
import type { DiagnosticReporter } from "../../diagnostics/src/index.js";

type WpsObject = Record<string, any>;
interface StoredJob { handle: RecognitionJobHandle; request_id: string; job_dir: string; terminal: RecognitionJobStatus | null; }
export interface RecognitionBrokerOptions { statusPath?: string; jobsPath?: string; runtimeVersion?: string; runtimeSha256?: string; contractVersion?: number; }

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
function uuidV4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function appDataRoot(application: WpsObject): string {
  const value = application.Env?.GetAppDataPath?.();
  if (!value) throw new Error("LOCAL_JOB_BROKER_APPDATA_UNAVAILABLE");
  return joinPath(value, "Docxtool");
}
function isFresh(heartbeat: unknown): boolean {
  if (typeof heartbeat !== "string") return false;
  const timestamp = Date.parse(heartbeat);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 3_000;
}

export class WpsRecognitionJobService {
  private readonly jobs = new Map<string, StoredJob>();
  constructor(
    private readonly application: WpsObject,
    private readonly executablePath: string,
    private readonly maxResultBytes = 20 * 1024 * 1024,
    private readonly diagnostics?: DiagnosticReporter,
    private readonly broker: RecognitionBrokerOptions = {},
  ) {}

  launch(snapshot: SerializableLocalDocumentSnapshot): RecognitionJobHandle {
    if (!snapshot.localDocxPath) throw new Error("DOCUMENT_MUST_BE_SAVED");
    const fsApi = this.application.FileSystem;
    if (!fsApi) throw new Error("WPS_FILESYSTEM_UNAVAILABLE");
    const fs = new WpsLocalFileSystem(fsApi);
    if (!fs.exists(this.executablePath)) throw new Error("LOCAL_RECOGNITION_RUNTIME_NOT_FOUND");
    this.assertBrokerReady(fs);
    const queueRoot = this.broker.jobsPath ?? joinPath(appDataRoot(this.application), "jobs");
    const requestId = uuidV4();
    const jobDir = joinPath(queueRoot, requestId);
    const requestPath = joinPath(jobDir, "request.json");
    const resultPath = joinPath(jobDir, "result.json");
    const errorPath = joinPath(jobDir, "error.json");
    const cancelPath = joinPath(jobDir, "cancel.json");
    const handle: RecognitionJobHandle = { recognition_job_id: requestId, queued_at: new Date().toISOString(), request_path: requestPath, result_path: resultPath, error_path: errorPath, cancel_path: cancelPath, launch_mode: "file_queue_broker" };
    const request = { schema_version: 1, request_id: requestId, source_path: snapshot.localDocxPath, result_path: resultPath, error_path: errorPath, host_snapshot: { host_type: "wps", document_identity: snapshot.documentId, document_revision: snapshot.revision, text_contract_version: HOST_TEXT_CONTRACT_VERSION, paragraphs: snapshot.paragraphs.map((item) => ({ host_paragraph_index: item.sourceParagraphIndex, raw_text: item.text, story_type: "main", is_in_table: item.isInTable })) } };
    const queued = { schema_version: 1, job_id: requestId, contract_version: this.broker.contractVersion ?? 1, runtime_version: this.broker.runtimeVersion ?? "", runtime_sha256: this.broker.runtimeSha256 ?? "", created_at: handle.queued_at, build_id: "wps-host" };
    const started = performance.now();
    try {
      fs.mkdir(jobDir);
      fs.writeText(requestPath, JSON.stringify(request));
      fs.writeText(joinPath(jobDir, "queued.json"), JSON.stringify(queued));
    } catch (error) {
      this.diagnostics?.writeForComponent("wps-recognition-broker", "ERROR", "host.recognition.job.queue.failed", "本地识别任务入队失败", { recognition_job_id: requestId, duration_ms: performance.now() - started, stable_error_code: "LOCAL_JOB_QUEUE_WRITE_FAILED" }, error);
      throw new Error("LOCAL_JOB_QUEUE_WRITE_FAILED");
    }
    this.jobs.set(requestId, { handle, request_id: requestId, job_dir: jobDir, terminal: null });
    this.diagnostics?.writeForComponent("wps-recognition-broker", "INFO", "host.recognition.job.queued", "本地识别任务已写入文件队列", { recognition_job_id: requestId, duration_ms: performance.now() - started, launch_mode: "file_queue_broker" });
    return handle;
  }

  probe(recognitionJobId: string): RecognitionJobStatus {
    const job = this.jobs.get(recognitionJobId);
    if (!job) throw new Error("RECOGNITION_JOB_NOT_FOUND");
    if (job.terminal) return job.terminal;
    const fs = new WpsLocalFileSystem(this.application.FileSystem);
    const finishedPath = joinPath(job.job_dir, "finished.json");
    if (fs.exists(job.handle.error_path) && fs.exists(finishedPath)) {
      const code = processError(fs.readText(job.handle.error_path));
      job.terminal = { state: code === "RECOGNITION_CANCELLED" ? "cancelled" : "failed", ...(code === "RECOGNITION_CANCELLED" ? {} : { error: { code, message: code } }) } as RecognitionJobStatus;
      this.cleanup(job);
      return job.terminal;
    }
    if (fs.exists(job.handle.result_path) && fs.exists(finishedPath)) {
      const raw = fs.readText(job.handle.result_path);
      if (new TextEncoder().encode(raw).byteLength > this.maxResultBytes) throw new Error("LOCAL_RECOGNITION_RESULT_TOO_LARGE");
      const payload = parseObject(raw, "LOCAL_RECOGNITION_INVALID_JSON");
      if (payload.request_id !== job.request_id) throw new Error("LOCAL_RECOGNITION_REQUEST_ID_MISMATCH");
      const plan = payload.recognition_plan ?? payload.data;
      if (!plan || typeof plan !== "object") throw new Error("LOCAL_RECOGNITION_INVALID_RESULT");
      job.terminal = { state: "completed", recognition_plan: plan as JsonValue };
      this.cleanup(job);
      this.diagnostics?.writeForComponent("wps-recognition-broker", "INFO", "recognition.result.ready", "本地识别结果已就绪", { recognition_job_id: recognitionJobId });
      return job.terminal;
    }
    if (fs.exists(joinPath(job.job_dir, "launched.json"))) return { state: "launched" };
    if (fs.exists(joinPath(job.job_dir, "claimed.json"))) return { state: "claimed" };
    if (fs.exists(joinPath(job.job_dir, "queued.json"))) return { state: "queued" };
    return { state: "running" };
  }

  cancel(recognitionJobId: string): boolean {
    const job = this.jobs.get(recognitionJobId);
    if (!job || job.terminal) return false;
    new WpsLocalFileSystem(this.application.FileSystem).writeText(job.handle.cancel_path, JSON.stringify({ recognition_job_id: recognitionJobId, cancelled_at: new Date().toISOString() }));
    return true;
  }

  private assertBrokerReady(fs: WpsLocalFileSystem): void {
    const statusPath = this.broker.statusPath ?? joinPath(appDataRoot(this.application), "broker\\status.json");
    if (!fs.exists(statusPath)) throw new Error("LOCAL_JOB_BROKER_NOT_RUNNING");
    let status: Record<string, unknown>;
    try { status = parseObject(fs.readText(statusPath), "LOCAL_JOB_BROKER_NOT_RUNNING"); }
    catch { throw new Error("LOCAL_JOB_BROKER_NOT_RUNNING"); }
    if (status.state !== "READY" && status.state !== "RUNNING") throw new Error("LOCAL_JOB_BROKER_NOT_RUNNING");
    if (!isFresh(status.heartbeat_at)) throw new Error("LOCAL_JOB_BROKER_STALE");
    if (status.broker_version !== undefined && status.contract_version !== (this.broker.contractVersion ?? 1)) throw new Error("LOCAL_JOB_BROKER_VERSION_MISMATCH");
    if (this.broker.runtimeVersion && status.runtime_version !== this.broker.runtimeVersion) throw new Error("LOCAL_JOB_BROKER_RUNTIME_MISMATCH");
    if (this.broker.runtimeSha256 && status.runtime_sha256 !== this.broker.runtimeSha256) throw new Error("LOCAL_JOB_BROKER_RUNTIME_MISMATCH");
  }

  private cleanup(job: StoredJob): void {
    const fs = new WpsLocalFileSystem(this.application.FileSystem);
    for (const path of [job.handle.result_path, job.handle.error_path, job.handle.cancel_path, job.handle.request_path, joinPath(job.job_dir, "queued.json"), joinPath(job.job_dir, "claimed.json"), joinPath(job.job_dir, "launched.json"), joinPath(job.job_dir, "heartbeat.json"), joinPath(job.job_dir, "finished.json")]) { try { fs.removeFile(path); } catch { /* terminal cleanup is best effort */ } }
    try { fs.removeDirectory(job.job_dir); } catch { /* terminal cleanup is best effort */ }
  }
}
