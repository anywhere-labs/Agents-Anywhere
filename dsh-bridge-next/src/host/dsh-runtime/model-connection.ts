import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { BridgeError } from './errors.js'
import { record } from './types.js'

/**
 * Agents Anywhere's model connection, written into DSH's own provider settings.
 *
 * AA owns only the routes it names `aa-tokens-<protocol>` and the credential
 * references they use; user-configured providers are never touched. DSH
 * applies provider settings to the next request, so nothing restarts.
 */
export const ROUTE_PREFIX = 'aa-tokens-'

const PROTOCOLS = {
  openai_chat: 'openai-completions',
  openai_responses: 'openai-responses',
  anthropic: 'anthropic-messages',
} as const

export type ModelProtocol = keyof typeof PROTOCOLS
export interface ConnectionModel { id: string, name?: string }
export interface Connection { protocol: ModelProtocol, baseUrl: string, apiKey: string, models: ConnectionModel[] }

type PathOp = { op: 'set', path: readonly string[], value: unknown } | { op: 'unset', path: readonly string[] }

/** The DSH services this needs, narrowed so tests can stand in for them. */
export interface ProviderSettingsHost {
  settings?: {
    readonly writable: boolean
    describe(options?: { redactSecrets?: boolean }): { ns: string, value: unknown, revision: number }[]
    mutate(ns: string, ops: readonly PathOp[], expectedRevision?: number): Promise<void>
  }
  credentials?: {
    set(ref: CredentialRef, value: string): Promise<void>
    unset(ref: CredentialRef): Promise<void>
  }
  llm?: { listConfigurableProviders(): { provider: string, settingsNs: string, settingsPath: readonly string[] }[] }
}

export function hostFromContext(ctx: Context): ProviderSettingsHost {
  return { settings: ctx.get('settings'), credentials: ctx.get('credentials'), llm: ctx.get('llm') } as ProviderSettingsHost
}

export function routeName(protocol: ModelProtocol): string {
  return `${ROUTE_PREFIX}${protocol.replace('_', '-')}`
}

function keyReference(route: string): CredentialRef {
  return credentialRef(`AA_TOKENS_${route.slice(ROUTE_PREFIX.length).replace(/-/g, '_').toUpperCase()}_API_KEY`)
}

export function parseConnection(raw: unknown): Connection | null {
  if (raw === null || raw === undefined) return null
  const value = record(raw)
  const protocol = value.protocol
  if (typeof protocol !== 'string' || !(protocol in PROTOCOLS)) throw new BridgeError('INVALID_PARAMS', 'Choose a protocol DSH supports.')
  const baseUrl = value.baseUrl
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(baseUrl) || baseUrl.length > 2048) {
    throw new BridgeError('INVALID_PARAMS', 'The model gateway address must be an HTTP or HTTPS URL.')
  }
  const apiKey = value.apiKey
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n\0]/.test(apiKey) || apiKey.length > 8192) {
    throw new BridgeError('INVALID_PARAMS', 'The model gateway key is missing or malformed.')
  }
  const models = Array.isArray(value.models) ? value.models.map(record) : []
  const parsed = models.flatMap(model => typeof model.id === 'string' && model.id
    ? [{ id: model.id, ...(typeof model.name === 'string' && model.name ? { name: model.name } : {}) }] : [])
  // A route DSH's catalog does not describe needs its models listed.
  if (!parsed.length) throw new BridgeError('INVALID_PARAMS', 'Import at least one model for DSH.')
  return { protocol: protocol as ModelProtocol, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, models: parsed.slice(0, 256) }
}

function providersNamespace(host: ProviderSettingsHost): string {
  // The adapter that takes declared gateway routes keeps them under `providers.<route>`.
  const entry = host.llm?.listConfigurableProviders()
    .find(item => item.settingsPath.length === 2 && item.settingsPath[0] === 'providers')
  if (!entry) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH has no provider settings that accept a model gateway.')
  return entry.settingsNs
}

function ownedRoutes(value: unknown): string[] {
  return Object.keys(record(record(value).providers)).filter(name => name.startsWith(ROUTE_PREFIX))
}

/**
 * Write the connection, or remove AA's routes when it is null.
 * @returns the route AA now owns, or null when none remains.
 */
export async function applyConnection(host: ProviderSettingsHost, connection: Connection | null): Promise<{ provider: string | null }> {
  const { settings, credentials } = host
  if (!settings || !credentials || !host.llm) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH provider settings are unavailable.')
  if (!settings.writable) throw new BridgeError('UNSUPPORTED_OPERATION', 'The active DSH profile is read-only.')
  const ns = providersNamespace(host)
  const route = connection ? routeName(connection.protocol) : null
  if (connection && route) await credentials.set(keyReference(route), connection.apiKey)
  for (let attempt = 0; ; attempt++) {
    const descriptor = settings.describe({ redactSecrets: true }).find(item => item.ns === ns)
    if (!descriptor) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH provider settings are unavailable.')
    const stale = ownedRoutes(descriptor.value).filter(name => name !== route)
    const ops: PathOp[] = stale.map(name => ({ op: 'unset', path: ['providers', name] }))
    if (connection && route) {
      ops.push({ op: 'set', path: ['providers', route], value: {
        displayName: 'Agents Anywhere',
        api: PROTOCOLS[connection.protocol],
        baseURL: connection.baseUrl,
        apiKeyEnv: keyReference(route),
        models: connection.models.map(model => ({ id: model.id, name: model.name ?? model.id })),
      } })
    }
    try {
      if (ops.length) await settings.mutate(ns, ops, descriptor.revision)
      for (const name of stale) await credentials.unset(keyReference(name))
      return { provider: route }
    } catch (error) {
      // Someone else saved settings in between; read them again once.
      if (record(error).code === 'SETTINGS_CONFLICT' && attempt === 0) continue
      if (error instanceof BridgeError) throw error
      throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'DSH refused the provider settings. Check the Bridge logs page.', true)
    }
  }
}
