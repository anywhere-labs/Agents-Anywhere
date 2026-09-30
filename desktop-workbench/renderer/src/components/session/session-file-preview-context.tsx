"use client"

import * as React from "react"
import { createPlanDraft, type PlanDraft } from "./plan-draft"
import { createPlanFileStorage, type PlanFileLocation } from "./plan-file-storage"

export type SessionFilePreviewTarget = {
  source: "workspace" | "attachment" | "plan"
  planDraft?: PlanDraft
  name: string
  path: string
  root: string
  sourceUrl?: string
  mediaType?: string
  size?: number
  // Supplied by a directory listing: the target is already a resolved file.
  browsePath?: string
  browseExpandedPaths?: readonly string[]
  browseScroll?: { top: number; left: number }
}

export type SessionFileOpenOptions = { preview?: boolean; sourceTabId?: string }
export type OpenSessionFilePreview = (target: SessionFilePreviewTarget, options?: SessionFileOpenOptions) => void

const PlanDraftContext = React.createContext<{ drafts: Map<string, PlanDraft>; location?: PlanFileLocation } | null>(null)

const SessionFilePreviewContext = React.createContext<OpenSessionFilePreview | null>(null)

export function SessionFilePreviewProvider({
  children,
  onOpenFilePreview,
  planLocation,
}: {
  children: React.ReactNode
  onOpenFilePreview: OpenSessionFilePreview
  planLocation?: PlanFileLocation
}) {
  const drafts = React.useRef(new Map<string, PlanDraft>())
  const context = React.useMemo(() => ({ drafts: drafts.current, location: planLocation }), [planLocation?.token, planLocation?.connectorId, planLocation?.root])
  return (
    <PlanDraftContext.Provider value={context}>
    <SessionFilePreviewContext.Provider value={onOpenFilePreview}>
      {children}
    </SessionFilePreviewContext.Provider>
    </PlanDraftContext.Provider>
  )
}

export function useSessionFilePreviewOpener() {
  return React.useContext(SessionFilePreviewContext)
}

export function usePlanDraft(id: string, text: string) {
  const context = React.useContext(PlanDraftContext)
  const draft = React.useMemo(() => {
    const location = context?.location
    const key = `${location?.connectorId ?? ""}:${location?.root ?? ""}:${id}`
    const draft = context?.drafts.get(key) ?? createPlanDraft(text, location ? createPlanFileStorage(location, id) : undefined)
    context?.drafts.set(key, draft)
    return draft
  }, [context, id])
  React.useEffect(() => {
    void draft.initialize().catch(() => {})
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      const status = draft.getSnapshot().status
      if (["unsaved", "saving", "error"].includes(status)) { event.preventDefault(); event.returnValue = "" }
    }
    window.addEventListener("beforeunload", warnBeforeLeaving)
    return () => { window.removeEventListener("beforeunload", warnBeforeLeaving) }
  }, [draft])
  return draft
}
