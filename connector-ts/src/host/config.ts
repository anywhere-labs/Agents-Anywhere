import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dataDir } from './paths.js'

/** The Connector's binding to a Server (the same field names as on `aa.local.v2.Control`). */
export interface ConnectorSettings {
  serverUrl: string
  connectorId: string
  connectorToken: string
  heartbeatSeconds: number
  reconnectSeconds: number
  syncExistingOnConnect: boolean
  syncIntervalSeconds: number
  statePath: string | null
  /** `system` (default), `direct`, or a proxy URL. */
  proxy?: string | null
}

export function defaultSettings(): ConnectorSettings {
  return { serverUrl: '', connectorId: '', connectorToken: '', heartbeatSeconds: 20, reconnectSeconds: 3, syncExistingOnConnect: true, syncIntervalSeconds: 30, statePath: null }
}

function number(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Settings from request params: the three credentials are required; the rest falls back to defaults. */
export function settingsFrom(params: unknown): ConnectorSettings {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new ConfigError('config params must be an object')
  const p = params as Record<string, unknown>
  const serverUrl = String(p.serverUrl ?? '').trim().replace(/\/+$/u, '')
  const connectorId = String(p.connectorId ?? '').trim()
  const connectorToken = String(p.connectorToken ?? '').trim()
  if (serverUrl === '' || connectorId === '' || connectorToken === '') throw new ConfigError('serverUrl, connectorId, and connectorToken are required')
  return {
    serverUrl,
    connectorId,
    connectorToken,
    heartbeatSeconds: number(p.heartbeatSeconds, 20),
    reconnectSeconds: number(p.reconnectSeconds, 3),
    syncExistingOnConnect: p.syncExistingOnConnect === undefined ? true : Boolean(p.syncExistingOnConnect),
    syncIntervalSeconds: number(p.syncIntervalSeconds, 30),
    statePath: typeof p.statePath === 'string' ? p.statePath : null,
    ...(typeof p.proxy === 'string' ? { proxy: p.proxy } : {}),
  }
}

export class ConfigError extends Error {
  public readonly code = 'invalid_argument'
  public constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** `AGENT_CONNECTOR_CONFIG`, else `<data dir>/connector.json`. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_CONNECTOR_CONFIG !== undefined && env.AGENT_CONNECTOR_CONFIG !== '' ? env.AGENT_CONNECTOR_CONFIG : join(dataDir(env), 'connector.json')
}

/** The saved binding; the token makes it a secret, so it is written 0600 and replaced atomically. */
export class ConfigFile {
  public constructor(public readonly path: string = defaultConfigPath()) {}

  public get exists(): boolean {
    return existsSync(this.path)
  }

  public load(): ConnectorSettings {
    const text = readFileSync(this.path, 'utf8').replace(/^﻿/u, '')
    return settingsFrom(JSON.parse(text) as unknown)
  }

  /** The saved settings, or the defaults when none are saved. */
  public read(): ConnectorSettings {
    return this.exists ? this.load() : defaultSettings()
  }

  public save(settings: ConnectorSettings): string {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    return this.path
  }
}
