import { IMAGE_MIME_TYPES } from './attachments.js'
import type { CommandCapability } from './commands.js'

const unsupported = [
  'session.send_message', 'session.interrupt', 'session.steer', 'session.interaction.approval',
  'catalog.model', 'catalog.permission', 'catalog.effort', 'session.commands', 'runtime.attachment',
]

export function capabilities(sessionId?: string, writable = false, userQuestions = false,
  controls: { approval?: boolean, model?: boolean, effort?: boolean, permission?: boolean, attachments?: boolean, files?: boolean, commands?: CommandCapability } = {}) {
  const enabled = new Set(['runtime.config', ...(writable ? ['session.send_message', 'session.interrupt'] : []),
    ...(userQuestions || controls.approval ? ['session.interaction.approval'] : []),
    ...(controls.model ? ['catalog.model'] : []), ...(controls.effort ? ['catalog.effort'] : []),
    ...(controls.permission ? ['catalog.permission'] : []),
    ...(controls.commands?.available ? ['session.commands'] : []),
    ...(writable && controls.attachments ? ['runtime.attachment'] : [])])
  return {
    runtime: 'dsh', revision: 7, ...(sessionId ? { sessionId } : {}),
    capabilities: ['runtime.config', ...unsupported].map(capabilityId => ({
      capabilityId, runtime: 'dsh', scope: sessionId ? 'session' : 'runtime',
      supported: enabled.has(capabilityId), available: enabled.has(capabilityId),
      allowed: enabled.has(capabilityId),
      ...(capabilityId === 'runtime.attachment' && !controls.files ? { metadata: { allowedMimeTypes: [...IMAGE_MIME_TYPES] } } : {}),
      ...(enabled.has(capabilityId) ? {} : { unavailableReason: 'This DSH capability is not available.' }),
      ...(capabilityId === 'session.commands' && controls.commands ? {
        supported: controls.commands.supported, available: controls.commands.available, allowed: controls.commands.available,
        unavailableReason: controls.commands.reason ?? null, metadata: { catalogRevision: controls.commands.catalogRevision },
      } : {}),
    })),
    metadata: { readOnly: !writable, attachments: writable && Boolean(controls.attachments), userQuestions, approval: Boolean(controls.approval) },
  }
}
