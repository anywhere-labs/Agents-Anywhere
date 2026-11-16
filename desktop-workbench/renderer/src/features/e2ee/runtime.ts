// Wires the E2EE trust layer into this client: one trust store, one tunnel socket, one channel pool, and the
// transport resolver that sends a session's content through its device's secure channel.
//
// Routing (docs/v3/11-e2ee-noise.md §3, §10):
// - the Server declared `required` (now or ever) -> every session's content goes through a channel; a device
//   this client has not paired with answers `e2ee_not_paired` instead of a plaintext request;
// - otherwise, sessions of a paired device go through its channel and the rest stay on HTTPS. A session whose
//   device is not known yet is treated as encrypted while any device is paired (fail closed).

import { dashboardApi } from "@/features/dashboard/api"
import { loadStoredSession } from "@/features/auth/session"
import { parsePairingUri, type PairingPayload } from "@/lib/e2ee/client-channel"
import { SecureChannelPool } from "@/lib/e2ee/secure-transport"
import { knownSessionDevice, onServerE2eeDeclared, serverE2eeDeclaration } from "@/lib/e2ee/state"
import { ClientTrustStore, indexedDbTrustBackend, memoryTrustBackend, type DevicePin } from "@/lib/e2ee/trust-store"
import { TunnelMux, type TunnelSocket } from "@/lib/e2ee/tunnel"
import { webNoiseCrypto } from "@/lib/e2ee/webcrypto"
import { onContentTransportRequired, setContentTransportResolver } from "@/lib/transport/content-transport"

export interface E2eeRuntime {
  readonly store: ClientTrustStore
  readonly pool: SecureChannelPool
  /** Pair with a device from its QR code text (`aa-pair://…`); `deviceLabel` is the device name to remember. */
  pair(uri: string | PairingPayload, deviceLabel?: string): Promise<DevicePin>
  /** Whether content of this device must use a secure channel. */
  requiresChannel(deviceId: string): boolean
  dispose(): Promise<void>
}

let runtime: E2eeRuntime | null = null

/** Same list as the Server's gate (`core/e2ee_settings.py`): per-session paths that are metadata, not content. */
const PLAINTEXT_METADATA = /^(?:\/api\/v\d+)?\/sessions\/[^/?#]+\/(?:meta|runtime\/state|runtime\/capabilities)(?:[?#].*)?$/

export function isPlaintextMetadataPath(path: string): boolean {
  return PLAINTEXT_METADATA.test(path)
}

function requireToken(): string {
  const token = loadStoredSession()?.accessToken
  if (!token) throw new Error("not signed in")
  return token
}

export function e2eeRuntime(): E2eeRuntime | null {
  return runtime
}

/** Starts the trust layer once per page; safe to call again. Needs WebCrypto X25519 and a secure context. */
export function startE2ee(platform: "web" | "desktop"): E2eeRuntime | null {
  if (runtime) return runtime
  if (typeof window === "undefined" || !globalThis.crypto?.subtle) return null
  const store = new ClientTrustStore(typeof indexedDB === "undefined" ? memoryTrustBackend() : indexedDbTrustBackend())
  const mux = new TunnelMux(async () => {
    const identity = await store.identity()
    const ticket = await dashboardApi.createTunnelTicket(requireToken(), identity.clientId)
    return new WebSocket(dashboardApi.tunnelWebSocketUrl(ticket.ticket)) as unknown as TunnelSocket
  })
  const pool = new SecureChannelPool({
    store,
    mux,
    crypto: webNoiseCrypto,
    label: platform === "desktop" ? "Agents Anywhere Desktop" : "Agents Anywhere Web",
    platform,
    registerCommand: (registration) => dashboardApi.registerE2eeCommand(requireToken(), registration),
    deviceOfSession: async (sessionId) => (await dashboardApi.getSessionMeta(requireToken(), sessionId)).session.connectorId,
    knownDevice: knownSessionDevice,
  })

  let required = serverE2eeDeclaration() === "required"
  let pinned = new Set<string>()
  const refresh = async () => {
    const [policy, pins] = await Promise.all([store.policy(), store.pins()])
    required = required || policy.required
    pinned = new Set(pins.map((pin) => pin.deviceId))
  }
  const tighten = (mode: string) => {
    if (mode !== "required") return
    required = true
    void store.requireEncryption()
  }
  if (required) tighten("required")
  const unsubscribers = [
    onServerE2eeDeclared(tighten),
    store.onChange(() => void refresh()),
    onContentTransportRequired(({ code }) => {
      if (code === "e2ee_required") tighten("required")
    }),
  ]
  void refresh()

  const requiresChannel = (deviceId: string) => required || pinned.has(deviceId)
  const restore = setContentTransportResolver(({ sessionId, path }) => {
    // Directory entry and scheduling state stay plaintext in E2EE mode (the Server serves them).
    if (isPlaintextMetadataPath(path)) return null
    if (required) return pool.transportFor(sessionId)
    if (pinned.size === 0) return null
    const deviceId = knownSessionDevice(sessionId)
    if (deviceId === undefined || pinned.has(deviceId)) return pool.transportFor(sessionId)
    return null
  })

  runtime = {
    store,
    pool,
    pair: (uri, deviceLabel) => pool.pair(typeof uri === "string" ? parsePairingUri(uri) : uri, deviceLabel),
    requiresChannel,
    async dispose() {
      restore()
      for (const unsubscribe of unsubscribers) unsubscribe()
      await pool.closeAll()
      mux.close()
      runtime = null
    },
  }
  return runtime
}
