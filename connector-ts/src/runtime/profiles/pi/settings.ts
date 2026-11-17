// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/settings.py @98dd0e6e5 (private_json, prepare_settings, update_default_model)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/definition.py @98dd0e6e5 (normalize_config)
// ported from Agents-Anywhere v2 connector/connector/runtimes/custom_models.py @98dd0e6e5 (normalize_custom_models)
//
// Pi instance config: execution mode (local / managed), custom models, and the managed environment's private Pi
// config (the model gateway is written into models.json). Only the custom model checks Pi uses are implemented.
//
// The model gateway is not part of instance config but comes from RuntimeInstanceConfig.modelGateway (instance config
// still cannot carry arbitrary command/args/env); the default model for new sessions is the gateway's `model`.

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { JsonObject, ModelGatewayConfig } from '../../../application/ports/runtime-session.js'
import { fail } from '../../acp/errors.js'

export const LOCAL_MODE_REASON = '本机模式使用 Pi 自己的模型配置，不能同时使用模型网关；要用网关请切换到 AA 受管环境。'
export const MAX_CUSTOM_MODELS = 64
export const MAX_CUSTOM_MODEL_EFFORTS = 16

export type ExecutionMode = 'auto' | 'local' | 'managed'

export interface CustomModel {
  readonly modelId: string
  readonly displayName: string
  readonly efforts?: ReadonlyArray<{ readonly effortId: string; readonly displayName: string }>
}

/** Validated and normalized Pi instance config. */
export interface PiSettings {
  readonly executionMode: ExecutionMode
  readonly cliPath?: string
  readonly agentDir?: string
  readonly historyDirs: readonly string[]
  readonly customModels: readonly CustomModel[]
}

const UNSAFE = /[\u0000\r\n]/

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const stripped = value.trim()
  return stripped === '' ? undefined : stripped
}

function invalid(message: string): never {
  fail('invalid_config', message)
}

/** Validates and normalizes the custom model list. */
export function normalizeCustomModels(raw: unknown): CustomModel[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) invalid('customModels must be an array')
  if (raw.length > MAX_CUSTOM_MODELS) invalid(`customModels cannot contain more than ${MAX_CUSTOM_MODELS} models`)
  const seen = new Set<string>()
  return raw.map((item, index): CustomModel => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid(`customModels[${index}] must be an object`)
    const record = item as Record<string, unknown>
    const modelId = clean(record.modelId)
    const displayName = clean(record.displayName)
    if (modelId === undefined) invalid(`customModels[${index}].modelId must be a non-empty string`)
    if (displayName === undefined) invalid(`customModels[${index}].displayName must be a non-empty string`)
    if (UNSAFE.test(modelId)) invalid(`customModels[${index}].modelId contains unsupported characters`)
    if (modelId.length > 256) invalid(`customModels[${index}].modelId is too long`)
    if (displayName.length > 128) invalid(`customModels[${index}].displayName is too long`)
    if (seen.has(modelId)) invalid(`customModels contains duplicate modelId: ${modelId}`)
    seen.add(modelId)
    const efforts = normalizeEfforts(record.efforts, index)
    return { modelId, displayName, ...(efforts.length ? { efforts } : {}) }
  })
}

function normalizeEfforts(raw: unknown, modelIndex: number): Array<{ effortId: string; displayName: string }> {
  if (raw === undefined || raw === null) return []
  const at = `customModels[${modelIndex}].efforts`
  if (!Array.isArray(raw)) invalid(`${at} must be an array`)
  if (raw.length > MAX_CUSTOM_MODEL_EFFORTS) invalid(`${at} cannot contain more than ${MAX_CUSTOM_MODEL_EFFORTS} efforts`)
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid(`${at}[${index}] must be an object`)
    const record = item as Record<string, unknown>
    const effortId = clean(record.effortId)
    const displayName = clean(record.displayName)
    if (effortId === undefined) invalid(`${at}[${index}].effortId must be a non-empty string`)
    if (displayName === undefined) invalid(`${at}[${index}].displayName must be a non-empty string`)
    if (UNSAFE.test(effortId)) invalid(`${at}[${index}].effortId contains unsupported characters`)
    if (effortId.length > 128) invalid(`${at}[${index}].effortId is too long`)
    if (displayName.length > 128) invalid(`${at}[${index}].displayName is too long`)
    if (seen.has(effortId)) invalid(`${at} contains duplicate effortId: ${effortId}`)
    seen.add(effortId)
    return { effortId, displayName }
  })
}

/**
 * Normalizes execution mode and gateway:
 * - an older config with no execution mode but a model gateway still uses the managed environment;
 * - the gateway is only for the managed environment: a gateway with any other mode is an error, not ignored;
 * - the managed environment requires a gateway (with a local Pi already installed, use local mode).
 */
