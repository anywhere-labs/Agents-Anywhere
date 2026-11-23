// Browser MeshCall client for `aa.v3.Control/*` via `meshcall/web`.
// Automatically obtains and renews Router `mt_` tokens from `server-v3` (`POST /auth/router-token`)
// whenever a Router restarts (401 / UnauthenticatedError) or tokens near expiry.

import { Mesh, Router, UnauthenticatedError } from "meshcall/web"

import { issueClientRouterToken } from "@/lib/api/control-http"
import type {
  DeviceRecord,
  DeviceSessionResult,
  OpenTunnelResponse,
  RouterTokenEntry,
  WatchDevicesEvent,
} from "@/lib/types/v3"

const CONTROL_SERVICE = "aa.v3.Control"

export interface ControlPlaneCredentials {
  serverUrl: string
  getAccessToken: () => Promise<string>
  clientId: string
}

function toWebRouterUrl(rawUrl: string): string {
  // MeshCall web supports both ws(s):// and http(s)://; prefer ws(s):// when provided.
  return rawUrl.trim()
}

export class ControlPlaneClient {
  private readonly creds: ControlPlaneCredentials
  private mesh: Mesh | null = null
  private activeToken: RouterTokenEntry | null = null
  private connectInFlight: Promise<Mesh> | null = null

  constructor(creds: ControlPlaneCredentials) {
    this.creds = creds
  }

  private isTokenFresh(entry: RouterTokenEntry): boolean {
    const exp = Date.parse(entry.expires_at)
    if (!Number.isFinite(exp)) return true
    return exp - Date.now() > 60_000
  }

  private async ensureMesh(forceRefresh = false): Promise<Mesh> {
    if (!forceRefresh && this.mesh && this.activeToken && this.isTokenFresh(this.activeToken)) {
      return this.mesh
    }
    if (this.connectInFlight && !forceRefresh) return this.connectInFlight

    this.connectInFlight = (async () => {
      await this.close()
      const bearer = await this.creds.getAccessToken()
      const issued = await issueClientRouterToken(
        this.creds.serverUrl,
        bearer,
        this.creds.clientId
      )
      const entry = issued.tokens[0]
      if (!entry) {
        throw new Error("Control plane returned no configured MeshCall routers")
      }
      const router = new Router(toWebRouterUrl(entry.router_url))
      const mesh = new Mesh(router, { token: entry.token })
      await mesh.connect()
      this.mesh = mesh
      this.activeToken = entry
      return mesh
    })()

    try {
      return await this.connectInFlight
    } finally {
      this.connectInFlight = null
    }
  }

  private async callUnary<Req, Res>(method: string, req: Req): Promise<Res> {
    try {
      const mesh = await this.ensureMesh(false)
      return await mesh.unary<Req, Res>(CONTROL_SERVICE, method, req)
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        const mesh = await this.ensureMesh(true)
        return await mesh.unary<Req, Res>(CONTROL_SERVICE, method, req)
      }
      throw err
    }
  }

  /**
   * Run a control-plane stream; if the Router refuses the token before the first item (it restarted, so every
   * token it issued is gone), fetch a fresh token once and start over.
   */
  private async *streamWithRefresh<T>(open: (mesh: Mesh) => AsyncIterable<T>): AsyncGenerator<T, void, void> {
    let yielded = false
    try {
      for await (const item of open(await this.ensureMesh(false))) {
        yielded = true
        yield item
      }
      return
    } catch (err) {
      if (yielded || !(err instanceof UnauthenticatedError)) throw err
    }
    yield* open(await this.ensureMesh(true))
  }

  async close(): Promise<void> {
    const m = this.mesh
    this.mesh = null
    this.activeToken = null
    if (m) {
      await m.close().catch(() => undefined)
    }
  }

  async listDevices(): Promise<DeviceRecord[]> {
    const res = await this.callUnary<Record<string, never>, { devices: DeviceRecord[] }>(
      "list_devices",
      {}
    )
    return res.devices ?? []
  }

  async getDevice(deviceId: string): Promise<DeviceRecord> {
    return this.callUnary<{ device_id: string }, DeviceRecord>("get_device", {
      device_id: deviceId,
    })
  }

  async renameDevice(deviceId: string, name: string): Promise<DeviceRecord> {
    return this.callUnary<{ device_id: string; name: string }, DeviceRecord>("rename_device", {
      device_id: deviceId,
      name,
    })
  }

  async deleteDevice(deviceId: string): Promise<boolean> {
    const res = await this.callUnary<{ device_id: string }, { ok: boolean }>("delete_device", {
      device_id: deviceId,
    })
    return Boolean(res.ok)
  }

  async pingDevice(deviceId: string): Promise<{ ok: boolean; server_time: string }> {
    return this.callUnary("ping_device", { device_id: deviceId })
  }

  async checkDeviceUpdate(deviceId: string, channel?: string): Promise<boolean> {
    const res = await this.callUnary<{ device_id: string; channel?: string }, { ok: boolean }>(
      "check_device_update",
      channel ? { device_id: deviceId, channel } : { device_id: deviceId }
    )
    return Boolean(res.ok)
  }

  async openTunnel(params: {
    deviceId: string
    e2eKey?: string
  }): Promise<OpenTunnelResponse> {
    return this.callUnary("open_tunnel", {
      device_id: params.deviceId,
      client_id: this.creds.clientId,
      ...(params.e2eKey ? { e2e_key: params.e2eKey } : {}),
    })
  }

  async revokeTunnel(deviceId: string, tunnelId: string): Promise<{ ok: boolean }> {
    return this.callUnary("revoke_tunnel", {
      device_id: deviceId,
      tunnel_id: tunnelId,
    })
  }

  async listSessionsOnce(params?: {
    deviceIds?: string[]
    limitPerDevice?: number
  }): Promise<DeviceSessionResult[]> {
    const res = await this.callUnary<
      { device_ids?: string[]; limit_per_device?: number },
      { results: DeviceSessionResult[] }
    >("list_sessions_once", {
      ...(params?.deviceIds ? { device_ids: params.deviceIds } : {}),
      ...(params?.limitPerDevice ? { limit_per_device: params.limitPerDevice } : {}),
    })
    return res.results ?? []
  }

  async *watchDevices(signal?: AbortSignal): AsyncGenerator<WatchDevicesEvent, void, void> {
    const stream = this.streamWithRefresh((mesh) =>
      mesh.serverStream<Record<string, never>, WatchDevicesEvent>(
        CONTROL_SERVICE,
        "watch_devices",
        {},
        signal ? { signal } : undefined
      )
    )
    for await (const ev of stream) {
      if (signal?.aborted) break
      yield ev
    }
  }

  async *listSessionsStream(
    params?: { deviceIds?: string[]; limitPerDevice?: number },
    signal?: AbortSignal
  ): AsyncGenerator<DeviceSessionResult, void, void> {
    const stream = this.streamWithRefresh((mesh) =>
      mesh.serverStream<{ device_ids?: string[]; limit_per_device?: number }, DeviceSessionResult>(
        CONTROL_SERVICE,
        "list_sessions",
        {
          ...(params?.deviceIds ? { device_ids: params.deviceIds } : {}),
          ...(params?.limitPerDevice ? { limit_per_device: params.limitPerDevice } : {}),
        },
        signal ? { signal } : undefined
      )
    )
    for await (const item of stream) {
      if (signal?.aborted) break
      yield item
    }
  }
}
