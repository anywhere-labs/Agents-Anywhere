import { useCallback, useEffect, useRef, useState } from 'react'
import type { OnboardingHostApi, OnboardingSnapshot } from '../../../contracts/index.js'

/** Shared by the official modal heading, login form, and signed-in panel. */
export function useOnboardingState(host: OnboardingHostApi, active: boolean) {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const request = useRef(0)

  const prepareOpen = useCallback(() => {
    // A new opening must wait for its own detection, never display a cached mode.
    request.current++
    setSnapshot(null); setReadError(null); setError(null)
  }, [])

  const refresh = useCallback(async () => {
    const id = ++request.current
    const next = await host.inspect()
    if (id === request.current) { setSnapshot(next); setReadError(null) }
  }, [host])

  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh() }
      catch (error) { if (!stopped) setReadError(error instanceof Error ? error.message : '读取插件状态失败。') }
      if (!stopped) timer = setTimeout(() => void poll(), 1_500)
    }
    void poll()
    return () => { stopped = true; request.current++; clearTimeout(timer) }
  }, [active, refresh])

  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return false
    running.current = true
    setBusy(true); setError(null)
    try { await action(); await refresh(); return true }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试。'); return false }
    finally { running.current = false; setBusy(false) }
  }

  return { snapshot, error, readError, busy, run, refresh, prepareOpen, clearError: () => setError(null) }
}

export type OnboardingState = ReturnType<typeof useOnboardingState>
