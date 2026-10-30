"use client"

import * as React from 'react'
import { apiClient } from '@/lib/api'
import type { PlanningState, PlanDocument } from '@/generated/protocol/v1/planning-state'
import type { PlanningRequest } from '@/generated/protocol/v1/planning-request'
import type { PlanningResponse } from '@/generated/protocol/v1/planning-response'

export type { PlanningState, PlanDocument, PlanningRequest }
type Visit = { sessionId: string; token: string }
export function useSessionPlanning(token: string, sessionId: string) {
  const visit = React.useRef<Visit>({ sessionId, token })
  const activeOperation = React.useRef<object | null>(null)
  if (visit.current.sessionId !== sessionId || visit.current.token !== token) {
    visit.current = { sessionId, token }; activeOperation.current = null
  }
  const [projection, setProjection] = React.useState<{ visit: Visit; state: PlanningState } | null>(null)
  const [archive, setArchive] = React.useState<{ visit: Visit; documents: PlanDocument[] } | null>(null)
  const [running, setRunning] = React.useState<object | null>(null)
  const [failure, setFailure] = React.useState<{ visit: Visit; message: string } | null>(null)
  const path = `/sessions/${encodeURIComponent(sessionId)}`
  const mergeDocuments = React.useCallback((incoming: PlanDocument[], current: Visit) => {
    if (visit.current !== current) return
    setArchive(old => ({ visit: current, documents: [...new Map([
      ...(old?.visit === current ? old.documents : []), ...incoming,
    ].map(doc => [`${doc.planId}:${doc.revision}`, doc])).values()] }))
  }, [])
  const ingest = React.useCallback((next: PlanningState) => {
    const current = visit.current
    if (next.sessionId !== current.sessionId) return
    setProjection(previous => {
      const old = previous?.visit === current ? previous.state : null
      if (old && old.epoch === next.epoch && (old.revision ?? 0) > (next.revision ?? 0)) return previous
      return { visit: current, state: { ...next, capabilities: next.capabilities ?? old?.capabilities ?? { supported: false, actions: [], contentStreaming: 'final_only' } } }
    })
    const incoming = [...(next.proposals ?? []), ...(next.proposal ? [next.proposal] : [])]
    if (incoming.length) mergeDocuments(incoming, current)
  }, [mergeDocuments])
  const refresh = React.useCallback(async () => {
    const current = visit.current
    const next = await apiClient.get<PlanningState>(`${path}/planning`, { token })
    if (visit.current === current) ingest(next)
    return next
  }, [path, token, ingest])
  React.useEffect(() => {
    const current = visit.current
    setProjection(null); setArchive(null); setFailure(null); setRunning(null)
    void refresh().catch(() => undefined)
    void apiClient.get<PlanDocument[]>(`${path}/plans`, { token }).then(docs => mergeDocuments(docs, current)).catch(() => undefined)
  }, [path, token, refresh, mergeDocuments])
  const execute = React.useCallback(async (request: Omit<PlanningRequest, 'operationId'>) => {
    if (activeOperation.current || visit.current.sessionId !== sessionId || visit.current.token !== token) return false
    const operation = {}, current = visit.current
    activeOperation.current = operation
    setRunning(operation); setFailure(null)
    try {
      const result = await apiClient.post<PlanningResponse>(`${path}/planning`, { ...request, operationId: crypto.randomUUID() }, { token })
      if (visit.current !== current) return false
      if (result.state) ingest(result.state)
      if (!result.ok) setFailure({ visit: current, message: result.message || '规划操作未完成，请刷新原生状态。' })
      await refresh().catch(() => undefined)
      return result.ok
    } catch (error) {
      if (visit.current === current) setFailure({ visit: current, message: error instanceof Error ? error.message : '规划操作结果尚不确定，请刷新状态。' })
      return false
    } finally {
      if (activeOperation.current === operation) activeOperation.current = null
      if (visit.current === current) setRunning(null)
    }
  }, [path, token, sessionId, refresh, ingest])
  return {
    state: projection?.visit === visit.current ? projection.state : null,
    documents: archive?.visit === visit.current ? archive.documents : [],
    busy: running !== null && running === activeOperation.current,
    error: failure?.visit === visit.current ? failure.message : null,
    execute, refresh, ingest,
  }
}