export function normalizePiSettings(settings: JsonObject, gateway: ModelGatewayConfig | undefined): PiSettings {
  const declared = settings.executionMode
  if (declared !== undefined && declared !== 'auto' && declared !== 'local' && declared !== 'managed') invalid('executionMode 必须是 auto、local 或 managed')
  const executionMode: ExecutionMode = declared ?? (gateway ? 'managed' : 'auto')
  if (gateway && executionMode !== 'managed') fail('model_connection_unsupported', LOCAL_MODE_REASON)
  if (executionMode === 'managed' && !gateway) invalid('受管环境需要填写模型网关；已有本机 Pi 请使用本机模式。')
  if (gateway) checkGateway(gateway)
  const historyDirs = settings.historyDirs ?? []
  if (!Array.isArray(historyDirs) || historyDirs.length > 32 || historyDirs.some(dir => typeof dir !== 'string' || dir === '' || dir.length > 4096)) {
    invalid('historyDirs 必须是至多 32 个非空路径')
  }
  const cliPath = clean(settings.cliPath)
  const agentDir = clean(settings.agentDir)
  return {
    executionMode,
    ...(cliPath !== undefined ? { cliPath } : {}),
    ...(agentDir !== undefined ? { agentDir } : {}),
    historyDirs: historyDirs as string[],
    customModels: normalizeCustomModels(settings.customModels),
  }
}

/** The Pi managed environment only accepts OpenAI Chat Completions compatible gateways. */
export function checkGateway(gateway: ModelGatewayConfig): void {
  if (gateway.protocol !== 'openai-chat') fail('model_connection_unsupported', 'Pi 受管环境只支持 OpenAI Chat Completions 兼容的模型网关。')
  let url: URL
  try {
    url = new URL(gateway.baseUrl)
  } catch {
    invalid('modelGateway.baseUrl must be a valid URL')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.host === '') invalid('modelGateway.baseUrl must be an absolute HTTP or HTTPS URL')
  if (gateway.authToken.trim() === '' || UNSAFE.test(gateway.authToken)) invalid('modelGateway.apiKey contains unsupported characters')
}

/** JSON file readable and writable only by the owner; written to a temporary file, then atomically replaced. */
export async function privateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID().replaceAll('-', '')}`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** The configured model if it is in Pi's list, otherwise the first one; Pi opens new sessions with it. */
function defaultModel(models: ReadonlyArray<{ modelId: string }>, configured: string | undefined): string {
  const ids = models.map(model => model.modelId)
  return configured !== undefined && ids.includes(configured) ? configured : ids[0]!
}

export interface ManagedSettingsOptions {
  /** Fetch function used when the gateway gives no model list (replaced by tests). */
  readonly fetch?: typeof fetch
  /** Absolute path of the guard extension (written into `extensions` in the private settings.json). */
  readonly guard: string
}

/** The gateway's model list (`GET <baseUrl>/models`). */
async function gatewayModels(gateway: ModelGatewayConfig, fetchImpl: typeof fetch): Promise<CustomModel[]> {
  try {
    const response = await fetchImpl(`${gateway.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${gateway.authToken}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json() as { data?: unknown }).data
    if (!Array.isArray(data)) throw new Error('no data')
    return data.flatMap(item => (typeof (item as { id?: unknown }).id === 'string' ? [{ modelId: (item as { id: string }).id, displayName: (item as { id: string }).id }] : [])).slice(0, 64)
  } catch {
    fail('pi_models_unavailable', '无法获取模型列表，请在自定义模型中填写模型 ID 后重试。')
  }
}

/**
 * The managed environment's private Pi config directory `<root>/pi`: models.json has a single provider `aa` pointing
 * at the gateway (the key is passed via the `AA_PI_GATEWAY_KEY` environment variable and never written to disk), and
 * settings.json sets the default model and loads the guard extension. The user's own Pi config is never touched.
 */
export async function prepareManagedSettings(root: string, settings: PiSettings, gateway: ModelGatewayConfig, options: ManagedSettingsOptions): Promise<string> {
  const agentDir = join(root, 'pi')
  let models: readonly CustomModel[] = settings.customModels
  if (!models.length) models = await gatewayModels(gateway, options.fetch ?? fetch)
  if (!models.length) fail('pi_models_required', '请在自定义模型中至少添加一个模型。')
  await privateJson(join(agentDir, 'models.json'), {
    providers: {
      aa: {
        baseUrl: gateway.baseUrl,
        api: 'openai-completions',
        apiKey: '${AA_PI_GATEWAY_KEY}',
        models: models.map(model => ({
          id: model.modelId,
          name: model.displayName,
          reasoning: Boolean(model.efforts?.length),
          input: ['text', 'image'],
          contextWindow: 128000,
          maxTokens: 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  })
  await privateJson(join(agentDir, 'settings.json'), {
    defaultProvider: 'aa',
    defaultModel: defaultModel(models, gateway.model),
    extensions: [options.guard],
  })
  return agentDir
}

/**
 * Switches new sessions to another configured model without restarting Pi. Each session reads settings.json when its
 * own Pi process starts; existing sessions keep the model in their session file.
 */
export async function updateDefaultModel(agentDir: string, model: string | undefined): Promise<void> {
  const path = join(agentDir, 'settings.json')
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const provider = (JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8')) as { providers: { aa: { models: Array<{ id: string }> } } }).providers.aa
  current.defaultModel = defaultModel(provider.models.map(item => ({ modelId: item.id })), model)
  await privateJson(path, current)
}
