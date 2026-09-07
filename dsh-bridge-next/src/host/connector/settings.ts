import { isAbsolute, join } from 'node:path'
import { DEFAULT_CONNECTOR_SETTINGS, PYPI_MIRRORS, type ConnectorSettings } from '../../contracts/connector.js'
import type { ResolvedConfig } from '../config.js'
import { readJson, writeJson } from '../storage/files.js'

const RETIRED_SETTINGS = ['autoStart', 'heartbeatSeconds', 'reconnectSeconds', 'syncExistingOnConnect'] as const

export function validateConnectorSettings(value: unknown): ConnectorSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connector 配置格式无效。')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => !Object.hasOwn(DEFAULT_CONNECTOR_SETTINGS, key))) throw new Error('包含不支持的 Connector 配置项。')
  const settings = { ...DEFAULT_CONNECTOR_SETTINGS, ...fields }
  if (typeof settings.uvPath !== 'string' || settings.uvPath.length > 4096 || /[\r\n\0]/.test(settings.uvPath)) throw new Error('uv 路径无效。')
  settings.uvPath = settings.uvPath.trim()
  if (settings.uvPath && !isAbsolute(settings.uvPath)) throw new Error('请填写 uv 可执行文件的绝对路径，或留空自动查找。')
  if (!PYPI_MIRRORS.some(mirror => mirror.url === settings.uvPypiIndexUrl)) throw new Error('请选择列表中的 PyPI 镜像。')
  if (!Number.isInteger(settings.syncIntervalSeconds) || settings.syncIntervalSeconds < 1 || settings.syncIntervalSeconds > 3600) {
    throw new Error('同步间隔必须是 1–3600 之间的整数。')
  }
  return settings
}

export class ConnectorSettingsStore {
  private current: ConnectorSettings
  private readonly path: string
  constructor(config: ResolvedConfig) {
    this.current = { ...DEFAULT_CONNECTOR_SETTINGS }
    this.path = join(config.stateRoot, 'connector-settings.json')
  }
  get(): ConnectorSettings { return { ...this.current } }
  async load(): Promise<void> {
    const saved = await readJson<unknown>(this.path)
    if (!saved) return
    if (typeof saved === 'object' && !Array.isArray(saved)) {
      const fields = { ...saved } as Record<string, unknown>
      // Remove old switches as well as hidden timing overrides. Startup and
      // initial history sync now always use the plugin's fixed behavior.
      const migrating = RETIRED_SETTINGS.some(key => Object.hasOwn(fields, key))
      for (const key of RETIRED_SETTINGS) delete fields[key]
      this.current = validateConnectorSettings(fields)
      if (migrating) await writeJson(this.path, this.current)
    } else this.current = validateConnectorSettings(saved)
  }
  async save(value: unknown): Promise<void> {
    const settings = validateConnectorSettings(value)
    await writeJson(this.path, settings)
    this.current = settings
  }
}
