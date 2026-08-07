import type { JsonValue } from "../../threading/src/protocol.js";
import type { PreviewPlanItem } from "./preview-comments.js";
import type { DiagnosticReporter } from "../../diagnostics/src/index.js";
import { rawSliceUtf16, stripWpsImplicitParagraphTerminator } from "./host-text.js";

type WpsObject = Record<string, any>;
interface PreviewSession { session_id: string; document_token: string; created: WpsObject[]; user_fingerprint: string; }
export const HOST_PREVIEW_BATCH_LIMIT = 5;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
function normalize(value: unknown): string { return stripWpsImplicitParagraphTerminator(value); }
class HostRangeTextMismatchError extends Error {
  readonly technical_detail: string;
  constructor(values: { paragraphIndex: number; relativeStart: number; relativeEnd: number; paragraphStart: number; paragraphEnd: number; requestedStart: number; requestedEnd: number; actualStart: number; actualEnd: number; expectedHash: string; actualHash: string; expectedLength: number; actualLength: number }) {
    super("HOST_RANGE_TEXT_MISMATCH");
    this.technical_detail = `paragraph_index=${values.paragraphIndex}; relative_start=${values.relativeStart}; relative_end=${values.relativeEnd}; paragraph_start=${values.paragraphStart}; paragraph_end=${values.paragraphEnd}; character_start=${values.requestedStart}; character_end=${values.requestedEnd}; actual_start=${values.actualStart}; actual_end=${values.actualEnd}; expected_sha256=${values.expectedHash.slice(0, 12)}; actual_sha256=${values.actualHash.slice(0, 12)}; expected_length_utf16=${values.expectedLength}; actual_length_utf16=${values.actualLength}`;
  }
}
function characterOrdinalAtUtf16Offset(value: string, offset: number): number {
  let position = 0; let ordinal = 0;
  for (const character of value) { if (position === offset) return ordinal; position += character.length; ordinal += 1; }
  if (position === offset) return ordinal;
  throw new Error("HOST_RANGE_UTF16_BOUNDARY_INVALID");
}
function commentContent(comment: WpsObject): string { return [comment.Content?.Text, comment.Content, comment.Text, comment.Range?.Text].filter((value) => typeof value === "string").join("\n"); }
function fingerprint(comments: WpsObject, excluded = new Set<WpsObject>()): string {
  const values: string[] = [];
  for (let index = 1; index <= Number(comments.Count ?? 0); index += 1) { const item = comments.Item(index) as WpsObject; if (!excluded.has(item)) values.push(`${String(item.Author ?? "")}:${String(item.Initial ?? "")}:${commentContent(item).replace(/\s+/g, " ").trim()}`); }
  return values.sort().join("|");
}

export class WpsPreviewBatchService {
  private active: PreviewSession | null = null;
  constructor(private readonly application: WpsObject, private readonly diagnostics?: DiagnosticReporter) {}

  private log(level: "DEBUG" | "INFO" | "ERROR", event: string, message: string, data: Record<string, unknown> = {}, error?: unknown): void {
    this.diagnostics?.writeForComponent("wps-preview-batch", level, event, message, data, error);
  }

  async apply(documentToken: string, sessionId: string, items: PreviewPlanItem[]): Promise<JsonValue> {
    if (!Array.isArray(items) || items.length < 1 || items.length > HOST_PREVIEW_BATCH_LIMIT) throw new Error("HOST_PREVIEW_BATCH_INVALID");
    const document = this.application.ActiveDocument as WpsObject | undefined; const comments = document?.Comments as WpsObject | undefined;
    if (!document || !comments || typeof comments.Add !== "function" || typeof comments.Item !== "function") throw new Error("COMMENT_PREVIEW_UNSUPPORTED");
    if (!this.active) this.active = { session_id: sessionId, document_token: documentToken, created: [], user_fingerprint: fingerprint(comments) };
    if (this.active.session_id !== sessionId || this.active.document_token !== documentToken) throw new Error("PREVIEW_SESSION_MISMATCH");
    const results: JsonValue[] = [];
    for (const item of items) {
      const target = item.target; const paragraph = document.Paragraphs?.Item(target.host_paragraph_index + 1) as WpsObject | undefined; const paragraphRange = paragraph?.Range as WpsObject | undefined;
      if (!paragraphRange) throw new Error("TARGET_NOT_FOUND");
      const hostRaw = normalize(paragraphRange.Text);
      if (await sha256(hostRaw) !== target.host_raw_text_sha256) throw new Error("PARAGRAPH_CHANGED");
      const fragment = rawSliceUtf16(hostRaw, target.host_raw_start_utf16, target.host_raw_end_utf16);
      if (fragment === null || await sha256(fragment) !== target.text_sha256) throw new Error("HOST_RANGE_HASH_MISMATCH");
      const characters = paragraphRange.Characters as WpsObject | undefined;
      if (!characters || typeof characters.Item !== "function") throw new Error("HOST_RANGE_CHARACTERS_UNSUPPORTED");
      const firstOrdinal = characterOrdinalAtUtf16Offset(hostRaw, target.host_raw_start_utf16); const lastOrdinal = characterOrdinalAtUtf16Offset(hostRaw, target.host_raw_end_utf16);
      const firstCharacter = characters.Item(firstOrdinal + 1) as WpsObject | undefined; const lastCharacter = characters.Item(lastOrdinal) as WpsObject | undefined;
      if (!firstCharacter || !lastCharacter || typeof firstCharacter.SetRange !== "function") throw new Error("HOST_RANGE_CHARACTER_BOUNDARY_INVALID");
      const start = Number(firstCharacter.Start); const end = Number(lastCharacter.End); firstCharacter.SetRange(start, end);
      const bodyRange = firstCharacter; const bodyText = normalize(bodyRange.Text); const bodyHash = await sha256(bodyText);
      if (bodyHash !== target.text_sha256) throw new HostRangeTextMismatchError({ paragraphIndex: target.host_paragraph_index, relativeStart: target.host_raw_start_utf16, relativeEnd: target.host_raw_end_utf16, paragraphStart: Number(paragraphRange.Start), paragraphEnd: Number(paragraphRange.End), requestedStart: start, requestedEnd: end, actualStart: Number(bodyRange.Start), actualEnd: Number(bodyRange.End), expectedHash: target.text_sha256, actualHash: bodyHash, expectedLength: fragment.length, actualLength: bodyText.length });
      const countBefore = Number(comments.Count ?? 0); const returned = comments.Add(bodyRange, item.comment_text) as WpsObject | undefined;
      let comment = returned && typeof returned === "object" ? returned : undefined;
      for (let attempt = 0; !comment && attempt < 10; attempt += 1) { const countAfter = Number(comments.Count ?? 0); if (countAfter > countBefore) comment = comments.Item(countAfter) as WpsObject; else await new Promise((resolve) => setTimeout(resolve, 10)); }
      if (!comment) throw new Error("PREVIEW_COMMENT_READBACK_FAILED");
      comment.Author = item.comment_author; comment.Initial = item.comment_initial;
      if (String(comment.Author ?? "") !== item.comment_author) throw new Error("PREVIEW_COLOR_ASSIGNMENT_FAILED");
      this.active.created.push(comment); results.push({ item_id: item.item_id, status: "PASS" });
    }
    return { session_id: sessionId, applied_count: results.length, total_created: this.active.created.length, results };
  }

