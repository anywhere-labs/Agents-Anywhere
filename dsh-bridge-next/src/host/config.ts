import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { CLOUD_API_BASE_URL, type ConnectionSettings } from '../contracts/index.js'
import { normalizeServerOrigin } from './account/server.js'

export interface Config {
  apiBaseUrl?: string
  stateRoot?: string
  connectorSourceDir?: string
  uvPath?: string
  autoStart?: boolean
}

export const Config: z<Config> = z.object({
  apiBaseUrl: z.string().default(CLOUD_API_BASE_URL),
  stateRoot: z.string(),
  connectorSourceDir: z.string(),
  uvPath: z.string(),
  autoStart: z.boolean().default(true),
})

export interface ResolvedConfig extends ConnectionSettings {
  stateRoot: string
  connectorSourceDir: string
  uvPath: string
  autoStart: boolean
}

export function resolveConfig(config: Config): ResolvedConfig {
  const stateRoot = config.stateRoot ?? join(userInfo().homedir, '.agentsanywhere', 'dsh-bridge-next')
  const connectorSourceDir = config.connectorSourceDir ?? fileURLToPath(new URL('./bundled-connector/', import.meta.url))
  if (!isAbsolute(stateRoot) || !isAbsolute(connectorSourceDir)) throw new Error('数据目录和 Connector 源码目录必须是绝对路径。')
  return {
    stateRoot,
    connectorSourceDir,
    apiBaseUrl: normalizeServerOrigin(config.apiBaseUrl ?? CLOUD_API_BASE_URL),
    uvPath: config.uvPath ?? process.env['UV_PATH'] ?? 'uv',
    autoStart: config.autoStart ?? true,
  }
}
