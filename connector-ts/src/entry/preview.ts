// Port preview in a Connector host (09-port-preview.md): which sessions the listening ports belong to, read from this
// Connector's Agent processes, AA terminals and session timelines; the `session.port_preview` capability that tells
// clients whether this device can open previews; and where the command-line host finds frpc.
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import type { AgentProcessInfo, ChangeFeed, TimelineRepository } from '../application/ports/index.js'
import type { TimelineItem } from '../domain/conversation/timeline.js'
import type { ProtocolCapabilitySet } from '../generated/protocol/v1_2/capability-set.js'
import { sessionHints, type PreviewHostOptions, type PrintedUrls, type SessionHints, type SessionProcess } from '../workspace/index.js'

/** The session capability clients show "在手机上预览" by (supported: this host wires preview; available: frpc found). */
export const PORT_PREVIEW_CAPABILITY = 'session.port_preview'

/** What a host decides about port preview; the rest (`hints`, `e2eeMode`, device id, data directory) comes from the running Connector. */
export type PreviewWiring = Pick<PreviewHostOptions, 'frpcPath' | 'proxyUrl' | 'log' | 'transport' | 'list' | 'parents' | 'intervalMs' | 'refreshMs'>

/** `set` with this device's port preview capability for `sessionId` (replacing one the set already has). */
export function withPortPreview(set: ProtocolCapabilitySet, available: boolean, scope: { readonly runtime: string; readonly sessionId: string | null }): ProtocolCapabilitySet {
  const others = (set.capabilities ?? []).filter(item => item.capabilityId !== PORT_PREVIEW_CAPABILITY)
  return {
    ...set,
    capabilities: [...others, {
      capabilityId: PORT_PREVIEW_CAPABILITY,
      supported: true,
      available,
      ...(available ? {} : { unavailableReason: 'preview_unavailable' }),
      runtime: scope.runtime,
      scope: scope.sessionId === null ? 'runtime' : 'session',
      sessionId: scope.sessionId,
    }],
  }
}

export interface SessionHintSources {
  /** The Agent processes of the started Runtime instances (`RuntimeRegistry.agentProcesses`). */
  readonly agents: () => Promise<readonly AgentProcessInfo[]>
  /** The shells of the running AA terminals and the scope each was opened in. */
  readonly terminals: () => readonly SessionProcess[]
  readonly printed: PrintedUrls
  /** False for a scope that is no session (the file browser's terminals). */
  readonly isSession: (sessionId: string) => boolean
}

/** Reads the current session hints: Agent processes first (a shared one's busy session first), then terminals. */
export function sessionHintsSource(sources: SessionHintSources): () => Promise<SessionHints> {
  return async () => {
    const processes: SessionProcess[] = []
    for (const agent of await sources.agents()) for (const sessionId of agent.sessionIds) processes.push({ pid: agent.pid, sessionId })
    processes.push(...sources.terminals())
    const mentioned = new Map([...sources.printed.mentioned()].filter(([, mention]) => sources.isSession(mention.sessionId)))
    return sessionHints(processes.filter(process => sources.isSession(process.sessionId)), mentioned)
  }
}

/** Tool output read per pass, by count and bytes. */
const TIMELINE_PAGE = 200
const TIMELINE_BUDGET = 1024 * 1024
/** Text read from one item at most; a URL a dev server prints is near the start of its output. */
const ITEM_TEXT_MAX = 64 * 1024

/** The text of a tool item's content: its string values, depth first, up to `ITEM_TEXT_MAX` characters. */
export function itemText(content: unknown): string {
  const parts: string[] = []
  let length = 0
  const walk = (value: unknown, depth: number): void => {
    if (length >= ITEM_TEXT_MAX || depth > 8) return
    if (typeof value === 'string') {
      parts.push(value.slice(0, ITEM_TEXT_MAX - length))
      length += value.length
    } else if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1)
    } else if (value !== null && typeof value === 'object') {
      for (const entry of Object.values(value)) walk(entry, depth + 1)
    }
  }
  walk(content, 0)
  return parts.join('\n')
}

