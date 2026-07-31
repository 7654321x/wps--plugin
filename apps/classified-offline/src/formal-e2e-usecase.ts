import { FormatDocumentUseCase, type FormattingExecutionOptions } from "../../../packages/application/src/format-document-usecase.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import type { ExecutionResult, FormattingCommandSet, RecognitionResult } from "../../../packages/contracts/src/index.js";
import { WpsApiDocumentExecutor, WpsCapabilityProvider, WpsDocumentReader, WpsFontCapabilityProvider, WpsTransactionManager } from "../../../packages/wps-adapter/src/index.js";

export interface FormalE2EPlan { recognition: RecognitionResult; commands: FormattingCommandSet; }
class PlanRecognitionProvider { constructor(private readonly plan: FormalE2EPlan) {} async recognize(): Promise<RecognitionResult> { return this.plan.recognition; } }
class PlanCommandService { constructor(private readonly plan: FormalE2EPlan) {} async requestCommands(): Promise<FormattingCommandSet> { return this.plan.commands; } }
class ClassifiedLicense { authorizationScope(): "classified-offline" { return "classified-offline"; } }

function formalUseCase(plan: FormalE2EPlan): FormatDocumentUseCase {
  const transaction = new WpsTransactionManager(); const capability = new WpsCapabilityProvider();
  return new FormatDocumentUseCase(
    new WpsDocumentReader(), new PlanRecognitionProvider(plan), new PlanCommandService(plan), new CommandValidator(),
    new WpsApiDocumentExecutor(undefined, capability, undefined, transaction), transaction, capability, new ClassifiedLicense(), new WpsFontCapabilityProvider(),
  );
}
function rollbackPlan(plan: FormalE2EPlan): FormalE2EPlan {
  const anchor = plan.commands.commands.at(-1)?.target;
  if (!anchor) throw new Error("ROLLBACK_TEST_PLAN_EMPTY");
  return { recognition: plan.recognition, commands: { ...plan.commands, commands: [...plan.commands.commands, { command_id: "cmd-999999", kind: "paragraph.set_alignment", target: { ...anchor, source_paragraph_index: 2147483647 }, arguments: { alignment: "left" }, required_capability: "paragraph.alignment", on_unsupported: "fail" }] } };
}

export async function loadRealE2EPlan(): Promise<FormalE2EPlan> {
  const session = await fetch("http://127.0.0.1:9528/v1/e2e/session").then((response) => response.ok ? response.json() as Promise<{ session_id: string }> : Promise.reject(new Error("E2E_SESSION_NOT_FOUND")));
  const value = await fetch("http://127.0.0.1:9528/v1/e2e/format-plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id }) }).then((response) => response.ok ? response.json() as Promise<{ ok: boolean; error_code?: string; recognition?: RecognitionResult; commands?: FormattingCommandSet }> : Promise.reject(new Error("E2E_FORMAT_PLAN_FAILED")));
  if (!value.ok || !value.recognition || !value.commands) throw new Error(value.error_code || "E2E_FORMAT_PLAN_FAILED");
  return { recognition: value.recognition, commands: value.commands };
}
export async function runFormalPlan(plan: FormalE2EPlan, options: FormattingExecutionOptions = {}): Promise<ExecutionResult> {
  return formalUseCase(plan).execute(plan.commands.request_id, options);
}
export async function runFormalRollbackProbe(plan: FormalE2EPlan, options: FormattingExecutionOptions = {}): Promise<void> {
  const reader = new WpsDocumentReader(); const before = await reader.readSnapshot();
  const result = await formalUseCase(rollbackPlan(plan)).execute(plan.commands.request_id, options);
  const document = (globalThis as { Application?: { ActiveDocument?: { Saved?: boolean; Save?: () => void } } }).Application?.ActiveDocument;
  document?.Save?.();
  for (let attempt = 0; attempt < 30 && !document?.Saved; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await reader.readSnapshot();
  if (!result.rolled_back || result.failed_command_id !== "cmd-999999" || after.revision !== before.revision || after.formattingRevision !== before.formattingRevision || after.paragraphOrderHash !== before.paragraphOrderHash || after.sectionCount !== before.sectionCount) throw new Error("ROLLBACK_FAILED");
}
