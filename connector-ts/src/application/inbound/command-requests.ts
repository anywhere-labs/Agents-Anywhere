import type { CommandMethod, CommandPayloads } from '../../generated/device-meshcall/v1_0/payloads.js'
import type { CommandAttachmentRef } from '../../generated/device-meshcall/v1_0/send-message-command.js'
import type { CreationBeginCommand } from '../../generated/device-meshcall/v1_0/creation-begin-command.js'
import { UseCaseError, type AttachmentRef, type CreateSessionCommand } from '../conversation-service.js'

export type CommandRequest<M extends CommandMethod> = CommandPayloads[M]['request']
export type CommandResponse<M extends CommandMethod> = CommandPayloads[M]['response']

type Planning = CommandRequest<'session.planning'>
type Goal = CommandRequest<'session.goal'>
type QueueMode = NonNullable<CommandRequest<'session.sendMessage'>['queue']>

const QUEUE_MODES: readonly QueueMode[] = ['auto', 'interrupt', 'never']
const PLANNING_COMMANDS: readonly Planning['command'][] = ['enter_plan', 'exit_plan', 'submit_task', 'approve_and_execute', 'request_revision', 'dismiss_review']
const GOAL_ACTIONS: readonly Goal['action'][] = ['set', 'edit', 'pause', 'resume', 'clear']

function invalid(message: string): UseCaseError {
  return new UseCaseError('invalid_argument', message)
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${field} is required`)
  return value
}

/** A non-empty string, else null (an absent, empty or non-string value). */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function oneOf<T extends string>(value: string, allowed: readonly T[], unknown: (value: string) => string): T {
  if (!(allowed as readonly string[]).includes(value)) throw invalid(unknown(value))
  return value as T
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${field} must be an object`)
  return value as Record<string, unknown>
}

/** Attachment refs as sent; their facts are checked where the file is resolved. */
function attachments(value: unknown): CommandAttachmentRef[] {
  return Array.isArray(value) ? (value as CommandAttachmentRef[]) : []
}

/** `selections` of v2 `session.selections.update`: catalog type → selection id (null keeps the current one). */
function selections(value: unknown): Record<string, string | boolean | null> {
  const entries = object(value, 'selections')
  const out: Record<string, string | boolean | null> = {}
  for (const [key, entry] of Object.entries(entries)) {
    if (entry !== null && typeof entry !== 'string' && typeof entry !== 'boolean') throw invalid(`selection ${key} must be a string`)
    out[key] = entry
  }
  return out
}

/** `planningIntent: {mode: "plan", operationId}` / `goalIntent: {mode: "goal", operationId}` of a creation. */
function intent<M extends 'plan' | 'goal'>(value: unknown, mode: M, field: string): { mode: M; operationId: string } | null {
  if (value === undefined || value === null) return null
  const entry = value as Record<string, unknown>
  if (typeof value !== 'object' || (entry.mode !== undefined && entry.mode !== mode)) throw invalid(`${field}.mode must be ${mode}`)
  return { mode, operationId: text(entry.operationId, `${field}.operationId`) }
}

/** A request whose use case validates its own fields (workspace preparation, Runtime Control, preview). */
function checkedBy<T>(): (p: Record<string, unknown>) => T {
  return p => p as T
}

function queueItem(p: Record<string, unknown>): CommandRequest<'session.queue.update'> & { content?: string; attachments?: CommandAttachmentRef[] } {
  return {
    sessionId: text(p.sessionId, 'sessionId'),
    messageId: text(p.messageId, 'messageId'),
    ...(typeof p.content === 'string' ? { content: p.content } : {}),
    ...(Array.isArray(p.attachments) ? { attachments: p.attachments as CommandAttachmentRef[] } : {}),
  }
}

function sessionOnly(p: Record<string, unknown>): CommandRequest<'session.interrupt'> {
  return { sessionId: text(p.sessionId, 'sessionId') }
}

/** `session.select`: a batch of `selections`, or one `optionId`/`value` (`kind`/`selectionId` are their v2 names). */
type SelectRequest = CommandRequest<'session.select'> & (
  | { selections: Record<string, string | boolean | null> }
  | { selections?: null; optionId: string; value: string | boolean }
)

/**
 * The one runtime check of every command's payload (`CommandCall.p`), run by `CommandInbox` before its handler: it
 * turns foreign data into the generated request type, or throws `invalid_argument`. Each parser may narrow its
 * request further (defaults filled in, legacy aliases resolved); the handler sees the parser's output type.
 */
