import { parseControlEndpointManifest, type ControlEndpointManifest } from "./contracts.js";

export interface ControlEndpointProvider {
  manifest(signal?: AbortSignal): Promise<ControlEndpointManifest>;
}

export class StaticControlEndpointProvider implements ControlEndpointProvider {
  constructor(private readonly value: ControlEndpointManifest, private readonly maxHeartbeatAgeMs = 10_000) {}

  async manifest(_signal?: AbortSignal): Promise<ControlEndpointManifest> {
    return parseControlEndpointManifest(this.value, Date.now(), this.maxHeartbeatAgeMs);
  }
}

export class CallbackControlEndpointProvider implements ControlEndpointProvider {
  constructor(private readonly reader: (signal?: AbortSignal) => Promise<unknown>, private readonly maxHeartbeatAgeMs = 10_000) {}

  async manifest(signal?: AbortSignal): Promise<ControlEndpointManifest> {
    return parseControlEndpointManifest(await this.reader(signal), Date.now(), this.maxHeartbeatAgeMs);
  }
}
