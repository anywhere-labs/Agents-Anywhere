const unsupported = [
  'session.send_message', 'session.interrupt', 'session.steer', 'session.interaction.approval',
  'catalog.model', 'catalog.permission', 'catalog.effort', 'session.commands',
]

export function capabilities(sessionId?: string) {
  return {
    runtime: 'dsh', revision: 1, ...(sessionId ? { sessionId } : {}),
    capabilities: ['runtime.config', ...unsupported].map(capabilityId => ({
      capabilityId, runtime: 'dsh', scope: sessionId ? 'session' : 'runtime',
      supported: capabilityId === 'runtime.config', available: capabilityId === 'runtime.config',
      allowed: capabilityId === 'runtime.config',
      ...(capabilityId === 'runtime.config' ? {} : { unavailableReason: 'DSH currently supports session history reading only.' }),
    })),
    metadata: { readOnly: true },
  }
}
