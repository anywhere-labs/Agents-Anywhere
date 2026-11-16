// Pi 与标准 ACP 的差异，作为通用引擎的方言钩子。
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/dialect.py
//
// v2 的方言还负责审批表单、计划审阅、合成配置项（权限、计划模式）和 `/bash` 授权；v3 端口里这些放在
// Pi 会话（session.ts）：它包着通用 ACP 会话，改写交互、拦截配置。这里只保留引擎内部要用的钩子。

import { fileURLToPath } from 'node:url'

import type { Capability, RuntimeEvent } from '../../../application/ports/runtime-session.js'
import { AcpProjectionIdentity, acpFingerprint } from '../../../domain/identity/index.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import { asRecord, type AgentInfo, type JsonRecord } from '../../acp/client.js'
import type { AcpDialect, ItemIdentity, SessionContext } from '../../acp/dialect.js'
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

/** 打开会话后由方言记下的事实：原生会话文件位置（v2 `native_files`）。 */
export interface PiDialectState {
  readonly sessionFiles: Map<string, string | null>
}

export function piDialect(state: PiDialectState = { sessionFiles: new Map() }): AcpDialect {
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
    acceptanceEvidence: update => isPiStatus(update, PROMPT_STARTED_KEY),
    translateUpdate: (update, context): RuntimeEvent[] | undefined => {
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
