import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile as readFileText, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  CLIENT_CAPABILITIES_VERSION,
  COMMAND_REQUEST_VERSION,
  FORMATTING_COMMAND_SET_VERSION,
  RECOGNITION_RESULT_VERSION,
  assertCommandRequest,
} from "../dist/packages/contracts/src/index.js";
import { LocalProcessRecognitionTransport, LocalWheelRecognitionProvider, quoteWindowsCommandLineArgument } from "../dist/packages/recognition-client/src/index.js";
import { HttpCommandServiceClient, LocalEndpointProvider } from "../dist/packages/command-service-client/src/index.js";
import {
  MockDocumentExecutor,
  MockDocumentReader,
  MockTransactionManager,
  WpsApiDocumentExecutor,
  WpsDocumentReader,
  WpsTargetLocator,
  computeGridMetrics,
  rotateLandscapeMargins,
  snapToGridForParagraph,
  DocumentGridCapabilityProvider,
  GridReadbackValidator,
  GridTransactionManager,
  WpsPreviewCommentService,
  WpsLocalFileSystem,
  normalizeWpsPath,
  WpsHostBridge,
  HOST_PARAGRAPH_BATCH_LIMIT,
  createPreviewPlan,
} from "../dist/packages/wps-adapter/src/index.js";
import { CommandValidator } from "../dist/packages/security/src/index.js";
import { FormatDocumentUseCase, PreviewDocumentUseCase } from "../dist/packages/application/src/format-document-usecase.js";
import { LocalApplicationRuntime, HostResultStore, TaskPaneManager } from "../dist/apps/classified-offline/src/host-runtime.js";
import { ClassifiedHealthChecker } from "../dist/apps/classified-offline/src/health-check.js";
import { errorMessage, errorText } from "../dist/apps/classified-offline/src/error-messages.js";
import { probeWorkerCapability } from "../dist/apps/classified-offline/src/worker-capability.js";
import { PipelineWorkerClient } from "../dist/apps/classified-offline/src/pipeline-worker-client.js";
import { AdaptiveBatchController, SnapshotPipelineWorkerRuntime, createEquivalentSnapshot, generateWorkerCommands } from "../dist/apps/classified-offline/src/pipeline-worker.js";
import { BoundedDiagnosticFileBuffer } from "../dist/apps/classified-offline/src/diagnostic-buffer.js";
import { LocalFormatCommandGenerator } from "../dist/packages/local-format-engine/src/index.js";
import { DiagnosticRunner, classifyNetworkError } from "../dist/packages/diagnostics/src/index.js";
import { parsePipelineJob, parseWorkerHostRequest } from "../dist/packages/threading/src/index.js";

const SHA = "a".repeat(64);
const hashText = (value) => createHash("sha256").update(value).digest("hex");
const wheelBlock = ({ physicalText, text = physicalText, physicalIndex = 0, occurrence = 0, type = "body", section = "body", review = "confirmed", blockIndex = 0, kind = "paragraph" }) => {
  const start = physicalText.indexOf(text);
  if (start < 0) throw new Error("TEST_LOCATOR_TEXT_NOT_FOUND");
  return { block_index: blockIndex, source_paragraph_index: physicalIndex, physical_paragraph_index: physicalIndex, physical_occurrence_index: occurrence,
    physical_text_sha256: hashText(physicalText), physical_text_length_utf16: physicalText.length,
    range_start_utf16: start, range_end_utf16: start + text.length, offset_encoding: "utf16_code_unit", locator_verified: true,
    recognized_text: text, text_sha256: hashText(text), type_id: type, section, review_level: review, kind };
};
const commandTarget = (hash = SHA, length = 4, occurrence = 0) => ({
  target_id: "doc-1:host:0:" + occurrence, source_paragraph_index: 0,
  host_paragraph_index: 0, host_raw_start_utf16: 0, host_raw_end_utf16: length,
  host_raw_text_sha256: hash, text_sha256: hash, text_length: length,
  occurrence_index: occurrence,
});
const commandSet = (commands, requestId = "request-00000001") => ({ schema_version: FORMATTING_COMMAND_SET_VERSION, request_id: requestId, service_version: "1.0", profile_id: "default", profile_version: "1.0", warnings: [], commands });
const snapshot = {
  documentId: "doc-1",
  revision: "rev-1",
  sourceSha256: SHA,
  paragraphs: [{ sourceParagraphIndex: 0, text: "本地正文" }],
};

test("classic Worker capability probe reports a successful ping roundtrip", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let terminated = false;
  class FakeWorker {
    onmessage = null;
    onerror = null;
    constructor(url) { assert.equal(url, "pipeline-worker-probe.js"); }
    postMessage(value) { assert.deepEqual(value, { type: "probe.ping" }); queueMicrotask(() => this.onmessage?.({ data: { type: "probe.pong" } })); }
    terminate() { terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker });
  try {
    const result = await probeWorkerCapability("pipeline-worker-probe.js");
    assert.equal(result.supported, true);
    assert.equal(result.classic_worker, true);
    assert.equal(result.error_code, null);
    assert.equal(terminated, true);
  } finally {
    if (original) Object.defineProperty(globalThis, "Worker", original); else delete globalThis.Worker;
  }
});

test("classic Worker capability probe refuses unsupported hosts without fallback", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  delete globalThis.Worker;
  try {
    assert.deepEqual(await probeWorkerCapability("pipeline-worker-probe.js"), { supported: false, classic_worker: false, roundtrip_ms: null, error_code: "WEB_WORKER_UNSUPPORTED" });
  } finally {
    if (original) Object.defineProperty(globalThis, "Worker", original);
  }
});

test("threading protocol accepts only pure-data jobs and known Host RPC operations", () => {
  assert.equal(parsePipelineJob({ job_id: "pipeline-1", command: "preview", build_id: "build-1", created_at: "2026-08-05T00:00:00.000Z" }).command, "preview");
  const request = parseWorkerHostRequest({ type: "host.rpc.request", operation: "host.read_paragraph_batch", rpc_id: "rpc-1", job_id: "pipeline-1", build_id: "build-1", document_token: "doc-1", payload: { start_index: 0, batch_size: 5 } });
  assert.equal(request.operation, "host.read_paragraph_batch");
  assert.throws(() => parseWorkerHostRequest({ ...request, payload: { application: { call() {} } } }), /INVALID_HOST_RPC_REQUEST/);
  assert.throws(() => parseWorkerHostRequest({ ...request, operation: "host.unknown" }), /INVALID_HOST_RPC_REQUEST/);
});

test("WpsHostBridge reads only the requested paragraph batch and enforces the hard limit", async () => {
  const accessed = [];
  const paragraphs = ["甲", "乙", "丙", "丁"].map((text, index) => ({ Range: { Text: `${text}\r`, Tables: { Count: index === 2 ? 1 : 0 }, Start: index * 10, End: index * 10 + text.length, get Font() { throw new Error("FORMAT_MUST_NOT_BE_READ"); }, get ParagraphFormat() { throw new Error("FORMAT_MUST_NOT_BE_READ"); } } }));
  const application = { ActiveDocument: { FullName: "C:\\fixture.docx", Saved: true, Paragraphs: { Count: paragraphs.length, Item(index) { accessed.push(index); return paragraphs[index - 1]; } }, Sections: { Count: 2 } } };
  const bridge = new WpsHostBridge(application);
  const base = { type: "host.rpc.request", rpc_id: "rpc-1", job_id: "pipeline-1", build_id: "build-1", payload: {} };
  const descriptor = await bridge.handle({ ...base, operation: "host.capture_document_descriptor" });
  assert.equal(descriptor.ok, true);
  assert.equal(descriptor.value.paragraph_count, 4);
  assert.deepEqual(accessed, []);
  const batch = await bridge.handle({ ...base, rpc_id: "rpc-2", operation: "host.read_paragraph_batch", document_token: descriptor.value.document_token, payload: { start_index: 1, batch_size: 2 } });
  assert.equal(batch.ok, true);
  assert.deepEqual(batch.value.map((item) => item.host_paragraph_index), [1, 2]);
  assert.deepEqual(accessed, [2, 3]);
  assert.equal(batch.value[1].is_in_table, true);
  const oversized = await bridge.handle({ ...base, rpc_id: "rpc-3", operation: "host.read_paragraph_batch", document_token: descriptor.value.document_token, payload: { start_index: 0, batch_size: HOST_PARAGRAPH_BATCH_LIMIT + 1 } });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "HOST_PARAGRAPH_BATCH_INVALID");
  const stale = await bridge.handle({ ...base, rpc_id: "rpc-4", operation: "host.read_paragraph_batch", document_token: "doc-stale", payload: { start_index: 0, batch_size: 1 } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "DOCUMENT_TOKEN_CHANGED");
});

test("adaptive batch uses rolling Host duration without collapsing on normal roundtrip or one outlier", () => {
  const normal = new AdaptiveBatchController(5);
  for (const duration of [15, 17, 13, 16, 14, 18, 12, 15]) assert.equal(normal.record(duration), 5);
  const fast = new AdaptiveBatchController(5);
  assert.deepEqual([fast.record(4), fast.record(5), fast.record(6)], [5, 5, 6]);
  const outlier = new AdaptiveBatchController(5);
  assert.equal(outlier.record(120), 4);
  assert.ok(outlier.record(10) > 1);
  assert.ok(outlier.record(11) > 1);
  const persistent = new AdaptiveBatchController(5);
  assert.deepEqual([persistent.record(101), persistent.record(120), persistent.record(130)], [4, 3, 1]);
});

test("diagnostic buffer batches fallback rewrites and caps the file instead of rewriting per event", () => {
  const scheduled = []; let existing = "x".repeat(1_100_000); let reads = 0; let writes = 0;
  const adapter = { hasNativeAppend() { return false; }, exists() { return true; }, readText() { reads += 1; return existing; }, writeText(_path, value) { writes += 1; existing = value; }, appendText() { throw new Error("MUST_NOT_APPEND"); } };
  const buffer = new BoundedDiagnosticFileBuffer({ adapter: () => adapter, path: () => "C:\\logs\\wps.log", schedule(callback, delayMs) { const item = { callback, delayMs }; scheduled.push(item); return item; }, cancel() {}, batchLimit: 50, maxFileBytes: 1_000_000 });
  for (let index = 0; index < 49; index += 1) buffer.enqueue(`event-${index}\n`);
  assert.equal(reads, 0); assert.equal(writes, 0);
  buffer.enqueue("event-49\n");
  assert.equal(scheduled.at(-1).delayMs, 0);
  scheduled.at(-1).callback();
  assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(buffer.flushCount, 1); assert.ok(existing.length <= 1_000_000);
});

test("diagnostic buffer prefers native append and does not read existing history", () => {
  const scheduled = []; let appends = 0; let reads = 0;
  const adapter = { hasNativeAppend() { return true; }, exists() { return true; }, readText() { reads += 1; return "old"; }, writeText() {}, appendText(_path, value) { appends += 1; assert.match(value, /urgent/); } };
  const buffer = new BoundedDiagnosticFileBuffer({ adapter: () => adapter, path: () => "C:\\logs\\wps.log", schedule(callback, delayMs) { const item = { callback, delayMs }; scheduled.push(item); return item; }, cancel() {} });
  buffer.enqueue("urgent\n", true); scheduled.at(-1).callback();
  assert.equal(appends, 1); assert.equal(reads, 0);
});

test("PipelineWorkerClient forwards current-job RPCs and rejects duplicate or late work", async () => {
  class FakeWorker {
    onmessage = null; onerror = null; onmessageerror = null; posted = []; terminated = false;
    postMessage(value) { this.posted.push(value); }
    terminate() { this.terminated = true; }
    emit(value) { this.onmessage?.({ data: value }); }
  }
  const worker = new FakeWorker(); const events = []; const bridged = [];
  const bridge = { async handle(request) { bridged.push(request); return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: 1, value: {} }; } };
  const client = new PipelineWorkerClient({ workerUrl: "pipeline-worker.js", bridge, buildId: "build-1", onEvent: (event) => events.push(event), workerFactory: () => worker });
  const receipt = client.startSnapshotJob();
  assert.equal(receipt.accepted, true);
  assert.equal(client.startSnapshotJob().reason, "PIPELINE_BUSY");
  assert.equal(worker.posted[0].type, "pipeline.init");
  assert.equal(worker.posted[1].type, "pipeline.start");
  const request = { type: "host.rpc.request", operation: "host.capture_document_descriptor", rpc_id: "rpc-1", job_id: receipt.command_id, build_id: "build-1", payload: {} };
  worker.emit(request); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridged.length, 1);
  assert.equal(worker.posted.at(-1).type, "host.rpc.result");
  worker.emit({ ...request, rpc_id: "rpc-late", job_id: "snapshot-old" }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridged.length, 1);
  assert.equal(worker.posted.at(-1).error.code, "PIPELINE_STALE_JOB");
  worker.emit({ type: "pipeline.completed", job_id: receipt.command_id, build_id: "build-1", snapshot_summary: { snapshot_contract_version: "worker-snapshot-v1", paragraph_count: 0, batch_count: 0, min_batch_size: 0, max_batch_size: 0, max_host_rpc_ms: 0, p95_host_rpc_ms: 0, worker_total_ms: 1, source_sha256_prefix: "00000000", order_sha256_prefix: "00000000", text_revision: "x" } });
  assert.equal(events.at(-1).type, "pipeline.completed");
  assert.equal(client.startSnapshotJob().accepted, true);
});

test("PipelineWorkerClient recovers after a Worker crash and ignores wrong builds", () => {
  const workers = []; const events = [];
  const factory = () => { const worker = { onmessage: null, onerror: null, onmessageerror: null, posted: [], terminated: false, postMessage(value) { this.posted.push(value); }, terminate() { this.terminated = true; } }; workers.push(worker); return worker; };
  const client = new PipelineWorkerClient({ workerUrl: "pipeline-worker.js", bridge: { async handle() { throw new Error("MUST_NOT_RUN"); } }, buildId: "build-1", onEvent: (event) => events.push(event), workerFactory: factory });
  const first = client.startSnapshotJob();
  workers[0].onmessage({ data: { type: "pipeline.failed", job_id: first.command_id, build_id: "wrong-build", error: { code: "X", message: "X" } } });
  assert.equal(events.at(-1).error.code, "PIPELINE_BUILD_MISMATCH");
  const second = client.startSnapshotJob();
  assert.equal(second.accepted, true);
  workers[1].onerror();
  assert.equal(events.at(-1).error.code, "PIPELINE_WORKER_CRASHED");
  assert.equal(client.startSnapshotJob().accepted, true);
});

