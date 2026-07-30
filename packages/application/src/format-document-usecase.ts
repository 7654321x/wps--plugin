import { PROTOCOL_VERSION, type CommandRequest, type ExecutionResult, type RecognitionResult } from "../../contracts/src/index.js";
import type { CapabilityProvider, CommandServiceClient, CommandValidator, DocumentExecutor, DocumentReader, LicenseProvider, RecognitionProvider, TransactionManager } from "./ports.js";
export class FormatDocumentUseCase {
  constructor(
    private readonly reader: DocumentReader, private readonly recognitionProvider: RecognitionProvider,
    private readonly commandService: CommandServiceClient, private readonly validator: CommandValidator,
    private readonly executor: DocumentExecutor, private readonly transactionManager: TransactionManager,
    private readonly capabilities: CapabilityProvider, private readonly license: LicenseProvider,
  ) {}
  async execute(requestId: string): Promise<ExecutionResult> {
    const snapshot = await this.reader.readSnapshot();
    const request: CommandRequest = {
      schema_version: PROTOCOL_VERSION, request_id: requestId,
      recognition_result: await this.recognitionProvider.recognize(snapshot),
      profile_id: "default", profile_version: "1.0", client_capabilities: this.capabilities.capabilities(),
      product_version: "0.1.0", authorization_scope: this.license.authorizationScope(),
    };
    const commandSet = this.validator.validate(await this.commandService.requestCommands(request), requestId);
    const transactionId = this.transactionManager.begin();
    const result = await this.executor.execute(commandSet, transactionId, snapshot.revision);
    if (result.rolled_back || result.failed_command_id) this.transactionManager.rollback(transactionId);
    else this.transactionManager.commit(transactionId);
    return result;
  }
}
export class RecognizeDocumentUseCase {
  constructor(private readonly reader: DocumentReader, private readonly recognitionProvider: RecognitionProvider) {}
  async execute(): Promise<RecognitionResult> { return this.recognitionProvider.recognize(await this.reader.readSnapshot()); }
}