export const REQUEST_PARSERS = {
  'session.sendMessage': (p): CommandRequest<'session.sendMessage'> & { content: string; attachments: CommandAttachmentRef[]; queue: QueueMode | null } => {
    const queue = optionalString(p.queue)
    return {
      sessionId: text(p.sessionId, 'sessionId'),
      clientMessageId: text(p.clientMessageId, 'clientMessageId'),
      content: typeof p.content === 'string' ? p.content : '',
      attachments: attachments(p.attachments),
      queue: queue === null ? null : oneOf(queue, QUEUE_MODES, () => 'queue must be auto, interrupt or never'),
    }
  },
  'session.steer': (p): CommandRequest<'session.steer'> & { content: string; attachments: CommandAttachmentRef[] } => ({
    sessionId: text(p.sessionId, 'sessionId'),
    clientMessageId: text(p.clientMessageId, 'clientMessageId'),
    content: typeof p.content === 'string' ? p.content : '',
    attachments: attachments(p.attachments),
  }),
  'session.select': (p): SelectRequest => {
    const sessionId = text(p.sessionId, 'sessionId')
    if (p.selections !== undefined) return { sessionId, selections: selections(p.selections) }
    return {
      sessionId,
      optionId: text(p.optionId ?? p.kind, 'optionId'),
      value: typeof p.value === 'boolean' ? p.value : text(p.value ?? p.selectionId, 'value'),
    }
  },
  'session.interrupt': sessionOnly,
  'session.respondNotice': (p): CommandRequest<'session.respondNotice'> => {
    const cancel = p.cancel === true
    const input = p.input !== undefined && p.input !== null && typeof p.input === 'object' ? (p.input as Record<string, unknown>) : null
    // An approval option needs its action id; a cancellation or a form answer may come without one.
    const actionId = cancel || input !== null ? optionalString(p.actionId) : text(p.actionId, 'actionId')
    return {
      sessionId: text(p.sessionId, 'sessionId'),
      noticeId: text(p.noticeId, 'noticeId'),
      responseId: optionalString(p.responseId),
      ...(cancel ? { cancel } : {}),
      ...(input !== null ? { input } : {}),
      ...(actionId !== null ? { actionId } : {}),
    }
  },
  // The use case (PreparationService.begin) checks the rest of a prepared creation.
  'session.creation.begin': (p): CreationBeginCommand => {
    text(p.preparationId, 'preparationId')
    return p as unknown as CreationBeginCommand
  },
  'session.creation.respond': checkedBy<CommandRequest<'session.creation.respond'>>(),
  'session.creation.cancel': checkedBy<CommandRequest<'session.creation.cancel'>>(),
  'workspace.prepare': checkedBy<CommandRequest<'workspace.prepare'>>(),
  'workspace.preparation.reserve': checkedBy<CommandRequest<'workspace.preparation.reserve'>>(),
  'workspace.preparation.cancel': checkedBy<CommandRequest<'workspace.preparation.cancel'>>(),
  'workspace.preparation.respond': checkedBy<CommandRequest<'workspace.preparation.respond'>>(),
  'session.planning': (p): Planning => {
    const optional = (field: 'reviewId' | 'planId' | 'contentHash' | 'epoch' | 'feedback') => (p[field] !== undefined ? { [field]: optionalString(p[field]) } : {})
    const planRevision = optionalNumber(p.planRevision)
    const expectedRevision = optionalNumber(p.expectedRevision)
    return {
      sessionId: text(p.sessionId, 'sessionId'),
      command: oneOf(text(p.command, 'command'), PLANNING_COMMANDS, value => `unknown planning command ${value}`),
      operationId: text(p.operationId, 'operationId'),
      ...optional('reviewId'),
      ...optional('planId'),
      ...(planRevision !== undefined ? { planRevision } : {}),
      ...optional('contentHash'),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...optional('epoch'),
      ...optional('feedback'),
    }
  },
  'session.goal': (p): Goal => ({
    sessionId: text(p.sessionId, 'sessionId'),
    action: oneOf(text(p.action, 'action'), GOAL_ACTIONS, value => `unknown goal action ${value}`),
    // Required by the contract; an absent one is read as -1.
    expectedRevision: optionalNumber(p.expectedRevision) ?? -1,
    objective: optionalString(p.objective),
    operationId: text(p.operationId, 'operationId'),
  }),
  'session.queue.update': queueItem,
  'session.queue.delete': queueItem,
  'session.queue.retry': queueItem,
  'session.queue.sendNow': queueItem,
  'session.queue.resume': sessionOnly,
  'session.queue.clear': sessionOnly,
  'session.queue.reorder': (p): CommandRequest<'session.queue.reorder'> => ({
    sessionId: text(p.sessionId, 'sessionId'),
    messageIds: Array.isArray(p.messageIds) ? p.messageIds.map(String) : [],
  }),
  'session.sync': (p): CommandRequest<'session.sync'> => {
    const takeover = optionalBoolean(p.takeover)
    const archived = optionalBoolean(p.archived)
    return {
      sessionId: text(p.sessionId, 'sessionId'),
      ...(takeover !== undefined ? { takeover } : {}),
      ...(archived !== undefined ? { archived } : {}),
    }
  },
  'session.configuration.update': (p): CommandRequest<'session.configuration.update'> & { values: Record<string, string | boolean> } => {
    const values = object(p.values ?? {}, 'values')
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') throw invalid(`value of ${key} must be a string or a boolean`)
    }
    const expectedRevision = optionalNumber(p.expectedRevision)
    if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw invalid('expectedRevision is required')
    return { sessionId: text(p.sessionId, 'sessionId'), operationId: text(p.operationId, 'operationId'), expectedRevision, values: values as Record<string, string | boolean> }
  },
  'session.agent.operate': (p): CommandRequest<'session.agent.operate'> & { values: Record<string, unknown> } => ({
    sessionId: text(p.sessionId, 'sessionId'),
    operation: text(p.operation, 'operation'),
    operationId: text(p.operationId, 'operationId'),
    expectedGeneration: text(p.expectedGeneration, 'expectedGeneration'),
    values: p.values === undefined || p.values === null ? {} : object(p.values, 'values'),
  }),
  'session.position.select': (p): CommandRequest<'session.position.select'> => {
    const positionRevision = optionalNumber(p.positionRevision)
    if (positionRevision === undefined || !Number.isSafeInteger(positionRevision) || positionRevision < 0) throw invalid('positionRevision is required')
    return {
      sessionId: text(p.sessionId, 'sessionId'),
      fileEntriesDigest: text(p.fileEntriesDigest, 'fileEntriesDigest'),
      sourceEpoch: text(p.sourceEpoch, 'sourceEpoch'),
      positionRevision,
      leafId: optionalString(p.leafId),
    }
  },
  'session.close': (p): CommandRequest<'session.close'> => ({
    sessionId: text(p.sessionId, 'sessionId'),
    ownerGeneration: text(p.ownerGeneration, 'ownerGeneration'),
    closeOperationId: optionalString(p.closeOperationId),
  }),
  'session.recover': (p): CommandRequest<'session.recover'> => ({
    sessionId: text(p.sessionId, 'sessionId'),
    operationId: text(p.operationId, 'operationId'),
    expectedGeneration: text(p.expectedGeneration, 'expectedGeneration'),
    cliExited: optionalBoolean(p.cliExited) ?? false,
    sourceRevision: optionalString(p.sourceRevision),
  }),
  'runtime.apply': checkedBy<CommandRequest<'runtime.apply'>>(),
  'channel.switch': checkedBy<CommandRequest<'channel.switch'>>(),
  'device.settings.apply': checkedBy<CommandRequest<'device.settings.apply'>>(),
  'preview.open': checkedBy<CommandRequest<'preview.open'>>(),
  'preview.close': checkedBy<CommandRequest<'preview.close'>>(),
} satisfies { readonly [M in CommandMethod]: (payload: Record<string, unknown>) => CommandRequest<M> }

