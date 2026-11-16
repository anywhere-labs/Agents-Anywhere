// 未加载线程的权限显示：从 rollout 末尾读 Codex 实际生效的审批与沙箱设置，映射到 v2 权限目录。
// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/sessions/rollout_settings.py
// 与 domain/selections.py `permission_selection_from_thread_state`（匹配规则）。
//
// `_codex/session/read` 和 thread/read 都不带审批与沙箱设置，而 resume 会从 Codex App 手里抢写锁，
// 所以读 rollout：Codex 每个回合追加 `turn_context`，设置变化时追加 `thread_settings_applied`，
// 取最新的一条。结果为空表示未知，调用方不得代入默认值。
// 与 v2 的差别：rollout 路径由线程 ID 在 `$CODEX_HOME/sessions/YYYY/MM/DD/` 和 `archived_sessions/` 里找
// （v2 从 thread/read 的 `path` 拿；v3 不直接连 app-server）。

import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { codexPermissionSelectionId } from '../../../domain/identity/index.js'
import { CODEX_PERMISSIONS } from '../../profiles/codex/permissions.js'

/** 设置记录实际都在末尾几 KiB 内；上限防止病态 rollout 变成整文件扫描。 */
export const MAX_SCAN_BYTES = 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const MARKERS = ['"turn_context"', '"thread_settings_applied"']
const PROFILE_SANDBOXES: Readonly<Record<string, string>> = {
  ':danger-full-access': 'danger-full-access',
  ':workspace': 'workspace-write',
  ':read-only': 'read-only',
}
const POLICY_SANDBOXES: Readonly<Record<string, string>> = {
  'danger-full-access': 'danger-full-access',
  dangerFullAccess: 'danger-full-access',
  'workspace-write': 'workspace-write',
  workspaceWrite: 'workspace-write',
  'read-only': 'read-only',
  readOnly: 'read-only',
}
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PermissionSettings {
  readonly approvalPolicy?: string
  readonly approvalsReviewer?: string
  readonly sandbox?: string
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 读 rollout 末尾最新的设置记录；读不到或没有记录时返回 {}。 */
export async function rolloutPermissionSettings(path: string | undefined, maxBytes = MAX_SCAN_BYTES): Promise<PermissionSettings> {
  if (!path) return {}
  try {
    for await (const line of linesFromEnd(path, maxBytes)) {
      if (!MARKERS.some(marker => line.includes(marker))) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue // Codex 还在追加的行
      }
      const settings = permissionSettings(record)
      if (settings !== undefined) return settings
    }
  } catch {
    return {}
  }
  return {}
}

export function permissionSettings(record: unknown): PermissionSettings | undefined {
  if (!isRecord(record) || !isRecord(record.payload)) return undefined
  const payload = record.payload
  let source: Json
  let sandbox: string | undefined
  if (record.type === 'turn_context') {
    source = payload
    sandbox = policySandbox(payload.sandbox_policy)
  } else if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    if (!isRecord(payload.thread_settings)) return undefined
    source = payload.thread_settings
    sandbox = profileSandbox(source)
  } else {
    return undefined
  }
  const result: { approvalPolicy?: string; approvalsReviewer?: string; sandbox?: string } = {}
  if (typeof source.approval_policy === 'string' && source.approval_policy) result.approvalPolicy = source.approval_policy
  if (typeof source.approvals_reviewer === 'string' && source.approvals_reviewer) result.approvalsReviewer = source.approvals_reviewer
  if (sandbox !== undefined) result.sandbox = sandbox
  return Object.keys(result).length ? result : undefined
}

function policySandbox(policy: unknown): string | undefined {
  const kind = isRecord(policy) ? policy.type : policy
  return typeof kind === 'string' ? POLICY_SANDBOXES[kind] : undefined
}

function profileSandbox(settings: Json): string | undefined {
  const active = settings.active_permission_profile
  if (isRecord(active) && typeof active.id === 'string' && PROFILE_SANDBOXES[active.id] !== undefined) return PROFILE_SANDBOXES[active.id]
  // 没有具名 profile 时只带解析后的 profile。
  const profile = settings.permission_profile
  if (!isRecord(profile)) return undefined
  if (profile.type === 'disabled') return 'danger-full-access'
  const fileSystem = profile.file_system
  if (profile.type !== 'managed' || !isRecord(fileSystem)) return undefined
  if (fileSystem.type !== 'restricted' || !Array.isArray(fileSystem.entries)) return undefined
  const writable = fileSystem.entries.some(entry => isRecord(entry) && entry.access === 'write')
  return writable ? 'workspace-write' : 'read-only'
}

