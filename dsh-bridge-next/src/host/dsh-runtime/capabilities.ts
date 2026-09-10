import { IMAGE_MIME_TYPES } from './attachments.js'

const unsupported = [
  'session.send_message', 'session.interrupt', 'session.steer', 'session.interaction.approval',
  'catalog.model', 'catalog.permission', 'catalog.effort', 'session.commands', 'runtime.attachment',
]

export function capabilities(sessionId?: string, writable = false, userQuestions = false,
  controls: { model?: boolean, effort?: boolean, permission?: boolean, attachments?: boolean } = {}) {
  const enabled = new Set(['runtime.config', ...(writable ? ['session.send_message', 'session.interrupt'] : []),
    ...(userQuestions ? ['session.interaction.approval'] : []),
    ...(controls.model ? ['catalog.model'] : []), ...(controls.effort ? ['catalog.effort'] : []),
    ...(controls.permission ? ['catalog.permission'] : []),
    ...(writable && controls.attachments ? ['runtime.attachment'] : [])])
  return {
    runtime: 'dsh', revision: 4, ...(sessionId ? { sessionId } : {}),
    capabilities: ['runtime.config', ...unsupported].map(capabilityId => ({
      capabilityId, runtime: 'dsh', scope: sessionId ? 'session' : 'runtime',
      supported: enabled.has(capabilityId), available: enabled.has(capabilityId),
      allowed: enabled.has(capabilityId),
      ...(capabilityId === 'runtime.attachment' ? { metadata: { allowedMimeTypes: [...IMAGE_MIME_TYPES] } } : {}),
      ...(enabled.has(capabilityId) ? {} : { unavailableReason: 'This DSH capability is not available.' }),
    })),
    metadata: { readOnly: !writable, attachments: writable && Boolean(controls.attachments), userQuestions, approval: false },
  }
}