test("snapshot worker creates text-equivalent snapshots for 0, 20, 200 and 1000 paragraphs", async () => {
  for (const count of [0, 20, 200, 1000]) {
    const values = Array.from({ length: count }, (_, index) => ({ host_paragraph_index: index, raw_text: index === 1 ? "" : index === 2 ? "中文段落" : index === 3 ? "超长".repeat(2000) : `段落${index}`, is_in_table: index === 4, range_start: index * 10, range_end: index * 10 + 2 }));
    const fullName = "C:\\snapshot-fixture.docx";
    const descriptor = { document_token: "doc-1", saved: true, local_docx_path: fullName, local_docx_path_hash: hashText(fullName.toLowerCase()), paragraph_count: count, section_count: 2, extension: ".docx" };
    const result = await createEquivalentSnapshot(descriptor, values);
    const expectedSource = hashText(values.map((item) => item.raw_text).join("\u001f"));
    const expectedOrder = hashText(values.map((item) => `${item.host_paragraph_index}:${item.raw_text}`).join("\u001f"));
    assert.equal(result.snapshotContractVersion, "worker-snapshot-v1");
    assert.equal(result.documentId, `wps-${expectedSource.slice(0, 16)}`);
    assert.equal(result.sourceSha256, expectedSource);
    assert.equal(result.revision, `${expectedSource}:${count}`);
    assert.equal(result.textRevision, result.revision);
    assert.equal(result.paragraphOrderHash, expectedOrder);
    assert.equal(result.paragraphs.length, count);
    assert.equal("formattingRevision" in result, false);
    if (count > 4) assert.equal(result.paragraphs[4].isInTable, true);
  }
});

test("snapshot worker uses multiple bounded Host RPC batches for 1000 paragraphs", async () => {
  const values = Array.from({ length: 1000 }, (_, index) => ({ Range: { Text: `脱敏段落${index}\r`, Tables: { Count: index % 31 === 0 ? 1 : 0 }, Start: index * 20, End: index * 20 + 8 } }));
  const application = { ActiveDocument: { FullName: "C:\\shadow-1000.docx", Saved: true, Paragraphs: { Count: values.length, Item(index) { return values[index - 1]; } }, Sections: { Count: 1 } } };
  const bridge = new WpsHostBridge(application); const events = [];
  class LoopbackWorker {
    onmessage = null; onerror = null; onmessageerror = null; terminated = false;
    scope = { onmessage: null, postMessage: (value) => queueMicrotask(() => this.onmessage?.({ data: value })) };
    runtime = new SnapshotPipelineWorkerRuntime(this.scope);
    postMessage(value) { queueMicrotask(() => this.scope.onmessage?.({ data: value })); }
    terminate() { this.terminated = true; }
  }
  const terminal = new Promise((resolve) => {
    const client = new PipelineWorkerClient({ workerUrl: "pipeline-worker.js", bridge, buildId: "build-1", workerFactory: () => new LoopbackWorker(), onEvent(event) { events.push(event); if (["pipeline.completed", "pipeline.failed"].includes(event.type)) resolve(event); } });
    assert.equal(client.startSnapshotJob().accepted, true);
  });
  const result = await terminal;
  assert.equal(result.type, "pipeline.completed");
  assert.equal(result.snapshot_summary.paragraph_count, 1000);
  assert.ok(result.snapshot_summary.batch_count > 1);
  assert.ok(result.snapshot_summary.batch_count <= 400);
  assert.ok(result.snapshot_summary.average_batch_size > 2);
  assert.ok(result.snapshot_summary.max_batch_size <= 10);
  assert.ok(result.snapshot_summary.worker_roundtrip_p95_ms >= result.snapshot_summary.host_duration_p95_ms);
  assert.ok(events.some((item) => item.type === "pipeline.progress" && item.completed === 1000));
});

test("snapshot worker cancels after the active small RPC and rejects late results", async () => {
  class LoopbackWorker {
    onmessage = null; onerror = null; onmessageerror = null;
    scope = { onmessage: null, postMessage: (value) => queueMicrotask(() => this.onmessage?.({ data: value })) };
    runtime = new SnapshotPipelineWorkerRuntime(this.scope);
    postMessage(value) { queueMicrotask(() => this.scope.onmessage?.({ data: value })); }
    terminate() {}
  }
  const terminal = new Promise((resolve) => {
    const bridge = { async handle(request) { await new Promise((done) => setTimeout(done, 10)); return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: 1, value: { document_token: "doc-1", saved: true, local_docx_path: "C:\\x.docx", local_docx_path_hash: SHA, paragraph_count: 20, section_count: 1, extension: ".docx" } }; } };
    const client = new PipelineWorkerClient({ workerUrl: "pipeline-worker.js", bridge, buildId: "build-1", workerFactory: () => new LoopbackWorker(), onEvent(event) { if (["pipeline.cancelled", "pipeline.failed", "pipeline.completed"].includes(event.type)) resolve(event); } });
    assert.equal(client.startSnapshotJob().accepted, true);
    assert.equal(client.cancelActiveJob(), true);
  });
  assert.equal((await terminal).type, "pipeline.cancelled");
});

test("snapshot worker fails a timed-out RPC and ignores its late response", async () => {
  const posted = [];
  const scope = { onmessage: null, postMessage(value) { posted.push(value); } };
  new SnapshotPipelineWorkerRuntime(scope, { rpc_timeout_ms: 5, paragraph_rpc_timeout_ms: 5 });
  scope.onmessage({ data: { type: "pipeline.init", build_id: "build-1" } });
  scope.onmessage({ data: { type: "pipeline.start", job: { job_id: "snapshot-timeout", command: "snapshot_shadow", build_id: "build-1", created_at: new Date().toISOString() } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = posted.find((item) => item.type === "pipeline.failed");
  assert.equal(failed.error.code, "HOST_RPC_TIMEOUT");
  const request = posted.find((item) => item.type === "host.rpc.request");
  scope.onmessage({ data: { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: 1, value: {} } });
  assert.equal(posted.filter((item) => item.type === "pipeline.failed").length, 1);
});
function withHostBinding(snapshotValue, plan) {
  const byHash = new Map();
  for (const host of snapshotValue.paragraphs) {
    if (host.isInTable) continue;
    const hash = hashText(host.text);
    const values = byHash.get(hash) ?? [];
    values.push(host); byHash.set(hash, values);
  }
  const blocks = plan.blocks.map((block) => {
    const start = Number(block.raw_start_utf16 ?? block.range_start_utf16 ?? 0);
    const end = Number(block.raw_end_utf16 ?? block.range_end_utf16 ?? 0);
    const text = block.recognized_text ?? "";
    return {
      ...block, raw_start_utf16: start, raw_end_utf16: end,
      canonical_start_utf16: start, canonical_end_utf16: end,
      source_locator_status: block.locator_verified === false ? "unresolved" : "confirmed",
      segment_count_total: block.segment_count_total ?? 1,
      segment_count_located: block.segment_count_located ?? 1,
      segment_count_confirmed: block.segment_count_confirmed ?? 1,
      raw_fragment_sha256: block.raw_fragment_sha256 ?? hashText(text),
      canonical_fragment_sha256: block.canonical_fragment_sha256 ?? hashText(text),
    };
  });
  const bindingBlocks = blocks.map((block) => {
    const candidates = byHash.get(block.physical_text_sha256) ?? [];
    const host = candidates[Number(block.physical_occurrence_index ?? 0)];
    return host ? {
      block_index: Number(block.block_index ?? 0), physical_paragraph_index: block.physical_paragraph_index,
      host_paragraph_index: host.sourceParagraphIndex, binding_status: "confirmed", binding_confidence: 1,
      host_raw_start_utf16: block.raw_start_utf16, host_raw_end_utf16: block.raw_end_utf16,
      host_canonical_start_utf16: block.canonical_start_utf16, host_canonical_end_utf16: block.canonical_end_utf16,
    } : { block_index: Number(block.block_index ?? 0), physical_paragraph_index: block.physical_paragraph_index, host_paragraph_index: null, binding_status: "unresolved", binding_confidence: 0 };
  });
  return { ...plan, host_text_contract_version: "host-text-v1", blocks, binding: { host_text_contract_version: "host-text-v1", blocks: bindingBlocks } };
}
function boundTransport(factory) {
  return { async recognize(value) { return withHostBinding(value, await factory.recognize(value)); } };
}
function hostFields(rawText, start = 0, end = rawText.length, index = 0) {
  return {
    host_paragraph_index: index, host_raw_start_utf16: start,
    host_raw_end_utf16: end, host_raw_text_sha256: hashText(rawText),
    host_text_contract_version: "host-text-v1",
    host_canonical_start_utf16: start, host_canonical_end_utf16: end,
    binding_status: "confirmed", binding_confidence: 1,
    segment_count_total: 1, segment_count_located: 1, segment_count_confirmed: 1,
  };
}
const transport = {
  async recognize() {
    return {
      schema_version: "1.0", engine_version: "3.0", document_mode: "normal",
      document_mode_confidence: 1, blocks: [wheelBlock({ physicalText: "本地正文" })],
    };
  },
};

function createTempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("local wheel adapter preserves the decision but emits only full hash anchors", async () => {
  const result = await new LocalWheelRecognitionProvider(boundTransport(transport)).recognize(snapshot);
  assert.equal(result.paragraphs[0].recognized_type, "body");
  assert.match(result.paragraphs[0].text_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("本地正文"), false);
});

test("local wheel adapter translates aliases and never invents uncovered paragraph roles", async () => {
  const source = { ...snapshot, paragraphs: [{ sourceParagraphIndex: 4, text: "标题" }, { sourceParagraphIndex: 99, text: "最后段落" }] };
  const provider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() {
    return { schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1,
      blocks: [wheelBlock({ physicalText: "标题", physicalIndex: 4, type: "title", section: "header" })] };
  } }));
  const result = await provider.recognize(source);
  assert.equal(result.paragraphs.find((item) => item.source_paragraph_index === 4).recognized_type, "main_title");
  assert.equal(result.paragraphs.find((item) => item.source_paragraph_index === 99), undefined);
});

test("local wheel adapter maps object captions to the frozen caption role", async () => {
  const provider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() {
    return { schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1,
      blocks: [wheelBlock({ physicalText: "本地正文", type: "__object_caption__", kind: "caption" })] };
  } }));
  const result = await provider.recognize(snapshot);
  assert.equal(result.paragraphs[0].recognized_type, "caption");
});

test("local wheel adapter leaves an unproved locator unresolved and never guesses a target", async () => {
  const provider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() {
    return { schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1, blocks: [{
      block_index: 7, source_paragraph_index: 0, physical_paragraph_index: 0,
      type_id: "body", section: "body", review_level: "review", kind: "paragraph",
      locator_verified: false,
    }] };
  } }));
  const result = await provider.recognize(snapshot);
  assert.deepEqual(result.paragraphs, []);
  assert.deepEqual(result.unresolved_blocks, [{ block_index: 7, recognized_type: "body", review_level: "review", reason: "RECOGNITION_LOCATOR_UNVERIFIED" }]);
  assert.equal(JSON.stringify(result).includes("target_id"), false);
});

test("local wheel adapter uses physical occurrence to distinguish duplicate paragraphs", async () => {
  const duplicate = "重复正文";
  const source = { ...snapshot, paragraphs: [{ sourceParagraphIndex: 3, text: duplicate }, { sourceParagraphIndex: 8, text: duplicate }] };
  const provider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() {
    return { schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1, blocks: [
      wheelBlock({ physicalText: duplicate, physicalIndex: 0, occurrence: 0, blockIndex: 0 }),
      wheelBlock({ physicalText: duplicate, physicalIndex: 1, occurrence: 1, blockIndex: 1 }),
    ] };
  } }));
  const result = await provider.recognize(source);
  assert.deepEqual(result.paragraphs.map((item) => item.source_paragraph_index), [3, 8]);
  assert.equal(result.unresolved_blocks, undefined);
});

test("command client exposes a stable command-service error code", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "INVALID_SCHEMA", message: "unknown recognized type" } }), {
    status: 400, headers: { "Content-Type": "application/json" },
  });
  const client = new HttpCommandServiceClient(new LocalEndpointProvider("http://127.0.0.1:9529", "session"));
  const request = {
    schema_version: COMMAND_REQUEST_VERSION, request_id: "request-00000001",
    recognition_result: { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "3.0", document_id: "doc-1", document_revision: "rev-1", source_sha256: SHA, document_mode: "normal", document_mode_confidence: 1, paragraphs: [] },
    profile_id: "default", profile_version: "1.0", client_capabilities: { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: [] }, product_version: "0.1.0", authorization_scope: "classified-offline",
  };
  await assert.rejects(() => client.requestCommands(request), /INVALID_SCHEMA/);
});

test("local wheel adapter resolves UTF-16 sub-ranges and skips table cells without index fallback", async () => {
  const mixed = "主标题\n主标题续行";
  const source = { ...snapshot, paragraphs: [
    { sourceParagraphIndex: 0, text: mixed },
    { sourceParagraphIndex: 1, text: "表格测试文字", isInTable: true },
    { sourceParagraphIndex: 2, text: "正文段落" },
  ] };
  const provider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() {
    return { schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1, blocks: [
      wheelBlock({ physicalText: mixed, text: "主标题", type: "title", section: "header", blockIndex: 0 }),
      wheelBlock({ physicalText: mixed, text: "主标题续行", type: "title_cont", section: "header", blockIndex: 1 }),
      { block_index: 2, source_paragraph_index: null, type_id: "__table__", section: "body", review_level: "confirmed", kind: "table" },
      wheelBlock({ physicalText: "正文段落", physicalIndex: 2, type: "body", blockIndex: 3 }),
    ] };
  } }));
  const result = await provider.recognize(source);
  const mixedItems = result.paragraphs.filter((item) => item.source_paragraph_index === 0);
  assert.deepEqual(mixedItems.map((item) => item.recognized_type), ["main_title", "title_continuation"]);
  assert.equal(mixedItems.every((item) => item.mixed_structure && item.formatting_disposition === "review_only"), true);
  assert.equal(result.paragraphs.some((item) => item.source_paragraph_index === 1), false);
  assert.equal(result.paragraphs.find((item) => item.source_paragraph_index === 2).formatting_disposition, "apply");
});

