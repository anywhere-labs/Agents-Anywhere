import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import {
  ConnectorAlreadyRunning,
  ownerAlive,
  readRuntimeState,
  requestClientPairing,
  routerDirectory,
  runtimeRecordPath,
  systemHome,
  type ClientPairingInvitation,
  type ConnectorState,
  type OwnerView,
  type PairingStatus,
  type PendingConfirmation,
  type TerminalConfirmer,
} from '../host/index.js'
import { startHostProcess, CONNECTOR_VERSION, type HostProcess, type HostProcessOptions } from './host-process.js'
import { terminalQr } from './qr.js'
import { runRpc } from './rpc.js'

export interface CliIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

/**
 * Asks the person at this terminal a yes/no question; anything but yes, an abort or an error is a no. Default: a
 * prompt when stdin and stdout are a TTY, otherwise none (a request with nobody to ask is refused).
 */
export type CliConfirm = (question: readonly string[], signal: AbortSignal) => Promise<boolean>

export interface CliOptions {
  readonly io?: CliIo
  /** The terminal confirmation for client approvals (tests); `null` = this terminal cannot answer. */
  readonly confirm?: CliConfirm | null
  /** Colours for the pairing QR code (default: when writing to a terminal). */
  readonly color?: boolean
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
  pair-client  show a pairing code for a client in encrypted mode (asks the running Connector, or starts one)
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

/** A y/N prompt on the process's terminal; aborting closes it unanswered (a no). */
const ttyConfirm: CliConfirm = async (question, signal) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    for (const line of question.slice(0, -1)) process.stderr.write(`${line}\n`)
    const answer = await rl.question(`${question.at(-1) ?? ''} [y/N] `, { signal })
    return /^y(es)?$/iu.test(answer.trim())
  } catch {
    return false
  } finally {
    rl.close()
  }
}

function defaultConfirm(): CliConfirm | null {
  return process.stdin.isTTY === true && process.stderr.isTTY === true ? ttyConfirm : null
}

/** §7.2 on this terminal: who approved whom, and the fingerprint to compare with the new client's screen. */
function terminalConfirmer(confirm: CliConfirm): TerminalConfirmer {
  return (request: PendingConfirmation, signal: AbortSignal) => confirm([
    '',
    `The paired client "${request.approverLabel}" asks to authorise a new client on this computer:`,
    `  name:        ${request.label || '(unnamed)'}`,
    `  fingerprint: ${request.fingerprint}`,
    `Compare the fingerprint with the one the new client shows. Unanswered, this is refused at ${request.expiresAt}.`,
    'Authorise this client?',
  ], signal)
}

/** The live Connector that owns this computer, other than this process; null when there is none. */
async function liveOwner(home: string): Promise<OwnerView | null> {
  try {
    const owner = (await readRuntimeState(runtimeRecordPath(home))).runtime
    if (owner === undefined || !(await ownerAlive(owner))) return null
    return { kind: owner.kind, pid: owner.pid, instanceId: owner.instanceId, connectorVersion: owner.connectorVersion ?? null }
  } catch {
    // An unreadable record: starting here reports it properly.
    return null
  }
}

function printInvitation(io: CliIo, invitation: ClientPairingInvitation, color: boolean): void {
  io.out('Scan this code with the Agents Anywhere app, or paste the link into the client:')
  for (const line of terminalQr(invitation.uri, { color })) io.out(line)
  io.out(invitation.uri)
  io.out(`Device fingerprint: ${invitation.fingerprint}`)
  io.out(`It works once and expires at ${invitation.expiresAt}.`)
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
  const color = options.color ?? (options.io === undefined && process.stdout.isTTY === true)
  const home = options.home ?? systemHome()
  // The Connector already running on this computer (Desktop, the DSH plugin, another `start`) serves the pairing:
  // single instance, and its psk lives in that process.
  const askOwner = async (owner: OwnerView): Promise<number> => {
    try {
      const invitation = await requestClientPairing(owner, routerDirectory(home))
      printInvitation(io, invitation, color)
      io.out(`The Connector already running on this computer (${owner.kind}, PID ${owner.pid}) serves this pairing; keep it running until the client has paired.`)
      return 0
    } catch (error) {
      io.err((error as Error).message)
      return 1
    }
  }
  if (command === 'pair-client') {
    const owner = await liveOwner(home)
    if (owner !== null) return askOwner(owner)
  }
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
  // This process hosts the Connector: approvals are confirmed on its terminal (none without a TTY: refused).
  const confirm = options.confirm === undefined ? defaultConfirm() : options.confirm
  if (confirm !== null) host.confirmations.useTerminal(terminalConfirmer(confirm))
  try {
    if (command === 'configure') {
      const saved = await host.controller.saveConfig(flags)
      io.out(`saved credentials for ${saved.connectorId} at ${host.controller.getPaths().configPath}`)
      return 0
    }
    if (command === 'pair-client') {
      // No Connector was running: this process becomes it, and must keep running for the client to pair.
      if (host.controller.getConfig().serverUrl === '') {
        io.err('pair this Connector with a Server first (anywhere-cli pair <server>)')
        return 1
      }
      try {
        await host.controller.start()
      } catch (error) {
        // Another host started in between: ask it instead, once this process has let go (shutdown is idempotent).
        if (error instanceof ConnectorAlreadyRunning) {
          await host.shutdown()
          return await askOwner(error.owner)
        }
        throw error
      }
      printInvitation(io, await host.startClientPairing(), color)
      io.out(`connector ${CONNECTOR_VERSION} running; keep it running until the client has paired, then press Ctrl-C to stop`)
    } else if (command === 'pair') {
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
    if (command !== 'pair-client') io.out(`connector ${CONNECTOR_VERSION} running; press Ctrl-C to stop`)
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
