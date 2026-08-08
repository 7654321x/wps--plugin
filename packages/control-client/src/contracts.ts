/** Contracts shared by the Dedicated Worker and the local WPS Control Server. */

export const CONTROL_CONTRACT_VERSION = 1 as const;
export const CONTROL_SERVER_VERSION = "1.4.3" as const;
export type ControlJobMode = "preview" | "format" | "recognize_only";
export type ControlJobState = "queued" | "recognizing" | "planning" | "completed" | "failed" | "cancelled";
export type JsonRecord = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

export interface ControlEndpointManifest {
  schema_version: 1;
  instance_id: string;
  pid: number;
  process_created_at: string;
  host: "127.0.0.1";
  port: number;
  base_url: string;
  session_token: string;
  server_version: string;
  contract_version: 1;
  started_at: string;
  heartbeat_at: string;
}

export interface ControlJobRequest {
  schema_version: typeof CONTROL_CONTRACT_VERSION;
  request_id: string;
  mode: ControlJobMode;
  document_token: string;
  document_revision: string;
  snapshot_sha256: string;
  snapshot: JsonRecord;
  profile_id?: string;
  profile_version?: string;
  client_capabilities?: JsonRecord;
}

export interface SubmittedJob {
  job_id: string;
  request_id: string;
  status: "queued";
  idempotent?: boolean;
}

export interface ControlJobStatus {
  schema_version: number;
  job_id: string;
  request_id: string;
  status: ControlJobState;
  stage: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  metrics?: JsonRecord;
  error?: { code: string; message: string };
}

export interface ControlJobResult {
  schema_version: number;
  job_id: string;
  request_id: string;
  document_token: string;
  snapshot_sha256: string;
  recognition_result: JsonRecord;
  formatting_plan: JsonRecord;
  warnings: string[];
  metrics?: JsonRecord;
}

export interface ControlHealth {
  status: "ready" | string;
  server_version: string;
  contract_version: number;
  instance_id: string;
  pid: number;
  process_created_at: string;
  heartbeat_at: string;
  jobs?: JsonRecord;
}

export interface ControlCapabilities {
  schema_version: number;
  server_version: string;
  recognition: { available: boolean; contract_versions: number[]; max_paragraphs: number };
  formatting: { available: boolean; plan_versions: number[] };
  job: { cancel: boolean; max_active_jobs: number; max_queued_jobs: number };
}

export type DocumentRepairInspection =
  | { schema_version: 1; status: "clean"; package_member_count: number; document_relationship_count: number; null_relationship_count: number; dangling_drawing_count: number }
  | { schema_version: 1; status: "repair_required"; repair_id: string; broken_relationship_count: number; package_member_count: number; document_relationship_count: number; null_relationship_count: number; dangling_drawing_count: number };

export interface DocumentRepairApplied {
  schema_version: 1;
  status: "applied";
  repair_id: string;
  removed_relationship_count: number;
  removed_drawing_count: number;
}

export interface DocumentRepairCompleted {
  schema_version: 1;
  status: "committed" | "restored";
  repair_id: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_EXECUTION_KEYS = new Set(["command", "code", "eval", "executable", "executable_path", "function", "import", "module", "powershell", "python", "script", "shell", "wscript"]);

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function isUuid(value: string): boolean { return UUID.test(value); }

export function assertDocumentRepairInspection(value: unknown): asserts value is DocumentRepairInspection {
  if (!object(value) || value.schema_version !== 1 || !["clean", "repair_required"].includes(String(value.status))) throw new Error("CONTROL_SERVER_RESULT_INVALID");
  for (const key of ["package_member_count", "document_relationship_count", "null_relationship_count", "dangling_drawing_count"] as const) if (!Number.isInteger(value[key]) || Number(value[key]) < 0) throw new Error("CONTROL_SERVER_RESULT_INVALID");
  if (value.status === "repair_required" && (typeof value.repair_id !== "string" || !UUID.test(value.repair_id) || !Number.isInteger(value.broken_relationship_count) || Number(value.broken_relationship_count) < 1)) throw new Error("CONTROL_SERVER_RESULT_INVALID");
}

export function assertDocumentRepairApplied(value: unknown, repairId: string): asserts value is DocumentRepairApplied {
  if (!object(value) || value.schema_version !== 1 || value.status !== "applied" || value.repair_id !== repairId || !Number.isInteger(value.removed_relationship_count) || Number(value.removed_relationship_count) < 0 || !Number.isInteger(value.removed_drawing_count) || Number(value.removed_drawing_count) < 1) throw new Error("CONTROL_SERVER_RESULT_INVALID");
}

export function assertDocumentRepairCompleted(value: unknown, repairId: string, outcome: "commit" | "restore"): asserts value is DocumentRepairCompleted {
  const expectedStatus = outcome === "commit" ? "committed" : "restored";
  if (!object(value) || value.schema_version !== 1 || value.status !== expectedStatus || value.repair_id !== repairId) throw new Error("CONTROL_SERVER_RESULT_INVALID");
}
function scanExecutionKeys(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(scanExecutionKeys); return; }
  if (!object(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_EXECUTION_KEYS.has(key.toLocaleLowerCase())) throw new Error("CONTROL_SERVER_EXECUTION_FIELD_REJECTED");
    scanExecutionKeys(nested);
  }
}

