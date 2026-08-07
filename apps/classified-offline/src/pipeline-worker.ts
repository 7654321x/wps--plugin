import type { DocumentDescriptor, HostParagraphData, HostRpcOperation, HostRpcResult, HostToWorkerMessage, JsonValue, PipelineJob, PipelineWorkerEvent, SerializableLocalDocumentSnapshot, SnapshotSummary, WorkerHostRequest } from "../../../packages/threading/src/protocol.js";
import { parseHostRpcResult, parsePipelineJob } from "../../../packages/threading/src/validation.js";
import { mapWheelRecognitionPlan, type WheelRecognitionPlan } from "../../../packages/recognition-client/src/index.js";
import { LocalFormatCommandGenerator, type LocalFormatProfile } from "../../../packages/local-format-engine/src/index.js";
import { COMMAND_REQUEST_VERSION, assertFormattingCommandSet, type CommandRequest, type FormattingCommandSet, type RecognitionResult } from "../../../packages/contracts/src/index.js";
import type { PipelineWorkerConfig } from "../../../packages/threading/src/protocol.js";
import { createPreviewPlan, type PreviewPlanItem } from "../../../packages/wps-adapter/src/preview-comments.js";
import { LocalHttpControlTransport, StaticControlEndpointProvider, assertControlJobResult, type ControlJobRequest, type ControlJobResult } from "../../../packages/control-client/src/index.js";

type WorkerScopeLike = { postMessage: (value: unknown) => void; onmessage: ((event: { data: unknown }) => void) | null };
type SnapshotStage = "idle" | "capturing_descriptor" | "reading_paragraphs" | "hashing" | "launching_recognition" | "waiting_recognition" | "mapping_recognition" | "generating_commands" | "writing_preview" | "completed" | "failed" | "cancelled";
interface SnapshotJobContext {
  job: PipelineJob; stage: SnapshotStage; cancelled: boolean; descriptor: DocumentDescriptor | null;
  paragraphs: HostParagraphData[]; started_at_ms: number; batch: AdaptiveBatchController; batch_sizes: number[];
  host_rpc_durations: number[]; worker_roundtrip_durations: number[];
  recognition_job_id: string | null;
  control_job_id: string | null;
  preview_session_id: string | null;
}
interface PendingRpc { resolve: (value: RpcResponse<JsonValue>) => void; reject: (error: Error) => void; job_id: string; started_at_ms: number; timer: ReturnType<typeof setTimeout>; }
export interface SnapshotWorkerOptions { rpc_timeout_ms?: number; paragraph_rpc_timeout_ms?: number; }
export interface RpcResponse<T> { value: T; host_duration_ms: number; worker_roundtrip_ms: number; }
export interface BatchMetrics { samples: number[]; batch_size: number; consecutive_fast: number; consecutive_slow: number; consecutive_outliers: number; outlier_count: number; outlier_recovery_size: number | null; }

export async function generateWorkerCommands(recognition: RecognitionResult, requestId: string, config: PipelineWorkerConfig): Promise<FormattingCommandSet> {
  const request: CommandRequest = { schema_version: COMMAND_REQUEST_VERSION, request_id: requestId, recognition_result: recognition, profile_id: "default", profile_version: "1.0", client_capabilities: config.client_capabilities, product_version: "1.0", authorization_scope: config.authorization_scope };
  const result = await new LocalFormatCommandGenerator(config.profile as unknown as LocalFormatProfile).requestCommands(request);
  assertFormattingCommandSet(result, requestId);
  return result;
}

function errorCode(error: unknown): string { const value = error instanceof Error ? error.message : "PIPELINE_WORKER_FAILED"; return /^[A-Z][A-Z0-9_]{1,100}$/.test(value) ? value : "PIPELINE_WORKER_FAILED"; }
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function shouldSampleBatch(ordinal: number): boolean { return ordinal <= 3 || ordinal % 20 === 0; }

