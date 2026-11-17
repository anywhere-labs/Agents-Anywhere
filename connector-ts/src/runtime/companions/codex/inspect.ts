// `_codex/session/inspect`: codex-acp's read-only ownership check (docs/session-ownership.md); never resumes.
// The three dimensions are independent: ownership (who holds it), execution (whether it is running) and control
// (whether a usable control path exists); route is the open route codex-acp derives from them. The write lock
// observation is present only when the route reaches the write lock check.

import { asRecord, type AcpClient } from '../../acp/client.js'

export const CODEX_INSPECT = '_codex/session/inspect'
export const CODEX_IPC_SESSIONS = '_codex/ipc/sessions'

export type CodexOwnership = 'local' | 'external' | 'unowned' | 'unknown'
export type CodexExecution = 'idle' | 'running' | 'waitingForInput' | 'unknown'
export type CodexRoute = 'local' | 'follow' | 'daemon' | 'resume' | 'blocked'

export interface CodexWriterLockObservation {
  readonly state: 'held' | 'unheld' | 'unknown'
  /** contended, acquired, missing, unsupported-platform, unavailable, changed, invalid-session-id. */
  readonly reason?: string
  readonly observedAt?: number
  /** Only Linux's /proc/locks can provide it; a PID alone is not grounds for ending a process. */
  readonly ownerPid?: number
  readonly fileIdentity?: string
}

export interface CodexInspection {
  readonly ownership: CodexOwnership
  readonly execution: CodexExecution
  readonly control: 'localAppServer' | 'ipc' | 'daemon' | 'unavailable'
  readonly route: CodexRoute
  readonly writerLock?: CodexWriterLockObservation
}

const OWNERSHIP = new Set<CodexOwnership>(['local', 'external', 'unowned', 'unknown'])
const EXECUTION = new Set<CodexExecution>(['idle', 'running', 'waitingForInput', 'unknown'])
const CONTROL = new Set<CodexInspection['control']>(['localAppServer', 'ipc', 'daemon', 'unavailable'])
const ROUTES = new Set<CodexRoute>(['local', 'follow', 'daemon', 'resume', 'blocked'])
const LOCK_STATES = new Set<CodexWriterLockObservation['state']>(['held', 'unheld', 'unknown'])

function pick<T extends string>(allowed: ReadonlySet<T>, value: unknown, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback
}

/** Parses the inspect response; unrecognized values are treated as unknown / blocked, never guessed optimistically. */
export function parseInspection(value: unknown): CodexInspection {
  const record = asRecord(value)
  const observation = asRecord(record.writerLockObservation)
  const lockState = typeof record.writerLock === 'string' ? record.writerLock : observation.state
  const writerLock: CodexWriterLockObservation | undefined = lockState === undefined ? undefined : {
    state: pick(LOCK_STATES, lockState, 'unknown'),
    ...(typeof observation.reason === 'string' ? { reason: observation.reason } : {}),
    ...(typeof observation.observedAt === 'number' ? { observedAt: observation.observedAt } : {}),
    ...(typeof observation.ownerPid === 'number' ? { ownerPid: observation.ownerPid } : {}),
    ...(typeof observation.fileIdentity === 'string' ? { fileIdentity: observation.fileIdentity } : {}),
  }
  return {
    ownership: pick(OWNERSHIP, record.ownership, 'unknown'),
    execution: pick(EXECUTION, record.execution, 'unknown'),
    control: pick(CONTROL, record.control, 'unavailable'),
    route: pick(ROUTES, record.route, 'blocked'),
    ...(writerLock !== undefined ? { writerLock } : {}),
  }
}

/** With no owner answering, codex-acp waits for the IPC discovery timeout (about 5 seconds measured), so the timeout is generous. */
export async function inspectThread(client: AcpClient, threadId: string, timeoutMs = 30_000): Promise<CodexInspection> {
  return parseInspection(await client.request(CODEX_INSPECT, { sessionId: threadId }, { timeoutMs }))
}

/** The write lock is still held by someone else (or cannot be determined): the external owner is still there. */
export function heldElsewhere(inspection: CodexInspection): boolean {
  if (inspection.route === 'follow' || inspection.route === 'daemon') return true
  if (inspection.route !== 'blocked') return false
  return inspection.writerLock?.state !== 'unheld'
}

/** On Windows and similar platforms codex-acp cannot check the write lock: blocked only because of unknown, not because someone holds it. */
export function blockedOnlyByUnknownLock(inspection: CodexInspection): boolean {
  return inspection.route === 'blocked'
    && inspection.ownership === 'unknown'
    && inspection.writerLock?.state === 'unknown'
    && inspection.writerLock.reason === 'unsupported-platform'
}
