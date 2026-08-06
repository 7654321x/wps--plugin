const SENSITIVE_KEY =
  /token|authorization|cookie|password|secret|raw_text|document_text|body|content|source_path|full_?name|file_?path/i;
const SAFE_METADATA_KEYS = new Set([
  "content_length",
  "endpoint_path",
  "request_size_bytes",
  "response_size_bytes",
]);
const MAX_STRING = 4096;
const MAX_STACK = 12288;
const MAX_DEPTH = 6;
const MAX_ARRAY = 100;

function clip(value: string, limit = MAX_STRING): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}…[truncated:${value.length - limit}]`;
}

function redactString(value: string): string {
  return value
    .replace(/\b(authorization|cookie|password|secret|session[_-]?token|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/](?:[^\s\r\n:'\"]+[\\/])*[^\s\r\n:'\"]*/g, "[local-path]");
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SAFE_METADATA_KEYS.has(normalized)) return false;
  return normalized === "path" || SENSITIVE_KEY.test(key);
}

export function safeError(error: unknown): {
  name: string;
  message: string;
} {
  if (error instanceof Error) {
    return {
      name: clip(redactString(error.name || "Error"), 200),
      message: clip(redactString(error.message || "Unknown error")),
    };
  }
  return { name: "NonErrorThrown", message: clip(redactString(String(error))) };
}

export function redactDiagnosticValue(value: unknown, depth = 0, key = ""): unknown {
  if (sensitiveKey(key)) return "[redacted]";
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clip(redactString(value), key === "stack" ? MAX_STACK : MAX_STRING);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redactDiagnosticValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [itemKey, item] of Object.entries(value as Record<string, unknown>)) {
      output[itemKey] = redactDiagnosticValue(item, depth + 1, itemKey);
    }
    return output;
  }
  return clip(redactString(String(value)));
}

export function redactDiagnosticData(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return redactDiagnosticValue(value) as Record<string, unknown>;
}
