import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  PROTOCOL_VERSION,
  assertCommandRequest,
} from "../dist/packages/contracts/src/index.js";
import { LocalWheelRecognitionProvider } from "../dist/packages/recognition-client/src/index.js";
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
} from "../dist/packages/wps-adapter/src/index.js";
import { CommandValidator } from "../dist/packages/security/src/index.js";
import { FormatDocumentUseCase } from "../dist/packages/application/src/format-document-usecase.js";
import { DiagnosticRunner, classifyNetworkError } from "../dist/packages/diagnostics/src/index.js";

const SHA = "a".repeat(64);
const snapshot = {
  documentId: "doc-1",
  revision: "rev-1",
  sourceSha256: SHA,
  paragraphs: [{ sourceParagraphIndex: 0, text: "本地正文" }],
};
const transport = {
  async recognize() {
    return {
      schema_version: "1.0", engine_version: "3.0", document_mode: "normal",
      document_mode_confidence: 1, blocks: [{
        source_paragraph_index: 0, type_id: "body", section: "body", review_level: "confirmed",
      }],
    };
  },
};

test("local wheel adapter preserves the decision but emits only full hash anchors", async () => {
  const result = await new LocalWheelRecognitionProvider(transport).recognize(snapshot);
  assert.equal(result.paragraphs[0].recognized_type, "body");
  assert.match(result.paragraphs[0].text_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("本地正文"), false);
});

test("outbound requests reject plaintext, code and local paths", () => {
  const request = {
    schema_version: PROTOCOL_VERSION, request_id: "request-00000001",
    recognition_result: {
      schema_version: PROTOCOL_VERSION, recognition_engine_version: "3.0",
      document_id: "doc-1", document_revision: "rev-1", source_sha256: SHA,
      document_mode: "normal", document_mode_confidence: 1, paragraphs: [],
    },
    profile_id: "default", profile_version: "1.0",
    client_capabilities: { schema_version: PROTOCOL_VERSION, capabilities: [] },
    product_version: "0.1.0", authorization_scope: "classified-offline", text: "secret",
  };
  assert.throws(() => assertCommandRequest(request), /SENSITIVE_FIELD_REJECTED/);
});

