"use client"

import * as React from "react"
import { toast } from "sonner"

import { modelConfigApi } from "@/features/model-config/api"
import { openTokensLinkStart } from "@/features/model-config/open-link"

/**
 * Links a Tokens Anywhere account in one click: the authorization finishes in
 * the system browser, and this window learns the result from its snapshot
 * (`linked`).
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

  React.useEffect(() => {
    if (linked) setAuthorizing(false)
  }, [linked, linkedAt])

  const link = async () => {
    if (busy) return
    setBusy(true)
    try {
      const response = await modelConfigApi.beginTokensLink(token)
      await openTokensLinkStart(response.startUrl)
      setAuthorizing(true)
      onChanged()
    } catch (error) {
      toast.error(errorText(error))
    } finally { setBusy(false) }
  }

  return { link, busy, authorizing }
}