/** The request a handler of `M` receives: the parser's output. */
export type ParsedRequest<M extends CommandMethod> = ReturnType<(typeof REQUEST_PARSERS)[M]>

/** Checks `payload` against `method`'s request; throws `invalid_argument` when it does not fit. */
export function parseRequest<M extends CommandMethod>(method: M, payload: unknown): ParsedRequest<M> {
  const parse = REQUEST_PARSERS[method] as (p: Record<string, unknown>) => ParsedRequest<M>
  return parse(object(payload ?? {}, 'payload'))
}

/**
 * The payload of a device-local create-and-start (`POST /sessions/create-and-start`): a new session, its Runtime and
 * directory, and the first message, with an optional planning or goal intent. Throws `invalid_argument`.
 */
export function parseCreateAndStart(payload: unknown): CreateSessionCommand {
  const p = object(payload ?? {}, 'payload')
  const projectId = optionalString(p.projectId)
  const planningIntent = intent(p.planningIntent, 'plan', 'planningIntent')
  const goalIntent = intent(p.goalIntent, 'goal', 'goalIntent')
  return {
    sessionId: text(p.sessionId, 'sessionId'),
    runtimeId: text(p.runtimeId, 'runtimeId'),
    runtimeType: text(p.runtimeType, 'runtimeType'),
    cwd: text(p.cwd, 'cwd'),
    ...(projectId !== null ? { projectId } : {}),
    title: optionalString(p.title),
    ...(p.selections !== null && typeof p.selections === 'object' ? { selections: p.selections as Record<string, string | null> } : {}),
    clientMessageId: text(p.clientMessageId, 'clientMessageId'),
    content: typeof p.content === 'string' ? p.content : '',
    attachments: attachments(p.attachments) as AttachmentRef[],
    ...(typeof p.takeover === 'boolean' ? { takeover: p.takeover } : {}),
    ...(planningIntent !== null ? { planningIntent } : {}),
    ...(goalIntent !== null ? { goalIntent } : {}),
  }
}
