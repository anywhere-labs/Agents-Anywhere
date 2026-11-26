// Experimental controlled mode ("被控模式", docs/v3/assistant-and-files-proposal.md §7): this browser tab's Portable
// Assistant temporarily registers as an online instance on the MeshCall Router, serving `aa.v3.Sessions` so other AA
// clients can list and open its conversations. Closing or hiding the tab takes it offline.
//
// What exists today (no server-v3 change needed for the control-plane half):
//   1. POST /devices/register      (user Bearer)   → device id + secret          (kept in IndexedDB, reused)
//   2. POST /devices/router-token  (device secret) → `mt_` tokens whose scopes allow registering aa.v3.Sessions,
//                                                    pinned to instance_id = device id
//   3. aa.v3.Control/presence      (client stream) → online while the stream lives (45 s TTL in Redis)
//
// What is missing: `meshcall/web` 0.4 is call-only. Its WebSocket transport always says `role: "client"` in `hello`
// and its `Mesh` has no `mount` / `startServing`, no tunnel host and no Noise responder; serving lives only in the
// Node entry (`node:http`, `ws`). So there is no way to *serve* `aa.v3.Sessions` from a browser yet. The serving side
// is therefore behind `BrowserServiceHost`; until an implementation exists the controller refuses to start, and it
// never publishes presence for a device that cannot answer calls.

import type { LocalAssistantConversation } from "@/lib/storage/idb"
import type {
  DeviceRecord,
  DeviceRouterTokenResponse,
  PresenceReport,
  RegisterDeviceResponse,
  RouterTokenEntry,
  SessionListPayload,
  SessionSummary,
} from "@/lib/types/v3"

export const CONTROLLED_MODE_VERSION = "3.0.0-web-experimental"
export const SESSIONS_SERVICE = "aa.v3.Sessions"
const PRESENCE_INTERVAL_MS = 20_000

// ── Availability ──

export type ControlledModeBlocker = "meshcall_web_server_role" | "browser_device_platform" | "ephemeral_device"

export interface ControlledModeSupport {
  available: boolean
  /** Hard blockers first; the rest are gaps the feature can work around. */
  blockers: ControlledModeBlocker[]
}

/** Whether a serving implementation is installed. Today none is, so the toggle stays disabled. */
export function getControlledModeSupport(host: BrowserServiceHost | null = registeredHost): ControlledModeSupport {
  if (!host) {
    return { available: false, blockers: ["meshcall_web_server_role", "browser_device_platform", "ephemeral_device"] }
  }
  return { available: true, blockers: ["browser_device_platform", "ephemeral_device"] }
}

// ── Serving seam ──

/** One method of a served service. Streams are async iterables, exactly as in `meshcall` service classes. */
export type ServedMethod =
  | { kind: "unary"; handle: (request: unknown, ctx: ServedCallContext) => Promise<unknown> }
  | { kind: "server_stream"; handle: (request: unknown, ctx: ServedCallContext) => AsyncIterable<unknown> }

export interface ServedCallContext {
  /** `meshcall-token-principal` of the caller, e.g. `user:<uid>/client:<cid>`. */
  principal: string | null
  signal: AbortSignal
}

export interface ServedService {
  name: string
  /** `targeted: true` — addressed by instance id (= device id). */
  targeted: boolean
  acceptTunnels: boolean
  methods: Record<string, ServedMethod>
}

export interface ServingHandle {
  close(): Promise<void>
  /** Resolves (or rejects) when the Router connection ends on its own. */
  closed: Promise<void>
}

/**
 * Server role on the MeshCall Router from a browser: open `wss://` with `hello{role:"server", instance_id}` and the
 * device `mt_` token, `server.register` the services, then dispatch incoming calls. Needs a `meshcall/web` release
 * with a browser server session (or an equivalent shim); nothing in `meshcall/web` 0.4 provides it.
 */
export interface BrowserServiceHost {
  serve(params: {
    routerUrl: string
    token: string
    instanceId: string
    services: ServedService[]
    signal: AbortSignal
  }): Promise<ServingHandle>
}

let registeredHost: BrowserServiceHost | null = null

/** Install a serving implementation (e.g. once `meshcall/web` gains a server role). */
export function registerBrowserServiceHost(host: BrowserServiceHost | null): void {
  registeredHost = host
}

export function getBrowserServiceHost(): BrowserServiceHost | null {
  return registeredHost
}

// ── aa.v3.Sessions adapter (read-only for now) ──

export function conversationToSessionSummary(conv: LocalAssistantConversation, deviceId: string): SessionSummary {
  return {
    id: conv.id,
    title: conv.title || "Untitled",
    agent: "pi-lite",
    device_id: deviceId,
    cwd: "/workspace",
    state: "idle",
    unread: false,
    pinned: false,
    updated_at: new Date(conv.updatedAt).toISOString(),
  }
}

