// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/sessions/rollout_settings.py @98dd0e6e5 (rollout settings)
// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/domain/selections.py @98dd0e6e5 (permission_selection_from_thread_state)
//
// Permission display for unloaded threads: reads the approval and sandbox settings Codex actually applied from the
// rollout tail and maps them onto the permission catalog.
//
// Neither `_codex/session/read` nor thread/read carries the approval and sandbox settings, and resume would take the
// write lock from the Codex App, so the rollout is read instead: Codex appends `turn_context` every turn and
// `thread_settings_applied` when settings change; the latest one wins. An empty result means unknown, and callers
// must not substitute defaults. The rollout path is found by thread ID under `$CODEX_HOME/sessions/YYYY/MM/DD/`
// and `archived_sessions/`, since this does not connect to the app-server directly.

import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { codexPermissionSelectionId } from '../../../domain/identity/index.js'
import { CODEX_PERMISSIONS } from '../../profiles/codex/permissions.js'

/** Settings records are always within the last few KiB; the cap keeps a pathological rollout from becoming a full-file scan. */
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

/** Reads the latest settings record from the rollout tail; returns {} when unreadable or absent. */
export async function rolloutPermissionSettings(path: string | undefined, maxBytes = MAX_SCAN_BYTES): Promise<PermissionSettings> {
  if (!path) return {}
  try {
    for await (const line of linesFromEnd(path, maxBytes)) {
      if (!MARKERS.some(marker => line.includes(marker))) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue // a line Codex is still appending
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
  // Without a named profile, only the resolved profile is included.
  const profile = settings.permission_profile
  if (!isRecord(profile)) return undefined
  if (profile.type === 'disabled') return 'danger-full-access'
  const fileSystem = profile.file_system
  if (profile.type !== 'managed' || !isRecord(fileSystem)) return undefined
  if (fileSystem.type !== 'restricted' || !Array.isArray(fileSystem.entries)) return undefined
  const writable = fileSystem.entries.some(entry => isRecord(entry) && entry.access === 'write')
  return writable ? 'workspace-write' : 'read-only'
}

/** Yields lines from the end of the file backwards (newest first). */
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
      // The first segment may continue from the previous chunk.
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
 * Permission catalog entries that match the settings:
 * - approvalPolicy, when given, must be equal;
 * - approvalsReviewer, when given, must be equal, but `user` (the Codex default) also matches entries with no fixed
 *   reviewer (full access);
 * - with no reviewer and an on-request policy, entries with a fixed reviewer do not match;
 * - sandbox, when given, must be equal.
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

/** The first 48 bits of a UUIDv7 thread ID are the creation time (ms); undefined when it is not v7. */
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
 * Finds a thread's rollout: first by the UUIDv7 creation date (one day either side, since directories are named in
 * local time), then in the latest `maxDays` date directories, and finally in archived_sessions (compressed
 * `.jsonl.zst` files are not read).
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

/** Current permission selection ID of an unloaded thread; undefined when unknown (no default is substituted). */
export async function nativePermissionSelection(codexHome: string, threadId: string): Promise<string | undefined> {
  return permissionSelectionFromSettings(await rolloutPermissionSettings(await findRollout(codexHome, threadId)))
}
