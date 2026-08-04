import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { LocalWheelRecognitionProvider } from "../dist/packages/recognition-client/src/index.js";
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
} from "../dist/packages/wps-adapter/src/index.js";
import { CommandValidator } from "../dist/packages/security/src/index.js";
import { FormatDocumentUseCase, PreviewDocumentUseCase } from "../dist/packages/application/src/format-document-usecase.js";
import { HostCommandRouter, HostResultStore, TaskPaneManager } from "../dist/apps/classified-offline/src/host-runtime.js";
import { ClassifiedHealthChecker } from "../dist/apps/classified-offline/src/health-check.js";
import { errorMessage, errorText } from "../dist/apps/classified-offline/src/error-messages.js";
import { DiagnosticRunner, classifyNetworkError } from "../dist/packages/diagnostics/src/index.js";

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
  assert.match(main, /dist\/host-runtime\.js/); assert.equal(main.includes("type='module'"), false);
  assert.equal(taskpane.includes("createClassifiedProductionComposition"), false);
  assert.equal(taskpane.includes("FormatDocumentUseCase"), false);
  assert.match(hostRuntime, /setInterval\(tryInstall,\s*250\)/);
  assert.match(hostRuntime, /host_router_installed/);
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

test("HostCommandRouter toggles a pane without a taskpane window and rejects unknown commands", async () => {
  const mocks = hostMocks(); const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" };
  const store = new HostResultStore(mocks.storage, build, "host-a"); const panes = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane");
  const router = new HostCommandRouter(mocks.application, panes, store, { recognitionEndpoint: "http://127.0.0.1:9528", commandEndpoint: "http://127.0.0.1:9529", sessionToken: "x" });
  assert.equal((await router.dispatch("toggle_taskpane")).status, "PASS"); assert.equal(panes.get().Visible, true);
  assert.equal((await router.dispatch("toggle_taskpane")).status, "PASS"); assert.equal(panes.get().Visible, false);
  await assert.rejects(() => router.dispatch("not_registered"), /UNKNOWN_HOST_COMMAND/);
});

test("HostCommandRouter isolates stored results after an active-document switch", async () => {
  const mocks = hostMocks(); mocks.application.ActiveDocument = { FullName: "C:\\one.docx", Paragraphs: { Count: 2 } };
  const build = { build_id: "build-a", plugin_version: "1", asset_hash: "a", build_timestamp: "now" }; const store = new HostResultStore(mocks.storage, build, "host-a"); const panes = new TaskPaneManager(mocks.application, mocks.storage, "http://127.0.0.1/taskpane"); const router = new HostCommandRouter(mocks.application, panes, store, { recognitionEndpoint: "http://127.0.0.1:9528", commandEndpoint: "http://127.0.0.1:9529", sessionToken: "x" });
  store.update({ document_identity_hash: "previous-document", recognition_summary: "旧文档结果", paragraph_recognition_models: [{ paragraph_index: 0, recognized_type: "body", confidence: 1, needs_review: false }], unresolved_block_count: 2, mixed_paragraph_count: 3 });
  await router.reconcileActiveDocument(); assert.equal(store.read().recognition_summary, ""); assert.deepEqual(store.read().paragraph_recognition_models, []);
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
  const workflow = await readFile(new URL("../apps/classified-offline/src/taskpane-workflow.ts", import.meta.url), "utf8");
  assert.match(html, /id="close-taskpane"/); assert.match(html, /aria-label="关闭任务窗格"/); assert.match(workflow, /GetTaskPane\(Number\(saved\)\)/); assert.match(workflow, /pane\.Visible = false/);
  assert.equal(/position\s*:\s*fixed|z-index|pointer-capture|focus-trap/i.test(html), false);
});

