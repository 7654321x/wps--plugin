export class ControlTransportError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: string, status: number | null = null, retryable = false) {
    super(code);
    this.name = "ControlTransportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function asControlError(error: unknown): ControlTransportError {
  if (error instanceof ControlTransportError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new ControlTransportError("CONTROL_SERVER_REQUEST_ABORTED", null, true);
  return new ControlTransportError(error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "CONTROL_SERVER_UNREACHABLE", null, true);
}
