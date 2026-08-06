import {
  RECOGNITION_RESULT_VERSION,
  type RecognitionParagraph,
  type RecognitionResult,
  type ReviewLevel,
} from "../../contracts/src/index.js";
import {
  HOST_TEXT_CONTRACT_VERSION,
  createHostTextTape,
  rawSliceUtf16,
} from "../../wps-adapter/src/host-text.js";
import { WpsLocalFileSystem, type WpsFileSystemApi } from "../../wps-adapter/src/local-filesystem.js";
import type { DiagnosticReporter } from "../../diagnostics/src/index.js";

export interface LocalHostParagraph {
  sourceParagraphIndex: number;
  text: string;
  isInTable?: boolean;
  storyType?: "main" | "header" | "footer";
}
export interface LocalDocumentSnapshot {
  documentId: string; revision: string; sourceSha256: string;
  localDocxPath?: string;
  paragraphs: LocalHostParagraph[];
  /** Local-only revision data. It is never sent to the command service. */
  formattingRevision?: string; paragraphOrderHash?: string; sectionCount?: number; documentFullNameHash?: string;
}
export interface WheelBindingBlock {
  block_index: number;
  physical_paragraph_index?: number | null;
  host_paragraph_index?: number | null;
  binding_status: "confirmed" | "review" | "unresolved";
  binding_confidence: number;
  binding_evidence?: string[];
  binding_warnings?: string[];
  host_raw_start_utf16?: number | null;
  host_raw_end_utf16?: number | null;
  host_canonical_start_utf16?: number | null;
  host_canonical_end_utf16?: number | null;
}
export interface WheelRecognitionPlan {
  schema_version: string; engine_version: string; package_version?: string;
  locator_version?: string; host_text_contract_version?: string;
  document_mode: RecognitionResult["document_mode"]; document_mode_confidence: number;
  blocks: Array<{
    source_paragraph_index: number | null; type_id: string; section: string; review_level: ReviewLevel;
    kind?: string; physical_paragraph_index?: number | null; physical_occurrence_index?: number;
    physical_text_sha256?: string; physical_text_length_utf16?: number;
    raw_start_utf16?: number | null; raw_end_utf16?: number | null;
    canonical_start_utf16?: number | null; canonical_end_utf16?: number | null;
    range_start_utf16?: number | null; range_end_utf16?: number | null;
    offset_encoding?: string; locator_verified?: boolean; source_locator_status?: string;
    segment_count_total?: number; segment_count_located?: number; segment_count_confirmed?: number;
    raw_fragment_sha256?: string; canonical_fragment_sha256?: string;
    text_length_utf16?: number; recognized_text?: string;
    /** Local wheel anchors. */
    text_sha256?: string; previous_text_sha256?: string; next_text_sha256?: string; block_index?: number;
  }>;
  binding?: {
    host_text_contract_version?: string;
    blocks: WheelBindingBlock[];
  };
}
export interface LocalRecognitionTransport { recognize(snapshot: LocalDocumentSnapshot): Promise<WheelRecognitionPlan>; }
export interface RecognitionProvider { recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult>; }
export interface WpsApplicationLike {
  Env?: { GetTempPath?: () => string; GetAppDataPath?: () => string };
  FileSystem?: WpsFileSystemApi;
  OAAssist?: { ShellExecute?: (path: string, args: string) => unknown };
}
export interface LocalRecognitionBrokerOptions {
  brokerVersion?: string;
  brokerExecutablePathHash?: string;
  brokerExecutableSha256?: string;
  queueContractVersion?: number;
}

