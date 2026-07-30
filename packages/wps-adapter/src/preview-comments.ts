import type { FormattingCommandSet, RecognitionResult } from "../../contracts/src/index.js";
import type { PreviewCommentResult, PreviewCommentService, PreviewDisplayMode, PreviewMutationTracker } from "../../application/src/ports.js";
import type { LocalDocumentSnapshot } from "../../recognition-client/src/index.js";

type WpsObject = Record<string, any>;
const MARKER = "[DOCXTOOL_PREVIEW]";
const SPECIAL = new Set(["main_title", "title_continuation", "heading1", "heading2", "heading3", "heading4", "recipient", "attachment_note", "attachment_title", "signature_org", "signature_date"]);
function app(): WpsObject { const value = (globalThis as { Application?: unknown }).Application; if (!value || typeof value !== "object") throw new Error("WPS_API_UNSUPPORTED"); return value as WpsObject; }
function normalize(value: unknown): string { return String(value ?? "").replace(/[\r\n\v\f]+$/g, ""); }
function collection(document: WpsObject): WpsObject { const comments = document.Comments as WpsObject | undefined; if (!comments || typeof comments.Item !== "function" || typeof comments.Add !== "function") throw new Error("COMMENT_PREVIEW_UNSUPPORTED"); return comments; }
function paragraph(document: WpsObject, index: number): WpsObject { const value = document.Paragraphs?.Item(index + 1) as WpsObject | undefined; if (!value?.Range) throw new Error("TARGET_NOT_FOUND"); return value; }
function content(comment: WpsObject): string { return String(comment.Content ?? comment.Range?.Text ?? ""); }
function marker(session: string, documentId: string, item: { source_paragraph_index: number; recognized_type: string; target_id: string }, style: string): string {
  return `${MARKER}\nversion=1\npreview_session=${session}\ndocument=${documentId.slice(-16)}\nparagraph_index=${item.source_paragraph_index}\nrole=${item.recognized_type}\nstyle=${style}\nanchor=${item.target_id.slice(-12)}`;
}
function display(item: { recognized_type: string; confidence: number; needs_review: boolean }, style: string, commands: FormattingCommandSet["commands"]): string {
  const role = ({ main_title: "主标题", title_continuation: "主标题续行", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", heading4: "四级标题", body: "正文", recipient: "称呼", attachment_note: "附件说明", attachment_title: "附件正文标题", signature_org: "落款署名", signature_date: "落款日期" } as Record<string, string>)[item.recognized_type] ?? "未知";
  const font = commands.find((command) => command.kind === "paragraph.set_font"); const alignment = commands.find((command) => command.kind === "paragraph.set_alignment"); const indent = commands.find((command) => command.kind === "paragraph.set_indent"); const spacing = commands.find((command) => command.kind === "paragraph.set_spacing");
  const lines = ["Docxtool 排版预览", "", `识别类别：${role}`, `计划样式：${style}`];
  if (font?.kind === "paragraph.set_font") lines.push(`中文字体：${font.arguments.east_asia_font_name}`, `西文字体：${font.arguments.latin_font_name}`, `字号：${font.arguments.font_size_pt} pt`, `粗体：${font.arguments.bold ? "是" : "否"}`);
  if (alignment?.kind === "paragraph.set_alignment") lines.push(`对齐：${alignment.arguments.alignment}`);
  if (indent?.kind === "paragraph.set_indent") lines.push(`首行缩进：${indent.arguments.first_line_indent_chars} 字符`, `左/右缩进：${indent.arguments.left_indent_chars}/${indent.arguments.right_indent_chars} 字符`);
  if (spacing?.kind === "paragraph.set_spacing") lines.push(`段前/段后：${spacing.arguments.space_before_lines}/${spacing.arguments.space_after_lines} 行`, `固定行距：${spacing.arguments.line_spacing_pt} pt`, `段前分页：${spacing.arguments.page_break_before ? "是" : "否"}`);
  lines.push(`状态：${item.needs_review ? "需要复核" : "可应用"}`);
  return lines.join("\n");
}
function shouldAdd(item: { recognized_type: string; needs_review: boolean }, mode: PreviewDisplayMode): boolean { return mode === "all" || (mode === "review_only" ? item.needs_review || item.recognized_type === "unknown" : SPECIAL.has(item.recognized_type)); }
function textHash(snapshot: LocalDocumentSnapshot): string { return snapshot.sourceSha256; }
function commentReference(comment: WpsObject): string {
  const range = (comment.Reference ?? comment.Range) as WpsObject | undefined;
  return [range?.Start, range?.End, comment.Author, comment.Initial, comment.Date].map((value) => String(value ?? "")).join(":");
}
function userCommentFingerprint(comments: WpsObject): string {
  const values: string[] = [];
  for (let index = 1; index <= Number(comments.Count ?? 0); index += 1) { const item = comments.Item(index) as WpsObject; if (!content(item).includes(MARKER)) values.push(commentReference(item)); }
  return values.sort().join("|");
}
function ownsComment(comment: WpsObject, tracker: PreviewMutationTracker): boolean {
  const value = content(comment);
  const anchor = String(comment.Reference?.Start ?? comment.Range?.Start ?? "");
  return value.includes(MARKER) && value.includes("version=1") && value.includes(`preview_session=${tracker.preview_session_id}`) && value.includes(`document=${tracker.document_id.slice(-16)}`) && tracker.created_comment_markers.some((item) => value.includes(item.split("\n").find((line) => line.startsWith("anchor=")) ?? "") && anchor !== "");
}

export class CommentPreviewCapabilityProvider {
  probe(): Record<string, boolean> {
    try { const comments = collection(app().ActiveDocument as WpsObject); return { COMMENT_COLLECTION_READABLE: true, COMMENT_ADD_WRITABLE: typeof comments.Add === "function", COMMENT_DELETE_WRITABLE: true, COMMENT_RANGE_READABLE: true, COMMENT_CONTENT_READABLE: true, COMMENT_SAVE_PERSISTED: false }; }
    catch { return { COMMENT_COLLECTION_READABLE: false, COMMENT_ADD_WRITABLE: false, COMMENT_DELETE_WRITABLE: false, COMMENT_RANGE_READABLE: false, COMMENT_CONTENT_READABLE: false, COMMENT_SAVE_PERSISTED: false }; }
  }
}

export class WpsPreviewCommentService implements PreviewCommentService {
  async addPreviewComments(input: { snapshot: LocalDocumentSnapshot; recognition: RecognitionResult; commands: FormattingCommandSet; mode: PreviewDisplayMode }): Promise<PreviewCommentResult> {
    const document = app().ActiveDocument as WpsObject; const comments = collection(document); const session = crypto.randomUUID().replace(/-/g, "");
    const created: string[] = []; const styleByIndex = new Map<number, string>(); const commandsByIndex = new Map<number, FormattingCommandSet["commands"]>();
    for (const command of input.commands.commands) if (command.kind === "paragraph.set_font") styleByIndex.set(command.target.source_paragraph_index, command.target.target_id);
    for (const command of input.commands.commands) { const values = commandsByIndex.get(command.target.source_paragraph_index) ?? []; values.push(command); commandsByIndex.set(command.target.source_paragraph_index, values); }
    for (const item of input.recognition.paragraphs) {
      if (!shouldAdd(item, input.mode)) continue;
      const source = input.snapshot.paragraphs.find((value) => value.sourceParagraphIndex === item.source_paragraph_index);
      if (!source || !normalize(source.text)) continue;
      const range = paragraph(document, item.source_paragraph_index).Range as WpsObject;
      const start = Number(range.Start); const end = Number(range.End) - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      // A new Range is obtained through the paragraph's parent document; no
      // Selection mutation occurs and the paragraph mark is excluded exactly.
      const bodyRange = document.Range(start, end) as WpsObject;
      const style = styleByIndex.get(item.source_paragraph_index) ?? item.recognized_type;
      const value = marker(session, input.snapshot.documentId, item, style) + "\n\n" + display(item, style, commandsByIndex.get(item.source_paragraph_index) ?? []);
      const comment = comments.Add(bodyRange, value) as WpsObject | undefined;
      if (!comment || !content(comment).includes(MARKER)) throw new Error("PREVIEW_COMMENT_READBACK_FAILED");
      created.push(marker(session, input.snapshot.documentId, item, style));
    }
    const tracker: PreviewMutationTracker = { preview_session_id: session, document_id: input.snapshot.documentId, document_full_name_hash: input.snapshot.sourceSha256.slice(0, 16), baseline_revision: input.snapshot.revision, baseline_text_hash: textHash(input.snapshot), baseline_paragraph_count: input.snapshot.paragraphs.length, baseline_paragraph_order_hash: input.snapshot.paragraphOrderHash ?? input.snapshot.sourceSha256, baseline_formatting_revision: input.snapshot.formattingRevision ?? "", baseline_section_count: input.snapshot.sectionCount ?? 0, baseline_saved_state: Boolean(document.Saved), user_comment_fingerprint: userCommentFingerprint(comments), created_comment_markers: created, paragraph_anchors: input.recognition.paragraphs.map((item) => item.target_id.slice(-12)), created_at: new Date().toISOString() };
    return { tracker, comment_count: created.length, unsupported: false, warnings: [] };
  }
  async removePreviewComments(tracker: PreviewMutationTracker): Promise<void> {
    const comments = collection(app().ActiveDocument as WpsObject); const count = Number(comments.Count ?? 0);
    for (let index = count; index >= 1; index -= 1) { const item = comments.Item(index) as WpsObject; if (ownsComment(item, tracker)) item.Delete(); }
    const state = await this.verifyPreviewComments(tracker); if (state.comment_count !== 0 || !state.user_comment_integrity) throw new Error("PREVIEW_COMMENT_CLEANUP_FAILED");
  }
  async verifyPreviewComments(tracker: PreviewMutationTracker): Promise<{ comment_count: number; user_comment_integrity: boolean }> {
    const comments = collection(app().ActiveDocument as WpsObject); let count = 0;
    for (let index = 1; index <= Number(comments.Count ?? 0); index += 1) if (ownsComment(comments.Item(index) as WpsObject, tracker)) count += 1;
    return { comment_count: count, user_comment_integrity: userCommentFingerprint(comments) === tracker.user_comment_fingerprint };
  }
}
