// Pi 与标准 ACP 的差异，作为通用引擎的方言钩子。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/dialect.py
//
// v2 的方言还负责审批表单、计划审阅、合成配置项（权限、计划模式）和 `/bash` 授权；v3 端口里这些放在
// Pi 会话（session.ts）：它包着通用 ACP 会话，改写交互、拦截配置。这里只保留引擎内部要用的钩子。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Capability, PromptAttachment, PromptInput, RuntimeError, RuntimeEvent } from '../../../application/ports/runtime-session.js'
import { AcpProjectionIdentity, acpFingerprint } from '../../../domain/identity/index.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import { asRecord, type AgentInfo, type JsonRecord } from '../../acp/client.js'
import type { AcpDialect, ItemIdentity, SessionContext } from '../../acp/dialect.js'
import { JsonRpcError } from '../../acp/jsonrpc.js'
import { contentText } from '../../acp/mapping.js'
import { promptBlocks } from '../../acp/session.js'
import { genericDialect } from '../generic/dialect.js'

/** AA 的审批守卫（Pi 扩展）。路径和内容摘要都会在 Pi 进程里核对。 */
export const GUARD = fileURLToPath(new URL('./assets/permissions.mjs', import.meta.url))
export const PERMISSION_OPTION = 'aa-permission'
export const PLAN_OPTION = 'aa-planning'
export const PERMISSIONS = ['ask', 'ask_all', 'readonly'] as const
export type PiPermission = (typeof PERMISSIONS)[number]
export const TOOL_PERMISSION_PREFIX = 'AA_TOOL_PERMISSION\n'
export const PLAN_REVIEW_PREFIX = 'AA_PLAN_REVIEW\n'
/** 守卫在 SDK 开始一轮时报告的状态键（模型输出之前）。 */
export const PROMPT_STARTED_KEY = 'aa-prompt-started'
export const PLAN_MODE_KEY = 'aa-plan-mode'

/** 守卫出错时方言发出的提示事件的错误码：Pi 会话据此停止执行。 */
export const GUARD_FAILED = 'pi_permissions_failed'

function piMeta(update: JsonRecord): JsonRecord {
  return asRecord(asRecord(update._meta).pi)
}

export function isPiStatus(update: JsonRecord, key: string): boolean {
  const meta = piMeta(update)
  return update.sessionUpdate === 'session_info_update' && meta.event === 'status' && meta.key === key
}

/** Pi 的会话级能力：AA 的审批守卫管工具权限；插话看 initialize 的 `_meta.steering.supported`。 */
export function piCapabilities(info: AgentInfo): Capability[] {
  const steer = asRecord(info.meta.steering).supported === true
  return negotiatedCapabilities(info, { steer, permissionCatalog: true })
}

/** 打开会话后由方言记下的事实：原生会话文件位置（v2 `native_files`）；正在输出的消息正文。 */
export interface PiDialectState {
  readonly sessionFiles: Map<string, string | null>
  /** `<更新类别>\0<messageId>` → 已收到的正文。消息结束时用它给出整条消息与结局。 */
  readonly messages: Map<string, string>
}

export function piDialectState(): PiDialectState {
  return { sessionFiles: new Map(), messages: new Map() }
}

/** v2 附件规则：这几种图片内联给模型，其余文件给 resource_link（acp/infrastructure/attachments.py `IMAGE_TYPES`）。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Pi 的输入块：本机图片文件读出来内联（Pi 只认内联图片，v2 同样处理）；带平台身份的附件在块上挂
 * `_meta.aa.attachment`，SDK bridge 据此把附件写进原生用户消息的 `aaAttachments`，历史与重放因此能还原附件。
 */
export function piPromptBlocks(input: PromptInput): JsonRecord[] {
  const inlined = (input.attachments ?? []).map((attachment): PromptAttachment => {
    if (attachment.kind !== 'file' || !IMAGE_TYPES.has(attachment.mimeType)) return attachment
    return {
      kind: 'inline', data: readFileSync(attachment.path).toString('base64'), mimeType: attachment.mimeType,
      ...(attachment.name !== undefined ? { name: attachment.name } : {}), ...(attachment.info !== undefined ? { info: attachment.info } : {}),
    }
  })
  const blocks = promptBlocks({ ...input, attachments: inlined })
  const offset = blocks.length - inlined.length
  return blocks.map((block, index) => {
    const info = index >= offset ? inlined[index - offset]?.info : undefined
    if (info === undefined) return block
    return { ...block, _meta: { ...asRecord(block._meta), aa: { attachment: { ...info } } } }
  })
}

/** Pi 的消息结束标记（每条助手消息末尾一个空文本块，`_meta.pi.event = assistant_message`）给出的结局。 */
function messageStatus(stopReason: unknown): 'done' | 'failed' | 'cancelled' {
  return stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'cancelled' : 'done'
}

/**
 * 模型报错时 pi-acp 让 session/prompt 失败，错误数据里带 `_meta.pi.assistantError`。这类错误的消息就是模型给的
 * 原因：原样保留（不拼上错误数据），并标在 details 上，Pi 会话据此在 Timeline 上给出错误提示。
 */
function assistantFailure(error: unknown): { message: string; failure?: string } | undefined {
  if (!(error instanceof JsonRpcError)) return undefined
  const meta = asRecord(asRecord(asRecord(error.data)._meta).pi)
  if (meta.assistantError !== true) return undefined
  return { message: error.message, ...(typeof meta.failure === 'string' ? { failure: meta.failure } : {}) }
}

