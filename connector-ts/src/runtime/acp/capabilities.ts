// Capabilities derived from the initialize negotiation (generic ACP: read-only capabilities come entirely from negotiation, 04 §5.5).

import type { Capability } from '../../application/ports/runtime-session.js'
import { asRecord, type AgentInfo } from './client.js'

export interface NegotiationOptions {
  /** Whether the dialect supports steering a running turn. */
  readonly steer: boolean
  /** Whether the client declared elicitation forms. */
  readonly forms?: boolean
  /** Whether permission options can be listed before a session is created. */
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
