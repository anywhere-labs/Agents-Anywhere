/**
 * `aa.v3.Terminals`: shells on this device (`runtime/terminal-manager.ts`). Design: docs/v3/terminal-proposal.md;
 * wire shapes: contracts/aa-v3/1.0/terminals.schema.json.
 *
 * Bytes travel base64-encoded. `attach` is a duplex call: the first frame is a screen `snapshot` (or, with a usable
 * `resume_seq`, only the missed output), then a `control` frame, then live output; `input` / `resize` / `claim` /
 * `release` go in. It ends when the shell exits, the caller leaves, or its tunnel / client is dropped.
 *
 * Control identity (who a stream belongs to, for the controller and the grace-period reconnect):
 * - an end-to-end call: `e2e:<peer_key>` (label: the paired-client entry, else the attach `label`);
 * - a tunnel call: the tunnel principal (label: the attach `label`, else the principal);
 * - a direct call on a temporary token: the token principal; otherwise `control` (the control plane / MCP).
 *
 * The unary `resize` has no stream to carry a generation, so it is honoured only when the caller's identity equals
 * the current controller's `client_id`; anyone else gets `failed_precondition` (`not_controller`).
 */

import { method, service, z, type DuplexChannel, type RpcContext } from "meshcall";

import type { DeviceGate } from "../core/gate.js";
import type { TerminalManager } from "../runtime/terminal-manager.js";
import type { TunnelStreamTracker } from "./device-admin-service.js";
import { rpcGuard, toRpcError } from "./device-service.js";
import { TerminalControllerSchema, TerminalInfoSchema } from "./terminal-schema.js";

export { TerminalControllerSchema, TerminalInfoSchema } from "./terminal-schema.js";

export interface TerminalsServiceDeps {
  gate: DeviceGate;
  terminals: TerminalManager;
  streams: TunnelStreamTracker;
}

// ── Schemas (mirror contracts/aa-v3/1.0/terminals.schema.json) ──────────────────────────────────────────────────

const EmptySchema = z.object({});
const OkSchema = z.object({ ok: z.literal(true) });

const Dimension = z.number().int().min(1).max(1000);
const Generation = z.number().int().min(0);
const Seq = z.number().int().min(0);
const Base64 = z.string();

const ListResponseSchema = z.object({ terminals: z.array(TerminalInfoSchema) });
const CreateRequestSchema = z.object({
  cwd: z.string().min(1).nullish(),
  shell: z.string().min(1).nullish(),
  cols: Dimension.nullish(),
  rows: Dimension.nullish(),
});
const IdSchema = z.object({ id: z.string().min(1) });
const ResizeRequestSchema = z.object({ id: z.string().min(1), cols: Dimension, rows: Dimension });

export const AttachRequestSchema = z.strictObject({
  id: z.string().min(1),
  mode: z.enum(["view", "control"]).default("view"),
  cols: Dimension.optional(),
  rows: Dimension.optional(),
  resume_seq: Seq.optional(),
  label: z.string().max(80).optional(),
});

export const TerminalInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("input"), data: Base64, generation: Generation }),
  z.strictObject({ type: z.literal("resize"), cols: Dimension, rows: Dimension, generation: Generation }),
  z.strictObject({ type: z.literal("claim"), cols: Dimension.optional(), rows: Dimension.optional(), keep_size: z.boolean().optional() }),
  z.strictObject({ type: z.literal("release") }),
]);

export const TerminalOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot"), data: Base64, seq: Seq, cols: Dimension, rows: Dimension }),
  z.strictObject({ type: z.literal("output"), data: Base64, seq: Seq }),
  z.strictObject({
    type: z.literal("control"),
    controller: TerminalControllerSchema.nullable(),
    generation: Generation,
    you: z.boolean(),
    cols: Dimension,
    rows: Dimension,
  }),
  z.strictObject({ type: z.literal("rejected"), reason: z.enum(["not_controller", "stale_generation", "agent_owned"]), generation: Generation }),
  z.strictObject({ type: z.literal("exit"), exit_code: z.number().int().nullable(), exit_signal: z.string().nullable().optional() }),
]);

type TerminalInput = z.output<typeof TerminalInputSchema>;
type TerminalOutput = z.input<typeof TerminalOutputSchema>;

