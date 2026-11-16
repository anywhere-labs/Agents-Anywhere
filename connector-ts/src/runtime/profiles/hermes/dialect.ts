// Hermes 方言。ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/hermes/definition.py `HermesDialect`

import type { ConfigOption } from '../../../application/ports/runtime-session.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import type { AcpDialect } from '../../acp/dialect.js'
import { genericDialect } from '../generic/dialect.js'

export const EDIT_POLICY_OPTION = 'edit_approval_policy'

export function hermesDialect(): AcpDialect {
  // 已经弹出的审批卡：(原生会话, toolCallId)。回答之后 Hermes 会用卡片自己的 id 发一条 tool_call_update
  // 关闭它；那不是工具调用，落条目会在 Timeline 上多出一项。
  const approvalCards = new Set<string>()
  const key = (nativeSessionId: string, toolCallId: unknown) => `${nativeSessionId}\u0000${String(toolCallId)}`
  return {
    ...genericDialect('hermes', { permissionCatalog: true }),
    capabilities: info => negotiatedCapabilities(info, { steer: true, permissionCatalog: true }),
    // Hermes 在纯文本 prompt 里执行注册过的斜杠命令，包括 /steer；不支持附件。
    steer: 'text-command',
    steerCommand: '/steer',
    steerAttachments: false,
    // Hermes 把编辑审批策略放在 ACP 的 mode 类别下。
    adaptConfig: options => options.map((option): ConfigOption => (option.id === EDIT_POLICY_OPTION && option.category === 'mode' ? { ...option, category: 'permission' } : option)),
    observeRequest: (method, params, context) => {
      if (method !== 'session/request_permission') return
      const toolCall = params.toolCall as { toolCallId?: unknown } | undefined
      if (toolCall?.toolCallId !== undefined) approvalCards.add(key(context.nativeSessionId, toolCall.toolCallId))
    },
    translateUpdate: (update, context) => {
      if (update.sessionUpdate !== 'tool_call_update') return undefined
      const card = key(context.nativeSessionId, update.toolCallId)
      if (!approvalCards.has(card)) return undefined
      approvalCards.delete(card)
      return []
    },
    verifySession: options => (options.some(option => option.category === 'model')
      ? undefined
      : { code: 'agent_version_unsupported', message: '当前 Hermes 版本没有提供 ACP 模型配置，请升级 Hermes 后重试。' }),
  }
}
