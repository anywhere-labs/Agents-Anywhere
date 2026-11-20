"use client"

// The pairing dialog for the whole workspace. It opens:
// - on request, any number of times (`requestSecurePairing(deviceId)`, e.g. a "Pair this device" button);
// - by itself once per device per page load, when session content needs a secure channel this client does not
//   have yet (`e2ee_not_paired`, or the Server's `e2ee_required` before any pairing).

import * as React from "react"
import type { StoredSession } from "@/features/auth/types"

import { SecurePairingDialog } from "@/components/e2ee/secure-pairing-dialog"
import { knownSessionDevice, onSecurePairingRequested } from "@/lib/e2ee/state"
import { onContentTransportRequired } from "@/lib/transport/content-transport"

const PROMPT_CODES = new Set(["e2ee_not_paired", "e2ee_required"])

export function SecurePairingHost({ session }: { session?: StoredSession | null }) {
  const [open, setOpen] = React.useState(false)
  const [device, setDevice] = React.useState<string | null>(null)
  const prompted = React.useRef(new Set<string>())

  React.useEffect(() => {
    const show = (deviceId: string | null) => {
      setDevice(deviceId)
      setOpen(true)
    }
    const offRequest = onSecurePairingRequested(show)
    const offRequired = onContentTransportRequired(({ sessionId, code }) => {
      if (!PROMPT_CODES.has(code)) return
      const deviceId = sessionId ? knownSessionDevice(sessionId) ?? null : null
      const key = deviceId ?? `session:${sessionId ?? "*"}`
      if (prompted.current.has(key)) return
      prompted.current.add(key)
      show(deviceId)
    })
    return () => {
      offRequest()
      offRequired()
    }
  }, [])

  return <SecurePairingDialog open={open} onOpenChange={setOpen} deviceHint={device} session={session} />
}
