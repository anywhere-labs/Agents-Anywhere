"use client"

import * as React from "react"
import { toast } from "sonner"

import { modelConfigApi } from "@/features/model-config/api"
import { createTokensLinkWindow, openTokensLinkStart } from "@/features/model-config/open-link"

/**
 * Links a Tokens Anywhere account in one click: the authorization finishes in a
 * popup, and the page learns the result from its snapshot (`linked`).
 */
export function useTokensLink({ token, linked, linkedAt, errorText, onChanged }: {
  token: string
  linked: boolean
  /** Changes when a new link replaces the old one. */
  linkedAt: string | null | undefined
  errorText: (error: unknown) => string
  onChanged: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [authorizing, setAuthorizing] = React.useState(false)
  const popupRef = React.useRef<Window | null>(null)

  React.useEffect(() => {
    if (linked) {
      popupRef.current?.close(); popupRef.current = null
      setAuthorizing(false)
    }
  }, [linked, linkedAt])
  React.useEffect(() => () => popupRef.current?.close(), [])
  React.useEffect(() => {
    if (!authorizing) return
    const timer = window.setInterval(() => {
      if (popupRef.current?.closed) { popupRef.current = null; setAuthorizing(false) }
    }, 500)
    return () => window.clearInterval(timer)
  }, [authorizing])

  const link = async () => {
    if (busy) return
    popupRef.current?.close()
    const popup = createTokensLinkWindow()
    popupRef.current = popup
    setBusy(true)
    try {
      const response = await modelConfigApi.beginTokensLink(token)
      openTokensLinkStart(response.startUrl, popup)
      setAuthorizing(true)
      onChanged()
    } catch (error) {
      popupRef.current?.close(); popupRef.current = null
      toast.error(errorText(error))
    } finally { setBusy(false) }
  }

  return { link, busy, authorizing }
}
