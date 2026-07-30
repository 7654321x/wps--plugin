import type { ClientCapabilities, CommandRequest, ExecutionResult, FormattingCommandSet, RecognitionResult } from "../../contracts/src/index.js";
import type { LocalDocumentSnapshot, RecognitionProvider } from "../../recognition-client/src/index.js";
import type { CommandServiceClient } from "../../command-service-client/src/index.js";
export interface DocumentReader { readSnapshot(options?: { allowUnsaved?: boolean }): Promise<LocalDocumentSnapshot>; }
export interface CommandValidator { validate(commandSet: FormattingCommandSet, requestId: string): FormattingCommandSet; }
export interface DocumentExecutor { execute(commandSet: FormattingCommandSet, transactionId: string, revision: string): Promise<ExecutionResult>; }
export interface TransactionManager { begin(): string; commit(transactionId: string): void; rollback(transactionId: string): void; }
export interface CapabilityProvider { capabilities(): ClientCapabilities; }
export interface FontCapability { requested_font: string; normalized_font: string; installed: boolean; matched_name: string | null; source: string; }
export interface FontCapabilityProvider { inspect(fontNames: string[]): FontCapability[]; assertAvailable(fontNames: string[]): void; }
export interface LicenseProvider { authorizationScope(): CommandRequest["authorization_scope"]; }
export type PreviewDisplayMode = "all" | "review_only" | "headings_and_special";
export interface PreviewMutationTracker {
  preview_session_id: string; document_id: string; document_full_name_hash: string; baseline_revision: string;
  baseline_text_hash: string; baseline_paragraph_count: number; baseline_paragraph_order_hash: string;
  baseline_formatting_revision: string; baseline_section_count: number; baseline_saved_state: boolean;
  user_comment_fingerprint: string; created_comment_markers: string[]; paragraph_anchors: string[]; created_at: string;
}
export interface PreviewCommentResult { tracker: PreviewMutationTracker; comment_count: number; unsupported: boolean; warnings: string[]; }
export interface PreviewCommentService {
  addPreviewComments(input: { snapshot: LocalDocumentSnapshot; recognition: RecognitionResult; commands: FormattingCommandSet; mode: PreviewDisplayMode }): Promise<PreviewCommentResult>;
  removePreviewComments(tracker: PreviewMutationTracker): Promise<void>;
  verifyPreviewComments(tracker: PreviewMutationTracker): Promise<{ comment_count: number; user_comment_integrity: boolean }>;
}
export type { CommandServiceClient, LocalDocumentSnapshot, RecognitionProvider, RecognitionResult };