export class AdaptiveBatchController {
  readonly metrics: BatchMetrics;
  constructor(initial = 5, private readonly minimum = 1, private readonly maximum = 10) {
    this.metrics = { samples: [], batch_size: initial, consecutive_fast: 0, consecutive_slow: 0, consecutive_outliers: 0, outlier_count: 0, outlier_recovery_size: null };
  }
  current(): number { return this.metrics.batch_size; }
  record(hostDurationMs: number): number {
    const metrics = this.metrics;
    if (hostDurationMs > 100) {
      metrics.outlier_count += 1; metrics.consecutive_outliers += 1; metrics.consecutive_fast = 0; metrics.consecutive_slow = 0;
      if (metrics.consecutive_outliers >= 3) { metrics.batch_size = this.minimum; metrics.outlier_recovery_size = null; }
      else {
        if (metrics.outlier_recovery_size === null) metrics.outlier_recovery_size = metrics.batch_size;
        metrics.batch_size = Math.max(this.minimum, metrics.batch_size - 1);
      }
      return metrics.batch_size;
    }
    if (metrics.outlier_recovery_size !== null) { metrics.batch_size = metrics.outlier_recovery_size; metrics.outlier_recovery_size = null; }
    metrics.consecutive_outliers = 0;
    metrics.samples.push(hostDurationMs);
    if (metrics.samples.length > 8) metrics.samples.shift();
    const median = percentile(metrics.samples, 0.5);
    if (median <= 6) {
      metrics.consecutive_fast += 1; metrics.consecutive_slow = 0;
      if (metrics.consecutive_fast >= 3) { metrics.batch_size = Math.min(this.maximum, metrics.batch_size + 1); metrics.consecutive_fast = 0; }
    } else if (median > 20) {
      metrics.consecutive_slow += 1; metrics.consecutive_fast = 0;
      if (metrics.consecutive_slow >= 2) { metrics.batch_size = Math.max(this.minimum, Math.floor(metrics.batch_size / 2)); metrics.consecutive_slow = 0; }
    } else { metrics.consecutive_fast = 0; metrics.consecutive_slow = 0; }
    return metrics.batch_size;
  }
}
function assertNotCancelled(context: SnapshotJobContext): void { if (context.cancelled) throw new Error("PIPELINE_CANCELLED"); }

export async function createEquivalentSnapshot(descriptor: DocumentDescriptor, paragraphs: HostParagraphData[]): Promise<SerializableLocalDocumentSnapshot> {
  const sourceSha256 = await sha256(paragraphs.map((item) => item.raw_text).join("\u001f"));
  const paragraphOrderHash = await sha256(paragraphs.map((item) => `${item.host_paragraph_index}:${item.raw_text}`).join("\u001f"));
  const textRevision = `${sourceSha256}:${paragraphs.length}`;
  return {
    snapshotContractVersion: "worker-snapshot-v1", documentId: `wps-${sourceSha256.slice(0, 16)}`, revision: textRevision, textRevision,
    sourceSha256, localDocxPath: descriptor.local_docx_path,
    paragraphs: paragraphs.map((item) => ({ sourceParagraphIndex: item.host_paragraph_index, text: item.raw_text, isInTable: item.is_in_table, rangeStart: item.range_start, rangeEnd: item.range_end })),
    paragraphOrderHash, sectionCount: descriptor.section_count, documentFullNameHash: descriptor.local_docx_path_hash,
  };
}

export class SnapshotPipelineWorkerRuntime {
  private buildId = "";
  private config: PipelineWorkerConfig | null = null;
  private active: SnapshotJobContext | null = null;
  private readonly pending = new Map<string, PendingRpc>();
  private rpcSequence = 0;

  constructor(private readonly scope: WorkerScopeLike, private readonly options: SnapshotWorkerOptions = {}) { scope.onmessage = (event) => { void this.handle(event.data); }; }

  private post(event: PipelineWorkerEvent): void { this.scope.postMessage(event); }
  private diagnostic(context: SnapshotJobContext, event: string, data: Record<string, JsonValue> = {}): void { this.post({ type: "pipeline.diagnostic", job_id: context.job.job_id, build_id: context.job.build_id, event, data }); }

