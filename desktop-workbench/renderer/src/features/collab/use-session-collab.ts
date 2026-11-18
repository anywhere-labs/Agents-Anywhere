"use client"

import * as React from "react"

import { collabApi, type CreateSupervisionInput, type UpdateSupervisionInput } from "@/features/collab/api"
import type { CollabView, SupervisionDetail } from "@/features/collab/model"

type Loaded = { key: string; view: CollabView | null; error: string | null }

/**
 * The supervisor's collaboration view (`GET /sessions/{id}/collab`), served by its device. `refreshKey` changes when the
 * session directory reports new supervision edges, which reloads the view. Mutations update it in place.
 */
export function useSessionCollab(token: string | null, sessionId: string, options: { enabled: boolean; refreshKey?: string }) {
  const key = `${token ?? ""}:${sessionId}`
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [loading, setLoading] = React.useState(false)
  const keyRef = React.useRef(key)
  keyRef.current = key

  const refresh = React.useCallback(async () => {
    if (!token || !options.enabled) return
    const requestKey = key
    setLoading(true)
    try {
      const view = await collabApi.getSessionCollab(token, sessionId)
      if (keyRef.current === requestKey) setLoaded({ key: requestKey, view, error: null })
    } catch (error) {
      if (keyRef.current === requestKey)
        setLoaded((current) => ({ key: requestKey, view: current?.key === requestKey ? current.view : null, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (keyRef.current === requestKey) setLoading(false)
    }
  }, [key, options.enabled, sessionId, token])

  React.useEffect(() => {
    void refresh()
  }, [refresh, options.refreshKey])

  const replaceSupervision = React.useCallback((detail: SupervisionDetail) => {
    setLoaded((current) => {
      if (!current || current.key !== keyRef.current) return current
      const view = current.view ?? { sessionId, available: true, grant: null, supervisions: [], actions: [] }
      const others = view.supervisions.filter((item) => item.supervisionId !== detail.supervisionId)
      return { ...current, view: { ...view, supervisions: [detail, ...others] } }
    })
  }, [sessionId])

  const createSupervision = React.useCallback(async (input: CreateSupervisionInput) => {
    if (!token) throw new Error("not signed in")
    const detail = await collabApi.createSupervision(token, sessionId, input)
    replaceSupervision(detail)
    return detail
  }, [replaceSupervision, sessionId, token])

  const updateSupervision = React.useCallback(async (supervisionId: string, input: UpdateSupervisionInput) => {
    if (!token) throw new Error("not signed in")
    const detail = await collabApi.updateSupervision(token, sessionId, supervisionId, input)
    replaceSupervision(detail)
    return detail
  }, [replaceSupervision, sessionId, token])

  const current = loaded?.key === key ? loaded : null
  return {
    collab: current?.view ?? null,
    error: current?.error ?? null,
    loading,
    refresh,
    createSupervision,
    updateSupervision,
  }
}

export type SessionCollabController = ReturnType<typeof useSessionCollab>