test("Ribbon callbacks use the fixed HostCommandRouter registry", async () => {
  const source = await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8"); const calls = [];
  const pane = { Visible: true }; const context = { Promise, JSON, Date, Number, String, Object, decodeURI, document: { location: { toString() { return "http://127.0.0.1:3891/main.js"; } } }, window: { DocxtoolHostDispatch(name, source) { calls.push([name, source]); return Promise.resolve(); }, Application: { GetTaskPane() { return pane; }, PluginStorage: { getItem(key) { return key === "docxtool_classified_taskpane" ? "1" : null; }, setItem() {} } } } };
  vm.runInNewContext(source, context); for (const id of ["preview", "apply", "health"]) context.OnAction({ Id: id });
  assert.deepEqual(calls, [["preview_document", "ribbon"], ["format_document", "ribbon"], ["health_check", "ribbon"]]); assert.equal(pane.Visible, true);
});

test("classified Ribbon exposes exactly preview, apply and health in the required order", async () => {
  const xml = await readFile(new URL("../apps/classified-offline/ribbon.xml", import.meta.url), "utf8");
  const buttons = [...xml.matchAll(/<button\s+id="([^"]+)"\s+label="([^"]+)"\s+onAction="([^"]+)"/g)].map((match) => match.slice(1));
  assert.deepEqual(buttons, [["preview", "预览排版", "OnAction"], ["apply", "一键排版", "OnAction"], ["health", "功能检测", "OnAction"]]);
  for (const removed of ["仅识别", "打开任务窗格", "关闭任务窗格", "关于"]) assert.equal(xml.includes(removed), false);
});

test("hidden automatic workflow sends all formal actions through HostCommandRouter bridge", async () => {
  const source = await readFile(new URL("../apps/classified-offline/src/formal-e2e-driver.ts", import.meta.url), "utf8");
  for (const command of ["health_check", "preview_document", "format_document"]) assert.match(source, new RegExp(command));
  assert.match(source, /docxtool_classified_host_request_v1/);
});

test("production classified build excludes development E2E taskpane assets", async () => {
  const config = await readFile(new URL("../apps/classified-offline/vite.config.js", import.meta.url), "utf8");
  assert.match(config, /DOCXTOOL_DEVELOPMENT_E2E/);
  const productionMain = await readFile(new URL("../apps/classified-offline/main.production.js", import.meta.url), "utf8");
  assert.equal(productionMain.includes("development"), false);
});

