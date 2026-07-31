import { assertCommandRequest, assertFormattingCommandSet, type CommandRequest, type FormattingCommandSet } from "../../contracts/src/index.js";
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
  constructor(private readonly endpointProvider: EndpointProvider, private readonly responseValidator = new ResponseValidator()) {}
  async requestCommands(request: CommandRequest): Promise<FormattingCommandSet> {
    assertCommandRequest(request);
    const endpoint = new URL("v1/commands", this.endpointProvider.endpoint().toString().replace(/\/?$/, "/"));
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", ...this.endpointProvider.headers() },
      body: JSON.stringify(request),
    });
    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      if (!response.ok) throw new Error("COMMAND_SERVICE_" + response.status);
      throw new Error("COMMAND_SERVICE_INVALID_JSON");
    }
    if (!response.ok) throw new Error(commandServiceErrorCode(payload) ?? ("COMMAND_SERVICE_" + response.status));
    return this.responseValidator.validate(payload as FormattingCommandSet, request.request_id);
  }
}
