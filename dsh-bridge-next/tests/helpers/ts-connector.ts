import { accessSync, constants, existsSync } from 'node:fs'
import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Mesh, Router } from 'meshcall'
import { ControlServiceClient } from '../../src/host/generated/connector-control.js'

/** The v3 Connector's sources next to this package; integration tests run it from source. */
export const connectorTs = new URL('../../../connector-ts/', import.meta.url)
export const connectorTsInstalled = existsSync(new URL('node_modules/meshcall/package.json', connectorTs))

/**
 * The MeshCall Router the Connector's meshcall version needs (0.4.0-dev has no release to download): the same lookup
 * as connector-ts/test/support/mesh-harness.ts.
 */
export function v3RouterBinary(): string | undefined {
  for (const path of [process.env['MESHCALL_V3_ROUTER_BINARY'], process.env['MESHCALL_ROUTER_BINARY'], '/tmp/aa-mc/bin/meshcall-router']) {
    if (!path) continue
    try { accessSync(path, constants.X_OK); return path } catch { /* next */ }
  }
  return undefined
}

/**
 * Takes the machine for a Connector bound to `id`, as a Connector start does: the record in
 * `<home>/.agents-anywhere/connector-runtime.json` names this process as the owner and lists `id`. Returns the release.
 */
export async function holdConnectorLease(home: string, id: string): Promise<() => Promise<void>> {
  const host = await import(new URL('src/host/index.ts', connectorTs).href) as typeof import('../../../connector-ts/src/host/index.js')
  const store = await import(new URL('src/store/index.ts', connectorTs).href) as typeof import('../../../connector-ts/src/store/index.js')
  const lease = new host.RuntimeLease({ path: host.runtimeRecordPath(home), identity: { kind: 'dsh-plugin', version: '3.0.0-test', schemaVersion: store.SCHEMA_VERSION } })
  await lease.acquire({ connectorId: id, serverUrl: 'https://example.test' })
  return () => lease.release()
}

/** Records `id` as a Connector of this computer, as a Connector that started and stopped leaves it. */
export async function recordConnectorId(home: string, id: string): Promise<void> {
  await (await holdConnectorLease(home, id))()
}

/**
 * Runs what the plugin launches (`anywhere-cli.js rpc --config …`) from the Connector's sources instead, through
 * connector-ts/test/support/e2e-device.ts: the same CLI, with `home` in place of the OS user's home, no system
 * keychain and the store in the Connector's main thread.
 */
export function sourceConnectorLauncher(home: string) {
  return (_command: string, args: string[], options: SpawnOptionsWithoutStdio) => spawn(process.execPath, [
    '--experimental-transform-types', '--no-warnings',
    '--import', new URL('test/support/ts-resolve.mjs', connectorTs).href,
    fileURLToPath(new URL('test/support/e2e-device.ts', connectorTs)), home,
    // The plugin's command line after the bundled entry (and Electron's preload, absent here).
    ...args.slice(args.indexOf('rpc')),
  ], { ...options, env: { ...options.env, NODE_OPTIONS: '' } })
}

/**
 * A Connector serving its control channel (`anywhere-cli rpc`) as the host `kind` launches it, with the plugin's own
 * Control client connected to it.
 */
export function launchRpcConnector(home: string, kind: 'desktop-workbench' | 'dsh-plugin') {
  const child = sourceConnectorLauncher(home)(process.execPath, ['anywhere-cli.js', 'rpc', '--config', join(home, kind, 'connector.json')], {
    env: { ...process.env, AA_CONNECTOR_OWNER_KIND: kind, AGENT_CONNECTOR_DATA_DIR: join(home, 'v3') },
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000) })
  let mesh: Mesh | undefined
  const ready = new Promise<ControlServiceClient>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    lines.once('line', line => {
      const value = JSON.parse(line) as { endpoint: { unixPath: string } | { pipe: string }, key: string }
      mesh = new Mesh(new Router(value.endpoint), { token: value.key })
      mesh.connect().then(() => resolve(new ControlServiceClient(mesh!)), reject)
    })
    child.once('exit', () => reject(new Error(`Connector exited: ${stderr}`)))
  })
  void ready.catch(() => undefined)
  return {
    child,
    get stderr() { return stderr },
    control: () => ready,
    /** Closing stdin is how a host stops it; `crash` kills it instead. */
    async close(crash = false) {
      await mesh?.close().catch(() => undefined)
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      if (crash) child.kill('SIGKILL')
      else child.stdin.end()
      await exited
    },
  }
}

/**
 * The v3 Connector's side of `dsh-bridge 2.0` (connector-ts/src/runtime/dsh-bridge2): its Router publishes
 * `<home>/.agents-anywhere/dsh-bridge/connector.json`, the plugin registers its Bridge there, and the returned runtime
 * calls it. What the Connector would commit goes to an in-memory ledger.
 */
export async function bridge2Connector(home: string, sessionNamespace: string, binaryPath: string) {
  const compat = await import(new URL('src/runtime/dsh-bridge2/index.ts', connectorTs).href) as typeof import('../../../connector-ts/src/runtime/dsh-bridge2/index.js')
  type Json = Record<string, unknown>
  const state = new Map<string, Json>()
  const ledger: import('../../../connector-ts/src/runtime/dsh-bridge2/index.js').Bridge2Ledger = {
    async publish() {},
    async replaceSession() {},
    readState: async key => state.get(key) ?? null,
    async writeState(key, value) { state.set(key, value) },
    async deleteState(key) { state.delete(key) },
  }
  let runtime: InstanceType<typeof compat.Bridge2Runtime> | undefined
  const router = await compat.Bridge2Router.start({ home, binaryPath, slot: { current: () => runtime?.relay } })
  try {
    runtime = await compat.Bridge2Runtime.connect({ mesh: router.mesh, ledger, connectorId: 'connector-test', sessionNamespace }, 20_000)
  } catch (error) {
    await router.stop().catch(() => undefined)
    throw error
  }
  const connected = runtime
  return {
    runtime: connected,
    async close() {
      await connected.stop().catch(() => undefined)
      await router.stop().catch(() => undefined)
    },
  }
}
