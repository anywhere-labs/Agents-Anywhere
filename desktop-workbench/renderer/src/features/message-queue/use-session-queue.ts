"use client"

import * as React from "react"
import { toast } from "sonner"

import { dashboardApi } from "@/features/dashboard/api"
import type { SessionQueueState } from "@/features/dashboard/types"
import { mergeQueueState, readQueueState, type QueueStateView } from "@/features/message-queue/queue-model"

type Visit = { sessionId: string; token: string }

/**
 * The session's server-owned message queue: loaded once per visit, then kept
 * current from ``runtime.queue.updated`` events and from action responses.
 */
export function useSessionQueue(token: string, sessionId: string, enabled: boolean) {
  const visit = React.useRef<Visit>({ token, sessionId })
  if (visit.current.token !== token || visit.current.sessionId !== sessionId) {
    visit.current = { token, sessionId }
  }
  const [projection, setProjection] = React.useState<{ visit: Visit; queue: QueueStateView } | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const queue = projection?.visit === visit.current ? projection.queue : null

  const ingest = React.useCallback((value: unknown) => {
    const next = readQueueState(value)
    if (!next || next.sessionId !== visit.current.sessionId) return
    const current = visit.current
    setProjection((old) => {
      const merged = mergeQueueState(old?.visit === current ? old.queue : null, next)
      return merged ? { visit: current, queue: merged } : old
    })
  }, [])

  const refresh = React.useCallback(async () => {
    const current = visit.current
    try {
      const next = await dashboardApi.getSessionQueue(current.token, current.sessionId)
      if (current === visit.current) ingest(next)
    } catch {
      // The queue arrives with the next event; nothing to show meanwhile.
    }
  }, [ingest])

  React.useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh, sessionId, token])

  const run = React.useCallback(
    async (messageId: string | null, action: () => Promise<SessionQueueState>, failure: string) => {
      const current = visit.current
      setBusyId(messageId ?? "*")
      try {
        const next = await action()
        if (current === visit.current) ingest(next)
        return true
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : failure)
        if (current === visit.current) void refresh()
        return false
      } finally {
        if (current === visit.current) setBusyId(null)
      }
    },
    [ingest, refresh],
  )

  return {
    queue,
    busyId,
    ingest,
    refresh,
    run,
    remove: (messageId: string, failure: string) =>
      run(messageId, () => dashboardApi.deleteSessionQueueItem(token, sessionId, messageId), failure),
    retry: (messageId: string, failure: string) =>
      run(messageId, () => dashboardApi.retrySessionQueueItem(token, sessionId, messageId), failure),
    sendNow: (messageId: string, failure: string) =>
      run(messageId, () => dashboardApi.sendSessionQueueItemNow(token, sessionId, messageId), failure),
    edit: (messageId: string, content: string, failure: string) =>
      run(messageId, () => dashboardApi.updateSessionQueueItem(token, sessionId, messageId, content), failure),
    resume: (failure: string) => run(null, () => dashboardApi.resumeSessionQueue(token, sessionId), failure),
    clear: (failure: string) => run(null, () => dashboardApi.clearSessionQueue(token, sessionId), failure),
  }
}

export type SessionQueueController = ReturnType<typeof useSessionQueue>