  private async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const message = raw as HostToWorkerMessage;
    if (message.type === "pipeline.init") {
      this.buildId = message.build_id;
      this.config = message.config ?? null;
      this.post({ type: "pipeline.ready", build_id: this.buildId });
      return;
    }
    if (message.type === "host.rpc.result") { this.resolveRpc(message); return; }
    if (message.type === "pipeline.cancel") {
      if (message.build_id === this.buildId && this.active?.job.job_id === message.job_id) this.active.cancelled = true;
      return;
    }
    if (message.type !== "pipeline.start") return;
    let job: PipelineJob;
    try { job = parsePipelineJob(message.job); }
    catch { return; }
    if (job.build_id !== this.buildId) { this.post({ type: "pipeline.failed", job_id: job.job_id, build_id: job.build_id, error: { code: "PIPELINE_BUILD_MISMATCH", message: "PIPELINE_BUILD_MISMATCH" } }); return; }
    if (!["snapshot_shadow", "diagnostic", "recognize", "preview"].includes(job.command)) { this.post({ type: "pipeline.failed", job_id: job.job_id, build_id: job.build_id, error: { code: "PIPELINE_COMMAND_NOT_IMPLEMENTED", message: "PIPELINE_COMMAND_NOT_IMPLEMENTED" } }); return; }
    if (this.active) { this.post({ type: "pipeline.failed", job_id: job.job_id, build_id: job.build_id, error: { code: "PIPELINE_BUSY", message: "PIPELINE_BUSY" } }); return; }
    const context: SnapshotJobContext = { job, stage: "idle", cancelled: false, descriptor: null, paragraphs: [], started_at_ms: performance.now(), batch: new AdaptiveBatchController(), batch_sizes: [], host_rpc_durations: [], worker_roundtrip_durations: [], recognition_job_id: null, control_job_id: null, preview_session_id: null };
    this.active = context;
    void this.run(context);
  }

  private async run(context: SnapshotJobContext): Promise<void> {
    this.diagnostic(context, "pipeline.job.started");
    try {
      const built = await this.buildSnapshot(context);
      assertNotCancelled(context);
      const controlResult = context.job.command === "snapshot_shadow" ? null : await this.controlJob(context, built.snapshot);
      const recognition = context.job.command === "snapshot_shadow" ? undefined : (controlResult?.recognition_result as RecognitionResult | undefined) ?? await this.recognize(context, built.snapshot);
      let commands: FormattingCommandSet | undefined; let previewResult: { session_id: string; comment_count: number; plan_count: number } | undefined;
      if (context.job.command === "preview") {
        if (!this.config) throw new Error("PIPELINE_WORKER_CONFIG_REQUIRED");
        context.stage = "generating_commands";
        if (controlResult) {
          commands = controlResult.formatting_plan as unknown as FormattingCommandSet;
          assertFormattingCommandSet(commands, context.job.job_id);
        } else {
          commands = await generateWorkerCommands(recognition!, context.job.job_id, this.config);
        }
        this.diagnostic(context, "pipeline.commands.complete", { command_count: commands.commands.length });
        const plan = createPreviewPlan(built.snapshot, recognition!, commands, "all");
        previewResult = await this.writePreview(context, plan);
      }
      context.stage = "completed";
      this.post({ type: "pipeline.completed", job_id: context.job.job_id, build_id: context.job.build_id, command: context.job.command, snapshot_summary: built.summary, ...(recognition ? { recognition_result: recognition } : {}), ...(commands ? { formatting_commands: commands } : {}), ...(previewResult ? { preview_result: previewResult } : {}) });
    } catch (error) {
      const code = errorCode(error);
      if (context.preview_session_id) await this.clearPreview(context).catch(() => undefined);
      if (code === "PIPELINE_CANCELLED") {
        context.stage = "cancelled";
        const control = this.createControlTransport();
        if (context.control_job_id && control) await control.cancel(context.control_job_id).catch(() => undefined);
        if (context.recognition_job_id) await this.rpc<JsonValue>(context, "host.cancel_recognition", { recognition_job_id: context.recognition_job_id }).catch(() => undefined);
        this.post({ type: "pipeline.cancelled", job_id: context.job.job_id, build_id: context.job.build_id });
      }
      else { context.stage = "failed"; this.post({ type: "pipeline.failed", job_id: context.job.job_id, build_id: context.job.build_id, error: { code, message: code } }); }
    } finally {
      this.rejectPendingForJob(context.job.job_id, "PIPELINE_JOB_FINISHED");
      if (this.active === context) this.active = null;
    }
  }

  private createControlTransport(): LocalHttpControlTransport | null {
    const endpoint = this.config?.control_endpoint;
    if (!endpoint) return null;
    return new LocalHttpControlTransport(new StaticControlEndpointProvider(endpoint));
  }

  private async controlJob(context: SnapshotJobContext, snapshot: SerializableLocalDocumentSnapshot): Promise<ControlJobResult | null> {
    const transport = this.createControlTransport();
    if (!transport || !context.descriptor) return null;
    const mode = context.job.command === "preview" ? "preview" : context.job.command === "format" ? "format" : "recognize_only";
    const request: ControlJobRequest = {
      schema_version: 1,
      request_id: context.job.job_id,
      mode,
      document_token: context.descriptor.document_token,
      document_revision: snapshot.revision,
      snapshot_sha256: snapshot.sourceSha256,
      snapshot: snapshot as unknown as import("../../../packages/control-client/src/contracts.js").JsonRecord,
      profile_id: "default",
      profile_version: "1.0",
      client_capabilities: this.config?.client_capabilities as unknown as import("../../../packages/control-client/src/contracts.js").JsonRecord,
    };
    context.stage = "launching_recognition";
    this.diagnostic(context, "control.job.submit", { mode });
    const submitted = await transport.submit(request);
    context.control_job_id = submitted.job_id;
    let intervalMs = 100;
    const started = performance.now();
    for (;;) {
      assertNotCancelled(context);
      if (performance.now() - started > 120_000) {
        await transport.cancel(submitted.job_id).catch(() => undefined);
        throw new Error("CONTROL_SERVER_JOB_TIMEOUT");
      }
      const status = await transport.status(submitted.job_id);
      if (status.status === "completed") {
        const result = await transport.result(submitted.job_id, undefined, request);
        assertControlJobResult(result, request);
        this.diagnostic(context, "control.job.complete", { mode, status: status.status });
        return result;
      }
      if (status.status === "failed") throw new Error(status.error?.code ?? "CONTROL_SERVER_JOB_FAILED");
      if (status.status === "cancelled") throw new Error("PIPELINE_CANCELLED");
      context.stage = status.status === "planning" ? "generating_commands" : status.status === "recognizing" ? "waiting_recognition" : "launching_recognition";
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      intervalMs = Math.min(500, intervalMs + 25);
    }
  }

  private async buildSnapshot(context: SnapshotJobContext): Promise<{ snapshot: SerializableLocalDocumentSnapshot; summary: SnapshotSummary }> {
    context.stage = "capturing_descriptor"; this.diagnostic(context, "pipeline.snapshot.descriptor.start");
    const descriptorResult = await this.rpc<DocumentDescriptor>(context, "host.capture_document_descriptor", {}, undefined, this.options.rpc_timeout_ms ?? 10_000);
    context.host_rpc_durations.push(descriptorResult.host_duration_ms); context.worker_roundtrip_durations.push(descriptorResult.worker_roundtrip_ms); context.descriptor = descriptorResult.value;
    this.diagnostic(context, "pipeline.snapshot.descriptor.complete", { paragraph_count: descriptorResult.value.paragraph_count, host_duration_ms: descriptorResult.host_duration_ms, worker_roundtrip_ms: descriptorResult.worker_roundtrip_ms });
    assertNotCancelled(context);
    context.stage = "reading_paragraphs";
    let index = 0;
    while (index < descriptorResult.value.paragraph_count) {
      assertNotCancelled(context);
      const requested = Math.min(context.batch.current(), descriptorResult.value.paragraph_count - index);
      const ordinal = context.batch_sizes.length + 1;
      const result = await this.rpc<HostParagraphData[]>(context, "host.read_paragraph_batch", { start_index: index, batch_size: requested }, descriptorResult.value.document_token, this.options.paragraph_rpc_timeout_ms ?? 15_000);
      context.host_rpc_durations.push(result.host_duration_ms); context.worker_roundtrip_durations.push(result.worker_roundtrip_ms);
      if (!Array.isArray(result.value) || result.value.length === 0) throw new Error("HOST_PARAGRAPH_BATCH_EMPTY");
      if (result.value.length > requested) throw new Error("HOST_PARAGRAPH_BATCH_OVERFLOW");
      context.paragraphs.push(...result.value); index += result.value.length; context.batch_sizes.push(result.value.length);
      const completed = index === descriptorResult.value.paragraph_count;
      if (shouldSampleBatch(ordinal) || completed || result.host_duration_ms > 50) this.diagnostic(context, "pipeline.snapshot.batch.complete", { batch_ordinal: ordinal, completed: index, total: descriptorResult.value.paragraph_count, batch_size: result.value.length, host_duration_ms: result.host_duration_ms, worker_roundtrip_ms: result.worker_roundtrip_ms });
      if (shouldSampleBatch(ordinal) || completed) this.post({ type: "pipeline.progress", job_id: context.job.job_id, build_id: context.job.build_id, stage: "reading_paragraphs", completed: index, total: descriptorResult.value.paragraph_count, batch_size: result.value.length, detail: `正在读取段落 ${index}/${descriptorResult.value.paragraph_count}` });
      context.batch.record(result.host_duration_ms);
    }
    assertNotCancelled(context); context.stage = "hashing"; this.diagnostic(context, "pipeline.snapshot.hash.start", { paragraph_count: context.paragraphs.length });
    const snapshot = await createEquivalentSnapshot(descriptorResult.value, context.paragraphs);
    this.diagnostic(context, "pipeline.snapshot.hash.complete", { source_sha256_prefix: snapshot.sourceSha256.slice(0, 8), order_sha256_prefix: snapshot.paragraphOrderHash.slice(0, 8) });
    const maxHost = context.host_rpc_durations.length ? Math.max(...context.host_rpc_durations) : 0;
    const hostP95 = percentile(context.host_rpc_durations, 0.95);
    return { snapshot, summary: { snapshot_contract_version: "worker-snapshot-v1", paragraph_count: snapshot.paragraphs.length, batch_count: context.batch_sizes.length, min_batch_size: context.batch_sizes.length ? Math.min(...context.batch_sizes) : 0, max_batch_size: context.batch_sizes.length ? Math.max(...context.batch_sizes) : 0, max_host_rpc_ms: maxHost, p95_host_rpc_ms: hostP95, average_batch_size: context.batch_sizes.length ? snapshot.paragraphs.length / context.batch_sizes.length : 0, host_duration_p50_ms: percentile(context.host_rpc_durations, 0.5), host_duration_p95_ms: hostP95, worker_roundtrip_p50_ms: percentile(context.worker_roundtrip_durations, 0.5), worker_roundtrip_p95_ms: percentile(context.worker_roundtrip_durations, 0.95), host_rpc_outlier_count: context.batch.metrics.outlier_count, worker_total_ms: performance.now() - context.started_at_ms, source_sha256_prefix: snapshot.sourceSha256.slice(0, 8), order_sha256_prefix: snapshot.paragraphOrderHash.slice(0, 8), text_revision: snapshot.textRevision } };
  }

  private async recognize(context: SnapshotJobContext, snapshot: SerializableLocalDocumentSnapshot) {
    context.stage = "launching_recognition"; this.diagnostic(context, "pipeline.recognition.launch", { paragraph_count: snapshot.paragraphs.length });
    const launched = await this.rpc<Record<string, JsonValue>>(context, "host.launch_recognition", { source_path: snapshot.localDocxPath, snapshot: snapshot as unknown as JsonValue, contract_version: 1 }, context.descriptor?.document_token);
    const recognitionJobId = String(launched.value.recognition_job_id ?? "");
    if (!recognitionJobId) throw new Error("LOCAL_RECOGNITION_HANDLE_INVALID");
    context.recognition_job_id = recognitionJobId; context.stage = "waiting_recognition";
    let intervalMs = 300; const started = performance.now(); let probes = 0; let lastState = "";
    while (performance.now() - started <= 120_000) {
      assertNotCancelled(context);
      const status = await this.rpc<Record<string, JsonValue>>(context, "host.probe_recognition", { recognition_job_id: recognitionJobId });
      probes += 1;
      const state = String(status.value.state ?? "running");
      if (state !== lastState) {
        lastState = state;
        if (state === "claimed") this.diagnostic(context, "broker.job.claimed");
        if (state === "launched") this.diagnostic(context, "broker.recognizer.started");
      }
      if (status.value.state === "completed") {
        context.stage = "mapping_recognition";
        const result = await mapWheelRecognitionPlan(snapshot, status.value.recognition_plan as unknown as WheelRecognitionPlan);
        this.diagnostic(context, "pipeline.recognition.complete", { probe_count: probes, recognized_paragraph_count: result.paragraphs.length });
        return result;
      }
      if (status.value.state === "failed") throw new Error(String((status.value.error as Record<string, JsonValue> | undefined)?.code ?? "LOCAL_RECOGNITION_FAILED"));
      if (status.value.state === "cancelled") throw new Error("PIPELINE_CANCELLED");
      const elapsed = performance.now() - started;
      if ((state === "queued" || state === "running") && elapsed > 5_000) throw new Error("BROKER_CLAIM_TIMEOUT");
      if (state === "claimed" && elapsed > 10_000) throw new Error("RECOGNIZER_LAUNCH_TIMEOUT");
      this.post({ type: "pipeline.progress", job_id: context.job.job_id, build_id: context.job.build_id, stage: "waiting_recognition", completed: probes, total: 0, batch_size: 1, detail: "本地识别正在运行" });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      intervalMs = Math.min(1_000, intervalMs + 100);
    }
    throw new Error("LOCAL_RECOGNITION_TIMEOUT");
  }

  private async writePreview(context: SnapshotJobContext, plan: PreviewPlanItem[]): Promise<{ session_id: string; comment_count: number; plan_count: number }> {
    if (!context.descriptor) throw new Error("PIPELINE_DESCRIPTOR_REQUIRED");
    context.stage = "writing_preview";
    await this.clearPreview(context);
    const sessionId = `preview-${context.job.job_id}`; context.preview_session_id = sessionId;
    const batch = new AdaptiveBatchController(3, 1, 5); let index = 0;
    while (index < plan.length) {
      assertNotCancelled(context);
      const requested = Math.min(batch.current(), plan.length - index); const ordinal = Math.floor(index / Math.max(1, requested)) + 1;
      const response = await this.rpc<Record<string, JsonValue>>(context, "host.apply_preview_batch", { session_id: sessionId, items: plan.slice(index, index + requested) as unknown as JsonValue }, context.descriptor.document_token);
      const applied = Number(response.value.applied_count ?? 0);
      if (applied !== requested) throw new Error("PREVIEW_BATCH_INCOMPLETE");
      index += applied; batch.record(response.host_duration_ms);
      if (ordinal <= 3 || ordinal % 10 === 0 || index === plan.length) this.post({ type: "pipeline.progress", job_id: context.job.job_id, build_id: context.job.build_id, stage: "writing_preview", completed: index, total: plan.length, batch_size: applied, detail: `正在写入预览批注 ${index}/${plan.length}` });
      if (ordinal <= 3 || ordinal % 20 === 0 || response.host_duration_ms > 50 || index === plan.length) this.diagnostic(context, "pipeline.preview.batch", { batch_ordinal: ordinal, completed: index, total: plan.length, batch_size: applied, host_duration_ms: response.host_duration_ms });
    }
    return { session_id: sessionId, comment_count: index, plan_count: plan.length };
  }

  private async clearPreview(context: SnapshotJobContext): Promise<void> {
    if (!context.descriptor) return;
    for (;;) {
      const result = await this.rpc<Record<string, JsonValue>>(context, "host.clear_preview_batch", { batch_size: 5 }, context.descriptor.document_token);
      if (result.value.user_comment_integrity === false) throw new Error("PREVIEW_USER_COMMENT_CHANGED");
      if (Number(result.value.remaining ?? 0) === 0) break;
      assertNotCancelled(context);
    }
    context.preview_session_id = null;
  }

  private rpc<T>(context: SnapshotJobContext, operation: HostRpcOperation, payload: Record<string, JsonValue>, documentToken?: string, timeoutMs = 10_000): Promise<RpcResponse<T>> {
    const rpcId = `rpc-${++this.rpcSequence}-${context.job.job_id}`;
    const request: WorkerHostRequest = { type: "host.rpc.request", operation, rpc_id: rpcId, job_id: context.job.job_id, build_id: context.job.build_id, ...(documentToken ? { document_token: documentToken } : {}), payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rpcId); reject(new Error("HOST_RPC_TIMEOUT")); }, timeoutMs);
      this.pending.set(rpcId, { resolve: resolve as PendingRpc["resolve"], reject, job_id: context.job.job_id, started_at_ms: performance.now(), timer });
      this.scope.postMessage(request);
    });
  }

  private resolveRpc(raw: unknown): void {
    let result: HostRpcResult;
    try { result = parseHostRpcResult(raw); } catch { return; }
    const pending = this.pending.get(result.rpc_id);
    if (!pending || pending.job_id !== result.job_id || result.build_id !== this.buildId) return;
    clearTimeout(pending.timer); this.pending.delete(result.rpc_id);
    if (!result.ok) pending.reject(new Error(result.error?.code ?? "HOST_RPC_FAILED"));
    else if (result.value === undefined) pending.reject(new Error("HOST_RPC_VALUE_MISSING"));
    else pending.resolve({ value: result.value, host_duration_ms: result.duration_ms, worker_roundtrip_ms: performance.now() - pending.started_at_ms });
  }

  private rejectPendingForJob(jobId: string, code: string): void {
    for (const [rpcId, pending] of this.pending) if (pending.job_id === jobId) { clearTimeout(pending.timer); this.pending.delete(rpcId); pending.reject(new Error(code)); }
  }
}

const workerScope = globalThis as unknown as WorkerScopeLike;
if (typeof workerScope.postMessage === "function") new SnapshotPipelineWorkerRuntime(workerScope);
