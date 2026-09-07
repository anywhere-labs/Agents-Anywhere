import { isAbsolute, join } from 'node:path'
import { DEFAULT_CONNECTOR_SETTINGS, PYPI_MIRRORS, type ConnectorSettings } from '../../contracts/connector.js'
import type { ResolvedConfig } from '../config.js'
import { readJson, writeJson } from '../storage/files.js'

export function validateConnectorSettings(value: unknown): ConnectorSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connector 配置格式无效。')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => !Object.hasOwn(DEFAULT_CONNECTOR_SETTINGS, key))) throw new Error('包含不支持的 Connector 配置项。')
  const settings = { ...DEFAULT_CONNECTOR_SETTINGS, ...fields }
  if (typeof settings.uvPath !== 'string' || settings.uvPath.length > 4096 || /[\r\n\0]/.test(settings.uvPath)) throw new Error('uv 路径无效。')
  settings.uvPath = settings.uvPath.trim()
  if (settings.uvPath && !isAbsolute(settings.uvPath)) throw new Error('请填写 uv 可执行文件的绝对路径，或留空自动查找。')
  if (!PYPI_MIRRORS.some(mirror => mirror.url === settings.uvPypiIndexUrl)) throw new Error('请选择列表中的 PyPI 镜像。')
  for (const key of ['autoStart', 'syncExistingOnConnect'] as const) {
    if (typeof settings[key] !== 'boolean') throw new Error('Connector 开关配置无效。')
  }
  for (const [key, minimum, maximum] of [
    ['heartbeatSeconds', 1, 300], ['reconnectSeconds', 1, 300], ['syncIntervalSeconds', 1, 3600],
  ] as const) {
    const value = settings[key]
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${key} 必须是 ${minimum}–${maximum} 之间的整数。`)
  }
  return settings
}

export class ConnectorSettingsStore {
  private current: ConnectorSettings
  private readonly path: string
  constructor(config: ResolvedConfig) {
    this.current = { ...DEFAULT_CONNECTOR_SETTINGS, autoStart: config.autoStart }
    this.path = join(config.stateRoot, 'connector-settings.json')
  }
  get(): ConnectorSettings { return { ...this.current } }
  async load(): Promise<void> {
    const saved = await readJson<unknown>(this.path)
    if (saved) this.current = validateConnectorSettings(saved)
  }
  async save(value: unknown): Promise<void> {
    const settings = validateConnectorSettings(value)
    await writeJson(this.path, settings)
    this.current = settings
  }
}
