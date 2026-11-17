// Device side of `Commands/previewOpen` and `Commands/previewClose` (contracts/preview/1.0) and of automatic
// closing when a previewed port stops listening (09-port-preview.md §5.4).
import type { PreviewCloseCommand } from '../../generated/preview/v1_0/preview-close-command.js'
import type { PreviewOpenCommand } from '../../generated/preview/v1_0/preview-open-command.js'
import { WorkspaceError } from '../errors.js'
import type { ListeningPort } from '../ports.js'
import { decidePortShare } from './port-share.js'
import type { PreviewTransport } from './frpc-manager.js'

export interface PreviewCommandDeps {
  readonly transport: PreviewTransport
  /** The ports listening right now (the Connector's `listeningPorts`). */
  readonly listening: () => Promise<ListeningPort[]>
  /**
   * The session a port's bindings belong to, or null (PortShare refuses it). Read when a preview opens, from the
   * process tree and session output at that moment (`host-wiring.ts`).
   */
  readonly sessionOf: (bindings: readonly ListeningPort[]) => Promise<string | null>
}

export interface PreviewOpenResult {
  readonly previewId: string
  readonly port: number
  readonly localIP: string
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value === '') throw new WorkspaceError('invalid_argument', `${name} is required`)
  return value
}

export function previewCommands(deps: PreviewCommandDeps): {
  previewOpen(payload: PreviewOpenCommand): Promise<PreviewOpenResult>
  previewClose(payload: PreviewCloseCommand): Promise<{ readonly closed: boolean }>
  portClosed(port: number): Promise<string[]>
} {
  return {
    async previewOpen(payload) {
      const previewId = text(payload.previewId, 'previewId')
      const open = deps.transport.openPreviews()
      const listening = await deps.listening()
      const bindings = listening.filter(entry => entry.port === payload.port)
      const session = bindings.length === 0 ? null : await deps.sessionOf(bindings)
      const decision = decidePortShare(payload.port, listening, open.length, open.some(p => p.previewId === previewId), () => session)
      await deps.transport.open({
        previewId,
        slug: text(payload.slug, 'slug'),
        port: decision.port,
        localIP: decision.localIP,
        token: text(payload.frpToken, 'frpToken'),
        tokenExpiresAt: text(payload.tokenExpiresAt, 'tokenExpiresAt'),
        frpsAddr: text(payload.frpsAddr, 'frpsAddr'),
      })
      return { previewId, port: decision.port, localIP: decision.localIP }
    },
    async previewClose(payload) {
      return { closed: await deps.transport.close(text(payload.previewId, 'previewId')) }
    },
    portClosed(port) {
      return deps.transport.closePort(port)
    },
  }
}
