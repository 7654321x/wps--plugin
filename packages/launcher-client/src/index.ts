export interface LocalServiceBootstrap {
  recognitionEndpoint(): Promise<URL>;
  commandEndpoint(): Promise<URL>;
  assertHealthy(): Promise<void>;
}

export class DevelopmentServiceBootstrap implements LocalServiceBootstrap {
  constructor(private readonly recognition: URL, private readonly command: URL) {}
  async recognitionEndpoint(): Promise<URL> { return this.recognition; }
  async commandEndpoint(): Promise<URL> { return this.command; }
  async assertHealthy(): Promise<void> {
    for (const base of [this.recognition, this.command]) {
      if (base.protocol !== "http:" || (base.hostname !== "127.0.0.1" && base.hostname !== "::1")) {
        throw new Error("LOCAL_SERVICE_NOT_LOOPBACK");
      }
      const response = await fetch(new URL("v1/health", base.toString().replace(/\/?$/, "/")));
      if (!response.ok) throw new Error("LOCAL_SERVICE_UNAVAILABLE");
    }
  }
}

export class PackagedServiceBootstrap implements LocalServiceBootstrap {
  async recognitionEndpoint(): Promise<URL> { throw new Error("PACKAGED_LAUNCHER_NOT_IMPLEMENTED"); }
  async commandEndpoint(): Promise<URL> { throw new Error("PACKAGED_LAUNCHER_NOT_IMPLEMENTED"); }
  async assertHealthy(): Promise<void> { throw new Error("PACKAGED_LAUNCHER_NOT_IMPLEMENTED"); }
}
