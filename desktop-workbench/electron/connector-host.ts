import readline from "node:readline";
import type { Readable } from "node:stream";

/**
 * What Main needs from Electron's `UtilityProcess`; tests pass a fake.
 * (`utilityProcess` exists only in Electron's main process, so the backend asks Main to fork.)
 */
export interface UtilityChild {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | Readable | null;
  readonly stderr: NodeJS.ReadableStream | Readable | null;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "error", listener: (...args: unknown[]) => void): this;
}

export type ForkUtility = (entry: string, env: Record<string, string>) => UtilityChild;

export type ConnectorHostEvent =
  | { type: "connectorMessage"; id: number; message: unknown }
  | { type: "connectorOutput"; id: number; line: string }
  | { type: "connectorExit"; id: number; code: number | null; error?: string };

/**
 * Main's side of the embedded Connector (v3 design 04-connector.md §9.4): forks
 * `desktop-main.js` in a utility process when the backend asks, relays its
 * `parentPort` messages and output lines back, and kills whatever is left when
 * the backend goes away. A utility process also ends with Main itself, and the
 * Connector stops on its own when its parent port closes.
 */
export class ConnectorUtilityHost {
  private readonly children = new Map<number, UtilityChild>();

  constructor(
    private readonly entry: string,
    private readonly fork: ForkUtility,
    private readonly send: (event: ConnectorHostEvent) => void,
  ) {}

  start(id: number, env: Record<string, string>): void {
    if (this.children.has(id)) return;
    let child: UtilityChild;
    try {
      child = this.fork(this.entry, env);
    } catch (error) {
      this.send({ type: "connectorExit", id, code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.children.set(id, child);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      readline.createInterface({ input: stream }).on("line", line => this.send({ type: "connectorOutput", id, line }));
    }
    child.on("message", message => this.send({ type: "connectorMessage", id, message }));
    child.on("exit", code => {
      if (this.children.get(id) !== child) return;
      this.children.delete(id);
      this.send({ type: "connectorExit", id, code });
    });
  }

  post(id: number, message: unknown): void {
    try {
      this.children.get(id)?.postMessage(message);
    } catch {
      // The process is exiting; its exit event follows.
    }
  }

  kill(id: number): void {
    this.children.get(id)?.kill();
  }

  /** The backend is gone: nobody will ask these processes to stop any more. */
  killAll(): void {
    for (const child of this.children.values()) child.kill();
  }

  get size(): number {
    return this.children.size;
  }
}