/** 从文件末尾往前逐行产出（最新的在前）。 */
async function* linesFromEnd(path: string, maxBytes: number): AsyncGenerator<string> {
  const file = await open(path, 'r')
  try {
    const end = (await file.stat()).size
    const stop = Math.max(0, end - maxBytes)
    let position = end
    let remainder: Buffer = Buffer.alloc(0)
    while (position > stop) {
      const size = Math.min(CHUNK_BYTES, position - stop)
      position -= size
      const chunk = Buffer.alloc(size)
      await file.read(chunk, 0, size, position)
      const parts = splitLines(Buffer.concat([chunk, remainder]))
      // 第一段可能接着上一块。
      remainder = parts[0] ?? Buffer.alloc(0)
      for (let i = parts.length - 1; i >= 1; i -= 1) {
        const line = parts[i]!.toString('utf8')
        if (line.trim()) yield line
      }
    }
    if (position === 0 && remainder.toString('utf8').trim()) yield remainder.toString('utf8')
  } finally {
    await file.close()
  }
}

function splitLines(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      parts.push(buffer.subarray(start, i))
      start = i + 1
    }
  }
  parts.push(buffer.subarray(start))
  return parts
}

/**
 * v2 权限目录里与设置匹配的条目（selections.py `permission_selection_from_thread_state` 的匹配规则）：
 * - approvalPolicy 给出时必须相同；
 * - approvalsReviewer 给出时必须相同，但 `user`（Codex 缺省）也匹配没有固定评审者的条目（完全访问）；
 * - 没有评审者而策略是 on-request 时，不匹配固定了评审者的条目；
 * - sandbox 给出时必须相同。
 */
export function permissionSelectionFromSettings(settings: PermissionSettings): string | undefined {
  const { approvalPolicy, approvalsReviewer, sandbox } = settings
  if (approvalPolicy === undefined && approvalsReviewer === undefined && sandbox === undefined) return undefined
  for (const permission of CODEX_PERMISSIONS) {
    const native = permission.nativeSettings
    if (approvalPolicy !== undefined && native.approvalPolicy !== approvalPolicy) continue
    const reviewer = native.approvalsReviewer
    if (approvalsReviewer !== undefined && reviewer !== approvalsReviewer && !(approvalsReviewer === 'user' && reviewer === undefined)) continue
    if (approvalsReviewer === undefined && (approvalPolicy === 'on-request' || approvalPolicy === 'on_request') && reviewer !== undefined) continue
    if (sandbox !== undefined && native.sandbox !== sandbox) continue
    return codexPermissionSelectionId(permission.id, { permission_mode: permission.id })
  }
  return undefined
}

/** UUIDv7 线程 ID 前 48 位是创建时间（毫秒）；不是 v7 时返回 undefined。 */
export function threadCreatedAt(threadId: string): Date | undefined {
  if (!THREAD_ID.test(threadId) || threadId[14] !== '7') return undefined
  const ms = Number.parseInt(threadId.slice(0, 8) + threadId.slice(9, 13), 16)
  return Number.isFinite(ms) ? new Date(ms) : undefined
}

const pad = (n: number) => String(n).padStart(2, '0')

async function findIn(directory: string, suffix: string): Promise<string | undefined> {
  try {
    const name = (await readdir(directory)).find(entry => entry.startsWith('rollout-') && entry.endsWith(suffix))
    return name === undefined ? undefined : join(directory, name)
  } catch {
    return undefined
  }
}

/**
 * 找线程的 rollout：先按 UUIDv7 的创建日期（前后各一天，目录按本地时区命名）找，再在最近
 * `maxDays` 个日期目录里找，最后找 archived_sessions（压缩过的 `.jsonl.zst` 不读）。
 */
export async function findRollout(codexHome: string, threadId: string, maxDays = 400): Promise<string | undefined> {
  if (!THREAD_ID.test(threadId)) return undefined
  const suffix = `-${threadId.toLowerCase()}.jsonl`
  const sessions = join(codexHome, 'sessions')
  const created = threadCreatedAt(threadId)
  const tried = new Set<string>()
  if (created !== undefined) {
    for (const offset of [0, -1, 1]) {
      const day = new Date(created.getTime() + offset * 86_400_000)
      const directory = join(sessions, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()))
      tried.add(directory)
      const found = await findIn(directory, suffix)
      if (found !== undefined) return found
    }
  }
  const sortedDesc = async (directory: string) => {
    try {
      return (await readdir(directory)).filter(name => /^\d+$/.test(name)).sort().reverse()
    } catch {
      return []
    }
  }
  let days = 0
  for (const year of await sortedDesc(sessions)) {
    for (const month of await sortedDesc(join(sessions, year))) {
      for (const day of await sortedDesc(join(sessions, year, month))) {
        if (days++ >= maxDays) return findIn(join(codexHome, 'archived_sessions'), suffix)
        const directory = join(sessions, year, month, day)
        if (tried.has(directory)) continue
        const found = await findIn(directory, suffix)
        if (found !== undefined) return found
      }
    }
  }
  return findIn(join(codexHome, 'archived_sessions'), suffix)
}

/** 未加载线程当前的权限 selection ID；未知时 undefined（不代入默认值）。 */
export async function nativePermissionSelection(codexHome: string, threadId: string): Promise<string | undefined> {
  return permissionSelectionFromSettings(await rolloutPermissionSettings(await findRollout(codexHome, threadId)))
}
