// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/hermes/definition.py @98dd0e6e5 (HermesDialect)
//
// Hermes dialect.

import type { ConfigOption } from '../../../application/ports/runtime-session.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import type { AcpDialect } from '../../acp/dialect.js'
import { genericDialect } from '../generic/dialect.js'

export const EDIT_POLICY_OPTION = 'edit_approval_policy'

export function hermesDialect(): AcpDialect {
  // Approval cards already shown: (native session, toolCallId). After an answer Hermes sends a tool_call_update with
  // the card's own id to close it; that is not a tool call, and recording it would add an extra Timeline item.
  const approvalCards = new Set<string>()
  const key = (nativeSessionId: string, toolCallId: unknown) => `${nativeSessionId}\u0000${String(toolCallId)}`
  return {
    ...genericDialect('hermes', { permissionCatalog: true }),
    capabilities: info => negotiatedCapabilities(info, { steer: true, permissionCatalog: true }),
    // Hermes runs registered slash commands, including /steer, from plain-text prompts; no attachments.
    steer: 'text-command',
    steerCommand: '/steer',
    steerAttachments: false,
    // Hermes puts its edit approval policy under the ACP mode category.
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
