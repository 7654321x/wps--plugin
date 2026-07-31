import { RECOGNITION_RESULT_VERSION, type RecognitionParagraph, type RecognitionResult, type ReviewLevel } from "../../contracts/src/index.js";

export interface LocalDocumentSnapshot {
  documentId: string; revision: string; sourceSha256: string;
  localDocxPath?: string;
  paragraphs: Array<{ sourceParagraphIndex: number; text: string; isInTable?: boolean }>;
  /** Local-only revision data. It is never sent to the recognition service. */
  formattingRevision?: string; paragraphOrderHash?: string; sectionCount?: number; documentFullNameHash?: string;
}
export interface WheelRecognitionPlan {
  schema_version: string; engine_version: string; document_mode: RecognitionResult["document_mode"];
  document_mode_confidence: number;
  blocks: Array<{
    source_paragraph_index: number | null; type_id: string; section: string; review_level: ReviewLevel;
    kind?: string; physical_paragraph_index?: number | null; physical_occurrence_index?: number;
    physical_text_sha256?: string; physical_text_length_utf16?: number;
    range_start_utf16?: number | null; range_end_utf16?: number | null;
    offset_encoding?: string; locator_verified?: boolean; recognized_text?: string;
    /** Local wheel anchors. */
    text_sha256?: string; previous_text_sha256?: string; next_text_sha256?: string; block_index?: number;
  }>;
}
export interface LocalRecognitionTransport { recognize(snapshot: LocalDocumentSnapshot): Promise<WheelRecognitionPlan>; }
export interface RecognitionProvider { recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult>; }
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
export class LocalWheelRecognitionProvider implements RecognitionProvider {
  constructor(private readonly transport: LocalRecognitionTransport) {}
  async recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult> {
    const plan = await this.transport.recognize(snapshot);
    const occurrences = new Map<string, number>();
    const hostParagraphs = await Promise.all(snapshot.paragraphs.map(async (source, position) => ({ source, position, hash: await sha256(source.text) })));
    const byPhysicalHash = new Map<string, typeof hostParagraphs>();
    for (const item of hostParagraphs) {
      if (item.source.isInTable) continue;
      const values = byPhysicalHash.get(item.hash) ?? [];
      values.push(item); byPhysicalHash.set(item.hash, values);
    }
    const resolved: RecognitionParagraph[] = [];
    const unresolved: NonNullable<RecognitionResult["unresolved_blocks"]> = [];
    for (const block of plan.blocks) {
      if (["table", "image", "letterhead"].includes(String(block.kind ?? "")) || block.source_paragraph_index === null) continue;
      const blockIndex = Number(block.block_index ?? 0);
      const type = contractType(block.type_id);
      const physicalHash = String(block.physical_text_sha256 ?? "").toLowerCase();
      const blockHash = String(block.text_sha256 ?? "").toLowerCase();
      const start = Number(block.range_start_utf16); const end = Number(block.range_end_utf16);
      const occurrenceInPhysical = Number(block.physical_occurrence_index ?? 0);
      const locatorShapeValid = block.locator_verified === true && block.offset_encoding === "utf16_code_unit" && /^[a-f0-9]{64}$/.test(physicalHash) && /^[a-f0-9]{64}$/.test(blockHash) && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && Number.isInteger(occurrenceInPhysical) && occurrenceInPhysical >= 0;
      if (!locatorShapeValid) { unresolved.push({ block_index: blockIndex, recognized_type: type, review_level: block.review_level, reason: "RECOGNITION_LOCATOR_UNVERIFIED" }); continue; }
      const candidates = byPhysicalHash.get(physicalHash) ?? [];
      const selected = candidates[occurrenceInPhysical];
      if (!selected) { unresolved.push({ block_index: blockIndex, recognized_type: type, review_level: block.review_level, reason: candidates.length > 0 ? "RECOGNITION_LOCATOR_AMBIGUOUS" : "RECOGNITION_LOCATOR_UNVERIFIED" }); continue; }
      const selectedText = selected.source.text.slice(start, end);
      const selectedHash = await sha256(selectedText);
      if (selectedHash !== blockHash || (typeof block.recognized_text === "string" && selectedText !== block.recognized_text)) { unresolved.push({ block_index: blockIndex, recognized_type: type, review_level: block.review_level, reason: "RECOGNITION_LOCATOR_UNVERIFIED" }); continue; }
      const occurrence = occurrences.get(blockHash) ?? 0; occurrences.set(blockHash, occurrence + 1);
      resolved.push({
        target_id: `${snapshot.documentId}:p:${selected.source.sourceParagraphIndex}:r:${start}:${end}:${blockIndex}`,
        source_paragraph_index: selected.source.sourceParagraphIndex, physical_paragraph_index: Number(block.physical_paragraph_index ?? block.source_paragraph_index),
        recognized_type: type, section_kind: contractSection(block.section), text_sha256: blockHash,
        physical_text_sha256: physicalHash, range_start_utf16: start, range_end_utf16: end, locator_verified: true,
        text_length: selectedText.length, occurrence_index: occurrence,
        confidence: block.review_level === "confirmed" ? 1 : block.review_level === "info" ? 0.8 : 0.5,
        review_level: block.review_level, needs_review: block.review_level === "review" || block.review_level === "critical_review",
        mixed_structure: false, formatting_disposition: "apply",
      });
    }
    const byHostParagraph = new Map<number, RecognitionParagraph[]>();
    for (const item of resolved) { const values = byHostParagraph.get(item.source_paragraph_index) ?? []; values.push(item); byHostParagraph.set(item.source_paragraph_index, values); }
    for (const [sourceIndex, values] of byHostParagraph) {
      const source = snapshot.paragraphs.find((item) => item.sourceParagraphIndex === sourceIndex);
      const mixed = values.length > 1 || values.some((item) => item.range_start_utf16 !== 0 || item.range_end_utf16 !== (source?.text.length ?? -1));
      if (mixed) for (const item of values) { item.mixed_structure = true; item.formatting_disposition = "review_only"; item.needs_review = true; }
    }
    return {
      schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: plan.engine_version,
      document_id: snapshot.documentId, document_revision: snapshot.revision,
      source_sha256: snapshot.sourceSha256, document_mode: plan.document_mode,
      document_mode_confidence: plan.document_mode_confidence, paragraphs: resolved,
      ...(unresolved.length ? { unresolved_blocks: unresolved } : {}),
    };
  }
}

export class HttpLocalRecognitionTransport implements LocalRecognitionTransport {
  constructor(private readonly endpoint: URL, private readonly sessionToken: string) {
    if (endpoint.protocol !== "http:" || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "::1")) {
      throw new Error("RECOGNITION_ENDPOINT_MUST_BE_LOOPBACK");
    }
  }

  async recognize(snapshot: LocalDocumentSnapshot): Promise<WheelRecognitionPlan> {
    if (!snapshot.localDocxPath) throw new Error("DOCUMENT_MUST_BE_SAVED");
    const response = await fetch(new URL("v1/recognize", this.endpoint.toString().replace(/\/?$/, "/")), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Docxtool-Session": this.sessionToken },
      body: JSON.stringify({ source_path: snapshot.localDocxPath }),
    });
    const payload = await response.json() as { data?: WheelRecognitionPlan; error?: { code?: string } };
    if (!response.ok || !payload.data) throw new Error(payload.error?.code || "RECOGNITION_FAILED");
    return payload.data;
  }
}
