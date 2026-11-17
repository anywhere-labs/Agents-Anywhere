// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/dialect.py @98dd0e6e5 (PiDialect)
//
// Pi's differences from standard ACP, as dialect hooks for the generic engine.
//
// Approval forms, plan review, synthesized config options (permission, plan mode) and `/bash` authorization live in
// the Pi session (session.ts), which wraps the generic ACP session, rewrites interactions and intercepts config.
// Only the hooks the engine itself needs are here.

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

/** AA's approval guard (a Pi extension). Both its path and content digest are verified inside the Pi process. */
export const GUARD = fileURLToPath(new URL('./assets/permissions.mjs', import.meta.url))
export const PERMISSION_OPTION = 'aa-permission'
export const PLAN_OPTION = 'aa-planning'
export const PERMISSIONS = ['ask', 'ask_all', 'readonly'] as const
export type PiPermission = (typeof PERMISSIONS)[number]
export const TOOL_PERMISSION_PREFIX = 'AA_TOOL_PERMISSION\n'
export const PLAN_REVIEW_PREFIX = 'AA_PLAN_REVIEW\n'
/** Status key the guard reports when the SDK starts a run (before any model output). */
export const PROMPT_STARTED_KEY = 'aa-prompt-started'
export const PLAN_MODE_KEY = 'aa-plan-mode'

/** Error code of the notice the dialect emits when the guard fails; the Pi session stops execution on it. */
export const GUARD_FAILED = 'pi_permissions_failed'

function piMeta(update: JsonRecord): JsonRecord {
  return asRecord(asRecord(update._meta).pi)
}

export function isPiStatus(update: JsonRecord, key: string): boolean {
  const meta = piMeta(update)
  return update.sessionUpdate === 'session_info_update' && meta.event === 'status' && meta.key === key
}

/** Pi's session capabilities: AA's approval guard handles tool permissions; steering follows `_meta.steering.supported` from initialize. */
export function piCapabilities(info: AgentInfo): Capability[] {
  const steer = asRecord(info.meta.steering).supported === true
  return negotiatedCapabilities(info, { steer, permissionCatalog: true })
}

/** Facts the dialect records after a session opens: native session file locations, and text of messages being streamed. */
export interface PiDialectState {
  readonly sessionFiles: Map<string, string | null>
  /** `<update kind>\0<messageId>` -> text received so far. Used to emit the whole message and its outcome when it ends. */
  readonly messages: Map<string, string>
}

export function piDialectState(): PiDialectState {
  return { sessionFiles: new Map(), messages: new Map() }
}

/** These image types are inlined for the model; other files are sent as resource_link. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Pi prompt blocks: local image files are read and inlined (Pi only accepts inline images). Attachments with a
 * platform identity get `_meta.aa.attachment` on their block; the SDK bridge uses it to write the attachment into the
 * native user message's `aaAttachments`, so history and replay can restore attachments.
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

/** Outcome given by Pi's end-of-message marker (an empty text block at the end of each assistant message, `_meta.pi.event = assistant_message`). */
function messageStatus(stopReason: unknown): 'done' | 'failed' | 'cancelled' {
  return stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'cancelled' : 'done'
}

/**
 * When the model errors, pi-acp fails session/prompt with `_meta.pi.assistantError` in the error data. The message of
 * such an error is the reason the model gave: it is kept as is (without the error data appended) and flagged in
 * details, so the Pi session shows an error notice on the Timeline.
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
    // Pi's message and tool IDs are stable across replays: updates with a messageId / toolCallId derive their item
    // from the native ID.
    identity: (context: SessionContext): ItemIdentity => {
      const projection = new AcpProjectionIdentity(context.sessionId, context.epoch)
      return {
        itemFor: update => projection.apply((update.messageId || update.toolCallId ? { ...update, aaProjectionVerified: true } : update) as Parameters<AcpProjectionIdentity['apply']>[0]),
        userItemId: clientMessageId => acpFingerprint([context.sessionId, 'user_message_chunk', clientMessageId]),
        finish: () => projection.finish(),
      }
    },
    // The patched adapter binds this to the message, so native history carries AA's message ID, display text and
    // attachments.
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
 * Message chunks with a messageId. Text goes through the generic translation as usual (returns undefined); this only
 * records the text received. On Pi's end-of-message marker it emits message.completed with the whole text and the
 * outcome (`_meta...stopReason`: error -> failed, aborted -> cancelled, anything else done), under the same item ID as
 * the text deltas (Pi's messageId is stable across replays). The message's thinking item ends with the same outcome at
 * the marker, matching the history rule (pi-history.ts: the outcome applies to every block of the message).
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