const CONTRACT_TYPE_BY_WHEEL_TYPE: Record<string, RecognitionParagraph["recognized_type"]> = {
  title: "main_title", title_cont: "title_continuation", addressing: "recipient",
  sign_org: "signature_org", sign_date: "signature_date", responsibility_line: "body", note: "source_note",
  __object_caption__: "caption",
};
function contractType(type: string): RecognitionParagraph["recognized_type"] {
  return CONTRACT_TYPE_BY_WHEEL_TYPE[type] ?? (type as RecognitionParagraph["recognized_type"]);
}
const CONTRACT_SECTIONS = new Set(["header", "dispatch_meta", "recipient", "body", "meeting_meta", "signature", "source_note", "embedded_document", "attachment_note", "attachment_body"]);
function contractSection(value: string): string { return CONTRACT_SECTIONS.has(value) ? value : "body"; }
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function asRangeStart(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
function asRangeEnd(value: unknown, start: number | null): number | null { return typeof value === "number" && Number.isInteger(value) && start !== null && value > start ? value : null; }

function unresolved(block: WheelRecognitionPlan["blocks"][number], reason: RecognitionResult["unresolved_blocks"] extends Array<infer T> | undefined ? T extends { reason: infer R } ? R : never : never) {
  return {
    block_index: Number(block.block_index ?? 0), recognized_type: contractType(block.type_id),
    review_level: block.review_level, reason,
  };
}

/**
 * The wheel plan and the host snapshot are coupled only through its returned
 * ``binding``. This adapter never uses a block index, first text occurrence,
 * or source offset as an editor position.
 */
export class LocalWheelRecognitionProvider implements RecognitionProvider {
  constructor(private readonly transport: LocalRecognitionTransport) {}

  async recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult> {
    const plan = await this.transport.recognize(snapshot);
    return mapWheelRecognitionPlan(snapshot, plan);
  }
}

export async function mapWheelRecognitionPlan(snapshot: LocalDocumentSnapshot, plan: WheelRecognitionPlan): Promise<RecognitionResult> {
    if (plan.host_text_contract_version !== HOST_TEXT_CONTRACT_VERSION || plan.binding?.host_text_contract_version !== HOST_TEXT_CONTRACT_VERSION) {
      throw new Error("HOST_TEXT_CONTRACT_MISMATCH");
    }
    const bindings = new Map<number, WheelBindingBlock>();
    for (const binding of plan.binding.blocks) bindings.set(binding.block_index, binding);
    const hosts = new Map(snapshot.paragraphs.map((item) => [item.sourceParagraphIndex, item]));
    const grouped = new Map<number, WheelRecognitionPlan["blocks"]>();
    for (const block of plan.blocks) {
      if (typeof block.physical_paragraph_index === "number") {
        const values = grouped.get(block.physical_paragraph_index) ?? [];
        values.push(block); grouped.set(block.physical_paragraph_index, values);
      }
    }
    const groupComplete = new Map<number, boolean>();
    for (const [physical, blocks] of grouped) {
      const expected = Math.max(...blocks.map((item) => Number(item.segment_count_total ?? 1)));
      const confirmed = blocks.filter((item) => bindings.get(Number(item.block_index ?? 0))?.binding_status === "confirmed").length;
      groupComplete.set(physical, blocks.length === expected && confirmed === expected);
    }

    const occurrences = new Map<string, number>();
    const resolved: RecognitionParagraph[] = [];
    const unresolvedBlocks: NonNullable<RecognitionResult["unresolved_blocks"]> = [];
    for (const block of plan.blocks) {
      if (["table", "image", "letterhead"].includes(String(block.kind ?? "")) || block.source_paragraph_index === null) continue;
      const blockIndex = Number(block.block_index ?? 0);
      const binding = bindings.get(blockIndex);
      const sourceStart = asRangeStart(block.raw_start_utf16 ?? block.range_start_utf16);
      const sourceEnd = asRangeEnd(block.raw_end_utf16 ?? block.range_end_utf16, sourceStart);
      const sourceConfirmed = block.locator_verified === true && block.source_locator_status === "confirmed" && sourceStart !== null && sourceEnd !== null;
      if (!sourceConfirmed) { unresolvedBlocks.push(unresolved(block, "RECOGNITION_LOCATOR_UNVERIFIED")); continue; }
      if (!binding || binding.binding_status === "unresolved" || binding.host_paragraph_index === null || binding.host_paragraph_index === undefined) {
        unresolvedBlocks.push(unresolved(block, "BINDING_NOT_CONFIRMED")); continue;
      }
      const host = hosts.get(binding.host_paragraph_index);
      const start = asRangeStart(binding.host_raw_start_utf16);
      const end = asRangeEnd(binding.host_raw_end_utf16, start);
      const canonicalStart = asRangeStart(binding.host_canonical_start_utf16);
      const canonicalEnd = asRangeEnd(binding.host_canonical_end_utf16, canonicalStart);
      if (!host || host.isInTable || (host.storyType && host.storyType !== "main") || start === null || end === null || canonicalStart === null || canonicalEnd === null) {
        unresolvedBlocks.push(unresolved(block, "BINDING_NOT_CONFIRMED")); continue;
      }
      const fragment = rawSliceUtf16(host.text, start, end);
      const tape = createHostTextTape(host.text);
      const canonicalFragment = rawSliceUtf16(tape.canonicalText, canonicalStart, canonicalEnd);
      const fragmentHash = fragment === null ? "" : await sha256(fragment);
      const canonicalHash = canonicalFragment === null ? "" : await sha256(canonicalFragment);
      const rawVerified = isHash(block.raw_fragment_sha256) && fragmentHash === block.raw_fragment_sha256;
      const canonicalVerified = isHash(block.canonical_fragment_sha256) && canonicalHash === block.canonical_fragment_sha256;
      if ((binding.binding_status === "confirmed" && !rawVerified) || (binding.binding_status === "review" && !canonicalVerified)) {
        unresolvedBlocks.push(unresolved(block, "BINDING_NOT_CONFIRMED")); continue;
      }
      const physical = Number(block.physical_paragraph_index);
      const total = Math.max(1, Number(block.segment_count_total ?? 1));
      const complete = groupComplete.get(physical) === true;
      const mixed = total > 1 || start !== 0 || end !== host.text.length;
      const disposition = binding.binding_status === "confirmed" && complete && !mixed ? "apply" : "review_only";
      const type = contractType(block.type_id);
      const occurrence = occurrences.get(fragmentHash) ?? 0; occurrences.set(fragmentHash, occurrence + 1);
      resolved.push({
        target_id: `${snapshot.documentId}:host:${host.sourceParagraphIndex}:r:${start}:${end}:${blockIndex}`,
        source_paragraph_index: host.sourceParagraphIndex,
        physical_paragraph_index: physical,
        host_paragraph_index: host.sourceParagraphIndex,
        host_raw_start_utf16: start, host_raw_end_utf16: end,
        host_raw_text_sha256: await sha256(host.text),
        recognized_type: type, section_kind: contractSection(block.section),
        text_sha256: fragmentHash, physical_text_sha256: String(block.physical_text_sha256 ?? ""),
        range_start_utf16: sourceStart, range_end_utf16: sourceEnd, locator_verified: true,
        text_length: fragment!.length, occurrence_index: occurrence,
        confidence: binding.binding_status === "confirmed" ? 1 : 0.8,
        review_level: binding.binding_status === "review" ? "review" : block.review_level,
        needs_review: binding.binding_status !== "confirmed" || disposition !== "apply" || block.review_level === "review" || block.review_level === "critical_review",
        mixed_structure: mixed, formatting_disposition: disposition,
        host_text_contract_version: HOST_TEXT_CONTRACT_VERSION,
        host_canonical_start_utf16: canonicalStart, host_canonical_end_utf16: canonicalEnd,
        binding_status: binding.binding_status, binding_confidence: binding.binding_confidence,
        segment_count_total: total,
        segment_count_located: Math.max(1, Number(block.segment_count_located ?? total)),
        segment_count_confirmed: Math.max(1, Number(block.segment_count_confirmed ?? (complete ? total : 1))),
      });
    }
    return {
      schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: plan.engine_version,
      document_id: snapshot.documentId, document_revision: snapshot.revision,
      source_sha256: snapshot.sourceSha256, document_mode: plan.document_mode,
      document_mode_confidence: plan.document_mode_confidence, paragraphs: resolved,
      ...(unresolvedBlocks.length ? { unresolved_blocks: unresolvedBlocks } : {}),
    };
}

export class HttpLocalRecognitionTransport implements LocalRecognitionTransport {
  constructor(private readonly endpoint: URL, private readonly sessionToken: string, private readonly diagnostics?: DiagnosticReporter) {
    if (endpoint.protocol !== "http:" || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "::1")) {
      throw new Error("RECOGNITION_ENDPOINT_MUST_BE_LOOPBACK");
    }
  }

  async recognize(snapshot: LocalDocumentSnapshot): Promise<WheelRecognitionPlan> {
    if (!snapshot.localDocxPath) throw new Error("DOCUMENT_MUST_BE_SAVED");
    const endpoint = new URL("v1/recognize", this.endpoint.toString().replace(/\/?$/, "/"));
    const body = JSON.stringify({
        source_path: snapshot.localDocxPath,
        host_snapshot: {
          host_type: "wps",
          document_identity: snapshot.documentId,
          document_revision: snapshot.revision,
          text_contract_version: HOST_TEXT_CONTRACT_VERSION,
          paragraphs: snapshot.paragraphs.map((item) => ({
            host_paragraph_index: item.sourceParagraphIndex,
            raw_text: item.text,
            story_type: item.storyType ?? "main",
            is_in_table: Boolean(item.isInTable),
          })),
        },
      });
    const started = Date.now();
    const base = { endpoint_origin: endpoint.origin, endpoint_path: endpoint.pathname, method: "POST", request_size_bytes: new TextEncoder().encode(body).byteLength, paragraph_count: snapshot.paragraphs.length };
    this.diagnostics?.writeForComponent("recognition-client", "INFO", "recognition.request.start", "开始请求本地识别服务", base);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Docxtool-Session": this.sessionToken }, body });
      const raw = await response.text();
      const responseSize = new TextEncoder().encode(raw).byteLength;
      this.diagnostics?.writeForComponent("recognition-client", response.ok ? "INFO" : "WARN", "recognition.request.response", "本地识别服务已响应", { ...base, response_size_bytes: responseSize, status_code: response.status, duration_ms: Date.now() - started });
      let payload: { data?: WheelRecognitionPlan; binding?: WheelRecognitionPlan["binding"]; error?: { code?: string } };
      try { payload = JSON.parse(raw) as typeof payload; }
      catch { throw new Error(response.ok ? "RECOGNITION_INVALID_JSON" : `RECOGNITION_${response.status}`); }
      if (!response.ok || !payload.data || !payload.binding) throw new Error(payload.error?.code || "RECOGNITION_FAILED");
      return { ...payload.data, binding: payload.binding };
    } catch (error) {
      this.diagnostics?.writeForComponent("recognition-client", "ERROR", "recognition.request.failed", "本地识别请求失败", { ...base, duration_ms: Date.now() - started }, error);
      throw error;
    }
  }
}

