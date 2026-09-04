"use client"

import * as React from "react"

export type SessionFilePreviewTarget = {
  source: "workspace" | "attachment"
  name: string
  path: string
  root: string
  sourceUrl?: string
  mediaType?: string
  size?: number
}

export type OpenSessionFilePreview = (target: SessionFilePreviewTarget) => void

const SessionFilePreviewContext = React.createContext<OpenSessionFilePreview | null>(null)

export function SessionFilePreviewProvider({
  children,
  onOpenFilePreview,
}: {
  children: React.ReactNode
  onOpenFilePreview: OpenSessionFilePreview
}) {
  return (
    <SessionFilePreviewContext.Provider value={onOpenFilePreview}>
      {children}
    </SessionFilePreviewContext.Provider>
  )
}

export function useSessionFilePreviewOpener() {
  return React.useContext(SessionFilePreviewContext)
}