// ── Identity ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TerminalClientIdentity {
  clientId: string;
  label: string;
}

/** Who a call is, for terminal control (see the file header). */
export function terminalClientIdentity(
  ctx: Pick<RpcContext, "e2e" | "tunnel" | "tokenPrincipal">,
  gate: Pick<DeviceGate, "listPairedClients">,
  requestedLabel?: string,
): TerminalClientIdentity {
  const label = requestedLabel?.trim() || undefined;
  const peerKey = ctx.e2e?.peerKey;
  if (peerKey) {
    const paired = gate.listPairedClients().find((entry) => entry.client_pub === peerKey);
    return { clientId: `e2e:${peerKey}`, label: paired?.label ?? label ?? `Client ${peerKey.slice(0, 8)}` };
  }
  const principal = ctx.tunnel?.principal || ctx.tokenPrincipal || "control";
  return { clientId: principal, label: label ?? principal };
}

// ── Service ─────────────────────────────────────────────────────────────────────────────────────────────────────

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

  @method({
    description: "Change a terminal's size. Only the current controller may (matched by client identity).",
    idempotent: true,
    request: ResizeRequestSchema,
    response: TerminalInfoSchema,
  })
  async resize(request: z.output<typeof ResizeRequestSchema>, ctx: RpcContext) {
    this.#deps.gate.assertBusinessCallAllowed(ctx);
    const { clientId } = terminalClientIdentity(ctx, this.#deps.gate);
    return rpcGuard(() => this.#deps.terminals.resize(request.id, request.cols, request.rows, { clientId }));
  }

  @method({ description: "Kill a terminal and everything it started.", destructive: true, idempotent: true, request: IdSchema, response: OkSchema })
  async close(request: z.output<typeof IdSchema>, ctx: RpcContext) {
    this.#deps.gate.assertBusinessCallAllowed(ctx);
    await rpcGuard(() => this.#deps.terminals.close(request.id));
    return { ok: true as const };
  }

  @method.duplex({
    description:
      "Attach to a terminal: a screen snapshot (or the missed output when resume_seq is still buffered), the control state, then live output. " +
      "Only the controller's input and resizes are applied. mode=control takes control only if nobody (or this same client) holds it; " +
      "a claim frame takes over unconditionally, release gives it up.",
    reason: "keystrokes and output interleave for as long as the terminal is open",
    request: AttachRequestSchema,
    inputItem: TerminalInputSchema,
    outputItem: TerminalOutputSchema,
  })
  async attach(request: z.output<typeof AttachRequestSchema>, channel: DuplexChannel<TerminalInput, TerminalOutput>, ctx: RpcContext) {
    const { gate, terminals, streams } = this.#deps;
    gate.assertBusinessCallAllowed(ctx);
    const identity = terminalClientIdentity(ctx, gate, request.label);
    const tracked = streams.open(ctx);
    try {
      let attachment: ReturnType<TerminalManager["attach"]>;
      try {
        attachment = terminals.attach(request.id, {
          clientId: identity.clientId,
          label: identity.label,
          mode: request.mode,
          ...(request.cols !== undefined ? { cols: request.cols } : {}),
          ...(request.rows !== undefined ? { rows: request.rows } : {}),
          ...(request.resume_seq !== undefined ? { resumeSeq: request.resume_seq } : {}),
          signal: tracked.signal,
        });
      } catch (error) {
        throw toRpcError(error);
      }
      const input = (async () => {
        for await (const item of channel) {
          if (tracked.signal.aborted || attachment.done) break;
          switch (item.type) {
            case "input":
              await attachment.input(Buffer.from(item.data, "base64"), item.generation);
              break;
            case "resize":
              attachment.resize(item.cols, item.rows, item.generation);
              break;
            case "claim":
              attachment.claim({
                ...(item.cols !== undefined ? { cols: item.cols } : {}),
                ...(item.rows !== undefined ? { rows: item.rows } : {}),
                ...(item.keep_size !== undefined ? { keepSize: item.keep_size } : {}),
              });
              break;
            case "release":
              attachment.release();
              break;
          }
        }
      })().catch(() => undefined); // input errors (terminal gone, caller left) end only the input side
      try {
        for await (const event of attachment) await channel.send(event);
      } finally {
        attachment.close();
      }
      void input;
    } finally {
      tracked.close();
    }
  }
}
