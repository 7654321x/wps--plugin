export type LocalCommandName =
  | "recognize_document"
  | "preview_document"
  | "clear_preview"
  | "format_document"
  | "health_check"
  | "open_taskpane"
  | "close_taskpane"
  | "toggle_taskpane";

export type LocalCommandSource = "ribbon" | "taskpane" | "test";

export interface CommandReceipt {
  accepted: boolean;
  command_id: string;
  command_name: LocalCommandName;
  reason?: string;
}

export interface QueuedCommand {
  command_id: string;
  command_name: LocalCommandName;
  source: LocalCommandSource;
  created_at: string;
}

function commandId(): string {
  const random =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `local-${Date.now().toString(36)}-${random}`;
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export class LocalCommandBus {
  private readonly queue: QueuedCommand[] = [];
  private running = false;
  private scheduled = false;

  constructor(
    private readonly execute: (command: QueuedCommand) => Promise<void>,
    private readonly onBusyChange?: (busy: boolean) => void,
    private readonly maxQueueLength = 20,
  ) {}

  enqueue(commandName: LocalCommandName, source: LocalCommandSource, requestedCommandId?: string): CommandReceipt {
    const id = requestedCommandId || commandId();
    const pending = this.running || this.scheduled || this.queue.length > 0;
    if (pending && this.queue.some((item) => item.command_name === commandName)) {
      return { accepted: false, command_id: id, command_name: commandName, reason: "DUPLICATE_COMMAND_PENDING" };
    }
    if (this.queue.length >= this.maxQueueLength) {
      return { accepted: false, command_id: id, command_name: commandName, reason: "LOCAL_COMMAND_QUEUE_FULL" };
    }
    this.queue.push({ command_id: id, command_name: commandName, source, created_at: new Date().toISOString() });
    this.schedule();
    return { accepted: true, command_id: id, command_name: commandName };
  }

  private schedule(): void {
    if (this.scheduled || this.running) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      void this.drain();
    }, 0);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.onBusyChange?.(true);
    try {
      while (this.queue.length > 0) {
        const command = this.queue.shift();
        if (!command) continue;
        await this.execute(command);
        await yieldToHost();
      }
    } finally {
      this.running = false;
      this.onBusyChange?.(false);
      if (this.queue.length > 0) this.schedule();
    }
  }
}
