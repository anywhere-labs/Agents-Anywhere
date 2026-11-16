import { startHostProcess, type HostProcess, type HostProcessOptions } from './host-process.js'

/** Messages to Desktop's main process over `process.parentPort` (Electron utilityProcess). */
export type DesktopHostMessage =
  | { type: 'ready'; kind: 'connector.ready'; version: 1; instanceId: string; pid: number; endpoint: unknown; key: string }
  | { type: 'failed'; code: string; message: string }
  | { type: 'stopped'; reason: 'shutdown' | 'handed_over' | 'parent_gone' }

/** Messages from Desktop: `shutdown` before quitting. */
export type DesktopParentMessage = { type: 'shutdown' }

export interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  once?(event: 'close', listener: () => void): void
}

/**
 * The Connector inside Desktop's utility process (04-connector.md §9.4): the same control channel as
 * `anywhere-cli rpc`, but the ready descriptor goes over `parentPort` instead of stdout. Desktop then calls
 * `aa.local.v2.Control` exactly as with the v2 Connector; ownership conflicts are Control errors
 * (`connector_already_running` with `details.decision`). A start-up failure is posted as `failed` with its code.
 */
export async function runDesktopHost(port: ParentPort | undefined = (process as unknown as { parentPort?: ParentPort }).parentPort, options: Pick<HostProcessOptions, 'home' | 'routerBinary' | 'compose'> = {}): Promise<void> {
  if (port === undefined) throw new Error('desktop-host must run in an Electron utility process (no parentPort)')
  let host: HostProcess
  let stop!: (reason: 'shutdown' | 'handed_over' | 'parent_gone') => void
  const stopped = new Promise<'shutdown' | 'handed_over' | 'parent_gone'>(resolve => {
    stop = resolve
  })
  try {
    host = await startHostProcess({ kind: 'desktop-workbench', ...(process.env.MESHCALL_ROUTER_BINARY ? { routerBinary: process.env.MESHCALL_ROUTER_BINARY } : {}), ...options, onHandedOver: () => stop('handed_over') })
  } catch (error) {
    port.postMessage({ type: 'failed', code: String((error as { code?: unknown }).code ?? 'connector_error'), message: (error as Error).message } satisfies DesktopHostMessage)
    throw error
  }
  port.on('message', event => {
    if ((event.data as DesktopParentMessage | null)?.type === 'shutdown') stop('shutdown')
  })
  port.once?.('close', () => stop('parent_gone'))
  port.postMessage({ type: 'ready', kind: 'connector.ready', version: 1, ...host.descriptor } satisfies DesktopHostMessage)
  const reason = await stopped
  await host.shutdown()
  port.postMessage({ type: 'stopped', reason } satisfies DesktopHostMessage)
}