test("classified Ribbon preserves a safe error and opens the result pane when the host router is stale", async () => {
  const source = await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8");
  let created = 0;
  const storage = new Map([["docxtool_classified_taskpane", "stale-pane"]]);
  const context = { decodeURI, document: { location: { toString() { return "http://127.0.0.1:3889/main.js"; } } }, window: { Application: {
    PluginStorage: { getItem(key) { return storage.get(key); }, setItem(key, value) { storage.set(key, value); } },
    GetTaskPane() { throw new Error("disposed"); },
    CreateTaskPane() { created += 1; return { ID: "fresh-pane", Visible: false }; },
  } } };
  vm.runInNewContext(source, context);
  assert.equal(context.OnAction({ Id: "unknown" }), true);
  assert.equal(created, 1);
  assert.equal(storage.get("docxtool_classified_taskpane"), "fresh-pane");
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
  const font = { Name: "仿宋_GB2312" }; const format = { Alignment: 0 }; const page = { PageWidth: 1 };
  const comments = { Count: 0, Item() { throw new Error("none"); }, Add() {} };
  const application = { ActiveDocument: { FullName: "C:\\fixture.docx", Saved: true, Paragraphs: { Count: 1, Item() { return { Range: { Text: "脱敏测试\r", Font: font, ParagraphFormat: format, PageSetup: page } }; } }, Comments: comments }, CreateTaskPane() {}, ApiEvent: {}, FontNames: { Count: 2, Item(index) { return { Name: index === 1 ? "仿宋_GB2312" : "Times New Roman" }; } } };
  const before = JSON.stringify({ saved: application.ActiveDocument.Saved, comments: comments.Count, font, format, page });
  const fetcher = async (input) => new Response(JSON.stringify(String(input).endsWith("/v1/version") ? { recognition_sdk: "docxtool.sdk.recognize_docx", package_version: "1.7", locator_version: "source-locator-v2", host_text_contract_version: "host-text-v1" } : { ok: true, package_version: "1.7", locator_version: "source-locator-v2", host_text_contract_version: "host-text-v1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  const profile = { page_setup: { normal_east_asia_font_name: "仿宋_GB2312", normal_latin_font_name: "Times New Roman" }, styles: {} };
  const report = await new ClassifiedHealthChecker(application, { recognitionEndpoint: "http://127.0.0.1:9528", commandEndpoint: "http://127.0.0.1:9529", sessionToken: "token" }, { build_id: "build", asset_hash: "hash" }, { build_id: "build", asset_hash: "hash" }, profile, true, fetcher).run();
  assert.equal(report.overall, "PASS"); assert.equal(report.items.every((item) => item.status === "PASS"), true); assert.match(report.text, /总体结果：PASS/);
  assert.equal(JSON.stringify({ saved: application.ActiveDocument.Saved, comments: comments.Count, font, format, page }), before);
});

test("classified health check reports missing fonts as WARN and unreachable services with stable codes", async () => {
  const range = { Text: "fixture\r", Font: {}, ParagraphFormat: {}, PageSetup: {} }; const comments = { Count: 0, Item() {}, Add() {} };
  const application = { ActiveDocument: { FullName: "C:\\fixture.docx", Saved: true, Paragraphs: { Count: 1, Item() { return { Range: range }; } }, Comments: comments }, CreateTaskPane() {}, ApiEvent: {}, FontNames: { Count: 0, Item() {} } };
  const base = [{ build_id: "build", asset_hash: "hash" }, { build_id: "build", asset_hash: "hash" }, { page_setup: { normal_east_asia_font_name: "方正小标宋简体" }, styles: {} }];
  const warnFetcher = async (input) => new Response(JSON.stringify(String(input).endsWith("/v1/version") ? { recognition_sdk: "docxtool.sdk.recognize_docx", package_version: "1.7", locator_version: "source-locator-v2", host_text_contract_version: "host-text-v1" } : { ok: true, package_version: "1.7", locator_version: "source-locator-v2", host_text_contract_version: "host-text-v1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  const warn = await new ClassifiedHealthChecker(application, { recognitionEndpoint: "http://127.0.0.1:9528", commandEndpoint: "http://127.0.0.1:9529", sessionToken: "token" }, ...base, true, warnFetcher).run();
  assert.equal(warn.overall, "WARN"); assert.deepEqual(warn.missing_fonts, ["方正小标宋简体"]); assert.equal(warn.first_error_code, "REQUIRED_FONT_MISSING");
  const failed = await new ClassifiedHealthChecker(application, { recognitionEndpoint: "http://127.0.0.1:9528", commandEndpoint: "http://127.0.0.1:9529", sessionToken: "token" }, ...base, true, async () => { throw new TypeError("offline"); }).run();
  assert.equal(failed.overall, "FAIL"); assert.equal(failed.items.find((item) => item.check_id === "recognition_service").error_code, "LOCAL_AGENT_UNAVAILABLE"); assert.equal(failed.items.find((item) => item.check_id === "command_service").error_code, "COMMAND_SERVICE_UNAVAILABLE");
  assert.match(failed.text, /本地识别服务不可达/);
  assert.match(failed.text, /错误码：LOCAL_AGENT_UNAVAILABLE/);
});

test("classified UI error messages localize stable WPS error codes", () => {
  assert.match(errorMessage("DOCUMENT_MUST_BE_SAVED"), /当前文档尚未保存/);
  assert.match(errorText("DOCUMENT_MUST_BE_SAVED"), /请先在 WPS 中保存为本地 DOCX 文件/);
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
