import { HOST_RPC_OPERATIONS, type HostRpcOperation, type HostRpcResult, type JsonValue, type PipelineCommand, type PipelineJob, type PipelineWorkerEvent, type WorkerHostRequest, type WorkerToHostMessage } from "./protocol.js";

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const COMMANDS = new Set<PipelineCommand>(["snapshot_shadow", "diagnostic", "recognize", "preview", "format", "clear_preview", "cancel"]);
const OPERATIONS = new Set<HostRpcOperation>(HOST_RPC_OPERATIONS);

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}
function identifier(value: unknown): value is string { return typeof value === "string" && ID.test(value); }

export function parsePipelineJob(value: unknown): PipelineJob {
  if (!record(value) || !identifier(value.job_id) || !COMMANDS.has(value.command as PipelineCommand) || !identifier(value.build_id) || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) throw new Error("INVALID_PIPELINE_JOB");
  return { job_id: value.job_id, command: value.command as PipelineCommand, build_id: value.build_id, created_at: value.created_at };
}

export function parseWorkerHostRequest(value: unknown): WorkerHostRequest {
  if (!record(value) || value.type !== "host.rpc.request" || !OPERATIONS.has(value.operation as HostRpcOperation) || !identifier(value.rpc_id) || !identifier(value.job_id) || !identifier(value.build_id) || (value.document_token !== undefined && !identifier(value.document_token)) || !record(value.payload) || !jsonValue(value.payload)) throw new Error("INVALID_HOST_RPC_REQUEST");
  return { type: "host.rpc.request", operation: value.operation as HostRpcOperation, rpc_id: value.rpc_id, job_id: value.job_id, build_id: value.build_id, ...(value.document_token === undefined ? {} : { document_token: value.document_token }), payload: value.payload as Record<string, JsonValue> };
}

export function parseHostRpcResult(value: unknown): HostRpcResult {
  if (!record(value) || value.type !== "host.rpc.result" || !identifier(value.rpc_id) || !identifier(value.job_id) || !identifier(value.build_id) || typeof value.ok !== "boolean" || typeof value.duration_ms !== "number" || !Number.isFinite(value.duration_ms) || (value.queue_delay_ms !== undefined && (typeof value.queue_delay_ms !== "number" || !Number.isFinite(value.queue_delay_ms))) || (value.roundtrip_hint_ms !== undefined && (typeof value.roundtrip_hint_ms !== "number" || !Number.isFinite(value.roundtrip_hint_ms))) || (value.value !== undefined && !jsonValue(value.value)) || (value.error !== undefined && !record(value.error))) throw new Error("INVALID_HOST_RPC_RESULT");
  return value as unknown as HostRpcResult;
}

export function parseWorkerMessage(value: unknown): WorkerToHostMessage {
  if (record(value) && value.type === "host.rpc.request") return parseWorkerHostRequest(value);
  if (!record(value) || typeof value.type !== "string" || !["pipeline.ready", "pipeline.progress", "pipeline.diagnostic", "pipeline.completed", "pipeline.failed", "pipeline.cancelled"].includes(value.type) || !identifier(value.build_id)) throw new Error("INVALID_PIPELINE_WORKER_MESSAGE");
  if (value.type !== "pipeline.ready" && !identifier(value.job_id)) throw new Error("INVALID_PIPELINE_WORKER_MESSAGE");
  if (!jsonValue(value)) throw new Error("INVALID_PIPELINE_WORKER_MESSAGE");
  return value as unknown as PipelineWorkerEvent;
}
