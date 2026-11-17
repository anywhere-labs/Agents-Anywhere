// Port preview wired into a Connector host (09-port-preview.md §5): the `preview.open` / `preview.close` commands,
// the port watcher whose `port.listening` / `port.closed` events go out on `Link/attach`, and closing the previews
// of a port that stopped listening. A host passes `commands` and `onLink` to `connectorRuntime` (ComposeOptions).
import { join } from 'node:path'

import type { CommandHandler } from '../../application/inbound/index.js'
import type { PreviewCloseCommand } from '../../generated/preview/v1_0/preview-close-command.js'
import type { PreviewOpenCommand } from '../../generated/preview/v1_0/preview-open-command.js'
import { listeningPorts, PortWatcher, type ListeningPort } from '../ports.js'
import { previewCommands } from './commands.js'
import { FrpcManager, type PreviewTransport } from './frpc-manager.js'
import { annotatePorts, processParents, sessionOfPort, type ProcessParents, type SessionHints } from './session-ports.js'

/** The Server keeps the last port list per device; a reconnected link or restarted Server gets it again this often. */
export const PORT_REFRESH_MS = 60_000

const NO_HINTS: SessionHints = { roots: new Map(), mentioned: new Map() }

export interface PreviewHostOptions {
  /** The frpc binary (bundled with Desktop, downloaded by the CLI); `null` refuses every preview. */
  readonly frpcPath: string | null
  /** The Connector's data directory; frpc's private config goes under `preview/`. */
  readonly dataDir: string
  /** This device's id, read when a link starts (the config can change between runs). */
  readonly deviceId: () => string
  /** frpc's outbound proxy; the device link's egress when the host knows it. */
  readonly proxyUrl?: string | null
  /** Root processes of sessions and URLs they printed (the Runtime and terminals provide them). */
  readonly hints?: () => SessionHints
  /**
   * The link's E2EE mode, read for every `port.listening`. Under `required` the event carries only the port and its
   * session (11-e2ee-noise.md §10): process ids and names and printed URLs stay on the device. Omitted means `off`.
   */
  readonly e2eeMode?: () => 'off' | 'required'
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** Test seams. */
  readonly transport?: PreviewTransport
  readonly list?: () => Promise<ListeningPort[]>
  readonly parents?: () => Promise<ProcessParents>
  readonly intervalMs?: number
  readonly refreshMs?: number
}

export interface PreviewHost {
  /** Command handlers by business method name, for `ComposeOptions.commands`. */
  readonly commands: Readonly<Record<string, CommandHandler>>
  /** For `ComposeOptions.onLink`: watches ports for this link (a new link replaces the previous watch). */
  onLink(link: AttachTarget): void
  /** Stops watching and closes every preview. */
  close(): Promise<void>
}

type Emit = (method: 'port.listening' | 'port.closed', payload: Record<string, unknown>) => void

/** What the wiring needs of a device link: its `Link/attach` events (LiveEvents). */
export interface AttachTarget {
  readonly attach: { emit(method: string, payload: Record<string, unknown>): void }
}

export function previewHost(options: PreviewHostOptions): PreviewHost {
  const log = options.log ?? (() => undefined)
  const list = options.list ?? (() => listeningPorts())
  const transport = options.transport ?? new FrpcManager({
    frpcPath: options.frpcPath,
    dir: join(options.dataDir, 'preview'),
    proxyUrl: options.proxyUrl ?? null,
    log: message => log('info', message),
  })
  const readParents = (): Promise<ProcessParents> => (options.parents ?? (() => processParents()))().catch(() => new Map<number, number>())
  const preview = previewCommands({
    transport,
    listening: list,
    // A preview opens only for a port a session on this device started or printed (PortShare, 09 §4.1).
    sessionOf: async bindings => {
      if (bindings.length === 0) return null
      return sessionOfPort(bindings[0]!.port, bindings.map(b => b.pid), options.hints?.() ?? NO_HINTS, await readParents())
    },
  })
  let stop: (() => void) | null = null

  /** The watcher's list with each port's session and URL (preview 1.0 `ListeningPort`). */
  const annotated = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const wire = Array.isArray(payload.ports) ? (payload.ports as { port: number; pid: number | null; processName: string | null }[]) : []
    const ports: ListeningPort[] = wire.map(port => ({ port: port.port, address: '', pid: port.pid, process: port.processName ?? '' }))
    const parents = await readParents()
    return { deviceId: payload.deviceId, ports: annotatePorts(ports, options.hints?.() ?? NO_HINTS, parents, options.e2eeMode?.() ?? 'off') }
  }

  const watch = (emit: Emit, deviceId: string): (() => void) => {
    let latest: Record<string, unknown> | null = null
    // Annotation is async: keep the events of one watcher in order.
    let queue: Promise<void> = Promise.resolve()
    const watcher = new PortWatcher({
      deviceId,
      list,
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      emit: (method, payload) => {
        queue = queue.then(async () => {
          if (method === 'port.closed') {
            const port = Number(payload.port)
            const closed = await preview.portClosed(port).catch(() => [] as string[])
            if (closed.length > 0) log('info', `port ${port} stopped listening; closed preview ${closed.join(', ')}`)
            emit('port.closed', payload)
            return
          }
          latest = await annotated(payload)
          emit('port.listening', latest)
        }).catch(error => log('warn', `port event failed: ${(error as Error).message}`))
      },
    })
    watcher.start()
    // Ports with nobody watching them change rarely; repeat the list so a reconnect or a Server restart still has it.
    const refresh = setInterval(() => {
      const ports = latest?.ports
      if (Array.isArray(ports) && ports.length > 0) queue = queue.then(() => emit('port.listening', latest!))
    }, options.refreshMs ?? PORT_REFRESH_MS)
    refresh.unref()
    return () => {
      watcher.stop()
      clearInterval(refresh)
    }
  }

  const handler = <T>(run: (payload: T) => Promise<object>): CommandHandler => async payload => ({ ...(await run(payload as T)) })

  return {
    commands: {
      'preview.open': handler<PreviewOpenCommand>(payload => preview.previewOpen(payload)),
      'preview.close': handler<PreviewCloseCommand>(payload => preview.previewClose(payload)),
    },
    onLink(link) {
      stop?.()
      const deviceId = options.deviceId()
      stop = deviceId === '' ? null : watch((method, payload) => link.attach.emit(method, payload), deviceId)
    },
    async close() {
      stop?.()
      stop = null
      await transport.closeAll().catch(() => undefined)
    },
  }
}
