import type { FormattingCommandSet, RecognitionResult } from "../../contracts/src/index.js";
import type { PreviewCommentResult, PreviewCommentService, PreviewDisplayMode, PreviewMutationTracker } from "../../application/src/ports.js";
import type { LocalDocumentSnapshot } from "../../recognition-client/src/index.js";
import type { DiagnosticReporter } from "../../diagnostics/src/index.js";
import { rawSliceUtf16, stripWpsImplicitParagraphTerminator } from "./host-text.js";

type WpsObject = Record<string, any>;
const LEGACY_MARKER = "[DOCXTOOL_PREVIEW]";
const PREVIEW_AUTHOR_PREFIX = "DocxTool·";
const SPECIAL = new Set(["main_title", "title_continuation", "heading1", "heading2", "heading3", "heading4", "recipient", "attachment_note", "attachment_title", "signature_org", "signature_date"]);
const ROLE_NAMES: Record<string, string> = { main_title: "主标题", title_continuation: "主标题续行", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", heading4: "四级标题", body: "正文", recipient: "称呼", attachment_note: "附件说明", attachment_title: "附件正文标题", signature_org: "落款署名", signature_date: "落款日期" };
function app(): WpsObject { const value = (globalThis as { Application?: unknown }).Application; if (!value || typeof value !== "object") throw new Error("WPS_API_UNSUPPORTED"); return value as WpsObject; }
function normalize(value: unknown): string { return stripWpsImplicitParagraphTerminator(value); }
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
function collection(document: WpsObject): WpsObject { const comments = document.Comments as WpsObject | undefined; if (!comments || typeof comments.Item !== "function" || typeof comments.Add !== "function") throw new Error("COMMENT_PREVIEW_UNSUPPORTED"); return comments; }
function paragraph(document: WpsObject, index: number): WpsObject { const value = document.Paragraphs?.Item(index + 1) as WpsObject | undefined; if (!value?.Range) throw new Error("TARGET_NOT_FOUND"); return value; }
function content(comment: WpsObject): string {
  return [comment.Content?.Text, comment.Content, comment.Text, comment.Range?.Text].filter((value) => typeof value === "string").join("\n");
}
function markerRecord(paragraphIndex: number, rangeStart: number, rangeEnd: number, value: string): string {
  return JSON.stringify({ paragraph_index: paragraphIndex, range_start_utf16: rangeStart, range_end_utf16: rangeEnd, marker: value });
}
function readMarkerRecord(value: string): { paragraph_index: number; marker: string } | null {
  try {
    const parsed = JSON.parse(value) as { paragraph_index?: unknown; marker?: unknown };
    return Number.isInteger(parsed.paragraph_index) && typeof parsed.marker === "string" ? { paragraph_index: parsed.paragraph_index as number, marker: parsed.marker } : null;
  } catch { return null; }
}
function normalizedComment(value: string): string { return normalize(value).replace(/\s+/g, " ").trim(); }
function commentSignature(value: string): string { return normalizedComment(value).split(" ", 1)[0] ?? ""; }
function fontSizeName(value: number): string {
  const names = new Map<number, string>([[42, "初号"], [36, "小初"], [26, "一号"], [24, "小一"], [22, "二号"], [18, "小二"], [16, "三号"], [15, "小三"], [14, "四号"], [12, "小四"], [10.5, "五号"], [9, "小五"], [7.5, "六号"], [6.5, "小六"], [5.5, "七号"], [5, "八号"]]);
  return names.get(value) ?? `${value} pt`;
}
function previewAuthor(type: string): string { return PREVIEW_AUTHOR_PREFIX + (ROLE_NAMES[type] ?? "需要复核"); }
function previewInitial(type: string): string { return ({ main_title: "主", title_continuation: "续", heading1: "一", heading2: "二", heading3: "三", heading4: "四", body: "文", recipient: "称", attachment_note: "附", attachment_title: "附题", signature_org: "署", signature_date: "日" } as Record<string, string>)[type] ?? "复"; }
function display(item: { recognized_type: string; confidence: number; needs_review: boolean }, commands: FormattingCommandSet["commands"]): string {
  const role = ROLE_NAMES[item.recognized_type] ?? "未知";
  const font = commands.find((command) => command.kind === "paragraph.set_font"); const alignment = commands.find((command) => command.kind === "paragraph.set_alignment"); const indent = commands.find((command) => command.kind === "paragraph.set_indent"); const spacing = commands.find((command) => command.kind === "paragraph.set_spacing");
  const alignmentNames: Record<string, string> = { left: "左对齐", center: "居中", right: "右对齐", justify: "两端对齐", distributed: "分散对齐" };
  const fields = [`识别结果：${role}`];
  if ((item as { mixed_structure?: boolean }).mixed_structure) fields.push("结构状态：同一段落包含多个角色，正式排版前需要拆段");
  if (item.recognized_type === "unknown" || commands.length === 0) fields.push("可应用格式：暂无");
  if (font?.kind === "paragraph.set_font") fields.push(`中文字体：${font.arguments.east_asia_font_name}`, `西文字体：${font.arguments.latin_font_name}`, `字号：${fontSizeName(font.arguments.font_size_pt)}`, `粗体：${font.arguments.bold ? "是" : "否"}`);
  if (alignment?.kind === "paragraph.set_alignment") fields.push(`对齐方式：${alignmentNames[alignment.arguments.alignment] ?? alignment.arguments.alignment}`);
  if (indent?.kind === "paragraph.set_indent") fields.push(`首行缩进：${indent.arguments.first_line_indent_chars} 字符`, `左缩进：${indent.arguments.left_indent_chars} 字符`, `右缩进：${indent.arguments.right_indent_chars} 字符`);
  if (spacing?.kind === "paragraph.set_spacing") fields.push(`段前：${spacing.arguments.space_before_lines} 行`, `段后：${spacing.arguments.space_after_lines} 行`, `固定行距：${spacing.arguments.line_spacing_pt} 磅`, `段前分页：${spacing.arguments.page_break_before ? "是" : "否"}`);
  const needsReview = item.needs_review || item.recognized_type === "unknown" || commands.length === 0 || Boolean((item as { mixed_structure?: boolean }).mixed_structure);
  fields.push(`识别状态：${needsReview ? "需要复核" : "可应用"}`, `识别置信度：${Math.round(item.confidence * 100)}%`);
  return [fields.slice(0, 5), fields.slice(5, 10), fields.slice(10)].filter((group) => group.length > 0).map((group) => group.join(" ")).join("\n");
}
function shouldAdd(item: { recognized_type: string; needs_review: boolean }, mode: PreviewDisplayMode): boolean { return mode === "all" || (mode === "review_only" ? item.needs_review || item.recognized_type === "unknown" : SPECIAL.has(item.recognized_type)); }
function textHash(snapshot: LocalDocumentSnapshot): string { return snapshot.sourceSha256; }
function commentReference(comment: WpsObject): string {
  return [comment.Author, comment.Initial, normalizedComment(content(comment))].map((value) => String(value ?? "")).join(":");
}
function userCommentFingerprint(comments: WpsObject, exclude: (comment: WpsObject) => boolean = () => false): string {
  const values: string[] = [];
  for (let index = 1; index <= Number(comments.Count ?? 0); index += 1) { const item = comments.Item(index) as WpsObject; if (!exclude(item) && !content(item).includes(LEGACY_MARKER)) values.push(commentReference(item)); }
  return values.sort().join("|");
}
function ownsComment(document: WpsObject, comment: WpsObject, tracker: PreviewMutationTracker): boolean {
  const value = content(comment);
  const reference = (comment.Reference ?? comment.Range) as WpsObject | undefined;
  const start = Number(reference?.Start); const end = Number(reference?.End);
  const userReferences = new Set(tracker.user_comment_fingerprint.split("|").filter(Boolean));
  if (userReferences.has(commentReference(comment))) return false;
  if (String(comment.Author ?? "").startsWith(PREVIEW_AUTHOR_PREFIX)) return true;
  const current = tracker.created_comment_markers.some((item) => {
    const record = readMarkerRecord(item);
    if (!record) return false;
    if (normalizedComment(value).includes(commentSignature(record.marker))) return true;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const paragraphRange = paragraph(document, record.paragraph_index).Range as WpsObject;
    return start >= Number(paragraphRange.Start) && end <= Number(paragraphRange.End) && end > start;
  });
  if (current) return true;
  const userAuthors = new Set([...userReferences].map((referenceKey) => referenceKey.split(":")[0] ?? "").filter(Boolean));
  if (userAuthors.has(String(comment.Author ?? ""))) return false;
  if (tracker.created_comment_markers.some((item) => readMarkerRecord(item) !== null)) return true;
  return value.includes(LEGACY_MARKER) && value.includes("version=1") && value.includes(`preview_session=${tracker.preview_session_id}`) && value.includes(`document=${tracker.document_id.slice(-16)}`) && value.includes(`document_identity=${tracker.document_full_name_hash}`) && tracker.created_comment_markers.some((item) => {
    const lines = item.split("\n");
    const anchor = lines.find((line) => line.startsWith("anchor=")) ?? "";
    const paragraphIndex = Number(lines.find((line) => line.startsWith("paragraph_index="))?.slice("paragraph_index=".length));
    if (anchor === "" || !value.includes(item) || !Number.isInteger(paragraphIndex) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
    const paragraphRange = paragraph(document, paragraphIndex).Range as WpsObject;
    return start >= Number(paragraphRange.Start) && end <= Number(paragraphRange.End) && end > start;
  });
}

export class CommentPreviewCapabilityProvider {
  constructor(private readonly application?: WpsObject) {}
  probe(): Record<string, boolean> {
    try {
      const document = (this.application ?? app()).ActiveDocument as WpsObject | undefined;
      const comments = document?.Comments as WpsObject | undefined;
      if (!comments || typeof comments.Item !== "function") throw new Error();
      const first = Number(comments.Count ?? 0) > 0 ? comments.Item(1) as WpsObject : undefined;
      return { COMMENT_COLLECTION_READABLE: true, COMMENT_ADD_WRITABLE: typeof comments.Add === "function", COMMENT_DELETE_WRITABLE: !first || typeof first.Delete === "function", COMMENT_RANGE_READABLE: !first || !!(first.Reference ?? first.Range), COMMENT_CONTENT_READABLE: !first || typeof first.Content === "string" || typeof first.Range?.Text === "string", COMMENT_SAVE_PERSISTED: false };
    }
    catch { return { COMMENT_COLLECTION_READABLE: false, COMMENT_ADD_WRITABLE: false, COMMENT_DELETE_WRITABLE: false, COMMENT_RANGE_READABLE: false, COMMENT_CONTENT_READABLE: false, COMMENT_SAVE_PERSISTED: false }; }
  }
}

export class WpsPreviewCommentService implements PreviewCommentService {
  constructor(private readonly diagnostics?: DiagnosticReporter) {}
  async addPreviewComments(input: { snapshot: LocalDocumentSnapshot; recognition: RecognitionResult; commands: FormattingCommandSet; mode: PreviewDisplayMode }): Promise<PreviewCommentResult> {
    const started = Date.now();
    this.diagnostics?.writeForComponent("wps-preview-comments", "INFO", "preview.comment.write.start", "开始写入 WPS 预览批注", { recognition_paragraph_count: input.recognition.paragraphs.length, formatting_command_count: input.commands.commands.length });
    const document = app().ActiveDocument as WpsObject; const comments = collection(document); const session = crypto.randomUUID().replace(/-/g, "");
    const userFingerprint = userCommentFingerprint(comments);
    const created: string[] = []; const commandsByTarget = new Map<string, FormattingCommandSet["commands"]>();
    for (const command of input.commands.commands) { const values = commandsByTarget.get(command.target.target_id) ?? []; values.push(command); commandsByTarget.set(command.target.target_id, values); }
    const tracker = (): PreviewMutationTracker => ({ preview_session_id: session, document_id: input.snapshot.documentId, document_full_name_hash: input.snapshot.documentFullNameHash ?? "", baseline_revision: input.snapshot.revision, baseline_text_hash: textHash(input.snapshot), baseline_paragraph_count: input.snapshot.paragraphs.length, baseline_paragraph_order_hash: input.snapshot.paragraphOrderHash ?? input.snapshot.sourceSha256, baseline_formatting_revision: input.snapshot.formattingRevision ?? "", baseline_section_count: input.snapshot.sectionCount ?? 0, baseline_saved_state: Boolean(document.Saved), user_comment_fingerprint: userFingerprint, created_comment_markers: [...created], paragraph_anchors: input.recognition.paragraphs.map((item) => item.target_id.slice(-12)), created_at: new Date().toISOString() });
    try {
      for (const item of input.recognition.paragraphs) {
        if (!shouldAdd(item, input.mode)) continue;
        const source = input.snapshot.paragraphs.find((value) => value.sourceParagraphIndex === item.host_paragraph_index);
        if (!source || !normalize(source.text)) continue;
        const hostParagraph = paragraph(document, item.host_paragraph_index);
        const paragraphRange = hostParagraph.Range as WpsObject;
        const hostRaw = normalize(paragraphRange.Text);
        if (await sha256(hostRaw) !== item.host_raw_text_sha256) throw new Error("PARAGRAPH_CHANGED");
        const expected = rawSliceUtf16(hostRaw, item.host_raw_start_utf16, item.host_raw_end_utf16);
        if (expected === null || await sha256(expected) !== item.text_sha256) throw new Error("HOST_RANGE_HASH_MISMATCH");
        const paragraphStart = Number(paragraphRange.Start);
        const start = paragraphStart + item.host_raw_start_utf16; const end = paragraphStart + item.host_raw_end_utf16;
        if (!item.locator_verified || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || item.host_raw_end_utf16 > hostRaw.length) continue;
        // The locator was validated against the host snapshot. Obtain exactly
        // that UTF-16 sub-range without changing Selection.
        const bodyRange = document.Range(start, end) as WpsObject;
        if (await sha256(normalize(bodyRange.Text)) !== item.text_sha256) throw new Error("HOST_RANGE_TEXT_MISMATCH");
        const value = display(item, commandsByTarget.get(item.target_id) ?? []);
        created.push(markerRecord(item.host_paragraph_index, item.host_raw_start_utf16, item.host_raw_end_utf16, value));
        const countBefore = Number(comments.Count ?? 0); const returned = comments.Add(bodyRange, value) as WpsObject | undefined;
        let comment = returned && typeof returned === "object" ? returned : undefined;
        for (let attempt = 0; !comment && attempt < 10; attempt += 1) {
          const countAfter = Number(comments.Count ?? 0); if (countAfter > countBefore) comment = comments.Item(countAfter) as WpsObject;
          else await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!comment) throw new Error("PREVIEW_COLOR_ASSIGNMENT_FAILED");
        comment.Author = previewAuthor(item.recognized_type); comment.Initial = previewInitial(item.recognized_type);
        if (String(comment.Author ?? "") !== previewAuthor(item.recognized_type)) throw new Error("PREVIEW_COLOR_ASSIGNMENT_FAILED");
        this.diagnostics?.writeForComponent("wps-preview-comments", "DEBUG", "preview.comment.write.item", "单条 WPS 预览批注写入完成", { source_paragraph_index: item.source_paragraph_index, recognized_type: item.recognized_type, command_count: (commandsByTarget.get(item.target_id) ?? []).length, write_result: "PASS" });
      }
    } catch (error) {
      if (created.length) await this.removePreviewComments(tracker()).catch(() => undefined);
      this.diagnostics?.writeForComponent("wps-preview-comments", "ERROR", "preview.comment.write.failed", "WPS 预览批注写入失败", { preview_comment_count: created.length, duration_ms: Date.now() - started }, error);
      throw error;
    }
    const finalTracker = tracker();
    this.diagnostics?.writeForComponent("wps-preview-comments", "INFO", "preview.comment.write.success", "WPS 预览批注写入完成", { preview_comment_count: created.length, duration_ms: Date.now() - started });
    return { tracker: finalTracker, comment_count: created.length, unsupported: false, warnings: [] };
  }
  async removePreviewComments(tracker: PreviewMutationTracker): Promise<void> {
    const started = Date.now();
    this.diagnostics?.writeForComponent("wps-preview-comments", "INFO", "preview.comment.cleanup.start", "开始清理 Docxtool 预览批注", {});
    try {
      const document = app().ActiveDocument as WpsObject; const comments = collection(document); const count = Number(comments.Count ?? 0);
      for (let index = count; index >= 1; index -= 1) { const item = comments.Item(index) as WpsObject; if (ownsComment(document, item, tracker)) item.Delete(); }
      const state = await this.verifyPreviewComments(tracker); if (state.comment_count !== 0 || !state.user_comment_integrity) throw new Error("PREVIEW_COMMENT_CLEANUP_FAILED");
      this.diagnostics?.writeForComponent("wps-preview-comments", "INFO", "preview.comment.cleanup.success", "Docxtool 预览批注清理完成", { remaining_preview_comment_count: state.comment_count, user_comment_integrity: state.user_comment_integrity, duration_ms: Date.now() - started });
    } catch (error) {
      this.diagnostics?.writeForComponent("wps-preview-comments", "ERROR", "preview.comment.cleanup.failed", "Docxtool 预览批注清理失败", { duration_ms: Date.now() - started }, error);
      throw error;
    }
  }
  async verifyPreviewComments(tracker: PreviewMutationTracker): Promise<{ comment_count: number; user_comment_integrity: boolean }> {
    const started = Date.now();
    this.diagnostics?.writeForComponent("wps-preview-comments", "DEBUG", "preview.comment.readback.start", "开始读回 WPS 预览批注", {});
    try {
      const document = app().ActiveDocument as WpsObject; const comments = collection(document); let count = 0;
      for (let index = 1; index <= Number(comments.Count ?? 0); index += 1) if (ownsComment(document, comments.Item(index) as WpsObject, tracker)) count += 1;
      const result = { comment_count: count, user_comment_integrity: userCommentFingerprint(comments, (comment) => ownsComment(document, comment, tracker)) === tracker.user_comment_fingerprint };
      this.diagnostics?.writeForComponent("wps-preview-comments", "INFO", "preview.comment.readback.success", "WPS 预览批注读回完成", { preview_comment_count: result.comment_count, user_comment_integrity: result.user_comment_integrity, duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      this.diagnostics?.writeForComponent("wps-preview-comments", "ERROR", "preview.comment.readback.failed", "WPS 预览批注读回失败", { duration_ms: Date.now() - started }, error);
      throw error;
    }
  }
}
