// `_codex/session/inspect`：codex-acp 的只读归属判定（docs/session-ownership.md），从不 resume。
// 三个维度相互独立：ownership（谁持有）、execution（在不在跑）、control（有没有可用的控制路径），
// route 是 codex-acp 据此给出的打开路线。写锁观察只在 route 走到写锁判定时才有。

import { asRecord, type AcpClient } from '../../acp/client.js'

export const CODEX_INSPECT = '_codex/session/inspect'
export const CODEX_IPC_SESSIONS = '_codex/ipc/sessions'

export type CodexOwnership = 'local' | 'external' | 'unowned' | 'unknown'
export type CodexExecution = 'idle' | 'running' | 'waitingForInput' | 'unknown'
export type CodexRoute = 'local' | 'follow' | 'daemon' | 'resume' | 'blocked'

export interface CodexWriterLockObservation {
  readonly state: 'held' | 'unheld' | 'unknown'
  /** contended、acquired、missing、unsupported-platform、unavailable、changed、invalid-session-id。 */
  readonly reason?: string
  readonly observedAt?: number
  /** 只有 Linux 的 /proc/locks 能给出；PID 不足以作为结束进程的依据。 */
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

/** 解析 inspect 响应；认不出的值一律当作 unknown / blocked，不往乐观方向猜。 */
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

/** 没有 owner 应答时 codex-acp 要等 IPC discovery 超时（实测约 5 秒），所以超时给得宽一些。 */
export async function inspectThread(client: AcpClient, threadId: string, timeoutMs = 30_000): Promise<CodexInspection> {
  return parseInspection(await client.request(CODEX_INSPECT, { sessionId: threadId }, { timeoutMs }))
}

/** 写锁仍被别人持有（或无法判定）：外部 owner 还在。 */
export function heldElsewhere(inspection: CodexInspection): boolean {
  if (inspection.route === 'follow' || inspection.route === 'daemon') return true
  if (inspection.route !== 'blocked') return false
  return inspection.writerLock?.state !== 'unheld'
}

/** Windows 等平台上 codex-acp 判定不了写锁：blocked 只是因为 unknown，不代表有人持有。 */
export function blockedOnlyByUnknownLock(inspection: CodexInspection): boolean {
  return inspection.route === 'blocked'
    && inspection.ownership === 'unknown'
    && inspection.writerLock?.state === 'unknown'
    && inspection.writerLock.reason === 'unsupported-platform'
}
