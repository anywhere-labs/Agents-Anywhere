import { homedir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { CLOUD_API_BASE_URL, type ConnectionSettings } from '../contracts/index.js'
import { normalizeServerOrigin } from './account/server.js'

export interface Config {
  dshHome?: string
  apiBaseUrl?: string
  stateRoot?: string
  /** The bundled Connector (`anywhere-cli.js` and its Routers); default the copy inside this package. */
  connectorDir?: string
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  apiBaseUrl: z.string().default(CLOUD_API_BASE_URL),
  stateRoot: z.string(),
  // `connectorSourceDir` and `uvPath` from earlier versions may still be saved; unknown keys are ignored.
  connectorDir: z.string(),
})

export interface ResolvedConfig extends ConnectionSettings {
  dshHome?: string
  stateRoot: string
  legacyStateRoot?: string
  connectorDir: string
  /** The Connector's data directory, shared by every host on this computer (Desktop, the CLI, this plugin). */
  connectorDataDir: string
}

export function stateRoot(config: Config): string {
  return config.stateRoot ?? join(userInfo().homedir, '.agents-anywhere', 'dsh-bridge-next')
}

/** Fixed per-user rendezvous with the Connector; DSH_HOME and stateRoot do not move it. */
export function bridgeDirectory(): string {
  return join(userInfo().homedir, '.agents-anywhere', 'dsh-bridge')
}

/** The v3 Connector's data directory: `~/.agents-anywhere/v3`, the same for every host that runs it. */
export function connectorDataDirectory(): string {
  return join(userInfo().homedir, '.agents-anywhere', 'v3')
}

/**
 * Where plugins before 2.0.3 published the endpoint. Connectors before 2.0.3 look only here, so
 * the bridge mirrors its endpoint to this directory; it is resolved exactly as those plugins did.
 */
export function legacyBridgeDirectory(config: Config): string | undefined {
  const home = config.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return isAbsolute(home) ? join(home, 'agents-anywhere', 'bridge') : undefined
}

export function resolveConfig(config: Config): ResolvedConfig {
  if (config.dshHome !== undefined && !isAbsolute(config.dshHome)) throw new Error('DSH_HOME 必须是绝对路径。')
  const root = stateRoot(config)
  const connectorDir = config.connectorDir ?? fileURLToPath(new URL('./bundled-connector/', import.meta.url))
  if (!isAbsolute(root) || !isAbsolute(connectorDir)) throw new Error('数据目录和 Connector 目录必须是绝对路径。')
  return {
    ...(config.dshHome !== undefined ? { dshHome: config.dshHome } : {}),
    stateRoot: root,
    ...(config.stateRoot === undefined ? { legacyStateRoot: join(userInfo().homedir, '.agentsanywhere', 'dsh-bridge-next') } : {}),
    connectorDir,
    connectorDataDir: connectorDataDirectory(),
    apiBaseUrl: normalizeServerOrigin(config.apiBaseUrl ?? CLOUD_API_BASE_URL),
  }
}
