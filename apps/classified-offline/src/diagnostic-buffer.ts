export interface DiagnosticFileAdapter {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, value: string): void;
  appendText(path: string, value: string): void;
  hasNativeAppend(): boolean;
}

export interface DiagnosticBufferOptions {
  adapter: () => DiagnosticFileAdapter | null;
  path: () => string;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (timer: unknown) => void;
  flushIntervalMs?: number;
  batchLimit?: number;
  maxFileBytes?: number;
}

export class BoundedDiagnosticFileBuffer {
  private lines: string[] = [];
  private timer: unknown;
  private flushing = false;
  flushCount = 0;

  constructor(private readonly options: DiagnosticBufferOptions) {}

  enqueue(line: string, urgent = false): void {
    this.lines.push(line);
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
    if (urgent || this.lines.length >= (this.options.batchLimit ?? 50)) this.schedule(0);
    else if (this.timer === undefined) this.schedule(this.options.flushIntervalMs ?? 1_000);
  }

  flush(): void {
    if (this.flushing || this.lines.length === 0) return;
    const adapter = this.options.adapter();
    const path = this.options.path();
    if (!adapter || !path) return;
    this.flushing = true;
    if (this.timer !== undefined) this.options.cancel(this.timer);
    this.timer = undefined;
    const batch = this.lines.splice(0, this.lines.length).join("");
    try {
      if (adapter.hasNativeAppend()) adapter.appendText(path, batch);
      else {
        const maximum = this.options.maxFileBytes ?? 1_000_000;
        const existing = adapter.exists(path) ? adapter.readText(path) : "";
        const retained = existing.slice(-Math.max(0, maximum - batch.length));
        adapter.writeText(path, `${retained}${batch}`.slice(-maximum));
      }
      this.flushCount += 1;
    } catch {
      this.lines.unshift(batch);
    } finally {
      this.flushing = false;
      if (this.lines.length > 0 && this.timer === undefined) this.schedule(this.options.flushIntervalMs ?? 1_000);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined) this.options.cancel(this.timer);
    this.timer = this.options.schedule(() => { this.timer = undefined; this.flush(); }, delayMs);
  }
}
