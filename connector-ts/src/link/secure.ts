import { MeshCallError, type DuplexChannel, type RpcContext } from 'meshcall'

import type { SecureChannelHandler } from './services.js'

/** What `channel/`'s `SecureChannelHub` offers (structural, so `link/` does not depend on `channel/`). */
/** One `SecureChannelItem` (`{n, ct}`): the Noise frame counter and the ciphertext. */
export interface SecureChannelFrame {
  readonly n: number
  readonly ct: string
}

export interface SecureChannelWire {
  send(item: SecureChannelFrame): void | Promise<void>
  /** Ends the channel; `code` travels as the MeshCall error code. */
  end(code?: string): void
}

export interface SecureChannelLike {
  readonly isClosed: boolean
  receive(item: SecureChannelFrame): Promise<void>
  close(reason: 'shutdown', code?: string): Promise<void>
}

export interface SecureChannelHubLike {
  open(open: { clientId: string; ch: string }, wire: SecureChannelWire): SecureChannelLike
}

/**
 * `Secure/channel` (06-protocols.md §2.3, `11-e2ee-noise.md` §8) on top of F's `SecureChannelHub`: one MeshCall
 * duplex call per client channel. Items received are handed to the channel strictly in order; `wire.end(code)`
 * ends the call (with `code` as the MeshCall error); the client closing its side, or the call being cancelled,
 * closes the channel.
 */
export function secureChannelVia(hub: SecureChannelHubLike): SecureChannelHandler {
  return async (request: Record<string, unknown>, duplex: DuplexChannel<Record<string, unknown>, Record<string, unknown>>, context: RpcContext): Promise<void> => {
    let finish!: (code: string | undefined) => void
    const ended = new Promise<string | undefined>(resolve => {
      finish = resolve
    })
    const channel = hub.open({ clientId: String(request.clientId), ch: String(request.ch) }, {
      send: item => duplex.send({ ...item }),
      end: code => finish(code),
    })
    const onAbort = (): void => {
      void channel.close('shutdown').catch(() => undefined)
      finish(undefined)
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    void (async () => {
      try {
        for await (const item of duplex) {
          if (channel.isClosed) break
          await channel.receive({ n: Number(item.n), ct: String(item.ct ?? '') })
        }
      } catch {
        // The call ended under us; the channel is closed below.
      }
      if (!channel.isClosed) await channel.close('shutdown').catch(() => undefined)
      finish(undefined)
    })()
    try {
      const code = await ended
      if (code !== undefined) throw new MeshCallError(code, 'secure channel closed')
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  }
}
