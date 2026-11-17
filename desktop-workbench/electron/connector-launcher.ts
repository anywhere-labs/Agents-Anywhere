import { EventEmitter } from "node:events";
import type { BackendControlMessage } from "./backend/protocol";

/** What `desktop-host.ts` (connector-ts) posts over its parent port. */
export type ConnectorHostMessage =
  | { type: "ready"; kind: "connector.ready"; version: 1; instanceId: string; pid: number; endpoint: unknown; key: string }
  | { type: "failed"; code: string; message: string }
  | { type: "stopped"; reason: "shutdown" | "handed_over" | "parent_gone" };

/** One embedded Connector process, as the supervisor sees it. */
export interface ConnectorProcess {
  readonly id: number;
  onMessage(listener: (message: ConnectorHostMessage) => void): void;
  onOutput(listener: (line: string) => void): void;
  onExit(listener: (exit: { code: number | null; error?: string }) => void): void;
  /** Ask it to stop (`{type: "shutdown"}`); it posts `stopped` and exits. */
  shutdown(): void;
  kill(): void;
}

export type LaunchConnector = (env: Record<string, string>) => ConnectorProcess;

/**
 * The backend's launcher: Main forks the utility process (only Main can) and
 * relays its messages over the backend's IPC channel.
 */
export class IpcConnectorLauncher {
  private nextId = 1;
  private readonly processes = new Map<number, EventEmitter>();

  constructor(private readonly send: (message: BackendControlMessage) => void) {}

  readonly launch: LaunchConnector = env => {
    const id = this.nextId++;
    const events = new EventEmitter();
    this.processes.set(id, events);
    let exited = false;
    events.once("exit", () => { exited = true; this.processes.delete(id); });
    this.send({ type: "connectorFork", id, env });
    return {
      id,
      onMessage: listener => { events.on("message", listener); },
      onOutput: listener => { events.on("output", listener); },
      onExit: listener => { events.on("exit", listener); },
      shutdown: () => { if (!exited) this.send({ type: "connectorPost", id, message: { type: "shutdown" } }); },
      kill: () => { if (!exited) this.send({ type: "connectorKill", id }); },
    };
  };

  /** Main's relay; returns false for messages that are not about a Connector. */
  handle(message: BackendControlMessage): boolean {
    if (message.type === "connectorMessage") this.processes.get(message.id)?.emit("message", message.message);
    else if (message.type === "connectorOutput") this.processes.get(message.id)?.emit("output", message.line);
    else if (message.type === "connectorExit") this.processes.get(message.id)?.emit("exit", { code: message.code, ...(message.error ? { error: message.error } : {}) });
    else return false;
    return true;
  }
}