export function conversationsToSessionList(
  conversations: LocalAssistantConversation[],
  deviceId: string,
  limit?: number
): SessionListPayload {
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  const sliced = typeof limit === "number" && limit >= 0 ? sorted.slice(0, limit) : sorted
  return { sessions: sliced.map((c) => conversationToSessionSummary(c, deviceId)), projects: ["/workspace"] }
}

/**
 * The `aa.v3.Sessions` surface this tab would serve: `list` and `watch_list` over the local conversations. Turn
 * streaming (`watch`, `send`, approvals) needs the assistant run loop to be driven remotely and is left for when
 * serving is possible at all.
 */
export function buildAssistantSessionsService(deps: {
  deviceId: string
  listConversations: () => Promise<LocalAssistantConversation[]>
  /** Fires whenever the local conversation list changed. */
  subscribe: (listener: () => void) => () => void
}): ServedService {
  return {
    name: SESSIONS_SERVICE,
    targeted: true,
    acceptTunnels: true,
    methods: {
      list: {
        kind: "unary",
        async handle(request) {
          const limit = (request as { limit?: unknown } | null)?.limit
          return conversationsToSessionList(
            await deps.listConversations(),
            deps.deviceId,
            typeof limit === "number" ? limit : undefined
          )
        },
      },
      watch_list: {
        kind: "server_stream",
        async *handle(_request, ctx) {
          let changed = true
          let wake: (() => void) | null = null
          const unsubscribe = deps.subscribe(() => {
            changed = true
            wake?.()
          })
          const onAbort = () => wake?.()
          ctx.signal.addEventListener("abort", onAbort)
          try {
            while (!ctx.signal.aborted) {
              if (changed) {
                changed = false
                yield conversationsToSessionList(await deps.listConversations(), deps.deviceId)
                continue
              }
              await new Promise<void>((resolve) => {
                wake = resolve
              })
              wake = null
            }
          } finally {
            unsubscribe()
            ctx.signal.removeEventListener("abort", onAbort)
          }
        },
      },
    },
  }
}

// ── Controller ──

export type ControlledModeState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "online"; deviceId: string; routerId: string }
  | { status: "error"; message: string }

export class ControlledModeUnavailableError extends Error {
  readonly blockers: ControlledModeBlocker[]
  constructor(blockers: ControlledModeBlocker[]) {
    super(`Controlled mode is not available in this browser yet (${blockers.join(", ")})`)
    this.name = "ControlledModeUnavailableError"
    this.blockers = blockers
  }
}

export interface ControlledDeviceStore {
  load(): Promise<{ deviceId: string; deviceSecret: string } | null>
  save(entry: { deviceId: string; deviceSecret: string; name: string }): Promise<void>
  clear(): Promise<void>
}

export interface ControlledModeDeps {
  deviceName: string
  store: ControlledDeviceStore
  registerDevice: (payload: { name: string; platform: DeviceRecord["platform"]; mode_hint: "normal"; connector_version: string }) => Promise<RegisterDeviceResponse>
  issueDeviceRouterToken: (payload: { device_id: string; device_secret: string }) => Promise<DeviceRouterTokenResponse>
  /** Keep `aa.v3.Control/presence` open with these reports until `signal` aborts. */
  runPresence: (entry: RouterTokenEntry, reports: AsyncIterable<PresenceReport>, signal: AbortSignal) => Promise<void>
  services: (deviceId: string) => ServedService[]
  host: BrowserServiceHost | null
  onState?: (state: ControlledModeState) => void
  presenceIntervalMs?: number
}

/** The browser cannot claim its own platform yet (server-v3 `DevicePlatform` is macos | linux | windows). */
const BROWSER_DEVICE_PLATFORM: DeviceRecord["platform"] = "linux"

function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return status === 401 || status === 403 || status === 404
}

export class ControlledModeController {
  private readonly deps: ControlledModeDeps
  private abort: AbortController | null = null
  private serving: ServingHandle | null = null
  private stateValue: ControlledModeState = { status: "off" }

  constructor(deps: ControlledModeDeps) {
    this.deps = deps
  }

  get state(): ControlledModeState {
    return this.stateValue
  }

  private setState(next: ControlledModeState): void {
    this.stateValue = next
    this.deps.onState?.(next)
  }

