import type { LinkHello } from '../generated/device-meshcall/v1_0/link-hello.js'
import type { LinkWelcome } from '../generated/device-meshcall/v1_0/link-welcome.js'
import type { Egress } from './egress.js'
import { HttpError, requestJson } from './http.js'

/** The device's long-lived credential, as `/api/v3/device/auth` wants it (`Connector <deviceId>:<token>`). */
export interface DeviceCredential {
  readonly deviceId: string
  readonly token: string
}

export interface ControlPlaneOptions {
  /** Server origin, e.g. `https://aa.example.com`. */
  readonly serverUrl: string
  /** Read on every request, so a rotated credential is picked up. */
  readonly credential: () => Promise<DeviceCredential> | DeviceCredential
  readonly egress: () => Egress
  readonly connectorVersion: string
  readonly os: string
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** `LinkWelcome.mesh` after parsing: what one registration needs. */
export interface MeshGrant {
  readonly routerUrl: string
  readonly token: string
  readonly tokenId: string | null
  readonly instanceId: string
  /** Unix ms; null when the Server gave none. */
  readonly expiresAt: number | null
  /** Services the token may register; null means the Server did not say (register everything). */
  readonly services: readonly string[] | null
  readonly maxFrameBytes: number | null
}

export const MESH_MAX_FRAME_BYTES = 4 * 1024 * 1024

export function meshGrant(welcome: LinkWelcome): MeshGrant {
  const mesh = welcome.mesh
  const expires = mesh.expiresAt === undefined || mesh.expiresAt === null ? Number.NaN : Date.parse(mesh.expiresAt)
  return {
    routerUrl: mesh.routerUrl,
    token: mesh.token,
    tokenId: mesh.tokenId ?? null,
    instanceId: mesh.instanceId,
    expiresAt: Number.isNaN(expires) ? null : expires,
    services: Array.isArray(mesh.services) ? mesh.services : null,
    maxFrameBytes: typeof mesh.maxFrameBytes === 'number' ? mesh.maxFrameBytes : null,
  }
}

/**
 * The Server's device handshake over HTTPS (06-protocols.md §2.2): `auth` trades the device credential for a
 * 15-minute access token, `hello` returns `LinkWelcome` (Router token, connection generation, floors, pending
 * commands), `ready` asks a worker to hold `Link/attach` and `Link/outbox`. Requests take the same egress as the
 * MeshCall link.
 */
export class ControlPlane {
  private access: { token: string; expiresAt: number } | null = null
  private readonly base: URL

  public constructor(private readonly options: ControlPlaneOptions) {
    this.base = new URL(options.serverUrl.endsWith('/') ? options.serverUrl : `${options.serverUrl}/`)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\//u, ''), this.base)
  }

  private headers(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}`, 'x-device-os': this.options.os, 'x-connector-version': this.options.connectorVersion }
  }

  /** Drops the cached access token (the next call authenticates again). */
  public invalidate(): void {
    this.access = null
  }

  public async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.access !== null && this.access.expiresAt - this.now() > 60_000) return this.access.token
    const credential = await this.options.credential()
    const response = await requestJson<{ accessToken: string; expiresIn?: number }>(this.options.egress, {
      method: 'POST',
      url: this.url('api/v3/device/auth'),
      headers: { authorization: `Connector ${credential.deviceId}:${credential.token}`, 'x-device-os': this.options.os, 'x-connector-version': this.options.connectorVersion },
      timeoutMs: this.options.timeoutMs ?? 15_000,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (typeof response?.accessToken !== 'string') throw new HttpError(502, 'bad_response', 'device auth returned no accessToken', response)
    this.access = { token: response.accessToken, expiresAt: this.now() + (typeof response.expiresIn === 'number' ? response.expiresIn : 900) * 1000 }
    return this.access.token
  }

  /** A call with the access token; a 401 re-authenticates once (the token may have been revoked early). */
  private async authorized<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(signal)
      try {
        return await requestJson<T>(this.options.egress, {
          method: 'POST',
          url: this.url(path),
          headers: this.headers(token),
          body,
          timeoutMs: this.options.timeoutMs ?? 15_000,
          ...(signal !== undefined ? { signal } : {}),
        })
      } catch (error) {
        if (error instanceof HttpError && error.status === 401 && attempt === 0) {
          this.invalidate()
          continue
        }
        throw error
      }
    }
  }

  public async hello(body: Omit<LinkHello, 'connectorVersion' | 'os'>, signal?: AbortSignal): Promise<LinkWelcome> {
    const welcome = await this.authorized<LinkWelcome>('api/v3/device/hello', { ...body, connectorVersion: this.options.connectorVersion, os: this.options.os }, signal)
    if (typeof welcome?.connectionId !== 'string' || typeof welcome.mesh?.token !== 'string' || typeof welcome.mesh.routerUrl !== 'string') {
      throw new HttpError(502, 'bad_response', 'LinkWelcome lacks connectionId or mesh credentials', welcome)
    }
    return welcome
  }

  public async ready(connectionId: string, signal?: AbortSignal): Promise<void> {
    await this.authorized('api/v3/device/ready', { connectionId }, signal)
  }
}
