import { resolve } from 'node:path'

import type { RuntimeInstanceSpec, RuntimeRegistry } from '../application/index.js'
import type { Log } from '../application/ports/index.js'
import { DshBridgeListener, type DshHostConnection } from '../host/index.js'
import { DSH_RUNTIME_TYPE, DshRuntime, dshHomeOf, dshPluginRoute, parseDshSettings } from '../runtime/profiles/dsh/index.js'

export interface DshHostsOptions {
  /** Where the rendezvous file and the socket live: `~/.agents-anywhere/dsh-bridge`. */
  readonly dir: string
  /** This Connector process (names the socket; plugins see it as `connectorInstance`). */
  readonly instanceId: string
  readonly connectorVersion: string
  readonly registry: RuntimeRegistry
  readonly log: Log
  /** A host now serves `spec` (its native sessions can be read through the instance). */
  readonly onAttached?: (spec: RuntimeInstanceSpec) => void
  readonly env?: NodeJS.ProcessEnv
}

/**
 * The DSH instance a host serves: the enabled one whose DSH home is the host's, else the default instance (which then
 * reports a home mismatch itself when the homes differ).
 */
export function dshInstanceFor(instances: readonly RuntimeInstanceSpec[], dshHome: string | undefined, env: NodeJS.ProcessEnv = process.env): RuntimeInstanceSpec | null {
  const candidates = instances.filter(spec => spec.enabled && spec.runtimeType === DSH_RUNTIME_TYPE)
  if (dshHome !== undefined && dshHome !== '') {
    const wanted = resolve(dshHome)
    const match = candidates.find(spec => resolve(dshHomeOf(parseDshSettings(spec.settings as Record<string, unknown>), env)) === wanted)
    if (match !== undefined) return match
  }
  return candidates.find(spec => spec.runtimeId === spec.runtimeType) ?? candidates[0] ?? null
}

/**
 * DSH hosts with the Agents Anywhere plugin (contracts/dsh-bridge/3.0) for one running Connector: the local socket
 * they dial, and each verified connection attached to the DSH instance it serves as that instance's plugin route.
 */
export class DshHosts {
  private readonly listener: DshBridgeListener
  private accepting = true

  public constructor(private readonly options: DshHostsOptions) {
    this.listener = new DshBridgeListener({
      dir: options.dir,
      instanceId: options.instanceId,
      connectorVersion: options.connectorVersion,
      accepting: () => this.accepting,
      onConnection: connection => void this.attach(connection),
    })
  }

  /** Whether a host is connected now. */
  public connected(): boolean {
    return this.listener.connectedHosts().length > 0
  }

  public async start(): Promise<void> {
    await this.listener.start()
  }

  public async stop(): Promise<void> {
    this.accepting = false
    await this.listener.stop()
  }

  private async attach(connection: DshHostConnection): Promise<void> {
    const { hello, socket } = connection
    const spec = dshInstanceFor(this.options.registry.instances(), hello.dshHome, this.options.env)
    const handle = spec === null ? null : await this.options.registry.handle(spec.runtimeId).catch(() => null)
    if (spec === null || !(handle instanceof DshRuntime) || socket.destroyed) {
      socket.destroy()
      this.options.log('warn', `DSH host ${hello.hostInstance} was not attached: ${spec === null ? 'no enabled DSH instance' : 'the DSH instance did not start'}`)
      return
    }
    const problem = handle.attachHost(dshPluginRoute(connection, spec.runtimeId))
    if (problem !== undefined) {
      this.options.log('warn', `DSH host ${hello.hostInstance} refused for ${spec.runtimeId}: ${problem.message}`)
      return
    }
    this.options.log('info', `DSH host ${hello.hostInstance} (${hello.hostKind}, DSH ${hello.dshVersion}) serves ${spec.runtimeId}`)
    this.options.onAttached?.(spec)
  }
}
