import { PROTOCOL_VERSION, type RecognitionParagraph, type RecognitionResult, type ReviewLevel } from "../../contracts/src/index.js";

export interface LocalDocumentSnapshot {
  documentId: string; revision: string; sourceSha256: string;
  localDocxPath?: string;
  paragraphs: Array<{ sourceParagraphIndex: number; text: string }>;
}
export interface WheelRecognitionPlan {
  schema_version: string; engine_version: string; document_mode: RecognitionResult["document_mode"];
  document_mode_confidence: number;
  blocks: Array<{ source_paragraph_index: number | null; type_id: string; section: string; review_level: ReviewLevel }>;
}
export interface LocalRecognitionTransport { recognize(snapshot: LocalDocumentSnapshot): Promise<WheelRecognitionPlan>; }
export interface RecognitionProvider { recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult>; }
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
    for (const block of plan.blocks) {
      if (block.source_paragraph_index === null) continue;
      const source = sourceByIndex.get(block.source_paragraph_index);
      if (!source) throw new Error("WHEEL_ANCHOR_NOT_FOUND");
      const textHash = await sha256(source.text);
      const occurrence = occurrences.get(textHash) ?? 0;
      occurrences.set(textHash, occurrence + 1);
      paragraphs.push({
        target_id: snapshot.documentId + ":p:" + source.sourceParagraphIndex + ":" + occurrence,
        source_paragraph_index: source.sourceParagraphIndex, recognized_type: block.type_id,
        section_kind: block.section, text_sha256: textHash, text_length: source.text.length,
        occurrence_index: occurrence, confidence: block.review_level === "confirmed" ? 1 : 0.5,
        review_level: block.review_level,
        needs_review: block.review_level === "review" || block.review_level === "critical_review",
      });
    }
    return {
      schema_version: PROTOCOL_VERSION, recognition_engine_version: plan.engine_version,
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
