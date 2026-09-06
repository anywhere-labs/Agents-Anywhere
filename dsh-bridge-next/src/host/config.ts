import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { ConnectionSettings } from '../contracts/index.js'

export interface Config {
  apiBaseUrl?: string
  webBaseUrl?: string
  stateRoot?: string
  connectorSourceDir?: string
  uvPath?: string
  autoStart?: boolean
}

export const Config: z<Config> = z.object({
  apiBaseUrl: z.string().default('http://127.0.0.1:8000'),
  webBaseUrl: z.string().default('http://127.0.0.1:5174'),
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

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('请填写不带账号、查询参数或页面片段的 HTTP(S) 地址。')
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('远程服务请使用 HTTPS 地址。')
  }
  return url.href.replace(/\/+$/, '')
}

export function resolveConfig(config: Config): ResolvedConfig {
  const stateRoot = config.stateRoot ?? join(userInfo().homedir, '.agentsanywhere', 'dsh-bridge-next')
  const connectorSourceDir = config.connectorSourceDir ?? fileURLToPath(new URL('./bundled-connector/', import.meta.url))
  if (!isAbsolute(stateRoot) || !isAbsolute(connectorSourceDir)) throw new Error('数据目录和 Connector 源码目录必须是绝对路径。')
  return {
    stateRoot,
    connectorSourceDir,
    apiBaseUrl: normalizeBaseUrl(config.apiBaseUrl ?? 'http://127.0.0.1:8000').replace(/\/api\/v2$/, ''),
    webBaseUrl: normalizeBaseUrl(config.webBaseUrl ?? 'http://127.0.0.1:5174'),
    uvPath: config.uvPath ?? process.env['UV_PATH'] ?? 'uv',
    autoStart: config.autoStart ?? true,
  }
}
