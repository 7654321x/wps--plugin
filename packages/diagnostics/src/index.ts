export interface TelemetryProvider { record(eventName: string, fields?: Record<string, string | number | boolean>): void; }
export class NoOpTelemetry implements TelemetryProvider { record(_eventName: string, _fields?: Record<string, string | number | boolean>): void {} }
export * from "./diagnostics.js";
export * from "./diagnostic-types.js";
export * from "./diagnostic-redaction.js";
export * from "./loopback-diagnostic-logger.js";
