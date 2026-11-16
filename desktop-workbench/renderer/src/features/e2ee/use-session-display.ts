"use client"

// React glue for session display envelopes: re-render when a decryption finishes or a key arrives.

import * as React from "react"
import { sessionDisplayDecryptor, withSessionDisplay, type DisplaySource, type SessionDisplayState } from "./display"

export function useSessionDisplayVersion(): number {
  const decryptor = sessionDisplayDecryptor()
  const subscribe = React.useCallback((listener: () => void) => decryptor.subscribe(listener), [decryptor])
  return React.useSyncExternalStore(subscribe, () => decryptor.version, () => 0)
}

/** Sessions as the UI shows them: decrypted title and cwd, or the locked placeholder. Same array when unchanged. */
export function useDisplayedSessions<T extends DisplaySource>(
  sessions: readonly T[],
  labels: { locked: string; untitled: string },
): (T & { displayState?: SessionDisplayState })[] {
  const version = useSessionDisplayVersion()
  const { locked, untitled } = labels
  return React.useMemo(() => {
    void version
    const decryptor = sessionDisplayDecryptor()
    let changed = false
    const next = sessions.map((session) => {
      const shown = withSessionDisplay(session, decryptor.read(session), { locked, untitled })
      if (shown !== session) changed = true
      return shown
    })
    return changed ? next : (sessions as T[])
  }, [locked, sessions, untitled, version])
}