test("formal formatting blocks mixed physical paragraphs before command generation or transaction", async () => {
  const physicalText = "一、标题。正文内容";
  const localSnapshot = { ...snapshot, paragraphs: [{ sourceParagraphIndex: 0, text: physicalText }] };
  const recognitionProvider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() { return {
    schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1, blocks: [
      wheelBlock({ physicalText, text: "一、标题。", type: "heading1", blockIndex: 0 }),
      wheelBlock({ physicalText, text: "正文内容", type: "body", blockIndex: 1 }),
    ],
  }; } }));
  let commandCalls = 0; let transactionCalls = 0;
  const useCase = new FormatDocumentUseCase(
    new MockDocumentReader(localSnapshot), recognitionProvider,
    { async requestCommands() { commandCalls += 1; throw new Error("unexpected"); } }, new CommandValidator(),
    new MockDocumentExecutor(), { begin() { transactionCalls += 1; return "tx"; }, commit() {}, rollback() {} },
    { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: [] }; } },
    { authorizationScope() { return "classified-offline"; } },
  );
  const result = await useCase.execute("request-00000001");
  assert.equal(result.executed_command_ids.length, 0);
  assert.deepEqual(result.warnings, ["SKIPPED_REVIEW_OR_UNRESOLVED=2"]);
  assert.equal(commandCalls, 0); assert.equal(transactionCalls, 0);
});

test("preview summary reports unresolved blocks and unique mixed physical paragraphs", async () => {
  const physicalText = "一、标题。正文内容";
  const localSnapshot = { ...snapshot, paragraphs: [{ sourceParagraphIndex: 0, text: physicalText }, { sourceParagraphIndex: 1, text: "无法定位" }] };
  const provider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() { return {
    schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1, blocks: [
      wheelBlock({ physicalText, text: "一、标题。", type: "heading1", blockIndex: 0 }),
      wheelBlock({ physicalText, text: "正文内容", type: "body", blockIndex: 1 }),
      { block_index: 2, source_paragraph_index: 1, physical_paragraph_index: 1, type_id: "body", section: "body", review_level: "review", kind: "paragraph", locator_verified: false },
    ],
  }; } }));
  const useCase = new PreviewDocumentUseCase(
    new MockDocumentReader(localSnapshot), provider,
    { async requestCommands(request) { return commandSet([], request.request_id); } }, new CommandValidator(),
    { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: [] }; } },
    { authorizationScope() { return "classified-offline"; } },
  );
  const result = await useCase.execute("request-00000001");
  assert.equal(result.summary.mixed_paragraph_count, 1);
  assert.equal(result.summary.unresolved_block_count, 1);
  assert.equal(result.summary.blocking_reason, "RECOGNITION_LOCATOR_UNVERIFIED");
});

test("outbound requests reject plaintext, code and local paths", () => {
  const request = {
    schema_version: COMMAND_REQUEST_VERSION, request_id: "request-00000001",
    recognition_result: {
      schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "3.0",
      document_id: "doc-1", document_revision: "rev-1", source_sha256: SHA,
      document_mode: "normal", document_mode_confidence: 1, paragraphs: [],
    },
    profile_id: "default", profile_version: "1.0",
    client_capabilities: { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: [] },
    product_version: "0.1.0", authorization_scope: "classified-offline", text: "secret",
  };
  assert.throws(() => assertCommandRequest(request), /SENSITIVE_FIELD_REJECTED/);
});

test("application flow rolls back the complete mock transaction on command failure", async () => {
  const recognitionProvider = new LocalWheelRecognitionProvider(boundTransport(transport));
  const response = {
    schema_version: FORMATTING_COMMAND_SET_VERSION, request_id: "request-00000001", service_version: "1.0", profile_id: "default", profile_version: "1.0", warnings: [],
    commands: [{
      command_id: "cmd-000001", kind: "paragraph.set_alignment",
      target: commandTarget(SHA, 4),
      arguments: { alignment: "justify" }, required_capability: "paragraph.alignment", on_unsupported: "skip",
    }],
  };
  const transactions = new MockTransactionManager();
  const useCase = new FormatDocumentUseCase(
    new MockDocumentReader(snapshot), recognitionProvider,
    { async requestCommands() { return response; } }, new CommandValidator(),
    new MockDocumentExecutor("cmd-000001"), transactions,
    { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.alignment"] }; } },
    { authorizationScope() { return "classified-offline"; } },
  );
  const result = await useCase.execute("request-00000001");
  assert.equal(result.rolled_back, true);
  assert.deepEqual(transactions.rolledBack, ["mock-tx-1"]);
});

test("classified composition does not reference cloud-only dependencies", async () => {
  const source = await readFile(new URL("../apps/classified-offline/src/composition-root.ts", import.meta.url), "utf8");
  for (const forbidden of ["CloudEndpointProvider", "OnlineTelemetry", "Cloudflare", "https://"]) {
    assert.equal(source.includes(forbidden), false, forbidden + " leaked into classified edition");
  }
});

test("WPS local file system adapter uses official methods and stable fallbacks", async () => {
  const root = await createTempRoot("docxtool-fs-");
  try {
    const calls = [];
    const api = {
      Exists(value) { calls.push(["Exists", value]); return existsSync(value); },
      mkdirSync(value, options) { calls.push(["mkdirSync", value, options]); return mkdirSync(value, options); },
      writeFileString(value, text) { calls.push(["writeFileString", value, text]); return writeFileSync(value, text, "utf8"); },
      readFileString(value) { calls.push(["readFileString", value]); return readFileSync(value, "utf8"); },
      unlinkSync(value) { calls.push(["unlinkSync", value]); return unlinkSync(value); },
      rmdirSync(value) { calls.push(["rmdirSync", value]); return rmdirSync(value); },
      AppendFile(value, text) { calls.push(["AppendFile", value, text]); return appendFileSync(value, text, "utf8"); },
    };
    const fs = new WpsLocalFileSystem(api);
    const nested = path.join(root, "one", "two");
    const file = path.join(nested, "value.txt");
    assert.equal(fs.exists(nested), false);
    fs.mkdir(nested);
    fs.writeText(file, "A");
    fs.appendText(file, "B");
    assert.equal(fs.readText(file), "AB");
    fs.removeFile(file);
    fs.removeDirectory(nested);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(nested), false);
    assert.ok(calls.some(([name]) => name === "mkdirSync"));
    assert.ok(calls.some(([name]) => name === "writeFileString"));
    assert.ok(calls.some(([name]) => name === "readFileString"));
    assert.ok(calls.some(([name]) => name === "unlinkSync"));
    assert.ok(calls.some(([name]) => name === "rmdirSync"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WPS local file system adapter exposes stable method-missing errors", () => {
  const fs = new WpsLocalFileSystem({});
  assert.throws(() => fs.exists("C:\\tmp"), /WPS_FILESYSTEM_EXISTS_UNAVAILABLE/);
  assert.throws(() => fs.mkdir("C:\\tmp"), /WPS_FILESYSTEM_MKDIR_UNAVAILABLE/);
  assert.throws(() => fs.writeText("C:\\tmp\\a.txt", "x"), /WPS_FILESYSTEM_WRITE_UNAVAILABLE/);
  assert.throws(() => fs.readText("C:\\tmp\\a.txt"), /WPS_FILESYSTEM_READ_UNAVAILABLE/);
  assert.throws(() => fs.removeFile("C:\\tmp\\a.txt"), /WPS_FILESYSTEM_REMOVE_UNAVAILABLE|WPS_FILESYSTEM_EXISTS_UNAVAILABLE/);
  assert.throws(() => fs.removeDirectory("C:\\tmp"), /WPS_FILESYSTEM_RMDIR_UNAVAILABLE|WPS_FILESYSTEM_EXISTS_UNAVAILABLE/);
});

test("WPS local file system normalizes mixed Windows separators before calling the host", () => {
  assert.equal(normalizeWpsPath("C:/Users/test\\Docxtool//runtime/current.json"), "C:\\Users\\test\\Docxtool\\runtime\\current.json");
  const calls = [];
  const fs = new WpsLocalFileSystem({ Exists(value) { calls.push(value); return false; } });
  fs.exists("C:/Users/test\\Docxtool/current.json");
  assert.equal(calls[0], "C:\\Users\\test\\Docxtool\\current.json");
});

test("WPS local file system prefers official ReadFile and does not misuse one-argument AppendFile", () => {
  const calls = [];
  const fs = new WpsLocalFileSystem({
    Exists(value) { calls.push(["Exists", value]); return true; },
    ReadFile(value) { calls.push(["ReadFile", value]); return "A"; },
    ReadFileString() { throw new Error("compatibility reader must not be used"); },
    WriteFile(value, text) { calls.push(["WriteFile", value, text]); },
    AppendFile(value) { calls.push(["AppendFile", value]); },
  });
  assert.equal(fs.readText("C:/runtime/current.json"), "A");
  fs.appendText("C:/runtime/current.json", "B");
  assert.deepEqual(calls.filter(([name]) => name === "ReadFile").length, 2);
  assert.deepEqual(calls.find(([name]) => name === "WriteFile"), ["WriteFile", "C:\\runtime\\current.json", "AB"]);
  assert.equal(calls.some(([name]) => name === "AppendFile"), false);
});

test("quoteWindowsCommandLineArgument preserves Windows argv semantics", () => {
  assert.equal(quoteWindowsCommandLineArgument("plain"), "plain");
  assert.equal(quoteWindowsCommandLineArgument("C:\\tmp path\\doc.txt"), "\"C:\\tmp path\\doc.txt\"");
  assert.equal(quoteWindowsCommandLineArgument("C:\\测试\\doc.txt"), "C:\\测试\\doc.txt");
  assert.equal(quoteWindowsCommandLineArgument("C:\\tmp path\\"), "\"C:\\tmp path\\\\\"");
  assert.equal(quoteWindowsCommandLineArgument("A\"B"), "\"A\\\"B\"");
  assert.equal(quoteWindowsCommandLineArgument(""), "\"\"");
});

test("local process recognition transport uses two-argument ShellExecute and cleans job files", async (context) => {
  const root = await createTempRoot("docxtool-process-");
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error("FETCH_NOT_EXPECTED"); };
  try {
    const snapshot = { documentId: "doc-1", revision: "rev-1", sourceSha256: SHA, localDocxPath: path.join(root, "source.docx"), paragraphs: [{ sourceParagraphIndex: 0, text: "测试段落" }] };
    await writeFile(snapshot.localDocxPath, "fake docx", "utf8");
    const calls = [];
    let capturedJobDir = "";
    const runtimeExecutablePath = "C:\\runtime\\docxtool-recognize.exe";
    const application = {
      Env: { GetTempPath() { return root; } },
      FileSystem: {
        Exists(value) { calls.push(["Exists", value]); return value === runtimeExecutablePath || existsSync(value); },
        mkdirSync(value, options) { calls.push(["mkdirSync", value, options]); return mkdirSync(value, options); },
        writeFileString(value, text) { calls.push(["writeFileString", value, text]); return writeFileSync(value, text, "utf8"); },
        readFileString(value) { calls.push(["readFileString", value]); return readFileSync(value, "utf8"); },
        unlinkSync(value) { calls.push(["unlinkSync", value]); return unlinkSync(value); },
        rmdirSync(value) { calls.push(["rmdirSync", value]); return rmdirSync(value); },
      },
      OAAssist: {
        ShellExecute(shellPath, argumentsText) {
          calls.push(["ShellExecute", shellPath, argumentsText, arguments.length]);
          assert.equal(arguments.length, 2);
          assert.equal(shellPath, runtimeExecutablePath);
          const requestPath = argumentsText.match(/--request\s+"([^"]+)"/)?.[1] ?? argumentsText.match(/--request\s+(\S+)/)?.[1];
          const resultPath = argumentsText.match(/--result\s+"([^"]+)"/)?.[1] ?? argumentsText.match(/--result\s+(\S+)/)?.[1];
          const errorPath = argumentsText.match(/--error\s+"([^"]+)"/)?.[1] ?? argumentsText.match(/--error\s+(\S+)/)?.[1];
          assert.ok(requestPath && resultPath && errorPath);
          capturedJobDir = path.dirname(requestPath);
          const request = JSON.parse(readFileSync(requestPath, "utf8"));
          writeFileSync(resultPath, JSON.stringify({
            schema_version: 1,
            request_id: request.request_id,
            recognition_plan: {
              schema_version: "1.0",
              engine_version: "3.0",
              document_mode: "normal",
              document_mode_confidence: 1,
              host_text_contract_version: "host-text-v1",
              blocks: [],
              binding: { host_text_contract_version: "host-text-v1", blocks: [] },
            },
          }), "utf8");
        },
      },
    };
    const transport = new LocalProcessRecognitionTransport(application, runtimeExecutablePath, 500, 5);
    const plan = await transport.recognize(snapshot);
    assert.equal(plan.engine_version, "3.0");
    assert.equal(plan.binding.host_text_contract_version, "host-text-v1");
    assert.equal(capturedJobDir && existsSync(capturedJobDir), false);
    assert.equal(calls.some(([name]) => name === "ShellExecute"), true);
    assert.equal(calls.some(([name]) => name === "writeFileString"), true);
    assert.equal(calls.some(([name]) => name === "readFileString"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WpsHostBridge separates recognition launch and probe without host-side polling", async () => {
  const root = await createTempRoot("docxtool-recognition-job-");
  try {
    const sourcePath = path.join(root, "source.docx"); await writeFile(sourcePath, "fixture", "utf8");
    const runtimeExecutablePath = "C:\\runtime\\docxtool-recognize.exe"; const reads = []; const diagnostics = []; let shellCalls = 0;
    const application = {
      ActiveDocument: { FullName: sourcePath, Saved: true, Paragraphs: { Count: 1, Item() { return { Range: { Text: "脱敏段落\r", Tables: { Count: 0 }, Start: 0, End: 5 } }; } }, Sections: { Count: 1 } },
      Env: { GetTempPath() { return root; } },
      FileSystem: { Exists(value) { return value === runtimeExecutablePath || existsSync(value); }, mkdirSync(value, options) { return mkdirSync(value, options); }, writeFileString(value, text) { return writeFileSync(value, text, "utf8"); }, readFileString(value) { reads.push(value); return readFileSync(value, "utf8"); }, unlinkSync(value) { return unlinkSync(value); }, rmdirSync(value) { return rmdirSync(value); } },
      OAAssist: { ShellExecute(_exe, argumentsText) { shellCalls += 1; const requestPath = argumentsText.match(/--request\s+"([^"]+)"/)?.[1] ?? argumentsText.match(/--request\s+(\S+)/)?.[1]; const resultPath = argumentsText.match(/--result\s+"([^"]+)"/)?.[1] ?? argumentsText.match(/--result\s+(\S+)/)?.[1]; const request = JSON.parse(readFileSync(requestPath, "utf8")); writeFileSync(resultPath, JSON.stringify({ request_id: request.request_id, recognition_plan: { schema_version: "1.0", engine_version: "4.0", document_mode: "normal", document_mode_confidence: 1, host_text_contract_version: "host-text-v1", blocks: [], binding: { host_text_contract_version: "host-text-v1", blocks: [] } } }), "utf8"); } },
    };
    const bridge = new WpsHostBridge(application, { writeForComponent(...values) { diagnostics.push(values); } }, { recognitionExecutablePath: runtimeExecutablePath, recognitionContractVersion: 1 });
    const base = { type: "host.rpc.request", job_id: "recognize-1", build_id: "build-1", payload: {} };
    const descriptor = await bridge.handle({ ...base, rpc_id: "descriptor-1", operation: "host.capture_document_descriptor" });
    const workerSnapshot = { snapshotContractVersion: "worker-snapshot-v1", documentId: "doc-1", revision: "rev-1", textRevision: "rev-1", sourceSha256: SHA, localDocxPath: sourcePath, paragraphs: [{ sourceParagraphIndex: 0, text: "脱敏段落", isInTable: false }], paragraphOrderHash: SHA, sectionCount: 1, documentFullNameHash: descriptor.value.local_docx_path_hash };
    const launched = await bridge.handle({ ...base, rpc_id: "launch-1", operation: "host.launch_recognition", document_token: descriptor.value.document_token, payload: { source_path: sourcePath, snapshot: workerSnapshot, contract_version: 1 } });
    assert.equal(launched.ok, true); assert.equal(shellCalls, 1); assert.equal(reads.length, 0);
    assert.deepEqual(diagnostics.filter((values) => String(values[2]).startsWith("recognition.shell_execute.call.")).map((values) => values[2]), ["recognition.shell_execute.call.start", "recognition.shell_execute.call.returned"]);
    const probed = await bridge.handle({ ...base, rpc_id: "probe-1", operation: "host.probe_recognition", payload: { recognition_job_id: launched.value.recognition_job_id } });
    assert.equal(probed.ok, true); assert.equal(probed.value.state, "completed"); assert.equal(probed.value.recognition_plan.engine_version, "4.0"); assert.equal(reads.length, 1);
    const repeated = await bridge.handle({ ...base, rpc_id: "probe-2", operation: "host.probe_recognition", payload: { recognition_job_id: launched.value.recognition_job_id } });
    assert.equal(repeated.value.state, "completed"); assert.equal(reads.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recognition Worker owns polling and returns the mapped RecognitionResult", async () => {
  const paragraphs = [{ Range: { Text: "脱敏段落\r", Tables: { Count: 0 }, Start: 0, End: 5 } }]; let probes = 0;
  const bridge = {
    async handle(request) {
      if (request.operation === "host.capture_document_descriptor") return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: 1, value: { document_token: "doc-1", saved: true, local_docx_path: "C:\\fixture.docx", local_docx_path_hash: SHA, paragraph_count: 1, section_count: 1, extension: ".docx" } };
      if (request.operation === "host.read_paragraph_batch") return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: 1, value: paragraphs.map((item, index) => ({ host_paragraph_index: index, raw_text: item.Range.Text.slice(0, -1), is_in_table: false, range_start: 0, range_end: 5 })) };
      if (request.operation === "host.launch_recognition") return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: 1, value: { recognition_job_id: "local-rec-1", started_at: new Date().toISOString(), result_path: "C:\\result.json", error_path: "C:\\error.json", cancel_path: "C:\\cancel.json" } };
      if (request.operation === "host.probe_recognition") { probes += 1; return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: 1, value: probes === 1 ? { state: "running" } : { state: "completed", recognition_plan: { schema_version: "1.0", engine_version: "4.0", document_mode: "normal", document_mode_confidence: 1, host_text_contract_version: "host-text-v1", blocks: [], binding: { host_text_contract_version: "host-text-v1", blocks: [] } } } }; }
      throw new Error("UNEXPECTED_RPC");
    },
  };
  class LoopbackWorker { onmessage = null; onerror = null; onmessageerror = null; scope = { onmessage: null, postMessage: (value) => queueMicrotask(() => this.onmessage?.({ data: value })) }; runtime = new SnapshotPipelineWorkerRuntime(this.scope); postMessage(value) { queueMicrotask(() => this.scope.onmessage?.({ data: value })); } terminate() {} }
  const terminal = new Promise((resolve) => { const client = new PipelineWorkerClient({ workerUrl: "pipeline-worker.js", bridge, buildId: "build-1", workerFactory: () => new LoopbackWorker(), onEvent(event) { if (["pipeline.completed", "pipeline.failed"].includes(event.type)) resolve(event); } }); assert.equal(client.start("recognize").accepted, true); });
  const result = await terminal; assert.equal(result.type, "pipeline.completed"); assert.equal(result.command, "recognize"); assert.equal(result.recognition_result.recognition_engine_version, "4.0"); assert.equal(probes, 2);
});

