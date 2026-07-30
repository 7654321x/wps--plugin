import type { ClientCapabilities, CommandRequest, ExecutionResult, FormattingCommandSet, RecognitionResult } from "../../contracts/src/index.js";
import type { LocalDocumentSnapshot, RecognitionProvider } from "../../recognition-client/src/index.js";
import type { CommandServiceClient } from "../../command-service-client/src/index.js";
export interface DocumentReader { readSnapshot(): Promise<LocalDocumentSnapshot>; }
export interface CommandValidator { validate(commandSet: FormattingCommandSet, requestId: string): FormattingCommandSet; }
export interface DocumentExecutor { execute(commandSet: FormattingCommandSet, transactionId: string, revision: string): Promise<ExecutionResult>; }
export interface TransactionManager { begin(): string; commit(transactionId: string): void; rollback(transactionId: string): void; }
export interface CapabilityProvider { capabilities(): ClientCapabilities; }
export interface LicenseProvider { authorizationScope(): CommandRequest["authorization_scope"]; }
export type { CommandServiceClient, LocalDocumentSnapshot, RecognitionProvider, RecognitionResult };
