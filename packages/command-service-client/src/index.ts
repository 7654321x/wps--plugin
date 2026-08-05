import { assertCommandRequest, assertFormattingCommandSet, type CommandRequest, type FormattingCommandSet } from "../../contracts/src/index.js";
import type { DiagnosticReporter } from "../../diagnostics/src/index.js";
export interface EndpointProvider { endpoint(): URL; headers(): Record<string, string>; }
function isLoopback(url: URL): boolean { return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1"); }
export class LocalEndpointProvider implements EndpointProvider {
  constructor(private readonly baseUrl: string, private readonly sessionToken: string) {
    if (!isLoopback(new URL(baseUrl))) throw new Error("LOCAL_ENDPOINT_MUST_BE_LOOPBACK");
  }
  endpoint(): URL { return new URL(this.baseUrl); }
  headers(): Record<string, string> { return { "X-Docxtool-Session": this.sessionToken }; }
}
export class CloudEndpointProvider implements EndpointProvider {
  constructor(private readonly fixedBaseUrl: string, private readonly accessToken: string) {
    if (new URL(fixedBaseUrl).protocol !== "https:") throw new Error("CLOUD_ENDPOINT_MUST_BE_HTTPS");
  }
  endpoint(): URL { return new URL(this.fixedBaseUrl); }
  headers(): Record<string, string> { return { Authorization: "Bearer " + this.accessToken }; }
}
export interface CommandServiceClient { requestCommands(request: CommandRequest): Promise<FormattingCommandSet>; }
export class ResponseValidator {
  validate(value: FormattingCommandSet, requestId: string): FormattingCommandSet {
    assertFormattingCommandSet(value, requestId); return value;
  }
}
function commandServiceErrorCode(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}
export class HttpCommandServiceClient implements CommandServiceClient {
  constructor(private readonly endpointProvider: EndpointProvider, private readonly responseValidator = new ResponseValidator(), private readonly diagnostics?: DiagnosticReporter) {}
  async requestCommands(request: CommandRequest): Promise<FormattingCommandSet> {
    assertCommandRequest(request);
    const endpoint = new URL("v1/commands", this.endpointProvider.endpoint().toString().replace(/\/?$/, "/"));
    const body = JSON.stringify(request);
    const started = Date.now();
    const base = { endpoint_origin: endpoint.origin, endpoint_path: endpoint.pathname, method: "POST", request_size_bytes: new TextEncoder().encode(body).byteLength, paragraph_count: request.recognition_result.paragraphs.length, request_id: request.request_id, correlation_id: request.request_id };
    this.diagnostics?.writeForComponent("command-service-client", "INFO", "command_service.request.start", "开始请求格式命令服务", base);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...this.endpointProvider.headers() }, body });
      const raw = await response.text();
      const responseSize = new TextEncoder().encode(raw).byteLength;
      this.diagnostics?.writeForComponent("command-service-client", response.ok ? "INFO" : "WARN", "command_service.request.response", "格式命令服务已响应", { ...base, response_size_bytes: responseSize, status_code: response.status, duration_ms: Date.now() - started });
      let payload: unknown;
      try { payload = JSON.parse(raw) as unknown; }
      catch {
        if (!response.ok) throw new Error("COMMAND_SERVICE_" + response.status);
        throw new Error("COMMAND_SERVICE_INVALID_JSON");
      }
      if (!response.ok) throw new Error(commandServiceErrorCode(payload) ?? ("COMMAND_SERVICE_" + response.status));
      return this.responseValidator.validate(payload as FormattingCommandSet, request.request_id);
    } catch (error) {
      this.diagnostics?.writeForComponent("command-service-client", "ERROR", "command_service.request.failed", "格式命令服务请求失败", { ...base, duration_ms: Date.now() - started }, error);
      throw error;
    }
  }
}
