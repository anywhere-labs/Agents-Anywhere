// Dual-mode MeshCall device tunnel pool (`aa.v3.Sessions`, `aa.v3.Device`, `aa.v3.Terminals`).
//
// Security invariants enforced here (docs/v3/e2ee-admission-proposal.md):
//   1. Single-device operations ALWAYS go over a MeshCall tunnel (normal or E2E).
//   2. If a device is locally pinned in IndexedDB (`require_e2ee: true`) OR reports `mode_hint === "encrypted"`:
//      - NEVER downgrade to a plain tunnel, even if the server lies and sends a plain `mtun_` credential.
//      - ONLY use the locally pinned `device_pub` (from a QR / `aa-pair://v1/...` link, or a server hint that a
//        pairing-code handshake proved), never an unproven server hint.
//      - First-time pairing persists trust in IndexedDB BEFORE opening the `Noise_IKpsk2` tunnel.
//      - Subsequent connections use `Noise_IK` with the browser's persistent X25519 private key.

import { Mesh, Router, UnauthenticatedError, type RpcDuplex } from "meshcall/web"

import type { ControlPlaneClient } from "@/lib/mesh/control-client"
import { buildCodePairingPayload, buildWebTrustRecord, PairingError, parsePairingUri } from "@/lib/mesh/pairing"
import { vault } from "@/lib/storage/idb"
import type {
  DeviceMode,
  DeviceRecord,
  PairingPayload,
  DeviceSettings,
  DeviceStatus,
  ListDirsResult,
  Message,
  OpenTunnelResponse,
  PairedClientEntry,
  ReadFileResult,
  PreparedAgent,
  Session,
  SessionListPayload,
  TerminalAttachRequest,
  TerminalInfo,
  TerminalInputFrame,
  TerminalOutputFrame,
  WatchEvent,
} from "@/lib/types/v3"

export type { TerminalAttachRequest, TerminalInputFrame, TerminalOutputFrame } from "@/lib/types/v3"

const SESSIONS_SVC = "aa.v3.Sessions"
const DEVICE_SVC = "aa.v3.Device"
const TERMINALS_SVC = "aa.v3.Terminals"

interface PooledTunnel {
  deviceId: string
  mode: DeviceMode
  tunnelId: string
  expiresAtMs: number
  mesh: Mesh
}

