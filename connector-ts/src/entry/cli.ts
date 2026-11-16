import { parseArgs } from 'node:util'

import { ConnectorAlreadyRunning, type ConnectorState, type PairingStatus } from '../host/index.js'
import { startHostProcess, CONNECTOR_VERSION, type HostProcess, type HostProcessOptions } from './host-process.js'
import { runRpc } from './rpc.js'

/** F's client pairing (DeviceTrustService.startPairing), when this build has it. */
export type ClientPairing = (serverUrl: string) => Promise<{ readonly uri: string; readonly payload: { readonly expiresAt: string } }>

export interface CliIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export interface CliOptions {
  readonly io?: CliIo
  readonly clientPairing?: ClientPairing
  /** The OS user's home (tests). */
  readonly home?: string
  readonly routerBinary?: string
  /** Composition overrides (tests run the store in-process). */
  readonly compose?: HostProcessOptions['compose']
  /** Resolves to end a foreground command (tests); default SIGINT/SIGTERM. */
  readonly until?: Promise<void>
}

const USAGE = `usage: anywhere-cli <command> [options]

commands:
  start        start the Connector (saved configuration, or --server-url/--connector-id/--connector-token)
  pair [url]   pair with a Server, save the credentials and start (--no-start to only save)
  configure    save credentials (--server-url --connector-id --connector-token)
  pair-client  show the pairing code for a client in encrypted mode
  rpc          serve the local control API (aa.local.v2) for Desktop and plugins

common options: --config <path>  --debug  --version`

const EXIT_CONFLICT = 2

function signals(): Promise<void> {
  return new Promise(resolve => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
}

function describe(state: ConnectorState): string {
  return state.lastError === null ? state.status : `${state.status}: ${state.lastError}`
}

/** Follows state and pairing events until `stop` resolves or `onEvent` returns true. */
async function follow(host: HostProcess, stop: Promise<void>, onEvent: (kind: string, payload: ConnectorState | PairingStatus) => boolean | void): Promise<void> {
  const abort = new AbortController()
  void stop.then(() => abort.abort())
  for await (const event of host.events.hub.subscribe(host.events.hub.lastSeq, abort.signal)) {
    if (onEvent(event.kind, event.item) === true) break
  }
  abort.abort()
}

/** `anywhere-cli`: the same commands as the v2 CLI (`start`, `pair`, `configure`, `rpc`) plus `pair-client`. Returns the exit code. */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? { out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`) }
  const [command, ...rest] = argv
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        debug: { type: 'boolean', default: false },
        'server-url': { type: 'string' },
        'connector-id': { type: 'string' },
        'connector-token': { type: 'string' },
        timeout: { type: 'string', default: '600' },
        'poll-interval': { type: 'string', default: '2' },
        'no-start': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    io.err((error as Error).message)
    io.err(USAGE)
    return 64
  }
  const values = parsed.values as Record<string, string | boolean | undefined>
  if (command === '--version' || values.version === true) {
    io.out(CONNECTOR_VERSION)
    return 0
  }
  const configPath = typeof values.config === 'string' ? values.config : undefined
  const debug = values.debug === true
  const flags = { serverUrl: values['server-url'], connectorId: values['connector-id'], connectorToken: values['connector-token'] }
  const until = options.until ?? signals()
  switch (command) {
    case 'rpc':
      await runRpc({ ...(configPath !== undefined ? { configPath } : {}), debug, ...(options.home !== undefined ? { home: options.home } : {}), ...(options.routerBinary !== undefined ? { routerBinary: options.routerBinary } : {}) })
      return 0
    case 'configure':
    case 'start':
    case 'pair':
    case 'pair-client':
      break
    default:
      io.err(USAGE)
      return command === undefined || command === 'help' || command === '--help' ? 0 : 64
  }
  let handedOver!: () => void
  const exit = new Promise<void>(resolve => {
    handedOver = resolve
  })
  const host = await startHostProcess({ kind: 'cli', ...(options.compose !== undefined ? { compose: options.compose } : {}), ...(configPath !== undefined ? { configPath } : {}), debug, ...(options.home !== undefined ? { home: options.home } : {}), ...(options.routerBinary !== undefined ? { routerBinary: options.routerBinary } : {}), echo: (level, message) => io.err(`[${level}] ${message}`), onHandedOver: () => handedOver() })
  const stop = Promise.race([until, exit])
  try {
    if (command === 'configure') {
      const saved = await host.controller.saveConfig(flags)
      io.out(`saved credentials for ${saved.connectorId} at ${host.controller.getPaths().configPath}`)
      return 0
    }
    if (command === 'pair-client') {
      if (options.clientPairing === undefined) {
        io.err('client pairing (encrypted mode) is not available in this build')
        return 1
      }
      const settings = host.controller.getConfig()
      if (settings.serverUrl === '') {
        io.err('pair this Connector with a Server first (anywhere-cli pair <server>)')
        return 1
      }
      const invitation = await options.clientPairing(settings.serverUrl)
      io.out('Scan this pairing link with the Agents Anywhere app, or open it on the client:')
      io.out(invitation.uri)
      io.out(`It expires at ${invitation.payload.expiresAt}.`)
      return 0
    }
    if (command === 'pair') {
      const server = parsed.positionals[0] ?? flags.serverUrl ?? null
      let claimed = false
      const following = follow(host, stop, (kind, payload) => {
        if (kind !== 'pairing') return
        const pairing = payload as PairingStatus
        if (pairing.status === 'waiting') {
          io.out(`Pairing code: ${pairing.code}`)
          io.out('Claim it from the web UI')
        } else if (pairing.status === 'claimed') {
          claimed = true
          io.out(`Paired as ${pairing.config?.connectorId}; credentials saved to ${host.controller.getPaths().configPath}`)
          return true
        } else if (pairing.status !== 'starting') {
          io.err(`pairing ${pairing.status}${pairing.error ? `: ${pairing.error}` : ''}`)
          return true
        }
      })
      await host.controller.startPairing({ server, timeout: Number(values.timeout), pollInterval: Number(values['poll-interval']), ...(values['no-start'] === true ? { start: false } : {}) })
      await following
      if (!claimed) return 1
      if (values['no-start'] === true) return 0
    } else {
      const given = flags.serverUrl !== undefined || flags.connectorId !== undefined || flags.connectorToken !== undefined
      await host.controller.start(given ? flags : undefined)
    }
    io.out(`connector ${CONNECTOR_VERSION} running; press Ctrl-C to stop`)
    let failed = false
    await follow(host, stop, (kind, payload) => {
      if (kind !== 'state') return
      const state = payload as ConnectorState
      if (!state.running) {
        failed = state.lastError !== null
        io.err(`connector ${describe(state)}`)
        return true
      }
    })
    return failed ? 1 : 0
  } catch (error) {
    if (error instanceof ConnectorAlreadyRunning) {
      io.err(error.message)
      return EXIT_CONFLICT
    }
    io.err((error as Error).message)
    return 1
  } finally {
    await host.shutdown()
  }
}
