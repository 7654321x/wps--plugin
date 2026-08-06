import type { DiagnosticReporter } from "../../../packages/diagnostics/src/index.js";
import type { HostRpcResult, PipelineCommand, PipelineWorkerConfig, PipelineWorkerEvent, WorkerHostRequest } from "../../../packages/threading/src/protocol.js";
import { parseWorkerMessage } from "../../../packages/threading/src/validation.js";
import type { WpsHostBridge } from "../../../packages/wps-adapter/src/host-bridge.js";

export interface SnapshotCommandReceipt { accepted: boolean; command_id: string; command_name: PipelineCommand; reason?: string; }
export interface PipelineWorkerClientOptions {
  workerUrl: string;
  bridge: WpsHostBridge;
  buildId: string;
  workerConfig?: PipelineWorkerConfig;
  diagnostics?: DiagnosticReporter;
  onEvent: (event: PipelineWorkerEvent) => void;
  workerFactory?: (url: string) => Worker;
}

function createId(prefix: string): string {
  if (typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("")}`;
}
function failure(jobId: string, buildId: string, code: string): PipelineWorkerEvent {
  return { type: "pipeline.failed", job_id: jobId, build_id: buildId, error: { code, message: code } };
}

export class PipelineWorkerClient {
  private worker: Worker | null = null;
  private activeJobId: string | null = null;
  private disposed = false;

  constructor(private readonly options: PipelineWorkerClientOptions) {}

  startSnapshotJob(): SnapshotCommandReceipt {
    return this.start("snapshot_shadow");
  }

  start(command: PipelineCommand): SnapshotCommandReceipt {
    if (this.disposed) return { accepted: false, command_id: "", command_name: command, reason: "PIPELINE_CLIENT_DISPOSED" };
    if (this.activeJobId) return { accepted: false, command_id: this.activeJobId, command_name: command, reason: "PIPELINE_BUSY" };
    const jobId = createId(command.replaceAll("_", "-"));
    try { this.ensureWorker(); }
    catch { return { accepted: false, command_id: "", command_name: command, reason: "PIPELINE_WORKER_CONSTRUCTION_FAILED" }; }
    this.activeJobId = jobId;
    this.worker!.postMessage({ type: "pipeline.start", job: { job_id: jobId, command, build_id: this.options.buildId, created_at: new Date().toISOString() } });
    this.options.diagnostics?.writeForComponent("pipeline-worker-client", "INFO", command === "snapshot_shadow" ? "worker.snapshot.shadow.start" : "pipeline.job.submitted", "后台线程任务已提交", { job_id: jobId, command });
    return { accepted: true, command_id: jobId, command_name: command };
  }

  cancelActiveJob(): boolean {
    if (!this.activeJobId || !this.worker) return false;
    this.worker.postMessage({ type: "pipeline.cancel", job_id: this.activeJobId, build_id: this.options.buildId });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const jobId = this.activeJobId;
    this.activeJobId = null;
    this.worker?.terminate();
    this.worker = null;
    if (jobId) this.options.onEvent({ type: "pipeline.cancelled", job_id: jobId, build_id: this.options.buildId });
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const worker = this.options.workerFactory?.(this.options.workerUrl) ?? new Worker(this.options.workerUrl);
    worker.onmessage = (event) => { void this.handleWorkerMessage(event.data); };
    worker.onerror = () => this.workerFailed("PIPELINE_WORKER_CRASHED");
    worker.onmessageerror = () => this.workerFailed("PIPELINE_WORKER_MESSAGE_ERROR");
    this.worker = worker;
    worker.postMessage({ type: "pipeline.init", build_id: this.options.buildId, ...(this.options.workerConfig ? { config: this.options.workerConfig } : {}) });
  }

  private async handleWorkerMessage(raw: unknown): Promise<void> {
    let message: WorkerHostRequest | PipelineWorkerEvent;
    try { message = parseWorkerMessage(raw); }
    catch { this.workerFailed("INVALID_PIPELINE_WORKER_MESSAGE"); return; }
    if (message.build_id !== this.options.buildId) {
      if (message.type === "host.rpc.request") this.postRejectedRpc(message, "PIPELINE_BUILD_MISMATCH");
      else if (message.type !== "pipeline.ready" && message.job_id === this.activeJobId) this.workerFailed("PIPELINE_BUILD_MISMATCH");
      return;
    }
    if (message.type === "host.rpc.request") {
      if (!this.activeJobId || message.job_id !== this.activeJobId) { this.postRejectedRpc(message, "PIPELINE_STALE_JOB"); return; }
      const result = await this.options.bridge.handle(message);
      if (this.worker && this.activeJobId === message.job_id) this.worker.postMessage(result);
      return;
    }
    if (message.type !== "pipeline.ready" && message.job_id !== this.activeJobId) return;
    this.options.onEvent(message);
    if (["pipeline.completed", "pipeline.failed", "pipeline.cancelled"].includes(message.type) && message.type !== "pipeline.ready" && message.job_id === this.activeJobId) this.activeJobId = null;
  }

  private postRejectedRpc(request: WorkerHostRequest, errorCode: string): void {
    const result: HostRpcResult = { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: this.options.buildId, ok: false, duration_ms: 0, error: { code: errorCode, message: errorCode } };
    this.worker?.postMessage(result);
  }

  private workerFailed(errorCode: string): void {
    const jobId = this.activeJobId;
    this.activeJobId = null;
    this.worker?.terminate();
    this.worker = null;
    if (jobId) this.options.onEvent(failure(jobId, this.options.buildId, errorCode));
    this.options.diagnostics?.writeForComponent("pipeline-worker-client", "ERROR", "pipeline.worker.failed", "后台线程运行失败", { stable_error_code: errorCode });
  }
}
