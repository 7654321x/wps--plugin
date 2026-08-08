export class ControlTransportError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly details: Record<string, string | number | boolean>;

  constructor(code: string, status: number | null = null, retryable = false, options?: { cause?: unknown; details?: Record<string, string | number | boolean> }) {
    super(code, options);
    this.name = "ControlTransportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = options?.details ?? {};
  }
}

export function asControlError(error: unknown): ControlTransportError {
  if (error instanceof ControlTransportError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new ControlTransportError("CONTROL_SERVER_REQUEST_ABORTED", null, true, { cause: error });
  return new ControlTransportError(error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "CONTROL_SERVER_UNREACHABLE", null, true, { cause: error });
}
