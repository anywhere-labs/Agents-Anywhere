import { RUNTIME_ID } from '../wire/protocol.js'
import type { Capability, RuntimeStatus } from './types.js'

const RUNTIME_CAPABILITIES = [
  'runtime.config',
  'catalog.model',
  'catalog.permission',
  'catalog.effort',
] as const

const SESSION_CAPABILITIES = [
  'session.send_message',
  'session.interrupt',
  'session.steer',
  'session.interaction.approval',
  'session.commands',
] as const

export function runtimeCapabilities(): Capability[] {
  return RUNTIME_CAPABILITIES.map(capabilityId => ({
    capabilityId,
    scope: 'runtime',
    runtime: RUNTIME_ID,
    supported: true,
    available: true,
    allowed: true,
  }))
}

export function sessionCapabilities(
  sessionId: string,
  status: RuntimeStatus,
  modelAvailable: boolean,
): Capability[] {
  return SESSION_CAPABILITIES.map((capabilityId): Capability => {
    let available = status !== 'error' && status !== 'disconnected'
    if (capabilityId === 'session.send_message') available = status === 'idle' && modelAvailable
    if (capabilityId === 'session.steer') available = status === 'running'
    if (capabilityId === 'session.interrupt') {
      available = ['running', 'waiting_approval', 'blocked', 'stopping'].includes(status)
    }
    if (capabilityId === 'session.commands') available = status === 'idle'
    return {
      capabilityId,
      scope: 'session',
      runtime: RUNTIME_ID,
      sessionId,
      supported: true,
      available,
      allowed: true,
      ...(available ? {} : { unavailableReason: unavailableReason(status, modelAvailable) }),
    }
  })
}

function unavailableReason(status: RuntimeStatus, modelAvailable: boolean): string {
  if (!modelAvailable) return 'Select a model available from the current DSH Host.'
  return `The operation is unavailable while the Session status is ${status}.`
}
