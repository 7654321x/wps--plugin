import { createClassifiedProductionComposition, type ClassifiedRuntimeConfig } from "./composition-root.js";
import { loadRealE2EPlan, runFormalPlan, runFormalRollbackProbe } from "./formal-e2e-usecase.js";

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
/** Controlled development driver. It uses the same production application use case. */
export function installFormalE2EDriver(): void {
  window.DocxtoolFormalE2E = {
    async run(onProgress) {
      await ensureE2EFixtureReady();
      const plan = await loadRealE2EPlan();
      await runFormalRollbackProbe(plan, { onProgress: (stage, detail) => onProgress?.(detail || stage) });
      await reportE2E("PASS", "", "rollback");
      const result = await runFormalPlan(plan, {
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
    const dispatch = async (command_name: "health_check" | "preview_document" | "format_document") => {
      const request_id = `e2e-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`; onProgress?.(command_name); if (result) result.textContent = command_name;
      storage.setItem("docxtool_classified_host_request_v1", JSON.stringify({ schema_version: 1, request_id, command_name, taskpane_build_id: build.build_id, created_at: new Date().toISOString() }));
      for (let attempt = 0; attempt < 600; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 100)); const state = JSON.parse(storage.getItem("docxtool_classified_host_result_v1") || "null") as { active_command?: { command_id?: string; status?: string; error_code?: string }; formatting_result?: string } | null; if (state?.active_command?.command_id === request_id && state.active_command.status !== "RUNNING") { if (state.active_command.status !== "PASS") throw new Error(state.active_command.error_code || "HOST_COMMAND_FAILED"); return state; } }
      throw new Error("HOST_COMMAND_TIMEOUT");
    };
    await dispatch("health_check"); await dispatch("preview_document"); const state = await dispatch("format_document");
    const report = { executed: Number(state.formatting_result?.match(/\d+/)?.[0] ?? 0), warnings: [] as string[], rollback: false };
    await reportE2E("PASS", "", "one_click_format");
    if (result) result.textContent = "本地应用流程完成：功能检测、预览排版和一键排版均直接调用正式用例。";
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
