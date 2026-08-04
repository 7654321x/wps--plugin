import { ALLOWED_COMMANDS, CLIENT_CAPABILITIES_VERSION, EXECUTION_RESULT_VERSION, type ClientCapabilities, type ExecutionResult, type FormattingCommandSet } from "../../contracts/src/index.js";
import type { DocumentExecutor, DocumentReader, TransactionManager } from "../../application/src/ports.js";
import type { LocalDocumentSnapshot } from "../../recognition-client/src/index.js";
export * from "./official-host.js";
export * from "./format-validation.js";
export * from "./grid.js";
export * from "./preview-comments.js";
export * from "./host-text.js";
export class CommandRegistry { allows(kind: string): boolean { return ALLOWED_COMMANDS.has(kind as never); } }
export class MockDocumentReader implements DocumentReader {
  constructor(private readonly snapshot: LocalDocumentSnapshot) {}
  async readSnapshot(): Promise<LocalDocumentSnapshot> { return this.snapshot; }
}
export class MockTransactionManager implements TransactionManager {
  public readonly committed: string[] = []; public readonly rolledBack: string[] = []; private sequence = 0;
  begin(): string { this.sequence += 1; return "mock-tx-" + this.sequence; }
  commit(transactionId: string): void { this.committed.push(transactionId); }
  rollback(transactionId: string): void { this.rolledBack.push(transactionId); }
}
export class MockCapabilityProvider {
  capabilities(): ClientCapabilities {
    return { schema_version: CLIENT_CAPABILITIES_VERSION, capabilities: ["paragraph.font", "paragraph.alignment", "paragraph.indent", "paragraph.spacing", "section.page_setup", "transaction.undo"] };
  }
}
export class MockDocumentExecutor implements DocumentExecutor {
  public readonly executed: string[] = [];
  constructor(private readonly failAtCommandId?: string, private readonly registry = new CommandRegistry()) {}
  async execute(commandSet: FormattingCommandSet, transactionId: string, documentRevision: string): Promise<ExecutionResult> {
    const executedThisRun: string[] = [];
    for (const command of commandSet.commands) {
      if (!this.registry.allows(command.kind)) throw new Error("UNKNOWN_COMMAND");
      if (command.command_id === this.failAtCommandId) {
        this.executed.splice(this.executed.length - executedThisRun.length, executedThisRun.length);
        return { schema_version: EXECUTION_RESULT_VERSION, transaction_id: transactionId, executed_command_ids: [], skipped_command_ids: [], failed_command_id: command.command_id, warnings: ["mock execution failure"], rolled_back: true, document_revision: documentRevision };
      }
      this.executed.push(command.command_id); executedThisRun.push(command.command_id);
    }
    return { schema_version: EXECUTION_RESULT_VERSION, transaction_id: transactionId, executed_command_ids: executedThisRun, skipped_command_ids: [], failed_command_id: null, warnings: [], rolled_back: false, document_revision: documentRevision };
  }
}
