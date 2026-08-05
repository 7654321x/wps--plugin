export type DiagnosticLevel =
  | "TRACE"
  | "DEBUG"
  | "INFO"
  | "WARN"
  | "ERROR"
  | "FATAL";

export type DiagnosticSource = "main" | "ribbon" | "host" | "taskpane";

export interface DiagnosticError {
  name: string;
  message: string;
  stack?: string;
}

export interface DiagnosticEvent {
  timestamp: string;
  level: DiagnosticLevel;
  component: string;
  event: string;
  message: string;
  build_id?: string;
  plugin_version?: string;
  host_context_id?: string;
  session_id?: string;
  correlation_id?: string;
  request_id?: string;
  command_id?: string;
  command_name?: string;
  stage?: string;
  duration_ms?: number;
  stable_error_code?: string;
  error?: DiagnosticError;
  data?: Record<string, unknown>;
}

export interface DiagnosticBatch {
  schema_version: 1;
  source: DiagnosticSource;
  events: DiagnosticEvent[];
}

export interface DiagnosticReporter {
  writeForComponent(
    component: string,
    level: DiagnosticLevel,
    event: string,
    message: string,
    data?: Record<string, unknown>,
    error?: unknown,
  ): void;
}
