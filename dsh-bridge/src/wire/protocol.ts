/** Shared DSH bridge protocol major/minor implemented by this package. */
export const PROTOCOL_VERSION = '1.0'
/** Provider identity on the Bridge wire. Named instance binding belongs to Connector. */
export const RUNTIME_ID = 'dsh'
/** Fixed line payload limit shared with the Connector. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export const REQUEST_METHODS = [
  'initialize',
  'runtime.getConfig',
  'runtime.getCapabilities',
  'catalog.listModels',
  'catalog.listPermissions',
  'session.list',
  'session.getSnapshot',
  'session.getState',
  'session.getNotices',
  'session.getCapabilities',
  'session.createAndStart',
  'session.startTurn',
  'session.steer',
  'session.interrupt',
  'session.updateSelections',
  'session.listCommands',
  'session.executeCommand',
  'session.respondInteraction',
  'ping',
  'shutdown',
] as const

export type RequestMethod = typeof REQUEST_METHODS[number]

export const INBOUND_NOTIFICATION_METHODS = ['$/cancelRequest'] as const
export type InboundNotificationMethod = typeof INBOUND_NOTIFICATION_METHODS[number]
