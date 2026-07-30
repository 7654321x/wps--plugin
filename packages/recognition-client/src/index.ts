import { RECOGNITION_RESULT_VERSION, type RecognitionParagraph, type RecognitionResult, type ReviewLevel } from "../../contracts/src/index.js";

export interface LocalDocumentSnapshot {
  documentId: string; revision: string; sourceSha256: string;
  localDocxPath?: string;
  paragraphs: Array<{ sourceParagraphIndex: number; text: string }>;
  /** Local-only revision data. It is never sent to the recognition service. */
  formattingRevision?: string; paragraphOrderHash?: string; sectionCount?: number;
}
export interface WheelRecognitionPlan {
  schema_version: string; engine_version: string; document_mode: RecognitionResult["document_mode"];
  document_mode_confidence: number;
  blocks: Array<{ source_paragraph_index: number | null; type_id: string; section: string; review_level: ReviewLevel }>;
}
export interface LocalRecognitionTransport { recognize(snapshot: LocalDocumentSnapshot): Promise<WheelRecognitionPlan>; }
export interface RecognitionProvider { recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult>; }
const CONTRACT_TYPE_BY_WHEEL_TYPE: Record<string, RecognitionParagraph["recognized_type"]> = {
  title: "main_title", title_cont: "title_continuation", addressing: "recipient",
  sign_org: "signature_org", sign_date: "signature_date", responsibility_line: "body", note: "source_note",
};
function contractType(type: string): RecognitionParagraph["recognized_type"] {
  return CONTRACT_TYPE_BY_WHEEL_TYPE[type] ?? (type as RecognitionParagraph["recognized_type"]);
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
export class LocalWheelRecognitionProvider implements RecognitionProvider {
  constructor(private readonly transport: LocalRecognitionTransport) {}
  async recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult> {
    const plan = await this.transport.recognize(snapshot);
    const sourceByIndex = new Map(snapshot.paragraphs.map((item) => [item.sourceParagraphIndex, item]));
    const occurrences = new Map<string, number>();
    const paragraphs: RecognitionParagraph[] = [];
    const blocksByIndex = new Map(plan.blocks.filter((block) => block.source_paragraph_index !== null).map((block) => [block.source_paragraph_index!, block]));
    // A section-break final paragraph is omitted by some wheel versions.  The
    // host still owns a concrete, text-safe paragraph anchor, so format that
    // uncovered paragraph as ordinary body instead of silently leaving it
    // unformatted.  This is a recognition coverage rule, not a WPS write path.
    for (const source of snapshot.paragraphs) {
      const block = blocksByIndex.get(source.sourceParagraphIndex);
      const sourceIndex = source.sourceParagraphIndex;
      if (block?.source_paragraph_index === null) continue;
      const textHash = await sha256(source.text);
      const occurrence = occurrences.get(textHash) ?? 0;
      occurrences.set(textHash, occurrence + 1);
      paragraphs.push({
        target_id: snapshot.documentId + ":p:" + sourceIndex + ":" + occurrence,
        source_paragraph_index: sourceIndex, recognized_type: contractType(block?.type_id ?? "body"),
        section_kind: block?.section ?? "body", text_sha256: textHash, text_length: source.text.length,
        occurrence_index: occurrence, confidence: block?.review_level === "confirmed" ? 1 : 0.5,
        review_level: block?.review_level ?? "review",
        needs_review: block?.review_level === "review" || block?.review_level === "critical_review",
      });
    }
    return {
      schema_version: RECOGNITION_RESULT_VERSION, recognition_engine_version: plan.engine_version,
      document_id: snapshot.documentId, document_revision: snapshot.revision,
      source_sha256: snapshot.sourceSha256, document_mode: plan.document_mode,
      document_mode_confidence: plan.document_mode_confidence, paragraphs,
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