  private async credentials(): Promise<{ deviceId: string; tokens: DeviceRouterTokenResponse }> {
    const stored = await this.deps.store.load()
    if (stored) {
      try {
        return {
          deviceId: stored.deviceId,
          tokens: await this.deps.issueDeviceRouterToken({ device_id: stored.deviceId, device_secret: stored.deviceSecret }),
        }
      } catch (err) {
        // The device was deleted from another client (or its secret no longer matches): register a new one.
        if (!isAuthFailure(err)) throw err
        await this.deps.store.clear()
      }
    }
    const created = await this.deps.registerDevice({
      name: this.deps.deviceName,
      platform: BROWSER_DEVICE_PLATFORM,
      mode_hint: "normal",
      connector_version: CONTROLLED_MODE_VERSION,
    })
    await this.deps.store.save({ deviceId: created.device.id, deviceSecret: created.device_secret, name: this.deps.deviceName })
    return {
      deviceId: created.device.id,
      tokens: await this.deps.issueDeviceRouterToken({ device_id: created.device.id, device_secret: created.device_secret }),
    }
  }

  private async *presenceReports(deviceId: string, signal: AbortSignal): AsyncGenerator<PresenceReport> {
    const interval = this.deps.presenceIntervalMs ?? PRESENCE_INTERVAL_MS
    while (!signal.aborted) {
      yield {
        device_id: deviceId,
        platform: BROWSER_DEVICE_PLATFORM,
        connector_version: CONTROLLED_MODE_VERSION,
        mode_hint: "normal",
        sent_at: new Date().toISOString(),
        summary: { runtimes: ["pi-lite"], active_sessions: 0, pending_approvals: 0 },
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, interval)
        signal.addEventListener("abort", () => {
          clearTimeout(t)
          resolve()
        }, { once: true })
      })
    }
  }

  async start(): Promise<void> {
    if (this.abort) return
    const host = this.deps.host
    if (!host) {
      const err = new ControlledModeUnavailableError(getControlledModeSupport(null).blockers)
      this.setState({ status: "error", message: err.message })
      throw err
    }
    const abort = new AbortController()
    this.abort = abort
    this.setState({ status: "starting" })
    try {
      const { deviceId, tokens } = await this.credentials()
      const entry = tokens.tokens[0]
      if (!entry) throw new Error("The control plane returned no MeshCall routers")
      // Serve first: presence is only published for an instance that can actually answer calls.
      this.serving = await host.serve({
        routerUrl: entry.router_url,
        token: entry.token,
        instanceId: deviceId,
        services: this.deps.services(deviceId),
        signal: abort.signal,
      })
      if (abort.signal.aborted) {
        await this.serving.close().catch(() => undefined)
        this.serving = null
        return
      }
      void this.serving.closed.catch(() => undefined).then(() => {
        if (this.abort === abort) void this.stop("The Router connection closed")
      })
      void this.deps
        .runPresence(entry, this.presenceReports(deviceId, abort.signal), abort.signal)
        .catch((err: unknown) => {
          if (this.abort === abort && !abort.signal.aborted) {
            void this.stop(err instanceof Error ? err.message : String(err))
          }
        })
      this.setState({ status: "online", deviceId, routerId: entry.router_id })
    } catch (err) {
      // `stop()` during start already reset the state; nothing to report.
      if (abort.signal.aborted) return
      await this.stop(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /** Go offline. Closing the presence stream marks the device offline on the control plane immediately. */
  async stop(errorMessage?: string): Promise<void> {
    const abort = this.abort
    this.abort = null
    abort?.abort()
    const serving = this.serving
    this.serving = null
    await serving?.close().catch(() => undefined)
    this.setState(errorMessage ? { status: "error", message: errorMessage } : { status: "off" })
  }
}

/**
 * Tab hidden or closed → offline (expected for a page-hosted instance; mobile browsers freeze hidden tabs anyway).
 * Returns the cleanup function.
 */
export function bindControlledModeToPage(controller: ControlledModeController, target: Document = document): () => void {
  const goOffline = () => {
    if (target.visibilityState === "hidden") void controller.stop()
  }
  const onPageHide = () => void controller.stop()
  target.addEventListener("visibilitychange", goOffline)
  target.defaultView?.addEventListener("pagehide", onPageHide)
  return () => {
    target.removeEventListener("visibilitychange", goOffline)
    target.defaultView?.removeEventListener("pagehide", onPageHide)
  }
}

/** Presence over `meshcall/web` (works today: presence is a plain client stream). Lazy so it stays out of the page bundle. */
export async function runPresenceOverMeshcallWeb(
  entry: RouterTokenEntry,
  reports: AsyncIterable<PresenceReport>,
  signal: AbortSignal
): Promise<void> {
  const { Mesh, Router } = await import("meshcall/web")
  // A WebSocket Router URL is required: over `https://` a client stream is buffered into one request body.
  const mesh = new Mesh(new Router(entry.router_url), { token: entry.token })
  const onAbort = () => void mesh.close().catch(() => undefined)
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    await mesh.connect()
    await mesh.clientStream("aa.v3.Control", "presence", {}, reports, { signal })
  } finally {
    signal.removeEventListener("abort", onAbort)
    await mesh.close().catch(() => undefined)
  }
}
