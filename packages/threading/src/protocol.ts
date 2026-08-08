export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PipelineCommand = "snapshot_shadow" | "diagnostic" | "recognize" | "preview" | "format" | "clear_preview" | "cancel";

export interface PipelineJob {
  job_id: string;
  command: PipelineCommand;
  build_id: string;
  created_at: string;
}

export const HOST_RPC_OPERATIONS = [
  "host.capture_document_descriptor",
  "host.read_paragraph_batch",
  "host.capture_target_batch",
  "host.launch_recognition",
  "host.probe_recognition",
  "host.probe_shell_execute_one_argument",
  "host.cancel_recognition",
  "host.apply_preview_batch",
  "host.clear_preview_batch",
  "host.apply_structural_normalization_batch",
  "host.begin_transaction",
  "host.apply_format_batch",
  "host.rollback_batch",
  "host.commit_transaction",
  "host.update_state",
] as const;

export type HostRpcOperation = typeof HOST_RPC_OPERATIONS[number];

export interface WorkerHostRequest {
  type: "host.rpc.request";
  operation: HostRpcOperation;
  rpc_id: string;
  job_id: string;
  build_id: string;
  document_token?: string;
  payload: { [key: string]: JsonValue };
}

export interface SerializedHostError {
  code: string;
  message: string;
  stack?: string;
}

export interface HostRpcResult<T extends JsonValue = JsonValue> {
  type: "host.rpc.result";
  rpc_id: string;
  job_id: string;
  build_id: string;
  ok: boolean;
  duration_ms: number;
  queue_delay_ms?: number;
  roundtrip_hint_ms?: number;
  value?: T;
  error?: SerializedHostError;
}

export interface DocumentDescriptor {
  document_token: string;
  saved: boolean;
  local_docx_path: string;
  local_docx_path_hash: string;
  paragraph_count: number;
  section_count: number;
  extension: string;
}

export interface HostParagraphData {
  host_paragraph_index: number;
  raw_text: string;
  is_in_table: boolean;
  range_start: number;
  range_end: number;
  has_section_break: boolean;
  has_page_break: boolean;
  has_object: boolean;
}

export interface RecognitionJobHandle {
  recognition_job_id: string;
  queued_at: string;
  request_path: string;
  result_path: string;
  error_path: string;
  cancel_path: string;
  launch_mode: "file_queue_broker";
}

export type RecognitionJobStatus =
  | { state: "queued" | "claimed" | "launched" | "running" }
  | { state: "completed"; recognition_plan: JsonValue }
  | { state: "failed"; error: SerializedHostError }
  | { state: "cancelled" };

export interface SerializableLocalDocumentSnapshot {
  snapshotContractVersion: "worker-snapshot-v1";
  documentId: string;
  revision: string;
  textRevision: string;
  sourceSha256: string;
  localDocxPath: string;
  paragraphs: Array<{ sourceParagraphIndex: number; text: string; isInTable: boolean; hasSectionBreak: boolean; hasPageBreak: boolean; hasObject: boolean }>;
  paragraphOrderHash: string;
  sectionCount: number;
  documentFullNameHash: string;
}

export interface SnapshotSummary {
  snapshot_contract_version: "worker-snapshot-v1";
  paragraph_count: number;
  batch_count: number;
  min_batch_size: number;
  max_batch_size: number;
  max_host_rpc_ms: number;
  p95_host_rpc_ms: number;
  average_batch_size: number;
  host_duration_p50_ms: number;
  host_duration_p95_ms: number;
  worker_roundtrip_p50_ms: number;
  worker_roundtrip_p95_ms: number;
  host_rpc_outlier_count: number;
  worker_total_ms: number;
  source_sha256_prefix: string;
  order_sha256_prefix: string;
  text_revision: string;
}

export type PipelineStage = "idle" | "capturing_descriptor" | "reading_snapshot" | "reading_paragraphs" | "hashing_snapshot" | "hashing" | "launching_recognition" | "waiting_recognition" | "mapping_recognition" | "normalizing_structure" | "resnapshotting_after_normalization" | "generating_commands" | "validating_targets" | "writing_preview" | "applying_format" | "rolling_back" | "completed" | "failed" | "cancelled";

export type PipelineWorkerEvent =
  | { type: "pipeline.ready"; build_id: string }
  | { type: "pipeline.progress"; job_id: string; build_id: string; stage: PipelineStage; completed: number; total: number; batch_size: number; detail: string }
  | { type: "pipeline.diagnostic"; job_id: string; build_id: string; event: string; data: { [key: string]: JsonValue } }
  | { type: "pipeline.completed"; job_id: string; build_id: string; command: PipelineCommand; snapshot_summary: SnapshotSummary; recognition_result?: import("../../contracts/src/index.js").RecognitionResult; formatting_commands?: import("../../contracts/src/index.js").FormattingCommandSet; preview_result?: { session_id: string; comment_count: number; plan_count: number }; format_result?: { executed_command_count: number; skipped_command_count: number; skipped_review_count: number; skipped_mixed_count: number; skipped_unresolved_count: number; split_source_paragraph_count: number; created_paragraph_count: number; trimmed_boundary_count: number; removed_empty_paragraph_count: number; batch_count: number } }
  | { type: "pipeline.failed"; job_id: string; build_id: string; error: SerializedHostError }
  | { type: "pipeline.cancelled"; job_id: string; build_id: string };

export interface PipelineWorkerConfig {
  profile: JsonValue;
  client_capabilities: import("../../contracts/src/index.js").ClientCapabilities;
  authorization_scope: "classified-offline";
  /** Optional C7 control-plane endpoint; absent keeps the proven local path. */
  control_endpoint?: import("../../control-client/src/contracts.js").ControlEndpointManifest;
}
export interface PipelineInitMessage { type: "pipeline.init"; build_id: string; config?: PipelineWorkerConfig; }
export interface PipelineStartMessage { type: "pipeline.start"; job: PipelineJob; }
export interface PipelineCancelMessage { type: "pipeline.cancel"; job_id: string; build_id: string; }
export type HostToWorkerMessage = PipelineInitMessage | PipelineStartMessage | PipelineCancelMessage | HostRpcResult;
export type WorkerToHostMessage = WorkerHostRequest | PipelineWorkerEvent;
