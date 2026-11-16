// 由 initialize 协商结果得出的能力（通用 ACP：只读能力完全来自协商，04 §5.5）。

import type { Capability } from '../../application/ports/runtime-session.js'
import { asRecord, type AgentInfo } from './client.js'

export interface NegotiationOptions {
  /** 方言是否提供运行中插话。 */
  readonly steer: boolean
  /** 客户端是否声明了 elicitation 表单。 */
  readonly forms?: boolean
  /** 是否有建会话前就能列出的权限选项。 */
  readonly permissionCatalog?: boolean
}

export function negotiatedCapabilities(info: AgentInfo, options: NegotiationOptions): Capability[] {
  const agent = info.agentCapabilities
  const sessions = asRecord(agent.sessionCapabilities)
  const prompt = asRecord(agent.promptCapabilities)
  const has = (name: string) => sessions[name] !== undefined && sessions[name] !== null
  const images = prompt.image === true
  return [
    { id: 'session.send_message', supported: true },
    { id: 'session.interrupt', supported: true },
    { id: 'session.steer', supported: options.steer },
    { id: 'session.interaction.approval', supported: true },
    { id: 'session.interaction.form', supported: options.forms ?? true },
    { id: 'session.commands', supported: true },
    { id: 'session.configuration.read', supported: true },
    { id: 'session.configuration.update', supported: true },
    { id: 'session.list', supported: has('list') },
    { id: 'session.fork', supported: has('fork') },
    { id: 'session.history.native', supported: agent.loadSession === true },
    { id: 'runtime.attachment', supported: images, ...(images ? { parameters: { image: true, audio: prompt.audio === true, embeddedContext: prompt.embeddedContext === true } } : {}) },
    { id: 'catalog.permission', supported: options.permissionCatalog === true },
  ]
}
