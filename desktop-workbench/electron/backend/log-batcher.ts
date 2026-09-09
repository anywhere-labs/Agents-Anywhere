import type { ConnectorLogEntry } from "../connector-types";
import { BACKEND_LOG_BATCH_MS } from "./protocol";

/**
 * Coalesces Connector log entries into bounded batches.
 *
 * A chatty Connector can emit hundreds of lines per second. Delivering one
 * event per line forces the renderer to re-render per line, which is what made
 * the window drop frames; one batch per interval keeps that cost bounded.
 */
export class LogBatcher {
  private batch: ConnectorLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deliver: (batch: ConnectorLogEntry[]) => void,
    private readonly intervalMs = BACKEND_LOG_BATCH_MS,
    private readonly maxBatch = 200,
  ) {}

  push(entry: ConnectorLogEntry): void {
    this.batch.push(entry);
    if (this.batch.length >= this.maxBatch) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.batch.length === 0) return;
    const batch = this.batch;
    this.batch = [];
    this.deliver(batch);
  }

  dispose(): void {
    this.flush();
  }
}
