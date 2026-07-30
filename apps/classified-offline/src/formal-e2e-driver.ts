import { createClassifiedProductionComposition, type ClassifiedRuntimeConfig } from "./composition-root.js";
import { FormatDocumentUseCase } from "../../../packages/application/src/format-document-usecase.js";
import { CommandValidator } from "../../../packages/security/src/index.js";
import type { FormattingCommandSet, RecognitionResult } from "../../../packages/contracts/src/index.js";
import { WpsApiDocumentExecutor, WpsCapabilityProvider, WpsDocumentReader, WpsFontCapabilityProvider, WpsTransactionManager } from "../../../packages/wps-adapter/src/index.js";

declare global {
  interface Window {
    DocxtoolRuntimeConfig?: ClassifiedRuntimeConfig;
    DocxtoolFormalE2E?: { run(onProgress?: (stage: string) => void): Promise<{ executed: number; warnings: string[]; rollback: boolean }>; };
    DocxtoolAutomaticFormatTest?: (onProgress?: (stage: string) => void) => Promise<{ executed: number; warnings: string[]; rollback: boolean }>;
    DocxtoolAutomaticWorkflowTest?: (onProgress?: (stage: string) => void) => Promise<{ executed: number; warnings: string[]; rollback: boolean }>;
    Application?: { ActiveDocument?: { Save?: () => void; FullName?: string; Saved?: boolean }; PluginStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } };
  }
}