export function parseControlEndpointManifest(value: unknown, now = Date.now(), maxHeartbeatAgeMs = 10_000): ControlEndpointManifest {
  if (!object(value) || value.schema_version !== 1 || value.host !== "127.0.0.1" || value.contract_version !== CONTROL_CONTRACT_VERSION) throw new Error("CONTROL_SERVER_VERSION_MISMATCH");
  if (typeof value.instance_id !== "string" || !UUID.test(value.instance_id) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.process_created_at !== "string") throw new Error("CONTROL_SERVER_IDENTITY_INVALID");
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.port === 9528) throw new Error("CONTROL_SERVER_PORT_INVALID");
  if (typeof value.base_url !== "string" || typeof value.session_token !== "string" || value.session_token.length < 32 || typeof value.server_version !== "string" || typeof value.started_at !== "string" || typeof value.heartbeat_at !== "string") throw new Error("CONTROL_SERVER_MANIFEST_INVALID");
  const endpoint = new URL(value.base_url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== value.port || endpoint.search || endpoint.hash) throw new Error("CONTROL_SERVER_ENDPOINT_INVALID");
  const heartbeat = Date.parse(value.heartbeat_at);
  if (!Number.isFinite(heartbeat) || now - heartbeat > maxHeartbeatAgeMs || heartbeat - now > 60_000) throw new Error("CONTROL_SERVER_STALE");
  return value as unknown as ControlEndpointManifest;
}

export function assertControlJobRequest(value: ControlJobRequest): void {
  if (!object(value) || value.schema_version !== CONTROL_CONTRACT_VERSION || !REQUEST_ID.test(value.request_id)) throw new Error("CONTROL_SERVER_REQUEST_INVALID");
  if (!["preview", "format", "recognize_only"].includes(value.mode)) throw new Error("CONTROL_SERVER_MODE_INVALID");
  if (typeof value.document_token !== "string" || !value.document_token || typeof value.document_revision !== "string" || !value.document_revision || !SHA256.test(value.snapshot_sha256)) throw new Error("CONTROL_SERVER_REQUEST_INVALID");
  if (!object(value.snapshot)) throw new Error("CONTROL_SERVER_SNAPSHOT_INVALID");
  scanExecutionKeys(value.snapshot);
}

export function assertControlJobResult(value: unknown, request?: ControlJobRequest): asserts value is ControlJobResult {
  if (!object(value) || typeof value.job_id !== "string" || typeof value.request_id !== "string" || typeof value.document_token !== "string" || !SHA256.test(String(value.snapshot_sha256)) || !object(value.recognition_result) || !object(value.formatting_plan) || !Array.isArray(value.warnings) || !value.warnings.every((item) => typeof item === "string")) throw new Error("CONTROL_SERVER_RESULT_INVALID");
  if (request && (value.request_id !== request.request_id || value.document_token !== request.document_token || value.snapshot_sha256 !== request.snapshot_sha256)) throw new Error("CONTROL_SERVER_RESULT_MISMATCH");
}
