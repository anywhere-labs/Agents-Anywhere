"use client"

// Opens the pairing dialog when session content needs a secure channel this client does not have yet
// (`e2ee_not_paired`, or the Server's `e2ee_required` before any pairing). Once per device per page load.

import * as React from "react"

import { SecurePairingDialog } from "@/components/e2ee/secure-pairing-dialog"
import { knownSessionDevice } from "@/lib/e2ee/state"
import { onContentTransportRequired } from "@/lib/transport/content-transport"

const PROMPT_CODES = new Set(["e2ee_not_paired", "e2ee_required"])

export function SecurePairingHost() {
  const [open, setOpen] = React.useState(false)
  const [device, setDevice] = React.useState<string | null>(null)
  const prompted = React.useRef(new Set<string>())

  React.useEffect(
    () =>
      onContentTransportRequired(({ sessionId, code }) => {
        if (!PROMPT_CODES.has(code)) return
        const deviceId = sessionId ? knownSessionDevice(sessionId) ?? null : null
        const key = deviceId ?? "*"
        if (prompted.current.has(key)) return
        prompted.current.add(key)
        setDevice(deviceId)
        setOpen(true)
      }),
    [],
  )

  return <SecurePairingDialog open={open} onOpenChange={setOpen} deviceHint={device} />
}
