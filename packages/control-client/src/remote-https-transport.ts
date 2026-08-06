import type { ControlJobRequest, ControlJobResult, ControlJobStatus, ControlCapabilities, ControlHealth, SubmittedJob } from "./contracts.js";

/** Reserved interface; classified-offline never constructs this transport. */
export class RemoteHttpsControlTransport {
  private unavailable(): never { throw new Error("CONTROL_REMOTE_TRANSPORT_NOT_ENABLED"); }
  health(_signal?: AbortSignal): Promise<ControlHealth> { return this.unavailable(); }
  capabilities(_signal?: AbortSignal): Promise<ControlCapabilities> { return this.unavailable(); }
  submit(_request: ControlJobRequest, _signal?: AbortSignal): Promise<SubmittedJob> { return this.unavailable(); }
  status(_jobId: string, _signal?: AbortSignal): Promise<ControlJobStatus> { return this.unavailable(); }
  result(_jobId: string, _signal?: AbortSignal): Promise<ControlJobResult> { return this.unavailable(); }
  cancel(_jobId: string, _signal?: AbortSignal): Promise<void> { return this.unavailable(); }
}
