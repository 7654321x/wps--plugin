import { FormatDocumentUseCase } from "../../../packages/application/src/format-document-usecase.js";
import { DevWriteTestPlanBuilder, type DevWriteTestProfile } from "../../../packages/application/src/dev-write-test-plan-builder.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import { PROTOCOL_VERSION, type RecognitionResult } from "../../../packages/contracts/src/index.js";
import type { LocalDocumentSnapshot, RecognitionProvider } from "../../../packages/recognition-client/src/index.js";
import { WpsApiDocumentExecutor, WpsCapabilityProvider, WpsDocumentReader, WpsTransactionManager } from "../../../packages/wps-adapter/src/index.js";

declare global {
  interface Window { DocxtoolDefaultProfile?: DevWriteTestProfile; DocxtoolFormalE2E?: { run(): Promise<{ executed: number; warnings: string[] }>; }; Application?: { ActiveDocument?: { Save?: () => void } }; }
}

const fixtureRoles: Array<[string, string]> = [
  ["文档网格验证", "main_title"], ["主标题格式", "main_title"], ["一级标题格式", "heading1"], ["二级标题格式", "heading2"],
  ["三级标题格式", "heading3"], ["四级标题格式", "heading4"], ["正文格式", "body"], ["称呼格式", "recipient"], ["日期行格式", "date_line"],
  ["作者行格式", "author_line"], ["职务姓名格式", "role_name"], ["居中小标题格式", "title2"], ["结束语格式", "closing"],
  ["名词解释条目格式", "glossary_item"], ["附件说明续项格式", "attachment_note_item"], ["附件说明格式", "attachment_note"],
  ["附件正文标记格式", "attachment_page_mark"], ["附件正文标题格式", "attachment_title"], ["附件正文格式", "attachment_body"],
  ["落款署名格式", "signature_org"], ["落款日期格式", "signature_date"], ["左对齐", "body:left"], ["居中", "body:center"],
  ["右对齐", "body:right"], ["两端对齐", "body:justify"], ["分散对齐", "body:distributed"],
];

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

class FixtureRecognitionProvider implements RecognitionProvider {
  async recognize(snapshot: LocalDocumentSnapshot): Promise<RecognitionResult> {
    const occurrences = new Map<string, number>();
    const paragraphs = [];
    for (const source of snapshot.paragraphs) {
      const role = fixtureRoles.find(([prefix]) => source.text.startsWith(prefix))?.[1];
      if (!role) continue;
      const textSha256 = await sha256(source.text);
      const occurrence = occurrences.get(textSha256) ?? 0;
      occurrences.set(textSha256, occurrence + 1);
      paragraphs.push({ target_id: snapshot.documentId + ":p:" + source.sourceParagraphIndex + ":" + occurrence, source_paragraph_index: source.sourceParagraphIndex, recognized_type: role, section_kind: "body", text_sha256: textSha256, text_length: source.text.length, occurrence_index: occurrence, confidence: 1, review_level: "confirmed" as const, needs_review: false });
    }
    return { schema_version: PROTOCOL_VERSION, recognition_engine_version: "dev-fixture-plan", document_id: snapshot.documentId, document_revision: snapshot.revision, source_sha256: snapshot.sourceSha256, document_mode: "normal", document_mode_confidence: 1, paragraphs };
  }
}

class ClassifiedLicense { authorizationScope(): "classified-offline" { return "classified-offline"; } }

export function installFormalE2EDriver(): void {
  window.DocxtoolFormalE2E = {
    async run() {
      const profile = window.DocxtoolDefaultProfile;
      if (!profile) throw new Error("DEFAULT_PROFILE_UNAVAILABLE");
      const builder = new DevWriteTestPlanBuilder(profile);
      const useCase = new FormatDocumentUseCase(
        new WpsDocumentReader(), new FixtureRecognitionProvider(),
        { async requestCommands(request) { return builder.build(request.recognition_result, request.request_id); } },
        new CommandValidator(), new WpsApiDocumentExecutor(), new WpsTransactionManager(), new WpsCapabilityProvider(), new ClassifiedLicense(),
      );
      const result = await useCase.execute("dev-grid-test-" + Date.now());
      if (result.failed_command_id || result.rolled_back) throw new Error(result.warnings[0] || "FORMAL_EXECUTION_FAILED");
      window.Application?.ActiveDocument?.Save?.();
      return { executed: result.executed_command_ids.length, warnings: result.warnings };
    },
  };
}

installFormalE2EDriver();
const button = document.getElementById("automatic-format-test-button") as HTMLButtonElement | null;
const result = document.getElementById("automatic-format-test-result");
if (button && result) button.onclick = async () => {
  button.disabled = true;
  result.textContent = "正在通过正式排版入口执行、读回并保存…";
  try {
    const report = await window.DocxtoolFormalE2E!.run();
    result.textContent = "自动格式测试完成：正式执行器已写入并读回 " + report.executed + " 项，文档已保存。";
  } catch (error) {
    result.textContent = "自动格式测试失败：" + (error instanceof Error ? error.message : "FORMAL_EXECUTION_FAILED");
  } finally {
    button.disabled = false;
  }
};
