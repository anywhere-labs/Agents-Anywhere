// Registry of every secure channel on the device: revoking a client closes its channels at once, and a directory key rotation pushes the new key to the remaining channels.

import type { TrustEvent } from '../domain/trust/index.js'
import { DeviceSecureChannel, type DeviceChannelDeps, type SecureChannelOpen } from './device-channel.js'
import type { ChannelWire } from './transport.js'

export class SecureChannelHub {
  readonly #deps: DeviceChannelDeps
  readonly #channels = new Set<DeviceSecureChannel>()
  readonly #unsubscribe: () => void

  constructor(deps: DeviceChannelDeps) {
    this.#deps = deps
    this.#unsubscribe = deps.trust.onEvent((event) => void this.#onTrustEvent(event))
  }

  /** A `Secure/channel` call arrived (link layer) or a tunnel opened (tests, local transports). */
  open(open: SecureChannelOpen, wire: ChannelWire): DeviceSecureChannel {
    const channel = new DeviceSecureChannel(open, wire, this.#deps)
    if (!channel.isClosed) {
      this.#channels.add(channel)
      channel.onClose(() => this.#channels.delete(channel))
    }
    return channel
  }

  get size(): number {
    return this.#channels.size
  }

  channelsOf(clientId: string): DeviceSecureChannel[] {
    return [...this.#channels].filter((channel) => channel.clientId === clientId)
  }

  /** Policy changed locally or the device shuts down. */
  async closeAll(reason: 'policy' | 'shutdown'): Promise<void> {
    await Promise.all([...this.#channels].map((channel) => channel.close(reason)))
  }

  dispose(): void {
    this.#unsubscribe()
  }

  async #onTrustEvent(event: TrustEvent): Promise<void> {
    switch (event.type) {
      case 'ClientRevoked':
        await Promise.all(this.channelsOf(event.clientId).map((channel) => channel.close('revoked', 'e2ee_not_paired')))
        return
      case 'DirectoryKeyRotated': {
        // Only clients that still hold a grant get the new key; the revoked one is filtered out even if its
        // channel has not finished closing yet.
        const active = new Set(this.#deps.trust.activeClientIds())
        const recipients = [...this.#channels].filter((channel) => channel.isOpen && active.has(channel.clientId))
        const grant = await this.#deps.trust.directoryKeyGrant()
        await Promise.all(
          recipients
            .map((channel) => channel.pushEvent({ type: 'e2ee.directory_key', payload: grant })),
        )
        return
      }
      case 'ClientPaired': {
        const list = this.#deps.trust.trustList()
        const active = new Set(this.#deps.trust.activeClientIds())
        await Promise.all(
          [...this.#channels]
            .filter((channel) => channel.isOpen && active.has(channel.clientId))
            .map((channel) => channel.pushEvent({ type: 'e2ee.trust_changed', payload: list })),
        )
        return
      }
      default:
        return
    }
  }
}
