import { assertControlJobRequest, assertControlJobResult, parseControlEndpointManifest, type ControlCapabilities, type ControlEndpointManifest, type ControlHealth, type ControlJobRequest, type ControlJobResult, type ControlJobStatus, type SubmittedJob } from "./contracts.js";
import { ControlTransportError, asControlError } from "./errors.js";
import type { ControlEndpointProvider } from "./endpoint-provider.js";

export interface LocalHttpControlTransportOptions {
  requestTimeoutMs?: number;
  maxHeartbeatAgeMs?: number;
}

type EndpointSource = ControlEndpointProvider | ControlEndpointManifest;

function isProvider(value: EndpointSource): value is ControlEndpointProvider { return typeof value === "object" && value !== null && "manifest" in value && typeof value.manifest === "function"; }
function endpointUrl(manifest: ControlEndpointManifest, path: string): URL {
  const base = new URL(manifest.base_url.endsWith("/") ? manifest.base_url : `${manifest.base_url}/`);
  const endpoint = new URL(path.replace(/^\//, ""), base);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(manifest.port) || endpoint.search || endpoint.hash) throw new ControlTransportError("CONTROL_SERVER_ENDPOINT_INVALID");
  return endpoint;
}

export class LocalHttpControlTransport {
  constructor(private readonly source: EndpointSource, private readonly options: LocalHttpControlTransportOptions = {}) {}

  async health(signal?: AbortSignal): Promise<ControlHealth> {
    return await this.request<ControlHealth>("/v1/health", "GET", undefined, signal);
  }

  async capabilities(signal?: AbortSignal): Promise<ControlCapabilities> {
    return await this.request<ControlCapabilities>("/v1/capabilities", "GET", undefined, signal);
  }

  async submit(request: ControlJobRequest, signal?: AbortSignal): Promise<SubmittedJob> {
    assertControlJobRequest(request);
    return await this.request<SubmittedJob>("/v1/jobs", "POST", request, signal);
  }

  async status(jobId: string, signal?: AbortSignal): Promise<ControlJobStatus> {
    this.assertJobId(jobId);
    return await this.request<ControlJobStatus>(`/v1/jobs/${jobId}`, "GET", undefined, signal);
  }

  async result(jobId: string, signal?: AbortSignal, request?: ControlJobRequest): Promise<ControlJobResult> {
    this.assertJobId(jobId);
    const value = await this.request<ControlJobResult>(`/v1/jobs/${jobId}/result`, "GET", undefined, signal);
    assertControlJobResult(value, request);
    return value;
  }

  async cancel(jobId: string, signal?: AbortSignal): Promise<void> {
    this.assertJobId(jobId);
    await this.request(`/v1/jobs/${jobId}/cancel`, "POST", {}, signal);
  }

  private async manifest(signal?: AbortSignal): Promise<ControlEndpointManifest> {
    const value = isProvider(this.source) ? await this.source.manifest(signal) : this.source;
    try { return parseControlEndpointManifest(value, Date.now(), this.options.maxHeartbeatAgeMs ?? 10_000); }
    catch (error) { throw asControlError(error); }
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<T> {
    const manifest = await this.manifest(signal);
    const endpoint = endpointUrl(manifest, path);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 10_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(endpoint, { method, headers: { Authorization: `Bearer ${manifest.session_token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      const raw = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(raw) as unknown; }
      catch { throw new ControlTransportError("CONTROL_SERVER_INVALID_JSON", response.status); }
      if (!response.ok) {
        const code = payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload && (payload as { error?: unknown }).error && typeof (payload as { error: { code?: unknown } }).error.code === "string" ? (payload as { error: { code: string } }).error.code : `CONTROL_SERVER_HTTP_${response.status}`;
        throw new ControlTransportError(code, response.status, response.status >= 500 || response.status === 408 || response.status === 429);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ControlTransportError) throw error;
      throw asControlError(error);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private assertJobId(value: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ControlTransportError("CONTROL_SERVER_JOB_ID_INVALID");
  }
}