function joinPath(left: string, right: string): string {
  return left.replace(/[\\/]+$/, "") + "\\" + right.replace(/^[\\/]+/, "");
}
export function quoteWindowsCommandLineArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  let result = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    result += "\\".repeat(slashes) + char;
    slashes = 0;
  }
  result += "\\".repeat(slashes * 2) + '"';
  return result;
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function uuidV4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function fileSystem(application: WpsApplicationLike): WpsLocalFileSystem {
  const fs = application.FileSystem;
  if (!fs) throw new Error("WPS_FILESYSTEM_UNAVAILABLE");
  return new WpsLocalFileSystem(fs);
}
function parseJsonObject(raw: string, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
  throw new Error(code);
}
function processError(raw: string): string {
  const payload = parseJsonObject(raw, "LOCAL_RECOGNITION_ERROR_INVALID_JSON");
  const code = payload.error_code ?? (payload.error && typeof payload.error === "object" ? (payload.error as { code?: unknown }).code : undefined);
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : "LOCAL_RECOGNITION_FAILED";
}

export class LocalProcessRecognitionTransport implements LocalRecognitionTransport {
  constructor(
    private readonly application: WpsApplicationLike,
    private readonly executablePath: string,
    private readonly timeoutMs = 120_000,
    private readonly pollMs = 100,
    private readonly maxResultBytes = 20 * 1024 * 1024,
    private readonly diagnostics?: DiagnosticReporter,
    private readonly broker: LocalRecognitionBrokerOptions = {},
  ) {}