export interface TimelineUrlWatchOptions {
  readonly feed: ChangeFeed
  readonly timeline: Pick<TimelineRepository, 'changesSince'>
  readonly printed: PrintedUrls
  /** Commits of one session within this window are read together (streaming output commits often). */
  readonly delayMs?: number
  readonly log?: (message: string) => void
  readonly now?: () => number
}

/** Tool items created this long before the watch started still count (a turn that was running across a restart). */
const EARLIER_ITEMS_MS = 60_000

/**
 * Feeds the local URLs printed in session tool output to `printed` (09 §5.1's fallback signal): every commit after
 * this starts is read once, from the session's change cursor. History is not output now: a commit that rebuilds a
 * timeline (`reset`) is skipped, and so are items created well before the watch started (native history imported
 * later). Returns the stop function.
 */
export function watchTimelineUrls(options: TimelineUrlWatchOptions): () => void {
  const now = options.now ?? Date.now
  const since = now() - EARLIER_ITEMS_MS
  const cursors = new Map<string, number>()
  const timers = new Map<string, NodeJS.Timeout>()
  const running = new Map<string, Promise<void>>()
  let stopped = false

  const scan = async (sessionId: string): Promise<void> => {
    for (;;) {
      if (stopped) return
      const after = cursors.get(sessionId) ?? 0
      const page = await options.timeline.changesSince(sessionId, after, TIMELINE_PAGE, TIMELINE_BUDGET)
      for (const item of page.items) observeItem(sessionId, item)
      // Below the fence or past the head: start over from the head; history replayed there is not output now.
      const next = page.snapshotRequired ? page.headSeq : Math.max(after, page.toSeq)
      cursors.set(sessionId, Math.max(cursors.get(sessionId) ?? 0, next))
      if (page.complete || page.snapshotRequired || next === after) return
    }
  }

  const observeItem = (sessionId: string, item: TimelineItem): void => {
    if (item.type !== 'tool' && item.role !== 'tool') return
    const created = Date.parse(item.createdAt)
    if (Number.isFinite(created) && created < since) return
    options.printed.observe(sessionId, itemText(item.content))
  }

  const schedule = (sessionId: string): void => {
    if (stopped || timers.has(sessionId)) return
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      const previous = running.get(sessionId) ?? Promise.resolve()
      const next = previous.then(() => scan(sessionId)).catch(error => options.log?.(`tool output of ${sessionId}: ${(error as Error)?.message ?? String(error)}`))
      running.set(sessionId, next)
      void next.finally(() => {
        if (running.get(sessionId) === next) running.delete(sessionId)
      })
    }, options.delayMs ?? 500)
    timer.unref()
    timers.set(sessionId, timer)
  }

  const unsubscribe = options.feed.subscribe('*', notice => {
    if (notice.reset) {
      cursors.set(notice.sessionId, Math.max(cursors.get(notice.sessionId) ?? 0, notice.toSeq))
      return
    }
    // The first commit seen for a session starts its cursor: output from before this Connector started is not read.
    if (!cursors.has(notice.sessionId)) cursors.set(notice.sessionId, Math.max(0, notice.fromSeq - 1))
    schedule(notice.sessionId)
  })
  return () => {
    stopped = true
    unsubscribe()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}

/**
 * The frpc binary of the command-line host: `AA_FRPC_BINARY`, else `frpc` on `PATH`; null when there is none (the
 * host then declares port preview unavailable).
 */
export function findFrpc(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const executable = (path: string): boolean => {
    try {
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const configured = env.AA_FRPC_BINARY?.trim()
  if (configured) return isAbsolute(configured) && executable(configured) ? configured : null
  const name = platform === 'win32' ? 'frpc.exe' : 'frpc'
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (executable(candidate)) return candidate
  }
  return null
}