function toWebSocketUrl(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`
  return url
}

export class DeviceTunnelManager {
  private readonly accountId: string
  private readonly control: ControlPlaneClient
  private readonly pool = new Map<string, PooledTunnel>()
  private readonly connecting = new Map<string, Promise<PooledTunnel>>()

  constructor(accountId: string, control: ControlPlaneClient) {
    this.accountId = accountId
    this.control = control
  }

  async closeDevice(deviceId: string): Promise<void> {
    const existing = this.pool.get(deviceId)
    this.pool.delete(deviceId)
    if (existing) {
      await existing.mesh.close().catch(() => undefined)
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.pool.values()]
    this.pool.clear()
    await Promise.all(entries.map((entry) => entry.mesh.close().catch(() => undefined)))
  }

  /**
   * First-time out-of-band pairing (`Noise_IKpsk2_25519_AESGCM_SHA256`) with a pasted `aa-pair://v1/` link.
   * Persists `require_e2ee: true` + `device_pub` to IndexedDB BEFORE opening the tunnel.
   */
  async pairEncryptedDevice(
    rawUri: string,
    deviceNameHint?: string
  ): Promise<{ deviceId: string; status: DeviceStatus; trustPub: string }> {
    return this.pairWith(parsePairingUri(rawUri), deviceNameHint, "link")
  }

  /**
   * First-time pairing with a code typed by the user (e2ee-admission-proposal §4.1). The device key is the
   * control plane's hint; the PSK handshake authenticates it, and it is pinned only after that handshake succeeds.
   */
  async pairEncryptedDeviceWithCode(
    device: Pick<DeviceRecord, "id" | "name" | "e2e_public_key_hint">,
    code: string
  ): Promise<{ deviceId: string; status: DeviceStatus; trustPub: string }> {
    const payload = await buildCodePairingPayload(code, device)
    return this.pairWith(payload, device.name, "code")
  }

  private async pairWith(
    payload: PairingPayload,
    deviceNameHint: string | undefined,
    source: "link" | "code"
  ): Promise<{ deviceId: string; status: DeviceStatus; trustPub: string }> {
    const deviceId = payload.instance_id

    // A pin is never replaced by a pasted link: a different key could be a forged link or a lying server.
    // Re-pairing with a new key needs the user to remove the old trust record explicitly (Settings).
    const previous = await vault.getDeviceTrust(this.accountId, deviceId)
    if (previous && previous.device_pub !== payload.device_pub) {
      throw new PairingError(
        "device_pub_mismatch",
        "This pairing link carries a different device key than the one pinned in this browser. " +
          "If the device really was reset, remove its local trust record in Settings first, then pair again."
      )
    }

    // Step 1 (link): lock the local trust record BEFORE contacting the server or opening the tunnel, so nothing in
    // between can talk plaintext to this device; it is rolled back below if the pairing does not complete.
    // A code's key comes from the server and must not be pinned before the PSK handshake proves it (a pin left
    // behind by a crash would let whoever holds that key pass the later IK handshakes), so it is saved after.
    const trustRecord = buildWebTrustRecord(payload, deviceNameHint)
    if (source === "link") await vault.saveDeviceTrust(this.accountId, trustRecord)
    const rollback = async () => {
      if (source === "code") return
      if (previous) await vault.saveDeviceTrust(this.accountId, previous)
      else await vault.removeDeviceTrust(this.accountId, deviceId)
    }

    let mesh: Mesh | undefined
    try {
      // Step 2: Obtain browser static X25519 keypair from IndexedDB.
      const identity = await vault.getOrCreateClientIdentity()

      // Step 3: Request E2E tunnel through control plane gate.
      const opened = await this.control.openTunnel({
        deviceId,
        e2eKey: payload.device_pub,
      })
      if (!opened.credential.startsWith("mtun_e2e.")) {
        throw new PairingError(
          "e2e_required_locally",
          "Control plane returned a non-E2E tunnel credential for a locally pinned encrypted device"
        )
      }

      // Step 4: Connect with Noise_IKpsk2 (verifying device static key + one-time PSK).
      await this.closeDevice(deviceId)
      mesh = new Mesh(new Router(toWebSocketUrl(opened.router_url)), {
        tunnel: opened.credential,
        e2eKey: payload.device_pub,
        e2eIdentity: {
          privateKey: identity.privateKey,
          instanceId: deviceId,
          pairing: { id: payload.pairing_id, psk: payload.psk },
        },
      })
      await mesh.connect()
      // An encrypted device serves only paired peers: an answer means the device accepted the pairing.
      const status = await mesh.unary<Record<string, never>, DeviceStatus>(DEVICE_SVC, "status", {})
      if (source === "code") await vault.saveDeviceTrust(this.accountId, trustRecord)
      const pooled: PooledTunnel = {
        deviceId,
        mode: "encrypted",
        tunnelId: opened.tunnel_id,
        expiresAtMs: Date.parse(opened.expires_at) || Date.now() + 3600_000,
        mesh,
      }
      this.pool.set(deviceId, pooled)
      return { deviceId, status, trustPub: payload.device_pub }
    } catch (err) {
      await mesh?.close().catch(() => undefined)
      await rollback().catch(() => undefined)
      if (err instanceof PairingError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (/expired/i.test(msg)) throw new PairingError("pairing_expired", msg)
      if (/used|consumed/i.test(msg)) throw new PairingError("pairing_used", msg)
      throw new PairingError("e2e_handshake_failed", msg)
    }
  }

  private async openTunnelForDevice(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    forceRefresh = false
  ): Promise<PooledTunnel> {
    // A tunnel credential's expiry only limits NEW connections (architecture §3.2): an established Mesh keeps
    // working past `expires_at`, and closing it would cut every live watch / terminal on it. So reuse it until a
    // call says the credential is no longer accepted (`forceRefresh` after `UnauthenticatedError`).
    const existing = this.pool.get(device.id)
    if (!forceRefresh && existing) return existing
    // One open at a time per device, refresh or not: concurrent refreshes would each replace the pool entry
    // and leak the Meshes they lost to.
    const inflight = this.connecting.get(device.id)
    if (inflight) return inflight

    const stale = existing
    const task = (async (): Promise<PooledTunnel> => {
      if (stale) {
        // Only reached on forceRefresh: the old credential was refused, so streams on it are failing anyway.
        if (this.pool.get(device.id) === stale) this.pool.delete(device.id)
        await stale.mesh.close().catch(() => undefined)
      }
      const trust = await vault.getDeviceTrust(this.accountId, device.id)
      const requireE2ee = Boolean(trust?.require_e2ee) || device.mode_hint === "encrypted"

      if (requireE2ee && !trust) {
        throw new PairingError(
          "e2e_not_paired",
          "This encrypted device is not paired with this browser yet; enter its pairing code or paste its pairing link."
        )
      }

      const opened: OpenTunnelResponse = await this.control.openTunnel({
        deviceId: device.id,
        ...(trust ? { e2eKey: trust.device_pub } : {}),
      })

      if (requireE2ee) {
        if (!opened.credential.startsWith("mtun_e2e.")) {
          throw new PairingError(
            "e2e_required_locally",
            "Refused plaintext tunnel for an encrypted device."
          )
        }
        const identity = await vault.getOrCreateClientIdentity()
        const mesh = new Mesh(new Router(toWebSocketUrl(opened.router_url)), {
          tunnel: opened.credential,
          e2eKey: trust!.device_pub,
          e2eIdentity: {
            privateKey: identity.privateKey,
            instanceId: device.id,
          },
        })
        try {
          await mesh.connect()
        } catch (err) {
          await mesh.close().catch(() => undefined)
          throw new PairingError(
            "e2e_handshake_failed",
            err instanceof Error ? err.message : "E2E Noise_IK handshake failed"
          )
        }
        const pooled: PooledTunnel = {
          deviceId: device.id,
          mode: "encrypted",
          tunnelId: opened.tunnel_id,
          expiresAtMs: Date.parse(opened.expires_at) || Date.now() + 3600_000,
          mesh,
        }
        this.pool.set(device.id, pooled)
        return pooled
      }

      // Normal mode device (also unified through MeshCall tunnel, never proxied by server-v3).
      const mesh = new Mesh(new Router(toWebSocketUrl(opened.router_url)), {
        tunnel: opened.credential,
      })
      await mesh.connect()
      const pooled: PooledTunnel = {
        deviceId: device.id,
        mode: "normal",
        tunnelId: opened.tunnel_id,
        expiresAtMs: Date.parse(opened.expires_at) || Date.now() + 3600_000,
        mesh,
      }
      this.pool.set(device.id, pooled)
      return pooled
    })()

    this.connecting.set(device.id, task)
    try {
      return await task
    } finally {
      if (this.connecting.get(device.id) === task) this.connecting.delete(device.id)
    }
  }

  /**
   * Run a stream on the device's tunnel. If it is refused as unauthenticated before yielding anything (the pooled
   * credential expired and the Mesh had to reconnect), open a fresh tunnel once and start over.
   */
  private async *streamWithRefresh<T>(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    open: (mesh: Mesh) => AsyncIterable<T>
  ): AsyncGenerator<T, void, void> {
    let pooled = await this.openTunnelForDevice(device, false)
    let yielded = false
    try {
      for await (const item of open(pooled.mesh)) {
        yielded = true
        yield item
      }
      return
    } catch (err) {
      if (!(err instanceof UnauthenticatedError)) throw err
      if (yielded) {
        // Refused mid-stream: let the caller's reconnect start on a fresh tunnel.
        await this.evict(device.id, pooled)
        throw err
      }
    }
    pooled = await this.openTunnelForDevice(device, true)
    yield* open(pooled.mesh)
  }

  private async callUnary<Req, Res>(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    service: string,
    method: string,
    req: Req,
    options?: { timeoutMs?: number }
  ): Promise<Res> {
    try {
      const pooled = await this.openTunnelForDevice(device, false)
      return await pooled.mesh.unary<Req, Res>(service, method, req, options)
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        const pooled = await this.openTunnelForDevice(device, true)
        return await pooled.mesh.unary<Req, Res>(service, method, req, options)
      }
      throw err
    }
  }

  // ── aa.v3.Sessions ──

  listSessions(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    limit?: number
  ): Promise<SessionListPayload> {
    return this.callUnary(device, SESSIONS_SVC, "list", limit != null ? { limit } : {})
  }

  /**
   * Start the agent before the conversation exists, for its options (see `PreparedAgent`). The first start of an
   * `npx` agent can take minutes: on a deadline, prepare again and it joins the start still in progress.
   */
  prepareSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    payload: { agent: string; cwd?: string }
  ): Promise<PreparedAgent> {
    return this.callUnary(device, SESSIONS_SVC, "prepare", payload, { timeoutMs: 120_000 })
  }

  createSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    payload: { agent: string; cwd?: string; title?: string; config?: Record<string, string>; prepared_id?: string }
  ): Promise<Session> {
    return this.callUnary(device, SESSIONS_SVC, "create", payload)
  }

  renameSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string,
    title: string
  ): Promise<Session> {
    return this.callUnary(device, SESSIONS_SVC, "rename", { id, title })
  }

  deleteSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string
  ): Promise<{ ok: true }> {
    return this.callUnary(device, SESSIONS_SVC, "delete", { id })
  }

  async *watchSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    sessionId: string,
    signal?: AbortSignal
  ): AsyncGenerator<WatchEvent, void, void> {
    const stream = this.streamWithRefresh(device, (mesh) =>
      mesh.serverStream<{ id: string }, WatchEvent>(
        SESSIONS_SVC,
        "watch",
        { id: sessionId },
        signal ? { signal } : undefined
      )
    )
    for await (const ev of stream) {
      if (signal?.aborted) break
      yield ev
    }
  }

  listMessages(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    params: { id: string; before_seq?: number; limit?: number }
  ): Promise<{ messages: Message[]; has_more: boolean; next_cursor?: string }> {
    return this.callUnary(device, SESSIONS_SVC, "list_messages", params)
  }

  sendMessage(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    payload: {
      id: string
      client_msg_id: string
      content?: string
      delivery?: "auto" | "steer" | "queue"
      attachments?: { path: string; name?: string; mime?: string; size?: number }[]
    }
  ): Promise<{ message_id: string; session_id: string; delivered: "started" | "steered" | "queued" }> {
    return this.callUnary(device, SESSIONS_SVC, "send", payload)
  }

  answerApproval(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    payload: { id: string; request_id: string; option_id: string; reason?: string }
  ): Promise<{ ok: true }> {
    return this.callUnary(device, SESSIONS_SVC, "answer", payload)
  }

  stopSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string
  ): Promise<{ ok: true }> {
    return this.callUnary(device, SESSIONS_SVC, "stop", { id })
  }

  setSessionConfig(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string,
    configId: string,
    value: string
  ): Promise<Session> {
    return this.callUnary(device, SESSIONS_SVC, "set_config", {
      id,
      config_id: configId,
      value,
    })
  }

  rewindSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string,
    messageId: string,
    content?: string
  ): Promise<{ message_id?: string }> {
    return this.callUnary(device, SESSIONS_SVC, "rewind", {
      id,
      message_id: messageId,
      ...(content ? { content } : {}),
    })
  }

  forkSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string,
    messageId: string,
    title?: string
  ): Promise<Session> {
    return this.callUnary(device, SESSIONS_SVC, "fork", {
      id,
      message_id: messageId,
      ...(title ? { title } : {}),
    })
  }

  /** Remove a queued message (`aa.v3.Sessions/unqueue`). */
  cancelQueued(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string,
    clientMsgId: string
  ): Promise<{ ok: true }> {
    return this.callUnary(device, SESSIONS_SVC, "unqueue", {
      id,
      client_msg_id: clientMsgId,
    })
  }

  /** Ask the agent to compact its context (agents that offer `/compact`). */
  compactSession(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string,
    instructions?: string
  ): Promise<{ message_id: string }> {
    return this.callUnary(device, SESSIONS_SVC, "compact", {
      id,
      ...(instructions ? { instructions } : {}),
    })
  }

  steerQueued(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string,
    clientMsgId: string
  ): Promise<{ delivered: "steered" }> {
    return this.callUnary(device, SESSIONS_SVC, "steer_queued", {
      id,
      client_msg_id: clientMsgId,
    })
  }

  // ── aa.v3.Device ──

  getDeviceStatus(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">
  ): Promise<DeviceStatus> {
    return this.callUnary(device, DEVICE_SVC, "status", {})
  }

  getDeviceSettings(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">
  ): Promise<DeviceSettings> {
    return this.callUnary(device, DEVICE_SVC, "get_settings", {})
  }

  updateDeviceSettings(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    patch: Partial<DeviceSettings>
  ): Promise<DeviceSettings> {
    return this.callUnary(device, DEVICE_SVC, "update_settings", patch)
  }

  listDirs(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    dirPath?: string
  ): Promise<ListDirsResult> {
    return this.callUnary(device, DEVICE_SVC, "list_dirs", dirPath ? { path: dirPath } : {})
  }

  readFile(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    filePath: string,
    options?: { offsetBytes?: number; maxBytes?: number }
  ): Promise<ReadFileResult> {
    return this.callUnary(device, DEVICE_SVC, "read_file", {
      path: filePath,
      ...(options?.offsetBytes != null ? { offset_bytes: options.offsetBytes } : {}),
      ...(options?.maxBytes != null ? { max_bytes: options.maxBytes } : {}),
    })
  }

  gitStatus(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    cwd: string
  ): Promise<{ is_repo: boolean; [k: string]: unknown }> {
    return this.callUnary(device, DEVICE_SVC, "git_status", { cwd })
  }

  gitDiff(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    cwd: string,
    options?: { filePath?: string; staged?: boolean }
  ): Promise<{ is_repo: boolean; diff?: string; truncated?: boolean; bytes?: number }> {
    return this.callUnary(device, DEVICE_SVC, "git_diff", {
      cwd,
      ...(options?.filePath ? { file_path: options.filePath } : {}),
      ...(options?.staged != null ? { staged: options.staged } : {}),
    })
  }

  /**
   * Store an attachment (≤ the device's `max_rpc_file_bytes`) on the device. With `session_id` the device files it
   * under the conversation's project (`.agents-anywhere/attachments/<id>/`, client-experience-proposal §3.1).
   */
  saveAttachment(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    payload: { name: string; base64: string; mime?: string; session_id?: string }
  ): Promise<{ id: string; path: string; name: string; mime: string; size: number }> {
    return this.callUnary(device, DEVICE_SVC, "save_attachment", payload)
  }

  /**
   * Have the device download a Cloud Drive transfer into the conversation's attachment folder (verifying `sha256`,
   * decrypting with `file_key` when the file was encrypted for an E2EE device). Older Connectors answer
   * `method_not_found`.
   */
  fetchDriveFile(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    payload: {
      session_id: string
      file_id: string
      name: string
      mime?: string
      sha256?: string
      file_key?: string
    }
  ): Promise<{ path: string; name: string; mime: string; size: number }> {
    return this.callUnary(device, DEVICE_SVC, "fetch_drive_file", payload)
  }

  listPairedClients(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">
  ): Promise<{ clients: PairedClientEntry[] }> {
    return this.callUnary(device, DEVICE_SVC, "list_paired_clients", {})
  }

  revokePairedClient(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    clientPub: string
  ): Promise<{ ok: true; revoked: boolean }> {
    return this.callUnary(device, DEVICE_SVC, "revoke_paired_client", {
      client_pub: clientPub,
    })
  }

  /** A one-time pairing for another client: a code to type in (`kind: "code"`) or an `aa-pair://` link. */
  createPairing(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    options?: {
      kind?: "link" | "code"
      ttl_ms?: number
      label?: string
      platform?: "ios" | "android" | "desktop" | "web"
    }
  ): Promise<{ uri?: string; code?: string; pairing_id: string; expires_at: string; fingerprint?: string }> {
    return this.callUnary(device, DEVICE_SVC, "create_pairing", options ?? {})
  }

  // ── aa.v3.Terminals ──

  listTerminals(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">
  ): Promise<{ terminals: TerminalInfo[] }> {
    return this.callUnary(device, TERMINALS_SVC, "list", {})
  }

  createTerminal(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    options?: { cwd?: string; shell?: string; cols?: number; rows?: number }
  ): Promise<TerminalInfo> {
    return this.callUnary(device, TERMINALS_SVC, "create", options ?? {})
  }

  closeTerminal(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    id: string
  ): Promise<{ ok: true }> {
    return this.callUnary(device, TERMINALS_SVC, "close", { id })
  }

  /**
   * Open the `attach` duplex (thin transport only). Control rules, seq tracking and reconnects live in
   * `lib/terminal/session.ts`; `lib/terminal/mesh-transport.ts` adapts this call to it.
   */
  async attachTerminal(
    device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">,
    request: TerminalAttachRequest,
    signal?: AbortSignal
  ): Promise<RpcDuplex<TerminalInputFrame, TerminalOutputFrame>> {
    const pooled = await this.openTunnelForDevice(device, false)
    const duplex = pooled.mesh.duplex<TerminalAttachRequest, TerminalInputFrame, TerminalOutputFrame>(
      TERMINALS_SVC,
      "attach",
      request,
      signal ? { signal } : undefined
    )
    // The call opens lazily, so a refused credential only shows while reading: evict the tunnel then, and the
    // caller's next attach opens a fresh one.
    const evict = (err: unknown) => {
      if (err instanceof UnauthenticatedError) void this.evict(device.id, pooled)
    }
    const wrapped: RpcDuplex<TerminalInputFrame, TerminalOutputFrame> = {
      get trailers() {
        return duplex.trailers
      },
      send: (item) => duplex.send(item),
      closeSend: () => duplex.closeSend(),
      cancel: (reason) => duplex.cancel(reason),
      next: async () => {
        try {
          return await duplex.next()
        } catch (err) {
          evict(err)
          throw err
        }
      },
      return: async (value?: unknown) =>
        duplex.return ? duplex.return(value) : { done: true, value: undefined },
      [Symbol.asyncIterator]() {
        return wrapped
      },
    }
    return wrapped
  }

  /** Drop a pooled tunnel whose credential was refused, if it is still the pooled one. */
  private async evict(deviceId: string, pooled: PooledTunnel): Promise<void> {
    if (this.pool.get(deviceId) !== pooled) return
    this.pool.delete(deviceId)
    await pooled.mesh.close().catch(() => undefined)
  }
}