test("application flow rolls back the complete mock transaction on command failure", async () => {
  const recognitionProvider = new LocalWheelRecognitionProvider(transport);
  const response = {
    schema_version: PROTOCOL_VERSION, request_id: "request-00000001", service_version: "0.1.0", warnings: [],
    commands: [{
      command_id: "cmd-000001", kind: "paragraph.set_alignment",
      target: { target_id: "doc-1:p:0:0", source_paragraph_index: 0, text_sha256: SHA },
      arguments: { alignment: "justify" }, required_capability: "paragraph.alignment", on_unsupported: "skip",
    }],
  };
  const transactions = new MockTransactionManager();
  const useCase = new FormatDocumentUseCase(
    new MockDocumentReader(snapshot), recognitionProvider,
    { async requestCommands() { return response; } }, new CommandValidator(),
    new MockDocumentExecutor("cmd-000001"), transactions,
    { capabilities() { return { schema_version: PROTOCOL_VERSION, capabilities: ["paragraph.alignment"] }; } },
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
  const paragraph = { Range: { Text: text, Font: { Name: "宋体", NameAscii: "宋体", NameOther: "宋体", NameFarEast: "宋体", Size: 12, Bold: 0, Spacing: 2, Scaling: 90, DisableCharacterSpaceGrid: false }, ParagraphFormat: format, PageSetup: pageSetup } };
  const paragraphs = { Count: 1, Item(index) { assert.equal(index, 1); return paragraph; } };
  globalThis.Application = { ActiveDocument: { FullName: "C:\\redacted.docx", Saved: true, Paragraphs: paragraphs, PageSetup: pageSetup } };
  return { paragraph, format };
}

test("official-host reader and locator use only local snapshot text and hash anchors", async () => {
  fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  assert.equal(snapshot.localDocxPath, "C:\\redacted.docx");
  assert.equal(snapshot.paragraphs[0].text, "测试段落");
  const target = { target_id: "x", source_paragraph_index: 0, text_sha256: (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex") };
  assert.ok(await new WpsTargetLocator().locate(target));
});

test("official-host normalizes WPS section-break control characters", async () => {
  fakeWps("测试段落\r\f");
  const snapshot = await new WpsDocumentReader().readSnapshot();
  assert.equal(snapshot.paragraphs[0].text, "测试段落");
  const target = { target_id: "section", source_paragraph_index: 0, text_sha256: (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex") };
  assert.ok(await new WpsTargetLocator().locate(target));
});

test("official-host executor rejects missing capabilities and compensates a failed transaction", async () => {
  const { paragraph, format } = fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = { target_id: "p", source_paragraph_index: 0, text_sha256: hash };
  const base = { schema_version: "1.0", request_id: "request-00000001", service_version: "test", warnings: [] };
  const command = { command_id: "cmd-000001", kind: "paragraph.set_font", target, arguments: { font_family: "仿宋", font_size_pt: 16, bold: true }, required_capability: "paragraph.font", on_unsupported: "fail" };
  const noCapabilities = { capabilities() { return { schema_version: "1.0", capabilities: [] }; } };
  const disabled = await new WpsApiDocumentExecutor(new WpsTargetLocator(), noCapabilities).execute({ ...base, commands: [command] }, "tx", snapshot.revision);
  assert.equal(disabled.failed_command_id, "cmd-000001");
  const capabilities = { capabilities() { return { schema_version: "1.0", capabilities: ["paragraph.font", "paragraph.alignment"] }; } };
  Object.defineProperty(format, "Alignment", { configurable: true, get() { return 0; }, set() { throw new Error("simulated"); } });
  const second = { command_id: "cmd-000002", kind: "paragraph.set_alignment", target, arguments: { alignment: "center" }, required_capability: "paragraph.alignment", on_unsupported: "fail" };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute({ ...base, commands: [command, second] }, "tx", snapshot.revision);
  assert.equal(result.rolled_back, true);
  assert.equal(paragraph.Range.Font.Name, "宋体");
  assert.equal(paragraph.Range.Font.Size, 12);
});

test("official-host defaults to line_only and never forces a 28-character grid", async () => {
  const { paragraph } = fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = { target_id: "p", source_paragraph_index: 0, text_sha256: hash };
  const command = { command_id: "cmd-000001", kind: "section.set_page_setup", target, arguments: { page_width_cm: 21, page_height_cm: 29.7, margin_top_cm: 3.7, margin_bottom_cm: 3.5, margin_left_cm: 2.8, margin_right_cm: 2.6, lines_per_page: 22, chars_per_line: 28, grid_alignment: "文字对齐字符网络", grid_mode: "line_only" }, required_capability: "section.page_setup", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: "1.0", capabilities: ["section.page_setup"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute({ schema_version: "1.0", request_id: "request-00000001", service_version: "test", warnings: [], commands: [command] }, "tx", snapshot.revision);
  assert.equal(result.rolled_back, false);
  // WPS retains the existing values, but with LayoutMode=0 they are no longer
  // a document character grid.  Setting CharsLine would stretch glyphs.
  assert.equal(paragraph.Range.PageSetup.LinesPage, 22);
  assert.equal(paragraph.Range.PageSetup.CharsLine, 28);
  assert.equal(paragraph.Range.PageSetup.LayoutMode, 0);
  assert.equal(paragraph.Range.PageSetup.ShowGrid, false);
  assert.equal(paragraph.Range.PageSetup.PageWidth, 21 * 28.3464567);
});

test("official-host rejects strict character grids until the complete WPS capability set is proven", async () => {
  fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = { target_id: "p", source_paragraph_index: 0, text_sha256: hash };
  const command = { command_id: "cmd-000001", kind: "section.set_page_setup", target, arguments: { page_width_cm: 21, page_height_cm: 29.7, margin_top_cm: 3.7, margin_bottom_cm: 3.5, margin_left_cm: 2.8, margin_right_cm: 2.6, lines_per_page: 22, chars_per_line: 28, grid_alignment: "文字对齐字符网络", grid_mode: "strict_lines_and_chars" }, required_capability: "section.page_setup", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: "1.0", capabilities: ["section.page_setup"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities, "strict_lines_and_chars").execute({ schema_version: "1.0", request_id: "request-00000001", service_version: "test", warnings: [], commands: [command] }, "tx", snapshot.revision);
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
  const target = { target_id: "p", source_paragraph_index: 0, text_sha256: hash };
  const command = { command_id: "cmd-000001", kind: "paragraph.set_spacing", target, arguments: { space_before_lines: 1, space_after_lines: 0, line_spacing_rule: "exactly", line_spacing_pt: 28, page_break_before: false, outline_level: 3 }, required_capability: "paragraph.spacing", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: "1.0", capabilities: ["paragraph.spacing"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute({ schema_version: "1.0", request_id: "request-00000001", service_version: "test", warnings: [], commands: [command] }, "tx", snapshot.revision);
  assert.equal(result.rolled_back, false);
  assert.equal(paragraph.Range.ParagraphFormat.LineUnitBefore, 1);
  assert.equal(paragraph.Range.ParagraphFormat.LineUnitAfter, 0);
  assert.equal(paragraph.Range.ParagraphFormat.LineSpacing, 28);
  assert.equal(paragraph.Range.ParagraphFormat.OutlineLevel, 3);
  assert.equal(paragraph.Range.ParagraphFormat.SnapToGrid, false);
});

test("formal WPS executor enforces natural glyph metrics for every font command", async () => {
  const { paragraph } = fakeWps();
  const snapshot = await new WpsDocumentReader().readSnapshot();
  const hash = (await import("node:crypto")).createHash("sha256").update("测试段落").digest("hex");
  const target = { target_id: "p", source_paragraph_index: 0, text_sha256: hash };
  const command = { command_id: "cmd-000001", kind: "paragraph.set_font", target, arguments: { east_asia_font_name: "仿宋_GB2312", latin_font_name: "Times New Roman", font_size_pt: 16, bold: false }, required_capability: "paragraph.font", on_unsupported: "fail" };
  const capabilities = { capabilities() { return { schema_version: "1.0", capabilities: ["paragraph.font"] }; } };
  const result = await new WpsApiDocumentExecutor(new WpsTargetLocator(), capabilities).execute({ schema_version: "1.0", request_id: "request-00000001", service_version: "test", warnings: [], commands: [command] }, "tx", snapshot.revision);
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
  assert.match(taskpane, /formal-e2e-driver\.ts/);
  assert.match(driver, /FormatDocumentUseCase/);
  assert.match(driver, /WpsApiDocumentExecutor/);
  for (const forbidden of ["PageSetup", "ParagraphFormat", ".Font", "CharsLine", "LinesPage", "LayoutMode"]) assert.equal(driver.includes(forbidden), false, forbidden);
});

test("production classified build excludes development E2E taskpane assets", async () => {
  const config = await readFile(new URL("../apps/classified-offline/vite.config.js", import.meta.url), "utf8");
  assert.match(config, /DOCXTOOL_DEVELOPMENT_E2E/);
  const productionMain = await readFile(new URL("../apps/classified-offline/main.production.js", import.meta.url), "utf8");
  assert.equal(productionMain.includes("development"), false);
});

test("classified Ribbon replaces a stale taskpane handle instead of becoming unresponsive", async () => {
  const source = await readFile(new URL("../apps/classified-offline/js/ribbon.js", import.meta.url), "utf8");
  let created = 0;
  const storage = new Map([["docxtool_classified_taskpane", "stale-pane"]]);
  const context = { decodeURI, document: { location: { toString() { return "http://127.0.0.1:3889/main.js"; } } }, window: { Application: {
    PluginStorage: { getItem(key) { return storage.get(key); }, setItem(key, value) { storage.set(key, value); } },
    GetTaskPane() { throw new Error("disposed"); },
    CreateTaskPane() { created += 1; return { ID: "fresh-pane", Visible: false }; },
  } } };
  vm.runInNewContext(source, context);
  assert.equal(context.OnAction({ Id: "taskpane" }), true);
  assert.equal(created, 1);
  assert.equal(storage.get("docxtool_classified_taskpane"), "fresh-pane");
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