const RUNTIME_CONFIG_KEY = "docxtool_classified_runtime_config";
function runtimeConfig(): ClassifiedRuntimeConfig {
  const stored = window.Application?.PluginStorage?.getItem(RUNTIME_CONFIG_KEY);
  const candidate = window.DocxtoolRuntimeConfig ?? (stored ? JSON.parse(stored) : null);
  if (!candidate || typeof candidate.recognitionEndpoint !== "string" || typeof candidate.commandEndpoint !== "string" || typeof candidate.sessionToken !== "string") throw new Error("LOCAL_RUNTIME_CONFIGURATION_REQUIRED");
  return candidate;
}
async function realE2EPlan(): Promise<{ recognition: RecognitionResult; commands: FormattingCommandSet }> {
  const session = await fetch("http://127.0.0.1:9528/v1/e2e/session").then((response) => response.ok ? response.json() as Promise<{ session_id: string }> : Promise.reject(new Error("E2E_SESSION_NOT_FOUND")));
  const result = await fetch("http://127.0.0.1:9528/v1/e2e/format-plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id }) }).then((response) => response.ok ? response.json() as Promise<{ ok: boolean; error_code?: string; recognition?: RecognitionResult; commands?: FormattingCommandSet }> : Promise.reject(new Error("E2E_FORMAT_PLAN_FAILED")));
  if (!result.ok || !result.recognition || !result.commands) throw new Error(result.error_code || "E2E_FORMAT_PLAN_FAILED");
  return { recognition: result.recognition, commands: result.commands };
}
async function ensureE2EFixtureReady(): Promise<void> {
  const document = window.Application?.ActiveDocument;
  if (!document || typeof document.FullName !== "string" || !document.FullName.toLowerCase().endsWith(".docx")) throw new Error("E2E_DOCUMENT_NOT_READY");
  const session = await fetch("http://127.0.0.1:9528/v1/e2e/session").then((response) => response.ok ? response.json() as Promise<{ session_id: string }> : Promise.reject(new Error("E2E_SESSION_NOT_FOUND")));
  const guard = await fetch("http://127.0.0.1:9528/v1/e2e/guard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id, source_path: document.FullName }) }).then((response) => response.ok ? response.json() as Promise<{ ok: boolean; error_code?: string }> : Promise.reject(new Error("E2E_ACTIVE_DOCUMENT_MISMATCH")));
  if (!guard.ok) throw new Error(guard.error_code === "E2E_TEST_DOCUMENT_REQUIRED" ? "E2E_ACTIVE_DOCUMENT_MISMATCH" : guard.error_code || "E2E_ACTIVE_DOCUMENT_MISMATCH");
  if (!document.Saved) {
    document.Save?.();
    for (let attempt = 0; attempt < 30 && !document.Saved; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!document.Saved) throw new Error("E2E_DOCUMENT_SAVE_FAILED");
}
class E2EBridgeRecognitionProvider {
  constructor(private readonly plan: { recognition: RecognitionResult; commands: FormattingCommandSet }) {}
  async recognize(): Promise<RecognitionResult> { return this.plan.recognition; }
}
class E2EBridgeCommandService {
  constructor(private readonly plan: { recognition: RecognitionResult; commands: FormattingCommandSet }) {}
  async requestCommands(): Promise<FormattingCommandSet> { return this.plan.commands; }
}
class ClassifiedLicense { authorizationScope(): "classified-offline" { return "classified-offline"; } }
function formalUseCase(plan: { recognition: RecognitionResult; commands: FormattingCommandSet }): FormatDocumentUseCase {
  const transaction = new WpsTransactionManager();
  const capability = new WpsCapabilityProvider();
  return new FormatDocumentUseCase(
    new WpsDocumentReader(), new E2EBridgeRecognitionProvider(plan), new E2EBridgeCommandService(plan), new CommandValidator(),
    new WpsApiDocumentExecutor(undefined, capability, undefined, transaction), transaction, capability, new ClassifiedLicense(), new WpsFontCapabilityProvider(),
  );
}
function rollbackPlan(plan: { recognition: RecognitionResult; commands: FormattingCommandSet }): { recognition: RecognitionResult; commands: FormattingCommandSet } {
  const anchor = plan.commands.commands.at(-1)?.target;
  if (!anchor) throw new Error("ROLLBACK_TEST_PLAN_EMPTY");
  return { recognition: plan.recognition, commands: { ...plan.commands, commands: [...plan.commands.commands, { command_id: "cmd-999999", kind: "paragraph.set_alignment", target: { ...anchor, source_paragraph_index: 2147483647 }, arguments: { alignment: "left" }, required_capability: "paragraph.alignment", on_unsupported: "fail" }] } };
}

/** Controlled development driver. It uses the same production application use case. */
export function installFormalE2EDriver(): void {
  window.DocxtoolFormalE2E = {
    async run(onProgress) {
      await ensureE2EFixtureReady();
      const plan = await realE2EPlan();
      const beforeRollback = await new WpsDocumentReader().readSnapshot();
      const rollback = await formalUseCase(rollbackPlan(plan)).execute(plan.commands.request_id, { onProgress: (stage, detail) => onProgress?.(detail || stage) });
      // WPS marks a document dirty even when the transaction restores every
      // captured value. Persist that restored state before its revision check.
      window.Application?.ActiveDocument?.Save?.();
      const afterRollback = await new WpsDocumentReader().readSnapshot();
      if (!rollback.rolled_back || afterRollback.revision !== beforeRollback.revision) throw new Error("ROLLBACK_FAILED");
      await reportE2E("PASS", "", "rollback");
      const result = await formalUseCase(plan).execute(plan.commands.request_id, {
        onProgress: (stage, detail) => onProgress?.(detail || stage),
      });
      if (result.failed_command_id || result.rolled_back) throw new Error(result.warnings[0] || "FORMAL_EXECUTION_FAILED");
      window.Application?.ActiveDocument?.Save?.();
      return { executed: result.executed_command_ids.length, warnings: result.warnings, rollback: true };
    },
  };
}

async function reportE2E(status: "PASS" | "FAIL", errorCode = "", stage = "one_click_format"): Promise<void> {
  try {
    const session = await fetch("http://127.0.0.1:9528/v1/e2e/session").then((response) => response.ok ? response.json() as Promise<{ session_id?: string }> : Promise.reject());
    if (session.session_id) await fetch("http://127.0.0.1:9528/v1/e2e/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id, stage, status, error_code: errorCode }) });
  } catch { /* E2E reporting must not change a formatting result. */ }
}
installFormalE2EDriver();
const button = document.getElementById("automatic-format-test-button") as HTMLButtonElement | null;
const result = document.getElementById("automatic-format-test-result");
async function runAutomaticFormatTest(onProgress?: (stage: string) => void): Promise<{ executed: number; warnings: string[]; rollback: boolean }> {
  try {
    const storage = window.Application?.PluginStorage; if (!storage) throw new Error("TASKPANE_BRIDGE_NOT_READY");
    const build = (window as unknown as { DocxtoolBuildInfo?: { build_id: string } }).DocxtoolBuildInfo; if (!build) throw new Error("ADDIN_CONTEXT_STALE");
    const dispatch = async (command_name: "recognize_document" | "preview_document" | "format_document") => {
      const request_id = `e2e-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`; onProgress?.(command_name); if (result) result.textContent = command_name;
      storage.setItem("docxtool_classified_host_request_v1", JSON.stringify({ schema_version: 1, request_id, command_name, taskpane_build_id: build.build_id, created_at: new Date().toISOString() }));
      for (let attempt = 0; attempt < 600; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 100)); const state = JSON.parse(storage.getItem("docxtool_classified_host_result_v1") || "null") as { active_command?: { command_id?: string; status?: string; error_code?: string }; formatting_result?: string } | null; if (state?.active_command?.command_id === request_id && state.active_command.status !== "RUNNING") { if (state.active_command.status !== "PASS") throw new Error(state.active_command.error_code || "HOST_COMMAND_FAILED"); return state; } }
      throw new Error("HOST_COMMAND_TIMEOUT");
    };
    await dispatch("recognize_document"); await dispatch("preview_document"); const state = await dispatch("format_document");
    const report = { executed: Number(state.formatting_result?.match(/\d+/)?.[0] ?? 0), warnings: [] as string[], rollback: false };
    await reportE2E("PASS", "", "one_click_format");
    if (result) result.textContent = "主上下文自动流程完成：识别、预览和一键排版均通过 HostCommandRouter。";
    return report;
  } catch (error) {
    const code = error instanceof Error ? error.message : "FORMAL_EXECUTION_FAILED";
    await reportE2E("FAIL", code, "one_click_format");
    if (result) result.textContent = "自动格式测试失败：" + code;
    throw error;
  }
}
window.DocxtoolAutomaticFormatTest = runAutomaticFormatTest;
window.DocxtoolAutomaticWorkflowTest = runAutomaticFormatTest;
if (button) button.onclick = async () => {
  button.disabled = true;
  try { await runAutomaticFormatTest(); }
  finally { button.disabled = false; }
};
// The hidden E2E taskpane is created by the WPS Ribbon callback below.  It
// invokes the exact same function as the visible button, never a separate
// test writer or a simulated mouse click.
if (new URLSearchParams(window.location.search).get("docxtool_e2e") === "silent") {
  void runAutomaticFormatTest();
}