  async recognize(snapshot: LocalDocumentSnapshot): Promise<WheelRecognitionPlan> {
    if (!snapshot.localDocxPath) throw new Error("DOCUMENT_MUST_BE_SAVED");
    const fs = fileSystem(this.application);
    if (!fs.exists(this.executablePath)) throw new Error("LOCAL_RECOGNITION_RUNTIME_NOT_FOUND");
    const appData = this.application.Env?.GetAppDataPath?.();
    if (!appData) throw new Error("LOCAL_JOB_BROKER_APPDATA_UNAVAILABLE");
    const currentPath = joinPath(joinPath(appData, "Docxtool"), "runtime\\current.json");
    const statusPath = joinPath(joinPath(appData, "Docxtool"), "broker\\status.json");
    if (!fs.exists(currentPath) || !fs.exists(statusPath)) throw new Error("LOCAL_JOB_BROKER_NOT_RUNNING");
    const current = parseJsonObject(fs.readText(currentPath), "LOCAL_JOB_BROKER_RUNTIME_MISMATCH");
    const status = parseJsonObject(fs.readText(statusPath), "LOCAL_JOB_BROKER_NOT_RUNNING");
    const heartbeat = typeof status.heartbeat_at === "string" ? Date.parse(status.heartbeat_at) : NaN;
    if (status.state !== "READY" && status.state !== "RUNNING") throw new Error("LOCAL_JOB_BROKER_NOT_RUNNING");
    if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 3_000) throw new Error("LOCAL_JOB_BROKER_STALE");
    if (this.broker.brokerVersion && (typeof status.pid !== "number" || status.pid <= 0 || typeof status.broker_instance_id !== "string" || !status.broker_instance_id || typeof status.process_created_at !== "string" || !status.process_created_at)) throw new Error("LOCAL_JOB_BROKER_IDENTITY_MISMATCH");
    if (this.broker.brokerVersion && status.broker_version !== this.broker.brokerVersion) throw new Error("LOCAL_JOB_BROKER_VERSION_MISMATCH");
    if (this.broker.brokerExecutablePathHash && status.broker_executable_path_hash !== this.broker.brokerExecutablePathHash) throw new Error("LOCAL_JOB_BROKER_IDENTITY_MISMATCH");
    if (this.broker.brokerExecutableSha256 && status.broker_executable_sha256 !== this.broker.brokerExecutableSha256) throw new Error("LOCAL_JOB_BROKER_HASH_MISMATCH");
    const queueContractVersion = this.broker.queueContractVersion ?? Number(current.queue_contract_version ?? current.broker_contract_version ?? 1);
    if (status.contract_version !== Number(current.contract_version ?? 1) || Number(status.queue_contract_version ?? status.contract_version) !== queueContractVersion) throw new Error("LOCAL_JOB_BROKER_CONTRACT_MISMATCH");
    if (status.runtime_version !== current.runtime_version || status.runtime_sha256 !== current.executable_sha256) throw new Error("LOCAL_JOB_BROKER_RUNTIME_MISMATCH");
    const requestId = uuidV4();
    const jobDir = joinPath(joinPath(appData, "Docxtool\\jobs"), requestId);
    const requestPath = joinPath(jobDir, "request.json");
    const resultPath = joinPath(jobDir, "result.json");
    const errorPath = joinPath(jobDir, "error.json");
    const finishedPath = joinPath(jobDir, "finished.json");
    const request = {
      schema_version: 1,
      request_id: requestId,
      source_path: snapshot.localDocxPath,
      result_path: resultPath,
      error_path: errorPath,
      host_snapshot: {
        host_type: "wps",
        document_identity: snapshot.documentId,
        document_revision: snapshot.revision,
        text_contract_version: HOST_TEXT_CONTRACT_VERSION,
        paragraphs: snapshot.paragraphs.map((item) => ({
          host_paragraph_index: item.sourceParagraphIndex,
          raw_text: item.text,
          story_type: item.storyType ?? "main",
          is_in_table: Boolean(item.isInTable),
        })),
      },
    };
    const queuedPath = joinPath(jobDir, "queued.json");
    const queued = { schema_version: 1, job_id: requestId, contract_version: queueContractVersion, runtime_version: String(current.runtime_version ?? ""), runtime_sha256: String(current.executable_sha256 ?? ""), created_at: new Date().toISOString(), build_id: "legacy-recognize" };
    fs.mkdir(jobDir); fs.writeText(requestPath, JSON.stringify(request)); fs.writeText(queuedPath, JSON.stringify(queued));
    const started = Date.now();
    this.diagnostics?.writeForComponent("recognition-client", "INFO", "host.recognition.job.queued", "本地识别任务已写入文件队列", { request_id: requestId, paragraph_count: snapshot.paragraphs.length, launch_mode: "file_queue_broker" });
    try {
      while (Date.now() - started <= this.timeoutMs) {
        if (fs.exists(resultPath) && fs.exists(finishedPath)) {
          const raw = fs.readText(resultPath);
          if (new TextEncoder().encode(raw).byteLength > this.maxResultBytes) throw new Error("LOCAL_RECOGNITION_RESULT_TOO_LARGE");
          const payload = parseJsonObject(raw, "LOCAL_RECOGNITION_INVALID_JSON");
          if (payload.request_id !== requestId) throw new Error("LOCAL_RECOGNITION_REQUEST_ID_MISMATCH");
          const plan = payload.recognition_plan ?? payload.data;
          if (!plan || typeof plan !== "object") throw new Error("LOCAL_RECOGNITION_INVALID_RESULT");
          return plan as WheelRecognitionPlan;
        }
        if (fs.exists(errorPath) && fs.exists(finishedPath)) throw new Error(processError(fs.readText(errorPath)));
        if (fs.exists(joinPath(jobDir, "cancel.json"))) throw new Error("RECOGNITION_CANCELLED");
        await delay(this.pollMs);
      }
      throw new Error("LOCAL_RECOGNITION_TIMEOUT");
    } finally {
      for (const path of [requestPath, resultPath, errorPath]) {
        try { fs.removeFile(path); } catch { /* cleanup must not hide the real error */ }
      }
      for (const path of [queuedPath, joinPath(jobDir, "claimed.json"), joinPath(jobDir, "claim.lock"), joinPath(jobDir, "launched.json"), joinPath(jobDir, "heartbeat.json"), finishedPath]) {
        try { fs.removeFile(path); } catch { /* cleanup must not hide the real error */ }
      }
      try { fs.removeDirectory(jobDir); } catch { /* cleanup must not hide the real error */ }
    }
  }
}
