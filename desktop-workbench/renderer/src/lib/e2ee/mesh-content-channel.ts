import { Mesh, MeshCallError, Router, type RpcStream } from "meshcall/web"

import type { ContentPairRequest } from "@/generated/device-content/v1_0/content-pair-request"
import type { ContentPairResult } from "@/generated/device-content/v1_0/content-pair-result"
import type { ContentRequest } from "@/generated/device-content/v1_0/content-request"
import type { ContentResult } from "@/generated/device-content/v1_0/content-result"
import type { ContentSubscribeRequest } from "@/generated/device-content/v1_0/content-subscribe-request"
import type { ContentTunnelGrant } from "@/generated/device-content/v1_0/content-tunnel-grant"
import type { EncryptedTunnelGrant } from "@/generated/device-content/v1_0/encrypted-tunnel-grant"
import type { MobileContentTunnelRequest } from "@/generated/device-content/v1_0/mobile-content-tunnel-request"
import { ApiError, apiErrorKind } from "@/lib/api/errors"

import { ChannelClosedError, type ChannelMethod, type SubscribeTarget } from "./content-channel"

const CONTENT = "aa.device.v1.Content"
const SERVER_CONTROL = "aa.server.v1.MobileControl"

function encryptedMesh(grant: EncryptedTunnelGrant): Mesh {
  if (!grant.credential.startsWith("mtun_e2e.") || !grant.e2e_key) {
    throw new ChannelClosedError("e2ee_required")
  }
  // Retrying a write is a business operation. MeshCall must not replay one implicitly.
  return new Mesh(new Router(grant.router_url), { tunnel: grant.credential, e2eKey: grant.e2e_key, retry: false })
}

function callError(error: unknown): ChannelClosedError {
  if (error instanceof ChannelClosedError) return error
  if (error instanceof MeshCallError) {
    const reason = error.details?.reason
    const code = typeof reason === "string" ? reason : error.code
    return new ChannelClosedError(code, error.message)
  }
  return new ChannelClosedError("connection_lost", (error as Error | undefined)?.message)
}

export async function openMeshContent(
  bootstrap: () => Promise<EncryptedTunnelGrant>,
  deviceId: string,
  pin: string,
): Promise<MeshContentChannel> {
  const controlGrant = await bootstrap()
  const server = encryptedMesh(controlGrant)
  try {
    const device = await server.unary<MobileContentTunnelRequest, ContentTunnelGrant>(
      SERVER_CONTROL, "issue_content_tunnel", { deviceId }, { instance: controlGrant.instance_id },
    )
    if (device.instance_id !== deviceId || device.e2e_key !== pin) {
      throw new ChannelClosedError("device_pin_mismatch")
    }
    return new MeshContentChannel(encryptedMesh(device), deviceId)
  } catch (error) {
    if (error instanceof MeshCallError && typeof error.details?.httpStatus === "number") {
      const status = error.details.httpStatus
      throw new ApiError({ status, kind: apiErrorKind(status), code: error.code, detail: error.message })
    }
    throw callError(error)
  } finally {
    await server.close()
  }
}

export class MeshContentChannel {
  readonly #streams = new Map<string, RpcStream<Record<string, unknown>>>()
  readonly #closeListeners = new Set<(error: ChannelClosedError) => void>()
  readonly #channelListeners = new Set<(event: Record<string, unknown>) => void>()
  #metadata: Record<string, string> | undefined
  #closed: ChannelClosedError | undefined
  #closing: Promise<void> | undefined
  #subscriptionId = 0

  constructor(private readonly mesh: Mesh, private readonly deviceId: string) {}

  async pair(request: ContentPairRequest): Promise<ContentPairResult> {
    try {
      return await this.mesh.unary<ContentPairRequest, ContentPairResult>(
        CONTENT, "pair", request, { instance: this.deviceId },
      )
    } catch (error) {
      throw callError(error)
    }
  }

  authorize(clientId: string, secret: string): void {
    this.#metadata = { "aa-content-client": clientId, "aa-content-credential": secret }
  }

  watchTrust(): void {
    this.#subscribe({ stream: "trust" }, (event) => {
      for (const listener of this.#channelListeners) listener(event)
    })
  }

  onChannelEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.#channelListeners.add(listener)
    return () => this.#channelListeners.delete(listener)
  }

  onClose(listener: (error: ChannelClosedError) => void): () => void {
    if (this.#closed) listener(this.#closed)
    else this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  async request(method: ChannelMethod, path: string, body: unknown = null): Promise<{ status: number; body: unknown }> {
    if (this.#closed) throw this.#closed
    try {
      const result = await this.mesh.unary<ContentRequest, ContentResult>(
        CONTENT, "request", { method, path, body: body as ContentRequest["body"] },
        { instance: this.deviceId, metadata: this.#metadata, timeoutMs: 75_000 },
      )
      return { status: result.status, body: result.body ?? null }
    } catch (error) {
      const failure = callError(error)
      this.#end(failure)
      throw failure
    }
  }

  async subscribe(target: SubscribeTarget, onEvent: (event: Record<string, unknown>) => void): Promise<string> {
    return this.#subscribe(target, onEvent)
  }

  async unsubscribe(id: string): Promise<void> {
    const stream = this.#streams.get(id)
    this.#streams.delete(id)
    await stream?.cancel()
  }

  async close(): Promise<void> {
    this.#end(new ChannelClosedError("closed"))
    await this.#closing
  }

  #subscribe(target: ContentSubscribeRequest, onEvent: (event: Record<string, unknown>) => void): string {
    if (this.#closed) throw this.#closed
    const id = String(++this.#subscriptionId)
    const stream = this.mesh.serverStream<ContentSubscribeRequest, Record<string, unknown>>(
      CONTENT, "subscribe", target, { instance: this.deviceId, metadata: this.#metadata },
    )
    this.#streams.set(id, stream)
    void (async () => {
      try {
        for await (const event of stream) if (this.#streams.has(id)) onEvent(event)
        if (this.#streams.has(id)) this.#end(new ChannelClosedError("connection_lost"))
      } catch (error) {
        if (this.#streams.has(id)) this.#end(callError(error))
      } finally {
        this.#streams.delete(id)
      }
    })()
    return id
  }

  #end(error: ChannelClosedError): void {
    if (this.#closed) return
    this.#closed = error
    this.#closing = this.mesh.close().catch(() => undefined)
    this.#streams.clear()
    for (const listener of this.#closeListeners) listener(error)
    this.#closeListeners.clear()
    this.#channelListeners.clear()
  }
}
