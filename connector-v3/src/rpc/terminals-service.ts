/**
 * `aa.v3.Terminals`: headless shells on this device (`runtime/terminal-manager.ts`).
 *
 * Bytes travel base64-encoded. `attach` is a duplex call: keystrokes and resizes go in while output comes out, and
 * it ends when the shell exits, the caller leaves, or its tunnel / client is dropped.
 */

import { method, service, z, type DuplexChannel, type RpcContext } from "meshcall";

import type { DeviceGate } from "../core/gate.js";
import type { TerminalManager } from "../runtime/terminal-manager.js";
import type { TunnelStreamTracker } from "./device-admin-service.js";
import { rpcGuard, toRpcError } from "./device-service.js";

export interface TerminalsServiceDeps {
  gate: DeviceGate;
  terminals: TerminalManager;
  streams: TunnelStreamTracker;
}

const EmptySchema = z.object({});
const OkSchema = z.object({ ok: z.literal(true) });

export const TerminalInfoSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  shell: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  created_at: z.string(),
  running: z.boolean(),
  exit_code: z.number().int().nullable(),
  exit_signal: z.string().nullable(),
  exited_at: z.string().nullable(),
  pid: z.number().int().nullable(),
  mode: z.enum(["pipe", "script"]),
});

const ListResponseSchema = z.object({ terminals: z.array(TerminalInfoSchema) });
const CreateRequestSchema = z.object({
  cwd: z.string().min(1).nullish(),
  shell: z.string().min(1).nullish(),
  cols: z.number().int().positive().nullish(),
  rows: z.number().int().positive().nullish(),
});
const IdSchema = z.object({ id: z.string().min(1) });
const ResizeRequestSchema = z.object({ id: z.string().min(1), cols: z.number().int().positive(), rows: z.number().int().positive() });

export const TerminalInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number().int().positive(), rows: z.number().int().positive() }),
]);
export const TerminalOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("exit"), exit_code: z.number().int().nullable() }),
]);

type TerminalInput = z.output<typeof TerminalInputSchema>;
type TerminalOutput = z.input<typeof TerminalOutputSchema>;

@service("aa.v3.Terminals", { targeted: true, description: "Shells running on this device." })
export class TerminalsService {
  readonly #deps: TerminalsServiceDeps;

  constructor(deps: TerminalsServiceDeps) {
    this.#deps = deps;
  }

  @method({ description: "Terminals on this device, running or recently exited.", readOnly: true, request: EmptySchema, response: ListResponseSchema })
  list(_request: z.output<typeof EmptySchema>, ctx: RpcContext) {
    this.#deps.gate.assertBusinessCallAllowed(ctx);
    return { terminals: this.#deps.terminals.list() };
  }

  @method({ description: "Start a shell.", idempotent: false, request: CreateRequestSchema, response: TerminalInfoSchema })
  async create(request: z.output<typeof CreateRequestSchema>, ctx: RpcContext) {
    this.#deps.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() =>
      this.#deps.terminals.create({
        ...(request.cwd != null ? { cwd: request.cwd } : {}),
        ...(request.shell != null ? { shell: request.shell } : {}),
        ...(request.cols != null ? { cols: request.cols } : {}),
        ...(request.rows != null ? { rows: request.rows } : {}),
      }),
    );
  }

  @method({ description: "Change a terminal's size.", idempotent: true, request: ResizeRequestSchema, response: TerminalInfoSchema })
  async resize(request: z.output<typeof ResizeRequestSchema>, ctx: RpcContext) {
    this.#deps.gate.assertBusinessCallAllowed(ctx);
    return rpcGuard(() => this.#deps.terminals.resize(request.id, request.cols, request.rows));
  }

  @method({ description: "Kill a terminal and everything it started.", destructive: true, idempotent: true, request: IdSchema, response: OkSchema })
  async close(request: z.output<typeof IdSchema>, ctx: RpcContext) {
    this.#deps.gate.assertBusinessCallAllowed(ctx);
    await rpcGuard(() => this.#deps.terminals.close(request.id));
    return { ok: true as const };
  }

  @method.duplex({
    description: "Attach to a terminal: recent output first, then live output, while keystrokes and resizes go in.",
    reason: "keystrokes and output interleave for as long as the terminal is open",
    request: IdSchema,
    inputItem: TerminalInputSchema,
    outputItem: TerminalOutputSchema,
  })
  async attach(request: z.output<typeof IdSchema>, channel: DuplexChannel<TerminalInput, TerminalOutput>, ctx: RpcContext) {
    this.#deps.gate.assertBusinessCallAllowed(ctx);
    const { terminals, streams } = this.#deps;
    const tracked = streams.open(ctx);
    try {
      let events: AsyncIterableIterator<TerminalOutput>;
      try {
        events = terminals.subscribe(request.id, { signal: tracked.signal });
      } catch (error) {
        throw toRpcError(error);
      }
      const input = (async () => {
        for await (const item of channel) {
          if (tracked.signal.aborted) break;
          if (item.type === "input") await terminals.write(request.id, Buffer.from(item.data, "base64"));
          else terminals.resize(request.id, item.cols, item.rows);
        }
      })().catch(() => undefined); // input errors (terminal gone, caller left) end only the input side
      for await (const event of events) await channel.send(event);
      void input;
    } finally {
      tracked.close();
    }
  }
}
