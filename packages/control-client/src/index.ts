export * from "./contracts.js";
export * from "./errors.js";
export * from "./endpoint-provider.js";
export * from "./local-http-transport.js";
export * from "./remote-https-transport.js";

export interface ControlTransport {
  health(signal?: AbortSignal): Promise<import("./contracts.js").ControlHealth>;
  capabilities(signal?: AbortSignal): Promise<import("./contracts.js").ControlCapabilities>;
  submit(request: import("./contracts.js").ControlJobRequest, signal?: AbortSignal): Promise<import("./contracts.js").SubmittedJob>;
  status(jobId: string, signal?: AbortSignal): Promise<import("./contracts.js").ControlJobStatus>;
  result(jobId: string, signal?: AbortSignal, request?: import("./contracts.js").ControlJobRequest): Promise<import("./contracts.js").ControlJobResult>;
  cancel(jobId: string, signal?: AbortSignal): Promise<void>;
}
