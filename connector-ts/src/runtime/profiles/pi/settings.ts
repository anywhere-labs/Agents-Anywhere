// Pi 实例配置：运行环境（本机 / 受管）、自定义模型，以及受管环境的私有 Pi 配置（模型网关写进 models.json）。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/settings.py、definition.py `normalize_config`，
// 以及 connector/connector/runtimes/custom_models.py（只保留 Pi 用到的校验）。
//
// 与 v2 的差别：模型网关不在实例配置里，而在 RuntimeInstanceConfig.modelGateway（实例配置仍不能携带任意 command/args/env）；
// v2 的 `model` 字段（新会话默认模型）改用网关的 `model`。

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

/** 校验并整理过的 Pi 实例配置。 */
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

/** custom_models.py `normalize_custom_models`。 */
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
 * definition.py `normalize_config`：
 * - 旧配置没写运行环境但有模型网关时，仍走受管环境；
 * - 网关只给受管环境用：其他模式带网关是错误，不是被忽略；
 * - 受管环境必须有网关（已有本机 Pi 请用本机模式）。
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

/** Pi 受管环境只认 OpenAI Chat Completions 兼容的网关（v2 MODEL_CONNECTION protocols=("openai_chat",)）。 */
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

/** 只有本人可读写的 JSON 文件；先写临时文件再原子替换（settings.py `private_json`）。 */
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

/** 配置的模型在 Pi 的列表里就用它，否则第一个；Pi 用它开新会话。 */
function defaultModel(models: ReadonlyArray<{ modelId: string }>, configured: string | undefined): string {
  const ids = models.map(model => model.modelId)
  return configured !== undefined && ids.includes(configured) ? configured : ids[0]!
}

export interface ManagedSettingsOptions {
  /** 网关不给模型列表时用的取数函数（测试替换）。 */
  readonly fetch?: typeof fetch
  /** 守卫扩展的绝对路径（写进私有 settings.json 的 extensions）。 */
  readonly guard: string
}

/** 网关的模型列表（`GET <baseUrl>/models`）。 */
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
 * 受管环境的私有 Pi 配置目录 `<root>/pi`：models.json 只有一个 provider `aa` 指向网关（密钥经环境变量
 * `AA_PI_GATEWAY_KEY` 传入，不落盘），settings.json 设好默认模型并载入守卫扩展。绝不碰用户自己的 Pi 配置。
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
 * 让新会话改用另一个已配置的模型，不重启 Pi（settings.py `update_default_model`）。
 * 每个会话在自己的 Pi 进程启动时读 settings.json；已有会话保留会话文件里的模型。
 */
export async function updateDefaultModel(agentDir: string, model: string | undefined): Promise<void> {
  const path = join(agentDir, 'settings.json')
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const provider = (JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf8')) as { providers: { aa: { models: Array<{ id: string }> } } }).providers.aa
  current.defaultModel = defaultModel(provider.models.map(item => ({ modelId: item.id })), model)
  await privateJson(path, current)
}
