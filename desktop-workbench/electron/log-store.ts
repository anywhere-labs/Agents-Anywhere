import fs from "node:fs";
import path from "node:path";
import type {
  ConnectorLogEntry,
  ConnectorLogPage,
  ConnectorLogQuery,
  DesktopSettings,
} from "./connector-types";

const DEFAULT_PAGE_SIZE = 100;

export class ConnectorLogStore {
  private nextSequence = 1;

  constructor(
    private readonly directory: string,
    private getSettings: () => DesktopSettings,
  ) {
    const lastSequence = this.readRows().at(-1)?.seq;
    this.nextSequence = typeof lastSequence === "number" ? lastSequence + 1 : 1;
  }

  updateSettings(getSettings: () => DesktopSettings): void {
    this.getSettings = getSettings;
    this.prune();
  }

  append(entry: string | Partial<ConnectorLogEntry>): ConnectorLogEntry {
    const details = typeof entry === "string" ? {} : entry;
    const normalized: ConnectorLogEntry = {
      ...details,
      seq: Number.isInteger(typeof entry === "string" ? undefined : entry.seq)
        ? Number((entry as Partial<ConnectorLogEntry>).seq)
        : this.nextSequence++,
      level: typeof entry === "string" ? "INFO" : entry.level ?? "INFO",
      message: redactSecrets(typeof entry === "string" ? entry : String(entry.message ?? "")),
      time: typeof entry === "string" ? new Date().toISOString() : entry.time ?? new Date().toISOString(),
    };
    this.nextSequence = Math.max(this.nextSequence, normalized.seq + 1);
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.activeChunk(), `${JSON.stringify(normalized)}\n`, "utf8");
      this.prune();
    } catch (error) {
      console.error("Failed to write Connector log", error);
    }
    return normalized;
  }

  read(query: ConnectorLogQuery = {}): ConnectorLogPage {
    const pageSize = clamp(query.pageSize, DEFAULT_PAGE_SIZE, 20, 5_000);
    const rows = this.readRows();
    let items: ConnectorLogEntry[];
    if (Number.isInteger(query.afterSeq)) {
      items = rows.filter((row) => row.seq > Number(query.afterSeq)).slice(-pageSize);
    } else if (Number.isInteger(query.beforeSeq)) {
      items = rows.filter((row) => row.seq < Number(query.beforeSeq)).slice(-pageSize);
    } else {
      items = rows.slice(-pageSize);
    }
    const firstSeq = rows[0]?.seq ?? null;
    const lastSeq = rows.at(-1)?.seq ?? null;
    return {
      items,
      firstSeq,
      lastSeq,
      hasMoreBefore: items.length > 0 && firstSeq != null && items[0].seq > firstSeq,
      total: rows.length,
    };
  }

  clear(): ConnectorLogPage {
    for (const filePath of this.chunkFiles()) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Continue clearing the other chunks.
      }
    }
    this.nextSequence = 1;
    return this.read();
  }

  exportTo(filePath: string): number {
    const rows = this.readRows();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
      "utf8",
    );
    return rows.length;
  }

  private activeChunk(): string {
    const files = this.chunkFiles();
    const latest = files.at(-1);
    if (latest) {
      try {
        if (fs.statSync(latest).size < this.getSettings().logChunkSizeKb * 1_024) return latest;
      } catch {
        // Create a fresh chunk below.
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(this.directory, `connector-${stamp}.jsonl`);
  }

  private chunkFiles(): string[] {
    try {
      return fs
        .readdirSync(this.directory)
        .filter((name) => name.startsWith("connector-") && name.endsWith(".jsonl"))
        .sort()
        .map((name) => path.join(this.directory, name));
    } catch {
      return [];
    }
  }

  private readRows(): ConnectorLogEntry[] {
    const rows: ConnectorLogEntry[] = [];
    let fallbackSequence = 1;
    for (const filePath of this.chunkFiles()) {
      try {
        const fileTime = new Date(fs.statSync(filePath).mtimeMs).toISOString();
        for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Partial<ConnectorLogEntry>;
            const sequence = Number.isInteger(parsed.seq) ? Number(parsed.seq) : fallbackSequence;
            fallbackSequence = Math.max(fallbackSequence + 1, sequence + 1);
            rows.push({
              ...parsed,
              seq: sequence,
              level: parsed.level ?? "INFO",
              message: redactSecrets(String(parsed.message ?? "")),
              time: parsed.time ?? fileTime,
            });
          } catch {
            rows.push({
              seq: fallbackSequence++,
              level: "WARNING",
              message: redactSecrets(line),
              time: fileTime,
            });
          }
        }
      } catch {
        // Ignore unreadable log chunks.
      }
    }
    return rows.sort((left, right) => left.seq - right.seq);
  }

  private prune(): void {
    const settings = this.getSettings();
    const files = this.chunkFiles();
    const cutoff = Date.now() - settings.logRetentionDays * 24 * 60 * 60 * 1_000;
    const removable = new Set<string>();
    for (const filePath of files) {
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) removable.add(filePath);
      } catch {
        removable.add(filePath);
      }
    }
    files.slice(0, Math.max(0, files.length - settings.logRetainChunks)).forEach((file) => {
      removable.add(file);
    });
    for (const filePath of removable) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Log retention is best effort.
      }
    }
  }
}

export function redactSecrets(message: string): string {
  return message
    .replace(
      /(["']?connectorToken["']?\s*[:=]\s*)(["']?)([^"'\s,}]+)\2/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(
      /(["']?authorization["']?\s*[:=]\s*)(["']?)((?:Bearer|Connector)\s+)([^"'\s,}]+)\2/gi,
      "$1$2$3[REDACTED]$2",
    );
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}
