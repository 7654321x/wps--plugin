import { redactDiagnosticData, redactDiagnosticValue, safeError } from "./diagnostic-redaction.js";
import type { DiagnosticBatch, DiagnosticEvent, DiagnosticLevel, DiagnosticSource } from "./diagnostic-types.js";

export interface DiagnosticLoggerConfig {
  endpoint: string;
  sessionToken: string;
  source: DiagnosticSource;
  component: string;
  buildId?: string;
  pluginVersion?: string;
  hostContextId?: string;
  sessionId?: string;
  minimumLevel?: DiagnosticLevel;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  fetcher?: typeof fetch;
}

const LEVEL_ORDER: Record<DiagnosticLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
};

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function diagnosticEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || (endpoint.port || "80") !== "9528") {
    throw new Error("DIAGNOSTIC_ENDPOINT_MUST_BE_127_0_0_1_9528");
  }
  return new URL("/v1/diagnostics/logs", endpoint);
}

function normalizedEvent(event: DiagnosticEvent): DiagnosticEvent {
  const sanitized = redactDiagnosticValue(event) as DiagnosticEvent;
  const normalized: DiagnosticEvent = {
    ...sanitized,
    timestamp: typeof sanitized.timestamp === "string" && sanitized.timestamp ? sanitized.timestamp : new Date().toISOString(),
    level: Object.prototype.hasOwnProperty.call(LEVEL_ORDER, sanitized.level) ? sanitized.level : "INFO",
    component: String(sanitized.component || "unknown").slice(0, 80),
    event: String(sanitized.event || "diagnostic.unknown").slice(0, 160),
    message: String(sanitized.message || ""),
  };
  const data = normalized.data;
  if (data) {
    for (const key of ["correlation_id", "request_id", "command_id", "command_name", "stage", "stable_error_code"] as const) {
      if (normalized[key] === undefined && typeof data[key] === "string") normalized[key] = data[key] as never;
    }
    if (normalized.duration_ms === undefined && typeof data.duration_ms === "number") normalized.duration_ms = data.duration_ms;
  }
  return normalized;
}

export class LoopbackDiagnosticLogger {
  private readonly endpoint: URL;
  private readonly minimumLevel: DiagnosticLevel;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly fetcher: typeof fetch;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly queue: DiagnosticEvent[] = [];
  private flushPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly config: DiagnosticLoggerConfig) {
    this.endpoint = diagnosticEndpoint(config.endpoint);
    this.minimumLevel = config.minimumLevel ?? "DEBUG";
    this.maxBatchSize = positiveInteger(config.maxBatchSize, 50, 50);
    this.maxQueueSize = positiveInteger(config.maxQueueSize, 500, 500);
    this.fetcher = config.fetcher ?? fetch;
    this.timer = setInterval(() => { void this.flush(); }, positiveInteger(config.flushIntervalMs, 500, 60_000));
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  write(level: DiagnosticLevel, event: string, message: string, data?: Record<string, unknown>, error?: unknown): void {
    this.writeForComponent(this.config.component, level, event, message, data, error);
  }

  writeForComponent(component: string, level: DiagnosticLevel, event: string, message: string, data?: Record<string, unknown>, error?: unknown): void {
    if (this.disposed || LEVEL_ORDER[level] < LEVEL_ORDER[this.minimumLevel]) return;
    const item: DiagnosticEvent = {
      timestamp: new Date().toISOString(),
      level,
      component: component.slice(0, 80),
      event: event.slice(0, 160),
      message,
      ...(this.config.buildId ? { build_id: this.config.buildId } : {}),
      ...(this.config.pluginVersion ? { plugin_version: this.config.pluginVersion } : {}),
      ...(this.config.hostContextId ? { host_context_id: this.config.hostContextId } : {}),
      ...(this.config.sessionId ? { session_id: this.config.sessionId } : {}),
      ...(data ? { data: redactDiagnosticData(data) } : {}),
      ...(error === undefined ? {} : { error: safeError(error) }),
    };
    this.enqueue(normalizedEvent(item));
    if (level === "ERROR" || level === "FATAL") void this.flush();
  }

  trace(event: string, message: string, data?: Record<string, unknown>): void { this.write("TRACE", event, message, data); }
  debug(event: string, message: string, data?: Record<string, unknown>): void { this.write("DEBUG", event, message, data); }
  info(event: string, message: string, data?: Record<string, unknown>): void { this.write("INFO", event, message, data); }
  warn(event: string, message: string, data?: Record<string, unknown>, error?: unknown): void { this.write("WARN", event, message, data, error); }
  error(event: string, message: string, data?: Record<string, unknown>, error?: unknown): void { this.write("ERROR", event, message, data, error); }
  fatal(event: string, message: string, data?: Record<string, unknown>, error?: unknown): void { this.write("FATAL", event, message, data, error); }

  adopt(events: DiagnosticEvent[]): void {
    for (const event of events) this.enqueue(normalizedEvent(event));
  }

  pendingCount(): number { return this.queue.length; }

  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.queue.length === 0) return;
    this.flushPromise = this.performFlush().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
  }

  private enqueue(event: DiagnosticEvent): void {
    this.queue.push(event);
    if (this.queue.length > this.maxQueueSize) this.queue.splice(0, this.queue.length - this.maxQueueSize);
  }

  private async performFlush(): Promise<void> {
    const events = this.queue.splice(0, this.maxBatchSize);
    const batch: DiagnosticBatch = { schema_version: 1, source: this.config.source, events };
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Docxtool-Session": this.config.sessionToken },
        body: JSON.stringify(batch),
      });
      if (!response.ok) throw new Error(`DIAGNOSTIC_HTTP_${response.status}`);
    } catch {
      this.queue.unshift(...events);
      if (this.queue.length > this.maxQueueSize) this.queue.splice(this.maxQueueSize);
    }
  }
}
