import { startHostProcess, type HostProcessOptions } from './host-process.js'

export const READY_KIND = 'connector.ready'
export const READY_VERSION = 1

/**
 * `anywhere-cli rpc` (local-machine 2.0, control channel): one ready line on stdout, then nothing else is ever written
 * there; the host talks to `aa.local.v2.Control` / `Logs` with the `host` key it carries. Closing stdin shuts the
 * Connector, and with it the Router, down.
 */
export async function runRpc(options: Omit<HostProcessOptions, 'kind' | 'echo'> & { kind?: HostProcessOptions['kind'] }, io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = { stdin: process.stdin, stdout: process.stdout }): Promise<void> {
  let handedOver!: () => void
  const exit = new Promise<void>(resolve => {
    handedOver = resolve
  })
  const host = await startHostProcess({ ...options, kind: options.kind ?? (process.env.AA_CONNECTOR_OWNER_KIND === 'dsh-plugin' ? 'dsh-plugin' : process.env.AA_CONNECTOR_OWNER_KIND === 'desktop-workbench' ? 'desktop-workbench' : 'cli'), onHandedOver: () => handedOver() })
  io.stdout.write(`${JSON.stringify({ kind: READY_KIND, version: READY_VERSION, ...host.descriptor })}\n`)
  const stdinClosed = new Promise<void>(resolve => {
    io.stdin.on('data', () => undefined)
    io.stdin.once('end', () => resolve())
    io.stdin.once('close', () => resolve())
    io.stdin.once('error', () => resolve())
    io.stdin.resume()
  })
  await Promise.race([stdinClosed, exit])
  await host.shutdown()
}