test("Worker command generation is field-equivalent to the legacy local format generator", async () => {
  const text = "xxxx"; const textHash = hashText(text);
  const recognition = { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "4.0", document_id: "doc-1", document_revision: "rev-1", source_sha256: SHA, document_mode: "normal", document_mode_confidence: 1, paragraphs: [{ target_id: "doc-1:p:0:0", source_paragraph_index: 0, physical_paragraph_index: 0, recognized_type: "body", section_kind: "body", text_sha256: textHash, physical_text_sha256: textHash, range_start_utf16: 0, range_end_utf16: text.length, locator_verified: true, mixed_structure: false, formatting_disposition: "apply", text_length: text.length, occurrence_index: 0, confidence: 1, review_level: "confirmed", needs_review: false, ...hostFields(text) }] };
  const profile = { id: "default", version: "1.0", page_setup: { page_width_cm: 21, page_height_cm: 29.7, margin_top_cm: 3.7, margin_bottom_cm: 3.5, margin_left_cm: 2.8, margin_right_cm: 2.6, lines_per_page: 22, chars_per_line: 28, grid_alignment: "文字对齐字符网络", grid_mode: "line_only", normal_east_asia_font_name: "仿宋_GB2312", normal_latin_font_name: "Times New Roman", normal_font_size_pt: 16 }, styles: { body: { east_asia_font_name: "仿宋_GB2312", latin_font_name: "Times New Roman", font_size_pt: 16, bold: false, alignment: "justify", first_line_indent_chars: 2, left_indent_chars: 0, right_indent_chars: 0, space_before_lines: 0, space_after_lines: 0, line_spacing_rule: "exactly", line_spacing_pt: 28, page_break_before: false, outline_level: 10 } } };
  const clientCapabilities = { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.font", "paragraph.alignment", "paragraph.indent", "paragraph.spacing", "section.page_setup"] };
  const requestId = "request-00000001";
  const request = { schema_version: COMMAND_REQUEST_VERSION, request_id: requestId, recognition_result: recognition, profile_id: "default", profile_version: "1.0", client_capabilities: clientCapabilities, product_version: "1.0", authorization_scope: "classified-offline" };
  const legacy = await new LocalFormatCommandGenerator(profile).requestCommands(request);
  const worker = await generateWorkerCommands(recognition, requestId, { profile, client_capabilities: clientCapabilities, authorization_scope: "classified-offline" });
  assert.deepEqual(worker, legacy);
});

function fakeWps(text = "测试段落\r") {
  const format = { Alignment: 0, CharacterUnitFirstLineIndent: 0, CharacterUnitLeftIndent: 0, CharacterUnitRightIndent: 0, LineUnitBefore: 0, LineUnitAfter: 0, LineSpacingRule: 0, LineSpacing: 0, PageBreakBefore: 0, OutlineLevel: 10, SnapToGrid: true };
  const pageSetup = { PageWidth: 600, PageHeight: 800, TopMargin: 70, BottomMargin: 70, LeftMargin: 70, RightMargin: 70, LinesPage: 22, CharsLine: 28, LayoutMode: 1, ShowGrid: true };
  const paragraph = { Range: { Start: 0, End: text.length, Text: text, Font: { Name: "宋体", NameAscii: "宋体", NameOther: "宋体", NameFarEast: "宋体", Size: 12, Bold: 0, Spacing: 2, Scaling: 90, DisableCharacterSpaceGrid: false }, ParagraphFormat: format, PageSetup: pageSetup } };
  const paragraphs = { Count: 1, Item(index) { assert.equal(index, 1); return paragraph; } };
  globalThis.Application = { ActiveDocument: { FullName: "C:\\redacted.docx", Saved: true, Paragraphs: paragraphs, PageSetup: pageSetup, Range(start, end) { return { ...paragraph.Range, Start: start, End: end, Text: text.slice(start, end) }; } } };
  return { paragraph, format };
}

test("official-host reader and locator use only local snapshot text and hash anchors", async () => {
  fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  assert.equal(snapshot.localDocxPath, "C:\\redacted.docx");
  assert.equal(snapshot.paragraphs[0].text, "测试段落");
  const target = commandTarget((await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex"));
  assert.ok(await new WpsTargetLocator().locate(target));
});

test("official-host normalizes WPS section-break control characters", async () => {
  fakeWps("测试段落\r\f");
  const snapshot = await new WpsDocumentReader().readSnapshot();
  assert.equal(snapshot.paragraphs[0].text, "测试段落");
  const target = commandTarget((await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex"));
  assert.ok(await new WpsTargetLocator().locate(target));
});

test("official-host executor rejects missing capabilities and compensates a failed transaction", async () => {
  const { paragraph, format } = fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = commandTarget(hash);
  const command = { command_id: "cmd-000001", kind: "paragraph.set_font", target, arguments: { east_asia_font_name: "仿宋", latin_font_name: "Times New Roman", font_size_pt: 16, bold: true }, required_capability: "paragraph.font", on_unsupported: "fail" };
  const noCapabilities = { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: [] }; } };
  const disabled = await new WpsApiDocumentExecutor(new WpsTargetLocator(), noCapabilities).execute(commandSet([command]), "tx", snapshot.revision);
  assert.equal(disabled.failed_command_id, "cmd-000001");
  const capabilities = { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.font", "paragraph.alignment"] }; } };
  Object.defineProperty(format, "Alignment", { configurable: true, get() { return 0; }, set() { throw new Error("simulated"); } });
  const second = { command_id: "cmd-000002", kind: "paragraph.set_alignment", target, arguments: { alignment: "center" }, required_capability: "paragraph.alignment", on_unsupported: "fail" };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute(commandSet([command, second]), "tx", snapshot.revision);
  assert.equal(result.rolled_back, true);
  assert.equal(paragraph.Range.Font.Name, "宋体");
  assert.equal(paragraph.Range.Font.Size, 12);
});

test("official-host defaults to line_only and never forces a 28-character grid", async () => {
  const { paragraph } = fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = commandTarget(hash);
  const command = { command_id: "cmd-000001", kind: "section.set_page_setup", target, arguments: { page_width_cm: 21, page_height_cm: 29.7, margin_top_cm: 3.7, margin_bottom_cm: 3.5, margin_left_cm: 2.8, margin_right_cm: 2.6, lines_per_page: 22, chars_per_line: 28, grid_alignment: "文字对齐字符网络", grid_mode: "line_only" }, required_capability: "section.page_setup", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["section.page_setup"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute(commandSet([command]), "tx", snapshot.revision);
  assert.equal(result.rolled_back, false);
  // WPS retains the existing values, but with LayoutMode=0 they are no longer
  // a document character grid.  Setting CharsLine would stretch glyphs.
  assert.equal(paragraph.Range.PageSetup.LinesPage, 22);
  assert.equal(paragraph.Range.PageSetup.CharsLine, 28);
  assert.equal(paragraph.Range.PageSetup.LayoutMode, 0);
  assert.equal(paragraph.Range.PageSetup.ShowGrid, false);
  assert.equal(paragraph.Range.PageSetup.PageWidth, 21 * 28.3464567);
});

test("official-host expands page setup to every section and preserves landscape physical edges", async () => {
  const { paragraph } = fakeWps();
  const portrait = paragraph.Range.PageSetup;
  const landscape = { ...portrait, Orientation: 1 };
  globalThis.Application.ActiveDocument.Sections = { Count: 2, Item(index) { return { PageSetup: index === 1 ? portrait : landscape }; } };
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const command = { command_id: "cmd-000001", kind: "section.set_page_setup", target: commandTarget(hash), arguments: { page_width_cm: 21, page_height_cm: 29.7, margin_top_cm: 3.7, margin_bottom_cm: 3.5, margin_left_cm: 2.8, margin_right_cm: 2.6, lines_per_page: 22, chars_per_line: 28, grid_alignment: "文字对齐字符网络", grid_mode: "line_only" }, required_capability: "section.page_setup", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["section.page_setup"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute(commandSet([command]), "tx", snapshot.revision);
  assert.equal(result.failed_command_id, null);
  assert.equal(landscape.PageWidth, 29.7 * 28.3464567);
  assert.equal(landscape.PageHeight, 21 * 28.3464567);
  assert.equal(landscape.TopMargin, 2.8 * 28.3464567);
  assert.equal(landscape.LeftMargin, 3.5 * 28.3464567);
});

test("official-host rejects strict character grids until the complete WPS capability set is proven", async () => {
  fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = commandTarget(hash);
  const command = { command_id: "cmd-000001", kind: "section.set_page_setup", target, arguments: { page_width_cm: 21, page_height_cm: 29.7, margin_top_cm: 3.7, margin_bottom_cm: 3.5, margin_left_cm: 2.8, margin_right_cm: 2.6, lines_per_page: 22, chars_per_line: 28, grid_alignment: "文字对齐字符网络", grid_mode: "strict_lines_and_chars" }, required_capability: "section.page_setup", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["section.page_setup"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities, "strict_lines_and_chars").execute(commandSet([command]), "tx", snapshot.revision);
  assert.equal(result.failed_command_id, "cmd-000001");
  assert.deepEqual(result.warnings, ["DOCUMENT_CHARACTER_GRID_UNSUPPORTED"]);
});

test("grid metrics exactly match the root OOXML charSpace and linePitch formulas", () => {
  // Root core.py writes final XML with its historical 567-twip/cm rounding:
  // A4=11907, left=1588, right=1474, therefore content=8845 twips.
  const metrics = computeGridMetrics({ pageWidthPt: 11907 / 20, pageHeightPt: 16840 / 20, topMarginPt: 2098 / 20, bottomMarginPt: 1985 / 20, leftMarginPt: 1588 / 20, rightMarginPt: 1474 / 20, landscape: false }, { charsPerLine: 28, linesPerPage: 22, lineSpacingPt: 28, normalFontSizePt: 16 });
  assert.equal(metrics.linePitchTwips, 560);
  assert.equal(metrics.charSpace, -842);
  assert.equal(metrics.contentWidthTwips, 8845);
});

test("landscape sections rotate physical margins and calculate an independent content width", () => {
  assert.deepEqual(rotateLandscapeMargins({ top: 3.7, bottom: 3.5, left: 2.8, right: 2.6 }), { top: 2.8, bottom: 2.6, left: 3.5, right: 3.7 });
  const portrait = computeGridMetrics({ pageWidthPt: 595.2756, pageHeightPt: 841.8898, topMarginPt: 104.88, bottomMarginPt: 99.21, leftMarginPt: 79.37, rightMarginPt: 73.70, landscape: false }, { charsPerLine: 28, linesPerPage: 22, lineSpacingPt: 28, normalFontSizePt: 16 });
  const landscape = computeGridMetrics({ pageWidthPt: 841.8898, pageHeightPt: 595.2756, topMarginPt: 79.37, bottomMarginPt: 73.70, leftMarginPt: 99.21, rightMarginPt: 104.88, landscape: true }, { charsPerLine: 28, linesPerPage: 22, lineSpacingPt: 28, normalFontSizePt: 16 });
  assert.notEqual(portrait.contentWidthTwips, landscape.contentWidthTwips);
  assert.notEqual(portrait.charSpace, landscape.charSpace);
});

test("strict mode cannot be enabled with wps-jsapi 1.0.5's incomplete grid capability set", () => {
  const matrix = new DocumentGridCapabilityProvider().probe({ pageSetup: { PageWidth: 1, LeftMargin: 1, Orientation: 0, LinesPage: 22, CharsLine: 28, LayoutMode: 0 }, paragraphFormat: { SnapToGrid: false }, font: { Spacing: 0, Scaling: 100 }, sections: {} });
  assert.equal(matrix.find((item) => item.name === "GRID_CHAR_SPACE").state, "UNSUPPORTED");
  assert.equal(matrix.find((item) => item.name === "GRID_LINE_PITCH").state, "UNSUPPORTED");
  assert.equal(new DocumentGridCapabilityProvider().supportsStrict(), false);
});

test("grid paragraph policy keeps titles natural and line_only keeps body natural", () => {
  assert.equal(snapToGridForParagraph("strict_lines_and_chars", 1), false);
  assert.equal(snapToGridForParagraph("strict_lines_and_chars", 10), true);
  assert.equal(snapToGridForParagraph("line_only", 10), false);
  const validator = new GridReadbackValidator();
  validator.validateLineOnly({ mode: "line_only", pageWidthPt: 1, pageHeightPt: 1, topMarginPt: 0, bottomMarginPt: 0, leftMarginPt: 0, rightMarginPt: 0, landscape: false, layoutMode: 0, showGrid: false, snapToGrid: false, characterSpacingPt: 0, characterScalingPercent: 100, fitText: false, alignment: "justify" });
  assert.throws(() => validator.validateLineOnly({ mode: "line_only", pageWidthPt: 1, pageHeightPt: 1, topMarginPt: 0, bottomMarginPt: 0, leftMarginPt: 0, rightMarginPt: 0, landscape: false, layoutMode: 0, showGrid: false, snapToGrid: false, characterSpacingPt: 0, characterScalingPercent: 100, fitText: false, alignment: "distributed" }), /GRID_READBACK_MISMATCH/);
});

test("grid transaction journal restores in reverse order", () => {
  const trace = []; const transaction = new GridTransactionManager();
  transaction.capture(() => trace.push("page")); transaction.capture(() => trace.push("paragraph"));
  transaction.rollback();
  assert.deepEqual(trace, ["paragraph", "page"]);
});

test("official-host writes paragraph spacing in lines and heading outline level", async () => {
  const { paragraph } = fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = commandTarget(hash);
  const command = { command_id: "cmd-000001", kind: "paragraph.set_spacing", target, arguments: { space_before_lines: 1, space_after_lines: 0, line_spacing_rule: "exactly", line_spacing_pt: 28, page_break_before: false, outline_level: 3 }, required_capability: "paragraph.spacing", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.spacing"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute(commandSet([command]), "tx", snapshot.revision);
  assert.equal(result.rolled_back, false);
  assert.equal(paragraph.Range.ParagraphFormat.LineUnitBefore, 1);
  assert.equal(paragraph.Range.ParagraphFormat.LineUnitAfter, 0);
  assert.equal(paragraph.Range.ParagraphFormat.LineSpacing, 28);
  assert.equal(paragraph.Range.ParagraphFormat.OutlineLevel, 3);
  assert.equal(paragraph.Range.ParagraphFormat.SnapToGrid, false);
});

test("preview comments use a paragraph Range and remove only their session marker", async () => {
  const text = "预览段落";
  const hash = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
  const comments = [{ Range: { Text: "用户已有批注" }, Delete() { this.deleted = true; } }];
  const paragraph = { Range: { Text: text + "\r", Start: 10, End: 15 } };
  const commentCollection = {
    get Count() { return comments.filter((item) => !item.deleted).length; },
    Item(index) { return comments.filter((item) => !item.deleted)[index - 1]; },
    Add(range, value) { const item = { Range: { Text: value, InsertBefore(chunk) { this.Text = chunk + this.Text; } }, Reference: range, Delete() { this.deleted = true; } }; comments.push(item); return item; },
  };
  const selection = { Start: 77, End: 77 };
  globalThis.Application = { Selection: selection, ActiveDocument: { Comments: commentCollection, Paragraphs: { Item() { return paragraph; } }, Range(start, end) { return { Start: start, End: end, Text: text }; } } };
  const service = new WpsPreviewCommentService();
  const snapshot = { documentId: "doc-1", revision: "rev", sourceSha256: hash, documentFullNameHash: "document-path-hash", paragraphs: [{ sourceParagraphIndex: 0, text }] };
  const recognition = { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "3", document_id: "doc-1", document_revision: "rev", source_sha256: hash, document_mode: "normal", document_mode_confidence: 1, paragraphs: [{ target_id: "doc-1:p:0:0", source_paragraph_index: 0, physical_paragraph_index: 0, recognized_type: "main_title", section_kind: "body", text_sha256: hash, physical_text_sha256: hash, range_start_utf16: 0, range_end_utf16: text.length, locator_verified: true, mixed_structure: false, formatting_disposition: "apply", text_length: text.length, occurrence_index: 0, confidence: 0.5, review_level: "review", needs_review: true, ...hostFields(text) }] };
  const target = { ...commandTarget(hash, text.length), target_id: "doc-1:p:0:0" };
  const commands = commandSet([
    { command_id: "cmd-000001", kind: "paragraph.set_font", target, arguments: { east_asia_font_name: "方正小标宋简体", latin_font_name: "Times New Roman", font_size_pt: 22, bold: false }, required_capability: "paragraph.font", on_unsupported: "fail" },
    { command_id: "cmd-000002", kind: "paragraph.set_alignment", target, arguments: { alignment: "center" }, required_capability: "paragraph.alignment", on_unsupported: "fail" },
    { command_id: "cmd-000003", kind: "paragraph.set_indent", target, arguments: { first_line_indent_chars: 0, left_indent_chars: 0, right_indent_chars: 0 }, required_capability: "paragraph.indent", on_unsupported: "fail" },
    { command_id: "cmd-000004", kind: "paragraph.set_spacing", target, arguments: { space_before_lines: 0, space_after_lines: 0, line_spacing_rule: "exactly", line_spacing_pt: 28, page_break_before: false, outline_level: 0 }, required_capability: "paragraph.spacing", on_unsupported: "fail" },
  ]);
  const created = await service.addPreviewComments({ snapshot, recognition, commands, mode: "all" });
  assert.equal(created.comment_count, 1);
  assert.equal(comments.filter((item) => !item.deleted).length, 2);
  const previewText = comments[1].Range.Text;
  assert.equal(comments[1].Author, "DocxTool·主标题");
  assert.equal(comments[1].Initial, "主");
  assert.match(previewText, /^识别结果：主标题 中文字体：方正小标宋简体/);
  assert.equal(previewText.split(/\r?\n/).length, 3);
  for (const value of ["识别结果：主标题", "中文字体：方正小标宋简体", "西文字体：Times New Roman", "字号：二号", "粗体：否", "对齐方式：居中", "首行缩进：0 字符", "左缩进：0 字符", "右缩进：0 字符", "段前：0 行", "段后：0 行", "固定行距：28 磅", "段前分页：否", "识别状态：需要复核", "识别置信度：50%"] ) assert.match(previewText, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const value of ["[DOCXTOOL_PREVIEW]", "\u2063", "preview_session=", "document_identity=", "paragraph_index=", "reference_start=", "识别代码：", "具体格式：", "固定行距：28 pt"]) assert.doesNotMatch(previewText, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  comments[1].Reference = { Start: 11, End: 14 };
  await service.removePreviewComments(created.tracker);
  assert.equal(comments[0].deleted, undefined);
  assert.equal(comments[1].deleted, true);
  assert.deepEqual(globalThis.Application.Selection, selection);
});

test("Worker PreviewPlan and Host preview batches use the same comment text and preserve user comments", async () => {
  const text = "预览段落"; const hash = hashText(text); const comments = [{ Author: "用户", Initial: "用", Range: { Text: "已有批注" }, Delete() { this.deleted = true; } }];
  const commentCollection = { get Count() { return comments.filter((item) => !item.deleted).length; }, Item(index) { return comments.filter((item) => !item.deleted)[index - 1]; }, Add(reference, value) { const item = { Range: { Text: value }, Reference: reference, Delete() { this.deleted = true; } }; comments.push(item); return item; } };
  const paragraphRange = { Text: text + "\r", Start: 10, End: 10 + text.length + 1, Tables: { Count: 0 } };
  const application = { ActiveDocument: { FullName: "C:\\preview.docx", Saved: true, Sections: { Count: 1 }, Comments: commentCollection, Paragraphs: { Count: 1, Item() { return { Range: paragraphRange }; } }, Range(start, end) { return { Start: start, End: end, Text: text.slice(start - 10, end - 10) }; } } };
  const bridge = new WpsHostBridge(application); const base = { type: "host.rpc.request", job_id: "preview-job-1", build_id: "build-1", payload: {} };
  const descriptor = await bridge.handle({ ...base, rpc_id: "descriptor-preview", operation: "host.capture_document_descriptor" });
  const recognition = { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "4", document_id: "doc-1", document_revision: "rev", source_sha256: hash, document_mode: "normal", document_mode_confidence: 1, paragraphs: [{ target_id: "doc-1:p:0", source_paragraph_index: 0, physical_paragraph_index: 0, recognized_type: "main_title", section_kind: "body", text_sha256: hash, physical_text_sha256: hash, range_start_utf16: 0, range_end_utf16: text.length, locator_verified: true, mixed_structure: false, formatting_disposition: "apply", text_length: text.length, occurrence_index: 0, confidence: 1, review_level: "confirmed", needs_review: false, ...hostFields(text) }] };
  const target = { ...commandTarget(hash, text.length), target_id: "doc-1:p:0" }; const commands = commandSet([{ command_id: "cmd-000001", kind: "paragraph.set_font", target, arguments: { east_asia_font_name: "方正小标宋简体", latin_font_name: "Times New Roman", font_size_pt: 22, bold: false }, required_capability: "paragraph.font", on_unsupported: "fail" }]);
  const plan = createPreviewPlan({ documentId: "doc-1", revision: "rev", sourceSha256: hash, paragraphs: [{ sourceParagraphIndex: 0, text }] }, recognition, commands, "all");
  assert.equal(plan.length, 1); assert.match(plan[0].comment_text, /识别结果：主标题/);
  const applied = await bridge.handle({ ...base, rpc_id: "preview-apply", operation: "host.apply_preview_batch", document_token: descriptor.value.document_token, payload: { session_id: "preview-session-1", items: plan } });
  assert.equal(applied.ok, true); assert.equal(applied.value.applied_count, 1); assert.equal(comments.filter((item) => !item.deleted).length, 2);
  const oversized = await bridge.handle({ ...base, rpc_id: "preview-overflow", operation: "host.apply_preview_batch", document_token: descriptor.value.document_token, payload: { session_id: "preview-session-1", items: Array(6).fill(plan[0]) } });
  assert.equal(oversized.ok, false); assert.equal(oversized.error.code, "HOST_PREVIEW_BATCH_INVALID");
  const cleared = await bridge.handle({ ...base, rpc_id: "preview-clear", operation: "host.clear_preview_batch", document_token: descriptor.value.document_token, payload: { batch_size: 5 } });
  assert.equal(cleared.ok, true); assert.equal(cleared.value.remaining, 0); assert.equal(cleared.value.user_comment_integrity, true); assert.equal(comments[0].deleted, undefined);
});

test("preview comments anchor each mixed role to its verified UTF-16 sub-range", async () => {
  const text = "一、标题。正文内容"; const title = "一、标题。"; const body = "正文内容";
  const comments = [];
  const collection = { get Count() { return comments.length; }, Item(index) { return comments[index - 1]; }, Add(reference, value) { const item = { Range: { Text: value }, Reference: reference, Delete() {} }; comments.push(item); return item; } };
  globalThis.Application = { ActiveDocument: { Saved: true, Comments: collection, Paragraphs: { Item() { return { Range: { Text: text + "\r", Start: 100, End: 100 + text.length + 1 } }; } }, Range(start, end) { return { Start: start, End: end, Text: text.slice(start - 100, end - 100) }; } } };
  const physicalHash = hashText(text);
  const makeItem = (value, type, blockIndex) => ({ target_id: `doc-mixed:p:0:r:${text.indexOf(value)}:${text.indexOf(value) + value.length}:${blockIndex}`, source_paragraph_index: 0, physical_paragraph_index: 0, recognized_type: type, section_kind: "body", text_sha256: hashText(value), physical_text_sha256: physicalHash, range_start_utf16: text.indexOf(value), range_end_utf16: text.indexOf(value) + value.length, locator_verified: true, mixed_structure: true, formatting_disposition: "review_only", text_length: value.length, occurrence_index: 0, confidence: 1, review_level: "confirmed", needs_review: true, ...hostFields(text, text.indexOf(value), text.indexOf(value) + value.length) });
  const recognition = { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "3", document_id: "doc-mixed", document_revision: "rev", source_sha256: physicalHash, document_mode: "normal", document_mode_confidence: 1, paragraphs: [makeItem(title, "heading1", 0), makeItem(body, "body", 1)] };
  const result = await new WpsPreviewCommentService().addPreviewComments({ snapshot: { documentId: "doc-mixed", revision: "rev", sourceSha256: physicalHash, documentFullNameHash: "path", paragraphs: [{ sourceParagraphIndex: 0, text }] }, recognition, commands: commandSet([]), mode: "all" });
  assert.equal(result.comment_count, 2);
  assert.deepEqual(comments.map((item) => [item.Reference.Start, item.Reference.End]), [[100, 100 + title.length], [100 + title.length, 100 + text.length]]);
  assert.match(comments[0].Range.Text, /识别结果：一级标题/); assert.match(comments[1].Range.Text, /识别结果：正文/);
  assert.match(comments[0].Range.Text, /正式排版前需要拆段/);
});

test("preview flow never creates a comment inside a table cell", async () => {
  const tableText = "表格内容"; const bodyText = "表外正文";
  const localSnapshot = { ...snapshot, paragraphs: [{ sourceParagraphIndex: 0, text: tableText, isInTable: true }, { sourceParagraphIndex: 1, text: bodyText }] };
  const provider = new LocalWheelRecognitionProvider(boundTransport({ async recognize() { return {
    schema_version: "1.0", engine_version: "3.0", document_mode: "normal", document_mode_confidence: 1, blocks: [
      wheelBlock({ physicalText: tableText, physicalIndex: 0, blockIndex: 0 }),
      wheelBlock({ physicalText: bodyText, physicalIndex: 1, blockIndex: 1 }),
    ],
  }; } }));
  const recognition = await provider.recognize(localSnapshot);
  assert.deepEqual(recognition.paragraphs.map((item) => item.source_paragraph_index), [1]);
  const comments = [];
  const collection = { get Count() { return comments.length; }, Item(index) { return comments[index - 1]; }, Add(reference, value) { const item = { Range: { Text: value }, Reference: reference, Delete() {} }; comments.push(item); return item; } };
  const ranges = [{ Text: tableText + "\r", Start: 10, End: 10 + tableText.length + 1 }, { Text: bodyText + "\r", Start: 30, End: 30 + bodyText.length + 1 }];
  globalThis.Application = { ActiveDocument: { Saved: true, Comments: collection, Paragraphs: { Item(index) { return { Range: ranges[index - 1] }; } }, Range(start, end) { const range = ranges.find((item) => start >= item.Start && end <= item.End); return { Start: start, End: end, Text: range ? String(range.Text).slice(start - range.Start, end - range.Start) : "" }; } } };
  const result = await new WpsPreviewCommentService().addPreviewComments({ snapshot: localSnapshot, recognition, commands: commandSet([]), mode: "all" });
  assert.equal(result.comment_count, 1);
  assert.deepEqual([comments[0].Reference.Start, comments[0].Reference.End], [30, 30 + bodyText.length]);
});

test("preview skips empty paragraphs and marks unknown paragraphs for review", async () => {
  const texts = ["", "未知类型测试"];
  const comments = [];
  const collection = { get Count() { return comments.filter((item) => !item.deleted).length; }, Item(index) { return comments.filter((item) => !item.deleted)[index - 1]; }, Add(reference, value) { const item = { Range: { Text: value }, Reference: reference, Delete() { this.deleted = true; } }; comments.push(item); return item; } };
  globalThis.Application = { Selection: { Start: 3, End: 3 }, ActiveDocument: { Saved: true, Comments: collection, Paragraphs: { Item(index) { const text = texts[index - 1]; return { Range: { Text: text + "\r", Start: index * 10, End: index * 10 + text.length + 1 } }; } }, Range(start, end) { const index = Math.floor(start / 10) - 1; const text = texts[index] ?? ""; return { Start: start, End: end, Text: text.slice(start - (index + 1) * 10, end - (index + 1) * 10) }; } } };
  const hashes = await Promise.all(texts.map((text) => import("node:crypto").then(({ createHash }) => createHash("sha256").update(text).digest("hex"))));
  const localSnapshot = { documentId: "doc-unknown", revision: "rev", sourceSha256: SHA, documentFullNameHash: "path", paragraphs: texts.map((text, index) => ({ sourceParagraphIndex: index, text })) };
  const recognition = { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "3", document_id: "doc-unknown", document_revision: "rev", source_sha256: SHA, document_mode: "normal", document_mode_confidence: 1, paragraphs: texts.map((text, index) => ({ target_id: `doc-unknown:p:${index}:0`, source_paragraph_index: index, physical_paragraph_index: index, recognized_type: "unknown", section_kind: "body", text_sha256: hashes[index], physical_text_sha256: hashes[index], range_start_utf16: 0, range_end_utf16: Math.max(1, text.length), locator_verified: true, mixed_structure: false, formatting_disposition: "review_only", text_length: text.length, occurrence_index: 0, confidence: 0.4, review_level: "review", needs_review: true, ...hostFields(text || " ", 0, Math.max(1, text.length), index) })) };
  const result = await new WpsPreviewCommentService().addPreviewComments({ snapshot: localSnapshot, recognition, commands: commandSet([]), mode: "all" });
  assert.equal(result.comment_count, 1); assert.equal(comments.length, 1); assert.match(comments[0].Range.Text, /识别结果：未知/); assert.match(comments[0].Range.Text, /可应用格式：暂无/); assert.match(comments[0].Range.Text, /识别状态：需要复核/); assert.match(comments[0].Range.Text, /识别置信度：40%/);
  assert.deepEqual(globalThis.Application.Selection, { Start: 3, End: 3 });
});

test("formal WPS executor enforces natural glyph metrics for every font command", async () => {
  const { paragraph } = fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = commandTarget(hash);
  const command = { command_id: "cmd-000001", kind: "paragraph.set_font", target, arguments: { east_asia_font_name: "仿宋_GB2312", latin_font_name: "Times New Roman", font_size_pt: 16, bold: false }, required_capability: "paragraph.font", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.font"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute(commandSet([command]), "tx", snapshot.revision);
  assert.equal(result.failed_command_id, null);
  assert.equal(paragraph.Range.Font.Spacing, 0);
  assert.equal(paragraph.Range.Font.Scaling, 100);
  assert.equal(paragraph.Range.Font.DisableCharacterSpaceGrid, true);
});

test("active WPS formatting paths never write paragraph before/after spacing in points", async () => {
  const files = [
    "../packages/wps-adapter/src/official-host.ts",
    "../apps/classified-offline/ui/e2e-dev.js",
    "../apps/classified-offline/src/formal-e2e-driver.ts",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes(".SpaceBefore"), false, file);
    assert.equal(source.includes(".SpaceAfter"), false, file);
    assert.equal(source.includes("space_before_pt"), false, file);
    assert.equal(source.includes("space_after_pt"), false, file);
  }
});

test("taskpane delegates formatting to the formal use case instead of writing WPS properties", async () => {
  const taskpane = await readFile(new URL("../apps/classified-offline/ui/taskpane-development.html", import.meta.url), "utf8");
  const driver = await readFile(new URL("../apps/classified-offline/src/formal-e2e-driver.ts", import.meta.url), "utf8");
  const helper = await readFile(new URL("../apps/classified-offline/src/formal-e2e-usecase.ts", import.meta.url), "utf8");
  assert.match(taskpane, /formal-e2e-driver\.ts/);
  assert.match(driver, /createClassifiedProductionComposition/);
  assert.match(driver, /runFormalPlan/); assert.match(helper, /new FormatDocumentUseCase/); assert.match(helper, /new WpsApiDocumentExecutor/);
  assert.match(driver, /DocxtoolAutomaticFormatTest/);
  assert.match(driver, /docxtool_e2e/);
  for (const forbidden of ["PageSetup", "ParagraphFormat", ".Font", "CharsLine", "LinesPage", "LayoutMode"]) { assert.equal(driver.includes(forbidden), false, forbidden); assert.equal(helper.includes(forbidden), false, forbidden); }
});

test("add-in main context loads the host router independently from the taskpane", async () => {
  const main = await readFile(new URL("../apps/classified-offline/main.js", import.meta.url), "utf8");
  const taskpane = await readFile(new URL("../apps/classified-offline/src/taskpane-workflow.ts", import.meta.url), "utf8");
  const hostRuntime = await readFile(new URL("../apps/classified-offline/src/host-runtime.ts", import.meta.url), "utf8");
  assert.match(main, /js\/bootstrap-probe\.js/);
  assert.match(main, /versioned\("host-runtime\.js"\)/);
  assert.equal(main.includes("type='module'"), false);
  assert.equal(main.includes("dist/host-runtime.js"), false);
  assert.equal(taskpane.includes("createClassifiedProductionComposition"), false);
  assert.equal(taskpane.includes("FormatDocumentUseCase"), false);
  assert.match(hostRuntime, /setInterval\(tryInstall,\s*250\)/);
  assert.match(hostRuntime, /local_application_runtime_installed/);
});

function hostMocks() {
  const values = new Map(); const storage = { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } };
  let created = 0; const panes = new Map();
  const application = { PluginStorage: storage, CreateTaskPane() { created += 1; const pane = { ID: created, Visible: false, Delete() { panes.delete(this.ID); } }; panes.set(created, pane); return pane; }, GetTaskPane(id) { const pane = panes.get(Number(id)); if (!pane) throw new Error("missing"); return pane; } };
  return { storage, application, values, panes, created: () => created };
}

test("TaskPaneManager follows official GetTaskPane and Visible lifecycle", () => {
  const mocks = hostMocks(); const manager = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane");
  const first = manager.show(); assert.equal(first.Visible, true); assert.equal(mocks.created(), 1);
  assert.equal(manager.toggle(), null); assert.equal(first.Visible, false); assert.equal(mocks.panes.size, 1);
  const second = manager.toggle(); assert.equal(second.Visible, true); assert.equal(mocks.created(), 1); assert.equal(mocks.panes.size, 1);
  manager.hide(); manager.show(); assert.equal(mocks.created(), 1); assert.equal(mocks.panes.size, 1);
});

test("HostResultStore persists redacted state and isolates stale builds", () => {
  const mocks = hostMocks(); const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" };
  const first = new HostResultStore(mocks.storage, build, "host-a"); first.update({ recognition_summary: "总段落 3" });
  assert.equal(new HostResultStore(mocks.storage, build, "host-b").read().recognition_summary, "总段落 3");
  const stale = new HostResultStore(mocks.storage, { ...build, build_id: "build-b" }, "host-c").read();
  assert.equal(stale.latest_error, "ADDIN_CONTEXT_STALE"); assert.equal(stale.recognition_summary, "");
});

test("LocalApplicationRuntime directly invokes pane actions and rejects unknown commands", async () => {
  const mocks = hostMocks(); const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" };
  const store = new HostResultStore(mocks.storage, build, "host-a"); const panes = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane");
  const runtime = new LocalApplicationRuntime(mocks.application, panes, store, { recognitionExecutablePath: "C:\\runtime\\docxtool-recognize.exe", runtimeVersion: "1", runtimeSha256: "a" });
  assert.equal((await runtime.run("toggle_taskpane")).status, "PASS"); assert.equal(panes.get().Visible, true);
  assert.equal((await runtime.run("toggle_taskpane")).status, "PASS"); assert.equal(panes.get().Visible, false);
  await assert.rejects(() => runtime.run("not_registered"), /UNKNOWN_LOCAL_COMMAND/);
});

test("production preview returns after Worker submission without awaiting the pipeline", async () => {
  const mocks = hostMocks(); const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" };
  const store = new HostResultStore(mocks.storage, build, "host-a"); const panes = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane");
  const runtime = new LocalApplicationRuntime(mocks.application, panes, store, { recognitionExecutablePath: "C:\\runtime\\docxtool-recognize.exe", runtimeVersion: "1", runtimeSha256: "a", threadedPreviewEnabled: true }); const calls = [];
  runtime.attachPipelineStarter((command) => { calls.push(command); return { accepted: true, command_id: "preview-worker-1", command_name: command }; });
  const result = await runtime.run("preview_document", "ribbon", "preview-request-1", "build-a");
  assert.equal(result.status, "PASS"); assert.equal(result.summary, "预览任务已提交"); assert.deepEqual(calls, ["preview"]);
});

test("production preview is safely blocked unless the threaded launch gate is explicitly enabled", async () => {
  const mocks = hostMocks(); const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" };
  const store = new HostResultStore(mocks.storage, build, "host-a"); const panes = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane");
  const runtime = new LocalApplicationRuntime(mocks.application, panes, store, { recognitionExecutablePath: "C:\\runtime\\docxtool-recognize.exe", runtimeVersion: "1", runtimeSha256: "a" }); const calls = [];
  runtime.attachPipelineStarter((command) => { calls.push(command); return { accepted: true, command_id: "unexpected", command_name: command }; });
  const result = await runtime.run("preview_document", "ribbon", "preview-request-blocked", "build-a");
  assert.equal(result.status, "FAIL");
  assert.equal(result.error_code, "THREADED_PREVIEW_RECOGNITION_LAUNCH_BLOCKED");
  assert.deepEqual(calls, []);
});

test("development recognition launch probe reuses the production Worker command without invoking preview", async () => {
  const source = await readFile(new URL("../apps/classified-offline/src/host-runtime.ts", import.meta.url), "utf8");
  const marker = source.slice(source.indexOf("if (developmentE2E &&"), source.indexOf("void runAutomaticHostAcceptance"));
  const automatic = source.slice(source.indexOf("async function runAutomaticHostAcceptance"), source.indexOf("function installDiagnosticLogger"));
  assert.match(marker, /developmentE2E\.command === "recognition_launch_probe"/);
  assert.match(marker, /startPipeline\("recognize"\)/);
  assert.equal(marker.includes('startPipeline("preview")'), false);
  assert.equal(automatic.includes("startSnapshotJob"), false);
});

test("LocalApplicationRuntime logs the original stack while public state keeps only the stable error", async () => {
  const mocks = hostMocks();
  const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" };
  const store = new HostResultStore(mocks.storage, build, "host-a");
  const panes = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane");
  const runtime = new LocalApplicationRuntime(mocks.application, panes, store, { recognitionExecutablePath: "C:\\runtime\\docxtool-recognize.exe", runtimeVersion: "1", runtimeSha256: "a" });
  const events = [];
  const previous = globalThis.DocxtoolDiagnosticLog;
  globalThis.DocxtoolDiagnosticLog = (...values) => events.push(values);
  try {
    const result = await runtime.run("toggle_taskpane", "taskpane", "request-error", "stale-build");
    assert.equal(result.status, "FAIL");
    assert.equal(result.error_code, "ADDIN_CONTEXT_STALE");
    const failed = events.find((values) => values[2] === "application.runtime.run.failed");
    assert.ok(failed);
    assert.match(failed[5].stack, /ADDIN_CONTEXT_STALE/);
    const publicState = mocks.storage.getItem("docxtool_classified_host_result_v1");
    assert.equal(publicState.includes("stack"), false);
    assert.equal(JSON.parse(publicState).latest_error, "ADDIN_CONTEXT_STALE");
  } finally {
    if (previous) globalThis.DocxtoolDiagnosticLog = previous;
    else delete globalThis.DocxtoolDiagnosticLog;
  }
});

test("LocalApplicationRuntime isolates stored results after an active-document switch", async () => {
  const mocks = hostMocks(); mocks.application.ActiveDocument = { FullName: "C:\\one.docx", Paragraphs: { Count: 2 } };
  const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" }; const store = new HostResultStore(mocks.storage, build, "host-a"); const panes = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane"); const runtime = new LocalApplicationRuntime(mocks.application, panes, store, { recognitionExecutablePath: "C:\\runtime\\docxtool-recognize.exe", runtimeVersion: "1", runtimeSha256: "a" });
  store.update({ document_identity_hash: "previous-document", recognition_summary: "旧文档结果", paragraph_recognition_models: [{ paragraph_index: 0, recognized_type: "body", confidence: 1, needs_review: false }], unresolved_block_count: 2, mixed_paragraph_count: 3 });
  await runtime.reconcileActiveDocument(); assert.equal(store.read().recognition_summary, ""); assert.deepEqual(store.read().paragraph_recognition_models, []);
  assert.equal(store.read().unresolved_block_count, 0); assert.equal(store.read().mixed_paragraph_count, 0);
});

test("document switch clears the old preview tracker without deleting comments from the previous document", async () => {
  const source = await readFile(new URL("../apps/classified-offline/src/host-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /previewTracker\.clear\(\)/);
  const switchBlock = source.slice(source.indexOf("async reconcileActiveDocument"), source.indexOf("private composition"));
  assert.equal(switchBlock.includes("removePreviewComments"), false);
});

test("taskpane close button uses the host bridge and CSS stays inside its webview", async () => {
  const html = await readFile(new URL("../apps/classified-offline/ui/taskpane-development.html", import.meta.url), "utf8");
  const productionHtml = await readFile(new URL("../apps/classified-offline/ui/taskpane.html", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../apps/classified-offline/src/taskpane-workflow.ts", import.meta.url), "utf8");
  assert.match(html, /id="close-taskpane"/); assert.match(html, /aria-label="关闭任务窗格"/); assert.match(workflow, /GetTaskPane\(Number\(saved\)\)/); assert.match(workflow, /pane\.Visible = false/);
  assert.match(html, /import\("\/dist\/taskpane-workflow\.js\?v="/);
  assert.match(productionHtml, /import\("\.\.\/taskpane-workflow\.js\?v="/);
  assert.match(html, /DocxtoolTaskpaneBuild/); assert.match(productionHtml, /DocxtoolTaskpaneBuild/);
  assert.equal(/position\s*:\s*fixed|z-index|pointer-capture|focus-trap/i.test(html), false);
});

test("Ribbon callbacks directly invoke the single local application runtime", async () => {
  const source = await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8"); const calls = [];
  const context = { Promise, JSON, Date, Number, String, Object, decodeURI, document: { location: { toString() { return "http://127.0.0.1:3891/main.js"; } } }, window: { DocxtoolRunLocalCommand(name, source) { calls.push([name, source]); return Promise.resolve({ status: "PASS", command_id: "cmd", command_name: name }); }, Application: { PluginStorage: { getItem() { return null; }, setItem() {} } } } };
  vm.runInNewContext(source, context); for (const id of ["preview", "apply", "health", "panel"]) context.OnAction({ Id: id });
  assert.deepEqual(calls, [["preview_document", "ribbon"], ["format_document", "ribbon"], ["health_check", "ribbon"], ["toggle_taskpane", "ribbon"]]);
});

test("classified Ribbon exposes the local-direct buttons in the required order", async () => {
  const xml = await readFile(new URL("../apps/classified-offline/ribbon.xml", import.meta.url), "utf8");
  const buttons = [...xml.matchAll(/<button\s+id="([^"]+)"\s+label="([^"]+)"\s+onAction="([^"]+)"/g)].map((match) => match.slice(1));
  assert.deepEqual(buttons, [["preview", "预览排版", "OnAction"], ["apply", "一键排版", "OnAction"], ["panel", "状态面板", "OnAction"], ["health", "本机检测", "OnAction"]]);
  for (const removed of ["仅识别", "打开任务窗格", "关闭任务窗格", "关于", "功能检测"]) assert.equal(xml.includes(removed), false);
});

test("canonical ribbon directly runs preview locally without dispatch or queue", async () => {
  const source = await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8");
  assert.equal(source.includes("dispatchEvent"), false);
  assert.equal(source.includes("CustomEvent"), false);
  assert.equal(source.includes("DocxtoolRunLocalCommand"), true);
  assert.equal(source.includes("DocxtoolHostEnqueue"), false);
  const calls = [];
  const context = { Promise, JSON, Date, String, decodeURI, document: { location: { toString() { return "http://127.0.0.1:3889/main.html"; } } }, window: { Application: { PluginStorage: { getItem() { return null; }, setItem() {} } }, DocxtoolRunLocalCommand(name, sourceName) { calls.push([name, sourceName]); return Promise.resolve({ status: "PASS", command_id: "cmd", command_name: name }); } } };
  vm.runInNewContext(source, context);
  assert.equal(context.OnAction({ Id: "preview" }), true);
  assert.deepEqual(calls, [["preview_document", "ribbon"]]);
});

test("production preview starts only the Worker while legacy preview remains unreachable", async () => {
  const host = await readFile(new URL("../apps/classified-offline/src/host-runtime.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../apps/classified-offline/src/pipeline-worker-client.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../apps/classified-offline/src/pipeline-worker.ts", import.meta.url), "utf8");
  const previewBlock = host.slice(host.indexOf("private async preview("), host.indexOf("/** @deprecated Retained only for legacy equivalence tests"));
  const legacyPreviewBlock = host.slice(host.indexOf("private async legacyPreview("), host.indexOf("private async clearPreview("));
  const formatBlock = host.slice(host.indexOf("private async format("), host.indexOf("private async health("));
  const shadowBlock = host.slice(host.indexOf("hostWindow.DocxtoolRunSnapshotShadow ="), host.indexOf("hostWindow.DocxtoolCancelSnapshotShadow ="));

  assert.match(previewBlock, /this\.pipelineStart\?\.\("preview"\)/);
  assert.equal(previewBlock.includes("previewUseCase.execute"), false);
  assert.equal(previewBlock.includes("readSnapshot"), false);
  assert.match(legacyPreviewBlock, /this\.composition\(\)\.previewUseCase\.execute/);
  assert.match(formatBlock, /this\.composition\(\)\.formatUseCase\.execute/);
  assert.match(shadowBlock, /startPipeline\("snapshot_shadow"\)/);
  for (const forbidden of ["PreviewDocumentUseCase", "FormatDocumentUseCase", "readSnapshot"]) {
    assert.equal(client.includes(forbidden), false);
  }
  for (const forbidden of ["window", "Application", "ActiveDocument", "Paragraphs", "Range", "Comments"]) {
    assert.equal(worker.includes(forbidden), false);
  }
});

test("canonical ribbon reports taskpane creation failure instead of swallowing it", async () => {
  const source = await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8");
  const storage = new Map();
  const context = { Promise, JSON, Date, String, decodeURI, document: { location: { toString() { return "http://127.0.0.1:3889/main.html"; } } }, window: { DocxtoolBuildInfo: { build_id: "build", asset_hash: "hash" }, Application: { PluginStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); } }, CreateTaskPane() { return null; } } } };
  vm.runInNewContext(source, context);
  assert.equal(context.OnAction({ Id: "preview" }), true);
  const state = JSON.parse(storage.get("docxtool_classified_host_result_v1"));
  assert.equal(state.latest_error, "LOCAL_APPLICATION_RUNTIME_NOT_READY");
  assert.match(state.formatting_progress, /本地应用运行时尚未就绪/);
});

test("taskpane exposes immediate pending feedback until host consumes request", async () => {
  const source = await readFile(new URL("../apps/classified-offline/src/taskpane-workflow.ts", import.meta.url), "utf8");
  assert.match(source, /pendingRequestId/);
  assert.match(source, /命令已发送，等待 WPS 主上下文处理/);
  assert.match(source, /REQUEST_KEY/);
  assert.equal(source.includes("window.dispatchEvent"), false);
  assert.equal(source.includes("CustomEvent"), false);
});

test("classified diagnostics cover bootstrap, Ribbon, Host, taskpane and preview stages", async () => {
  const files = {
    main: await readFile(new URL("../apps/classified-offline/main.js", import.meta.url), "utf8"),
    probe: await readFile(new URL("../apps/classified-offline/js/bootstrap-probe.js", import.meta.url), "utf8"),
    ribbon: await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8"),
    host: await readFile(new URL("../apps/classified-offline/src/host-runtime.ts", import.meta.url), "utf8"),
    taskpane: await readFile(new URL("../apps/classified-offline/src/taskpane-workflow.ts", import.meta.url), "utf8"),
    recognition: await readFile(new URL("../packages/recognition-client/src/index.ts", import.meta.url), "utf8"),
    commands: await readFile(new URL("../packages/command-service-client/src/index.ts", import.meta.url), "utf8"),
    comments: await readFile(new URL("../packages/wps-adapter/src/preview-comments.ts", import.meta.url), "utf8"),
  };
  assert.match(files.main, /bootstrap\.main\.loaded/);
  for (const event of ["bootstrap.probe.loaded", "window.error", "window.unhandledrejection"]) assert.match(files.probe, new RegExp(event.replaceAll(".", "\\.")));
  assert.match(files.probe, /__docxtool_log/);
  assert.equal(files.probe.includes("setInterval"), false);
  for (const event of ["ribbon.action.received", "ribbon.command.started", "ribbon.command.completed", "ribbon.command.failed"]) assert.match(files.ribbon, new RegExp(event.replaceAll(".", "\\.")));
  for (const event of ["host.module.loaded", "application.install.attempt", "application.install.success", "application.runtime.run.received", "application.runtime.run.failed", "preview.use_case.start", "preview.comment.readback"]) assert.match(files.host, new RegExp(event.replaceAll(".", "\\.")));
  for (const event of ["taskpane.module.loaded", "taskpane.button.clicked", "taskpane.request.persisted", "taskpane.pending.timeout"]) assert.match(files.taskpane, new RegExp(event.replaceAll(".", "\\.")));
  assert.match(files.recognition, /(recognition\.request\.(start|response|failed)|recognition\.local_process\.start)/);
  assert.match(files.commands, /command_service\.request\.(start|response|failed)|local-format-engine/);
  for (const event of ["preview.comment.write.start", "preview.comment.write.failed", "preview.comment.readback.success"]) assert.match(files.comments, new RegExp(event.replaceAll(".", "\\.")));
});

test("hidden automatic workflow names all formal actions without direct WPS formatting writes", async () => {
  const source = await readFile(new URL("../apps/classified-offline/src/formal-e2e-driver.ts", import.meta.url), "utf8");
  for (const command of ["health_check", "preview_document", "format_document"]) assert.match(source, new RegExp(command));
  assert.match(source, /docxtool_classified_host_request_v1/);
});

test("classified build has no environment-selected duplicate entry", async () => {
  const config = await readFile(new URL("../apps/classified-offline/vite.config.js", import.meta.url), "utf8");
  assert.equal(config.includes("DOCXTOOL_DEVELOPMENT_E2E"), false);
  assert.equal(config.includes("main.production.js"), false);
  assert.equal(config.includes("ribbon-production.js"), false);
});

test("local recognition runtime build collects the installed docxtool resources", async () => {
  const script = await readFile(new URL("../scripts/build-local-recognition-runtime.ps1", import.meta.url), "utf8");
  const config = await readFile(new URL("../apps/classified-offline/ui/local-runtime-config.js", import.meta.url), "utf8");
  assert.match(script, /--collect-data\s+"docxtool"/);
  assert.match(config, /threadedPreviewEnabled:\s*false/);
});

test("canonical entry loads the runtime config, probe, ribbon and classic host emitted by the build", async () => {
  const config = await readFile(new URL("../apps/classified-offline/vite.config.js", import.meta.url), "utf8");
  const main = await readFile(new URL("../apps/classified-offline/main.js", import.meta.url), "utf8");
  const host = await readFile(new URL("../apps/classified-offline/dist/host-runtime.js", import.meta.url), "utf8");
  assert.match(main, /versioned\("js\/ribbon\.js"\)/);
  assert.match(main, /versioned\("ui\/local-runtime-config\.js"\)/);
  assert.match(main, /js\/bootstrap-probe\.js/);
  assert.match(config, /copyFile\(\{src:"ui\/local-runtime-config\.js",dest:"ui\/local-runtime-config\.js"\}\)/);
  assert.equal(main.includes("type='module'"), false);
  assert.match(main, /versioned\("host-runtime\.js"\)/);
  assert.equal(/^\s*import\s/m.test(host), false);
  assert.equal(/import\s*\(/.test(host), false);
  assert.match(host, /host\.module\.loaded/);
});

test("classified Ribbon preserves a safe error when the host queue is stale", async () => {
  const source = await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8");
  const storage = new Map([["docxtool_classified_taskpane", "stale-pane"]]);
  const context = { decodeURI, document: { location: { toString() { return "http://127.0.0.1:3889/main.js"; } } }, window: { Application: {
    PluginStorage: { getItem(key) { return storage.get(key); }, setItem(key, value) { storage.set(key, value); } },
    GetTaskPane() { throw new Error("disposed"); },
  } } };
  vm.runInNewContext(source, context);
  assert.equal(context.OnAction({ Id: "unknown" }), true);
  assert.equal(storage.get("docxtool_classified_host_result_v1") !== undefined, true);
});

test("one-click formatting removes the tracked preview then re-recognizes the current document", async () => {
  const events = [];
  const baseline = { ...snapshot, paragraphOrderHash: "order", formattingRevision: "format", sectionCount: 1, documentFullNameHash: "path-hash" };
  const trackerValue = { preview_session_id: "preview", document_id: baseline.documentId, document_full_name_hash: "path-hash", baseline_revision: baseline.revision, baseline_text_hash: baseline.sourceSha256, baseline_paragraph_count: 1, baseline_paragraph_order_hash: "order", baseline_formatting_revision: "format", baseline_section_count: 1, baseline_saved_state: false, user_comment_fingerprint: "user", created_comment_markers: [], paragraph_anchors: [], created_at: "now" };
  let tracker = trackerValue; let recognitionCalls = 0;
  const recognition = { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "3", document_id: "doc-1", document_revision: "rev-1", source_sha256: SHA, document_mode: "normal", document_mode_confidence: 1, paragraphs: [{ target_id: "doc-1:p:0:0", source_paragraph_index: 0, physical_paragraph_index: 0, recognized_type: "body", section_kind: "body", text_sha256: SHA, physical_text_sha256: SHA, range_start_utf16: 0, range_end_utf16: 4, locator_verified: true, mixed_structure: false, formatting_disposition: "apply", text_length: 4, occurrence_index: 0, confidence: 1, review_level: "confirmed", needs_review: false, ...hostFields("xxxx") }] };
  const commands = commandSet([{ command_id: "cmd-000001", kind: "paragraph.set_alignment", target: commandTarget(), arguments: { alignment: "justify" }, required_capability: "paragraph.alignment", on_unsupported: "fail" }]);
  const useCase = new FormatDocumentUseCase(
    { async readSnapshot() { events.push("snapshot"); return baseline; } },
    { async recognize() { recognitionCalls += 1; events.push("recognize"); return recognition; } },
    { async requestCommands() { return commands; } }, new CommandValidator(),
    { async execute(_set, transactionId, revision) { events.push("execute"); return { schema_version: "1.0", transaction_id: transactionId, executed_command_ids: ["cmd-000001"], skipped_command_ids: [], failed_command_id: null, warnings: [], rolled_back: false, document_revision: revision }; } },
    { begin() { return "tx"; }, commit() { events.push("commit"); }, rollback() { events.push("rollback"); } },
    { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.alignment"] }; } }, { authorizationScope() { return "classified-offline"; } }, undefined,
    { async removePreviewComments() { events.push("remove_preview"); }, async verifyPreviewComments() { return { comment_count: 0, user_comment_integrity: true }; } },
    { current() { return tracker; }, clear() { tracker = null; } },
  );
  const result = await useCase.execute("request-00000001");
  assert.equal(result.failed_command_id, null); assert.equal(recognitionCalls, 1); assert.equal(tracker, null);
  assert.ok(events.indexOf("remove_preview") < events.indexOf("recognize")); assert.ok(events.indexOf("recognize") < events.indexOf("execute"));
});

test("repeated preview removes the previous session before adding a fresh preview", async () => {
  const baseline = { ...snapshot, paragraphOrderHash: "order", formattingRevision: "format", sectionCount: 1, documentFullNameHash: "path-hash" };
  const oldTracker = { preview_session_id: "old", document_id: baseline.documentId, document_full_name_hash: "path-hash", baseline_revision: baseline.revision, baseline_text_hash: baseline.sourceSha256, baseline_paragraph_count: 1, baseline_paragraph_order_hash: "order", baseline_formatting_revision: "format", baseline_section_count: 1, baseline_saved_state: false, user_comment_fingerprint: "", created_comment_markers: [], paragraph_anchors: [], created_at: "now" };
  const newTracker = { ...oldTracker, preview_session_id: "new" }; let current = oldTracker; const events = [];
  const recognition = { schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: "3", document_id: "doc-1", document_revision: "rev-1", source_sha256: SHA, document_mode: "normal", document_mode_confidence: 1, paragraphs: [{ target_id: "doc-1:p:0:0", source_paragraph_index: 0, physical_paragraph_index: 0, recognized_type: "body", section_kind: "body", text_sha256: SHA, physical_text_sha256: SHA, range_start_utf16: 0, range_end_utf16: 4, locator_verified: true, mixed_structure: false, formatting_disposition: "apply", text_length: 4, occurrence_index: 0, confidence: 1, review_level: "confirmed", needs_review: false, ...hostFields("xxxx") }] };
  const commands = commandSet([{ command_id: "cmd-000001", kind: "paragraph.set_alignment", target: commandTarget(), arguments: { alignment: "justify" }, required_capability: "paragraph.alignment", on_unsupported: "fail" }]);
  const preview = new PreviewDocumentUseCase({ async readSnapshot() { events.push("snapshot"); return baseline; } }, { async recognize() { events.push("recognize"); return recognition; } }, { async requestCommands() { return commands; } }, new CommandValidator(), { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.alignment"] }; } }, { authorizationScope() { return "classified-offline"; } }, undefined, { async removePreviewComments() { events.push("remove"); }, async addPreviewComments() { events.push("add"); return { tracker: newTracker, comment_count: 1, unsupported: false, warnings: [] }; }, async verifyPreviewComments() { return { comment_count: 0, user_comment_integrity: true }; } }, { current() { return current; }, set(value) { current = value; }, clear() { current = null; } });
  const result = await preview.execute("request-00000001");
  assert.equal(result.summary.preview_comment_count, 1); assert.equal(current.preview_session_id, "new"); assert.ok(events.indexOf("remove") < events.indexOf("recognize")); assert.ok(events.indexOf("recognize") < events.indexOf("add"));
});

test("preview document identity mismatch refuses cleanup and formatting", async () => {
  const baseline = { ...snapshot, paragraphOrderHash: "order", formattingRevision: "format", sectionCount: 1, documentFullNameHash: "new-document" };
  const trackerValue = { preview_session_id: "preview", document_id: baseline.documentId, document_full_name_hash: "old-document", baseline_revision: baseline.revision, baseline_text_hash: baseline.sourceSha256, baseline_paragraph_count: 1, baseline_paragraph_order_hash: "order", baseline_formatting_revision: "format", baseline_section_count: 1, baseline_saved_state: false, user_comment_fingerprint: "", created_comment_markers: [], paragraph_anchors: [], created_at: "now" };
  let removed = false;
  const useCase = new FormatDocumentUseCase({ async readSnapshot() { return baseline; } }, { async recognize() { throw new Error("unexpected"); } }, { async requestCommands() { throw new Error("unexpected"); } }, new CommandValidator(), { async execute() { throw new Error("unexpected"); } }, new MockTransactionManager(), { capabilities() { return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: [] }; } }, { authorizationScope() { return "classified-offline"; } }, undefined, { async removePreviewComments() { removed = true; }, async verifyPreviewComments() { return { comment_count: 0, user_comment_integrity: true }; } }, { current() { return trackerValue; }, clear() {} });
  await assert.rejects(() => useCase.execute("request-00000001"), /DOCUMENT_CHANGED/); assert.equal(removed, false);
});

test("classified health check is read-only and returns concrete PASS items", async () => {
  const runtimeRoot = await createTempRoot("docxtool-runtime-health-");
  const manifestPath = path.join(runtimeRoot, "current.json");
  await writeFile(manifestPath, JSON.stringify({ schema_version: 1, contract_version: 1, executable_path: "C:\\runtime\\docxtool-recognize.exe", executable_sha256: "a", recognition_package_version: "4.0" }), "utf8");
  const font = { Name: "仿宋_GB2312" }; const format = { Alignment: 0 }; const page = { PageWidth: 1 };
  const comments = { Count: 0, Item() { throw new Error("none"); }, Add() {} };
  const application = { ActiveDocument: { FullName: "C:\\fixture.docx", Saved: true, Paragraphs: { Count: 1, Item() { return { Range: { Text: "脱敏测试\r", Font: font, ParagraphFormat: format, PageSetup: page } }; } }, Comments: comments }, CreateTaskPane() {}, ApiEvent: {}, FontNames: { Count: 2, Item(index) { return { Name: index === 1 ? "仿宋_GB2312" : "Times New Roman" }; } }, FileSystem: { Exists(value) { return value === "C:\\runtime\\docxtool-recognize.exe" || value === manifestPath || existsSync(value); }, ReadFileString(value) { return readFileSync(value, "utf8"); }, WriteFileString() {}, unlinkSync() {}, Remove() {}, mkdirSync() {}, rmdirSync() {} }, OAAssist: { ShellExecute() {} } };
  const before = JSON.stringify({ saved: application.ActiveDocument.Saved, comments: comments.Count, font, format, page });
  const profile = { page_setup: { normal_east_asia_font_name: "仿宋_GB2312", normal_latin_font_name: "Times New Roman" }, styles: {} };
  const report = await new ClassifiedHealthChecker(application, { recognitionExecutablePath: "C:\\runtime\\docxtool-recognize.exe", runtimeVersion: "1", runtimeSha256: "a", runtimeManifestPath: manifestPath }, { build_id: "build", asset_hash: "hash" }, { build_id: "build", asset_hash: "hash" }, profile, true).run();
  assert.equal(report.overall, "PASS"); assert.equal(report.items.every((item) => item.status === "PASS"), true); assert.match(report.text, /总体结果：PASS/);
  assert.equal(JSON.stringify({ saved: application.ActiveDocument.Saved, comments: comments.Count, font, format, page }), before);
  await rm(runtimeRoot, { recursive: true, force: true });
});

test("classified health check reports missing fonts as WARN and unreachable services with stable codes", async () => {
  const runtimeRoot = await createTempRoot("docxtool-runtime-health-");
  const manifestPath = path.join(runtimeRoot, "current.json");
  await writeFile(manifestPath, JSON.stringify({ schema_version: 1, contract_version: 1, executable_path: "C:\\runtime\\docxtool-recognize.exe", executable_sha256: "a", recognition_package_version: "4.0" }), "utf8");
  const range = { Text: "fixture\r", Font: {}, ParagraphFormat: {}, PageSetup: {} }; const comments = { Count: 0, Item() {}, Add() {} };
  const application = { ActiveDocument: { FullName: "C:\\fixture.docx", Saved: true, Paragraphs: { Count: 1, Item() { return { Range: range }; } }, Comments: comments }, CreateTaskPane() {}, ApiEvent: {}, FontNames: { Count: 0, Item() {} }, FileSystem: { Exists(value) { return value === "C:\\runtime\\docxtool-recognize.exe" || value === manifestPath || existsSync(value); }, ReadFileString(value) { return readFileSync(value, "utf8"); }, WriteFileString() {}, unlinkSync() {}, Remove() {}, mkdirSync() {}, rmdirSync() {} }, OAAssist: { ShellExecute() {} } };
  const base = [{ build_id: "build", asset_hash: "hash" }, { build_id: "build", asset_hash: "hash" }, { page_setup: { normal_east_asia_font_name: "方正小标宋简体" }, styles: {} }];
  const warn = await new ClassifiedHealthChecker(application, { recognitionExecutablePath: "C:\\runtime\\docxtool-recognize.exe", runtimeVersion: "1", runtimeSha256: "a", runtimeManifestPath: manifestPath }, ...base, true).run();
  assert.equal(warn.overall, "WARN"); assert.deepEqual(warn.missing_fonts, ["方正小标宋简体"]); assert.equal(warn.first_error_code, "REQUIRED_FONT_MISSING");
  const failed = await new ClassifiedHealthChecker({ ActiveDocument: application.ActiveDocument, CreateTaskPane() {}, ApiEvent: {}, FontNames: { Count: 0, Item() {} }, FileSystem: undefined }, { recognitionExecutablePath: "", runtimeVersion: "1", runtimeSha256: "a" }, ...base, true).run();
  assert.equal(failed.overall, "FAIL");
  assert.equal(failed.items.find((item) => item.check_id === "filesystem_api").error_code, "WPS_FILESYSTEM_UNAVAILABLE");
  assert.equal(failed.items.find((item) => item.check_id === "local_runtime").error_code, "LOCAL_RUNTIME_CONFIGURATION_REQUIRED");
  assert.equal(failed.items.find((item) => item.check_id === "local_process_api").error_code, "LOCAL_PROCESS_EXECUTION_BLOCKED");
  await rm(runtimeRoot, { recursive: true, force: true });
});

test("classified UI error messages localize stable WPS error codes", () => {
  assert.match(errorMessage("DOCUMENT_MUST_BE_SAVED"), /当前文档尚未保存/);
  assert.match(errorText("DOCUMENT_MUST_BE_SAVED"), /请先在 WPS 中保存为本地 \.docx 文件/);
  assert.match(errorText("DOCUMENT_MUST_BE_SAVED"), /错误码：DOCUMENT_MUST_BE_SAVED/);
});

test("diagnostic runner blocks dependent checks and identifies the first root cause", async () => {
  const runner = new DiagnosticRunner([
    { check_id: "agent", group: "service", title: "agent", dependencies: [], retryable: true },
    { check_id: "recognition", group: "pipeline", title: "recognition", dependencies: ["agent"], retryable: true },
  ]);
  const report = await runner.run({ agent: async () => ({ status: "FAIL", error_code: "LOCAL_AGENT_UNREACHABLE", summary: "offline" }) });
  assert.equal(report.first_root_cause, "agent");
  assert.equal(report.results[1].status, "NOT_RUN");
  assert.equal(report.results[1].error_code, "DEPENDENCY_FAILED");
  assert.equal(classifyNetworkError(new TypeError("Failed to fetch"), "preflight"), "PREFLIGHT_FAILED");
});
