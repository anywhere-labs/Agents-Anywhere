const unsupported = [
  'session.send_message', 'session.interrupt', 'session.steer', 'session.interaction.approval',
  'catalog.model', 'catalog.permission', 'catalog.effort', 'session.commands',
]

export function capabilities(sessionId?: string, writable = false, userQuestions = false) {
  const enabled = new Set(['runtime.config', ...(writable ? ['session.send_message', 'session.interrupt'] : []),
    ...(userQuestions ? ['session.interaction.approval'] : [])])
  return {
    runtime: 'dsh', revision: 2, ...(sessionId ? { sessionId } : {}),
    capabilities: ['runtime.config', ...unsupported].map(capabilityId => ({
      capabilityId, runtime: 'dsh', scope: sessionId ? 'session' : 'runtime',
      supported: enabled.has(capabilityId), available: enabled.has(capabilityId),
      allowed: enabled.has(capabilityId),
      ...(enabled.has(capabilityId) ? {} : { unavailableReason: 'This DSH capability is not available.' }),
    })),
    metadata: { readOnly: !writable, attachments: false, userQuestions, approval: false },
  }
}