  clear(documentToken: string, batchSize: number): JsonValue {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > HOST_PREVIEW_BATCH_LIMIT) throw new Error("HOST_PREVIEW_BATCH_INVALID");
    const session = this.active;
    if (!session) return { session_id: "", deleted_count: 0, remaining: 0, user_comment_integrity: true };
    const document = this.application.ActiveDocument as WpsObject | undefined;
    const comments = document?.Comments as WpsObject | undefined;
    const commentsBefore = Number(comments?.Count ?? 0);
    this.log("INFO", "preview.cleanup.batch.start", "开始清理 Worker 预览批注批次", { batch_size: batchSize, comments_before_count: commentsBefore, preview_session_suffix: session.session_id.slice(-12), session_document_token_suffix: session.document_token.slice(-12), request_document_token_suffix: documentToken.slice(-12), created_preview_count: session.created.length });
    if (session.document_token !== documentToken) {
      this.log("ERROR", "preview.cleanup.batch.failed", "预览批注清理拒绝跨文档操作", { stable_error_code: "DOCUMENT_CHANGED", comments_before_count: commentsBefore, preview_session_suffix: session.session_id.slice(-12), session_document_token_suffix: session.document_token.slice(-12), request_document_token_suffix: documentToken.slice(-12), created_preview_count: session.created.length });
      throw new Error("DOCUMENT_CHANGED");
    }
    if (!document || !comments) throw new Error("COMMENT_PREVIEW_UNSUPPORTED");
    let deleted = 0;
    while (session.created.length && deleted < batchSize) {
      const comment = session.created.pop()!;
      try { comment.Delete(); }
      catch (error) {
        this.log("ERROR", "preview.cleanup.batch.failed", "删除 Worker 预览批注失败", { stable_error_code: "PREVIEW_COMMENT_CLEANUP_FAILED", comments_before_count: commentsBefore, comments_current_count: Number(comments.Count ?? 0), deleted_count: deleted, remaining_preview_count: session.created.length, preview_session_suffix: session.session_id.slice(-12) }, error);
        throw new Error("PREVIEW_COMMENT_CLEANUP_FAILED", { cause: error });
      }
      deleted += 1;
    }
    const remaining = session.created.length; const integrity = fingerprint(comments, new Set(session.created)) === session.user_fingerprint;
    const commentsCurrent = Number(comments.Count ?? 0);
    this.log(integrity ? "DEBUG" : "ERROR", integrity ? "preview.cleanup.batch.completed" : "preview.cleanup.batch.failed", integrity ? "Worker 预览批注批次清理完成" : "用户批注完整性校验失败", { stable_error_code: integrity ? "" : "PREVIEW_USER_COMMENT_CHANGED", comments_before_count: commentsBefore, comments_current_count: commentsCurrent, deleted_count: deleted, remaining_preview_count: remaining, expected_user_fingerprint_present: Boolean(session.user_fingerprint), user_comment_integrity: integrity, preview_session_suffix: session.session_id.slice(-12) });
    if (!integrity) throw new Error("PREVIEW_USER_COMMENT_CHANGED");
    if (remaining === 0) this.active = null;
    return { session_id: session.session_id, deleted_count: deleted, remaining, user_comment_integrity: integrity };
  }
}
