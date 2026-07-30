export type DiagnosticStatus = "PASS" | "WARN" | "FAIL" | "NOT_RUN" | "UNSUPPORTED" | "RUNNING";
export interface DiagnosticCheck { check_id: string; group: string; title: string; dependencies: string[]; retryable: boolean; }
export interface DiagnosticResult extends DiagnosticCheck { status: DiagnosticStatus; error_code: string; summary: string; started_at: string; finished_at: string; duration_ms: number; details_safe: Record<string, string | number | boolean>; }
export interface DiagnosticReport { session_id: string; results: DiagnosticResult[]; first_root_cause: string | null; }
export type CheckAction = () => Promise<{ status: Exclude<DiagnosticStatus, "RUNNING" | "NOT_RUN">; error_code?: string; summary?: string; details_safe?: Record<string, string | number | boolean>; }>;
export class DiagnosticRunner {
  constructor(private readonly checks: DiagnosticCheck[]) {}
  async run(actions: Record<string, CheckAction>, previous: DiagnosticResult[] = []): Promise<DiagnosticReport> {
    const complete = new Map(previous.map((item) => [item.check_id, item])); const results: DiagnosticResult[] = [];
    for (const check of this.checks) {
      const dependency = check.dependencies.find((id) => complete.get(id)?.status !== "PASS"); const started = new Date();
      let result: DiagnosticResult;
      if (dependency) result = { ...check, status: "NOT_RUN", error_code: "DEPENDENCY_FAILED", summary: "前置检测未通过：" + dependency, started_at: started.toISOString(), finished_at: started.toISOString(), duration_ms: 0, details_safe: { dependency_failed: dependency } };
      else if (!actions[check.check_id]) result = { ...check, status: "NOT_RUN", error_code: "CHECK_NOT_IMPLEMENTED", summary: "当前环境未执行", started_at: started.toISOString(), finished_at: started.toISOString(), duration_ms: 0, details_safe: {} };
      else {
        try { const value = await actions[check.check_id](); const done = new Date(); result = { ...check, status: value.status, error_code: value.error_code || "", summary: value.summary || "", started_at: started.toISOString(), finished_at: done.toISOString(), duration_ms: done.getTime() - started.getTime(), details_safe: value.details_safe || {} }; }
        catch { const done = new Date(); result = { ...check, status: "FAIL", error_code: "UNKNOWN_FETCH_FAILURE", summary: "检测请求未完成", started_at: started.toISOString(), finished_at: done.toISOString(), duration_ms: done.getTime() - started.getTime(), details_safe: {} }; }
      }
      complete.set(check.check_id, result); results.push(result);
    }
    return { session_id: "", results, first_root_cause: results.find((item) => item.status === "FAIL")?.check_id || null };
  }
}
export function classifyNetworkError(error: unknown, phase: "health" | "preflight" | "request" = "request"): string {
  if (error instanceof DOMException && error.name === "AbortError") return "SERVICE_TIMEOUT";
  if (error instanceof TypeError) return phase === "preflight" ? "PREFLIGHT_FAILED" : phase === "health" ? "LOCAL_AGENT_UNREACHABLE" : "CORS_BLOCKED";
  return "UNKNOWN_FETCH_FAILURE";
}
