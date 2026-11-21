/**
 * `aa.v3.DeviceAdmin`: the four content-free calls the control plane may make on any device, including encrypted
 * ones (contracts/aa-v3/1.0/control.schema.json, `server-v3/aa_control/infra/router_pool.py::call_device_admin`).
 *
 * It does not go through the device gate: nothing here reads or changes conversations, files or terminals. It is
 * mounted without tunnels, so it is reachable only by direct (control plane) calls.
 *
 * Also home of `TunnelStreamTracker`: every long-lived business stream registers here under its tunnel id and
 * peer key, so `close_tunnel_sessions` (a revoked tunnel) and client revocation end them at once.
 */

import { method, service, z, type RpcContext } from "meshcall";

// ── Stream tracking ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TrackedStream {
  /** Aborted when the call ends, its tunnel is closed, its peer is revoked, or the device stops serving. */
  readonly signal: AbortSignal;
  /** Unregister (call in `finally`). */
  close(): void;
}

interface Entry {
  controller: AbortController;
  tunnelId: string | undefined;
  peerKey: string | undefined;
}

/** Long-lived streams (watch, watch_list, terminal attach) by tunnel and by E2E peer. */
export class TunnelStreamTracker {
  readonly #entries = new Set<Entry>();

  open(ctx: Pick<RpcContext, "signal" | "tunnel" | "e2e">): TrackedStream {
    const controller = new AbortController();
    const entry: Entry = { controller, tunnelId: ctx.tunnel?.id, peerKey: ctx.e2e?.peerKey ?? undefined };
    this.#entries.add(entry);
    const onCallEnd = () => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
    else ctx.signal.addEventListener("abort", onCallEnd, { once: true });
    return {
      signal: controller.signal,
      close: () => {
        ctx.signal.removeEventListener("abort", onCallEnd);
        this.#entries.delete(entry);
      },
    };
  }

  /** Abort every stream that came through `tunnelId`; returns how many. */
  closeTunnel(tunnelId: string): number {
    return this.#abortWhere((e) => e.tunnelId === tunnelId, `tunnel ${tunnelId} closed`);
  }

  /** Abort every stream of an E2E client (revoked). */
  closePeer(peerKey: string): number {
    return this.#abortWhere((e) => e.peerKey === peerKey, "client revoked");
  }

  closeAll(reason = "device stopped serving"): number {
    return this.#abortWhere(() => true, reason);
  }

  get size(): number {
    return this.#entries.size;
  }

  #abortWhere(match: (entry: Entry) => boolean, reason: string): number {
    let count = 0;
    for (const entry of [...this.#entries]) {
      if (!match(entry)) continue;
      this.#entries.delete(entry);
      entry.controller.abort(new Error(reason));
      count++;
    }
    return count;
  }
}

// ── Service ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceAdminHooks {
  /** Drop the live sessions and watchers of a tunnel the control plane revoked. */
  closeTunnelSessions(tunnelId: string): void | Promise<void>;
  /** Remember the device name the owner chose in the control plane. */
  rename(name: string): void | Promise<void>;
  /** A hint to look for an update. Checking is local; nothing the server sends is executed. */
  checkUpdate?(channel: string | undefined): void | Promise<void>;
  now?(): number;
}

// Python sends `None` fields as `null`; accept both absent and null for optional ones.
const EmptySchema = z.object({});
const PingResponseSchema = z.object({ ok: z.literal(true), server_time: z.string() });
const OkSchema = z.object({ ok: z.literal(true) });
const CloseTunnelSessionsSchema = z.object({ tunnel_id: z.string().min(1).max(128) });
const CheckUpdateSchema = z.object({ channel: z.string().max(64).nullish() });
const RenameSchema = z.object({ name: z.string().trim().min(1).max(128) });

@service("aa.v3.DeviceAdmin", {
  targeted: true,
  description: "Content-free device administration the control plane may call on every device, normal or encrypted.",
})
export class DeviceAdminService {
  readonly #hooks: DeviceAdminHooks;

  constructor(hooks: DeviceAdminHooks) {
    this.#hooks = hooks;
  }

  @method({ description: "Reachability probe; returns the device clock.", readOnly: true, request: EmptySchema, response: PingResponseSchema })
  ping(_request: z.output<typeof EmptySchema>, _ctx: RpcContext) {
    return { ok: true as const, server_time: new Date(this.#hooks.now?.() ?? Date.now()).toISOString() };
  }

  @method({
    description: "End every stream and watcher that came through a tunnel the control plane revoked.",
    idempotent: true,
    request: CloseTunnelSessionsSchema,
    response: OkSchema,
  })
  async close_tunnel_sessions(request: z.output<typeof CloseTunnelSessionsSchema>, _ctx: RpcContext) {
    await this.#hooks.closeTunnelSessions(request.tunnel_id);
    return { ok: true as const };
  }

  @method({
    description: "Hint the Connector to check for an update on its own; never runs anything the server sends.",
    idempotent: true,
    request: CheckUpdateSchema,
    response: OkSchema,
  })
  async check_update(request: z.output<typeof CheckUpdateSchema>, _ctx: RpcContext) {
    // Fire and forget: an update check may take long and must not hold the control plane's call.
    void Promise.resolve()
      .then(() => this.#hooks.checkUpdate?.(request.channel ?? undefined))
      .catch(() => undefined);
    return { ok: true as const };
  }

  @method({ description: "Update the device name shown to the owner.", idempotent: true, request: RenameSchema, response: OkSchema })
  async rename(request: z.output<typeof RenameSchema>, _ctx: RpcContext) {
    await this.#hooks.rename(request.name);
    return { ok: true as const };
  }
}