export function piDialect(state: PiDialectState = piDialectState()): AcpDialect {
  return {
    ...genericDialect('pi', { permissionCatalog: true }),
    capabilities: piCapabilities,
    steer: 'extension',
    // Pi 的消息与工具 ID 在回放之间稳定：带 messageId / toolCallId 的更新用原生 ID 算条目（v2 `aaProjectionVerified`）。
    identity: (context: SessionContext): ItemIdentity => {
      const projection = new AcpProjectionIdentity(context.sessionId, context.epoch)
      return {
        itemFor: update => projection.apply((update.messageId || update.toolCallId ? { ...update, aaProjectionVerified: true } : update) as Parameters<AcpProjectionIdentity['apply']>[0]),
        userItemId: clientMessageId => acpFingerprint([context.sessionId, 'user_message_chunk', clientMessageId]),
      }
    },
    // 补丁后的适配器把它绑到这条消息上，原生历史因此带着 AA 的消息 ID、显示文本与附件。
    promptParams: delivery => ({ _meta: { aa: { clientMessageId: delivery.clientMessageId } } }),
    promptBlocks: piPromptBlocks,
    acceptanceEvidence: update => isPiStatus(update, PROMPT_STARTED_KEY),
    translateUpdate: (update, context, turn): RuntimeEvent[] | undefined => {
      if ((update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') && typeof update.messageId === 'string' && update.messageId !== '') {
        return messageUpdate(state, update, context, turn.turnId)
      }
      if (update.sessionUpdate !== 'session_info_update') return undefined
      const meta = piMeta(update)
      if (meta.event === 'extension_error' && meta.extensionPath === GUARD) {
        return [{
          type: 'notice', itemId: `pi-guard:${context.nativeSessionId}:${String(meta.hook ?? 'error')}`, level: 'error', kind: 'error',
          text: 'Pi 审批守卫异常，执行已停止。', data: { code: GUARD_FAILED },
        }]
      }
      if (meta.event === 'status' && meta.key === PLAN_MODE_KEY) return [{ type: 'planning.mode_changed', mode: meta.text === 'plan' ? 'plan' : 'normal' }]
      if (meta.event === 'status') return []
      return undefined
    },
    verifySession: (_config, response, nativeSessionId) => {
      const meta = asRecord(asRecord(response._meta).pi)
      const extensions = Array.isArray(meta.extensions) ? meta.extensions.map(asRecord) : []
      if (!extensions.length || extensions[0]!.path !== GUARD || asRecord(meta.aaLoadingReport).mandatoryGuard !== true) {
        return { code: 'pi_permissions_unavailable', message: 'Pi 工具审批扩展未能加载，已阻止执行。' }
      }
      state.sessionFiles.set(nativeSessionId, typeof meta.sessionFile === 'string' ? meta.sessionFile : null)
      return undefined
    },
    classifyError: error => {
      const assistant = assistantFailure(error)
      if (assistant !== undefined) {
        const details = { assistantError: true, ...(assistant.failure !== undefined ? { failure: assistant.failure } : {}) }
        if (assistant.failure === 'auth_required' || (error as { code?: unknown }).code === -32000) {
          return { code: 'pi_authentication_required', message: assistant.message, details } satisfies RuntimeError
        }
        return { code: 'runtime_error', message: assistant.message, details } satisfies RuntimeError
      }
      const text = error instanceof Error ? `${error.message} ${JSON.stringify((error as { data?: unknown }).data ?? '')}` : String(error)
      if (text.includes('pi_source_conflict')) return { code: 'pi_source_conflict', message: '原生历史已被其他来源修改，已阻止继续写入。' }
      if (text.includes('pi_model_unavailable')) return { code: 'pi_model_unavailable', message: '原会话模型不可用，请先恢复对应原生模型配置。' }
      if ((error as { code?: unknown }).code === -32000) {
        return { code: 'pi_authentication_required', message: 'Pi 没有可用的模型或认证：本机模式请先运行 pi 完成登录或模型配置，受管环境请检查模型网关。' }
      }
      return undefined
    },
  }
}

/**
 * 带 messageId 的消息块（v2 `Projection.apply` 的消息部分）。正文照常交给通用翻译（返回 undefined），这里只记下
 * 已收到的正文；遇到 Pi 的消息结束标记时，用整条正文和结局（v2 `_meta…stopReason`：error → failed、aborted →
 * cancelled、其余 done）发 message.completed，条目 ID 与正文增量相同（Pi 的 messageId 在回放之间稳定）。
 * 同一条消息的思考条目也随结束标记以同一个结局结束，与历史里的规则一致（pi-history.ts：结局作用于整条消息的各块）。
 */
function messageUpdate(state: PiDialectState, update: JsonRecord, context: SessionContext, turnId: string | undefined): RuntimeEvent[] | undefined {
  const messageId = String(update.messageId)
  if (piMeta(update).event !== 'assistant_message') {
    const key = `${String(update.sessionUpdate)}\0${messageId}`
    const text = contentText(update.content)
    if (text !== undefined && text !== '') state.messages.set(key, (state.messages.get(key) ?? '') + text)
    return undefined
  }
  const base = turnId !== undefined ? { turnId } : {}
  const status = messageStatus(piMeta(update).stopReason)
  const events: RuntimeEvent[] = []
  for (const [chunk, role] of [['agent_thought_chunk', 'reasoning'], ['agent_message_chunk', 'assistant']] as const) {
    const text = state.messages.get(`${chunk}\0${messageId}`)
    state.messages.delete(`${chunk}\0${messageId}`)
    if (!text) continue
    events.push({
      ...base, type: 'message.completed', itemId: acpFingerprint([context.sessionId, chunk, messageId]), role, text,
      ...(status !== 'done' ? { status } : {}),
    })
  }
  return events
}
