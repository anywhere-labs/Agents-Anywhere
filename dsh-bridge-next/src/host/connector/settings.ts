import { join } from 'node:path'
import { DEFAULT_CONNECTOR_SETTINGS, type ConnectorSettings } from '../../contracts/connector.js'
import type { ResolvedConfig } from '../config.js'
import { readJson, writeJson } from '../storage/files.js'

/**
 * Settings earlier versions saved: old startup switches and timing overrides, and the Python Connector's uv path and
 * PyPI / Python download mirrors. They are dropped when the file is read; the bundled Connector needs none of them.
 */
const RETIRED_SETTINGS = ['autoStart', 'heartbeatSeconds', 'reconnectSeconds', 'syncExistingOnConnect',
  'uvPath', 'uvPypiIndexUrl', 'uvPythonInstallMirror'] as const

export function validateConnectorSettings(value: unknown): ConnectorSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connector 配置格式无效。')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => !Object.hasOwn(DEFAULT_CONNECTOR_SETTINGS, key))) throw new Error('包含不支持的 Connector 配置项。')
  const settings = { ...DEFAULT_CONNECTOR_SETTINGS, ...fields }
  if (typeof settings.connectorProxy !== 'string') throw new Error('代理地址无效，请填写完整地址，例如 http://127.0.0.1:7890。')
  settings.connectorProxy = settings.connectorProxy.trim()
  if (settings.connectorProxy && settings.connectorProxy !== 'direct' && !/^(?:https?|socks5h?):\/\/[^\s/]+/i.test(settings.connectorProxy)) {
    throw new Error('代理地址无效，请填写完整地址，例如 http://127.0.0.1:7890。')
  }
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
    if (saved === null) return
    if (typeof saved !== 'object' || Array.isArray(saved)) { this.current = validateConnectorSettings(saved); return }
    const fields = { ...saved } as Record<string, unknown>
    const migrating = RETIRED_SETTINGS.some(key => Object.hasOwn(fields, key))
    for (const key of RETIRED_SETTINGS) delete fields[key]
    this.current = validateConnectorSettings(fields)
    if (migrating) await writeJson(this.path, this.current)
  }
  async reset(): Promise<void> {
    await this.save({ ...DEFAULT_CONNECTOR_SETTINGS })
  }
  async save(value: unknown): Promise<void> {
    const settings = validateConnectorSettings(value)
    await writeJson(this.path, settings)
    this.current = settings
  }
}
