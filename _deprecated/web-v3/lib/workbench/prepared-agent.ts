"use client"

// The new-conversation page's agent, started ahead of the first message (aa.v3.Sessions/prepare, client-experience-
// proposal §2.6): as soon as a device, an agent and a directory are chosen the Connector starts the agent, so its
// model, permission and thinking options can be picked before anything is sent, and a first `npx` download happens
// while the user types. While the page stays open the agent is kept (prepared again before it would expire); the
// first message's create takes it over with `prepared_id`. A Connector without `prepare` (older than it) starts the
// agent at create, as before.
import { useEffect, useState } from "react"
import { DeadlineExceededError, MeshCallError } from "meshcall/web"

import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { ConfigOption, DeviceRecord, PreparedAgent } from "@/lib/types/v3"
import { signInNeeded, type SignInNeeded } from "@/lib/workbench/sign-in"

export type PrepareState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready"; prepared: PreparedAgent }
  /** The Connector predates `prepare`: the options appear once the conversation has started. */
  | { status: "unsupported" }
  | { status: "failed"; reason: string; message: string; signIn: SignInNeeded | null }

type Keyed = PrepareState & { key: string }

/** Prepare again this long before the agent would be closed. */
const RENEW_BEFORE_MS = 60_000

export function usePreparedAgent({
  tunnelManager,
  device,
  agent,
  cwd,
  enabled,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: Pick<DeviceRecord, "id" | "mode_hint" | "presence"> | null
  agent: string | null
  cwd: string | null
  enabled: boolean
}): { state: PrepareState; retry: () => void } {
  // A retry is a new key, so the page shows "starting" again until it answers.
  const [attempt, setAttempt] = useState(0)
  const key = enabled && tunnelManager && device && agent ? `${device.id}|${agent}|${cwd ?? ""}#${attempt}` : null
  const [result, setResult] = useState<Keyed | null>(null)

  useEffect(() => {
    if (!key || !tunnelManager || !device || !agent) return
    let cancelled = false
    let timer: number | undefined
    const run = async () => {
      try {
        const prepared = await tunnelManager.prepareSession(device, { agent, ...(cwd ? { cwd } : {}) })
        if (cancelled) return
        setResult({ key, status: "ready", prepared })
        const renewIn = Date.parse(prepared.expires_at) - Date.now() - RENEW_BEFORE_MS
        timer = window.setTimeout(() => void run(), Math.max(15_000, Number.isFinite(renewIn) ? renewIn : 15_000))
      } catch (err) {
        if (cancelled) return
        // Still starting (a first download): ask again, which joins the start in progress.
        if (err instanceof DeadlineExceededError) {
          timer = window.setTimeout(() => void run(), 0)
          return
        }
        if (err instanceof MeshCallError && err.code === "method_not_found") {
          setResult({ key, status: "unsupported" })
          return
        }
        setResult({
          key,
          status: "failed",
          reason: err instanceof MeshCallError ? (err.reason ?? err.code) : "error",
          message: err instanceof Error ? err.message : String(err),
          signIn: signInNeeded(err),
        })
      }
    }
    void run()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [agent, cwd, device, key, tunnelManager])

  const state: PrepareState = !key ? { status: "idle" } : result?.key === key ? result : { status: "starting" }
  return { state, retry: () => setAttempt((n) => n + 1) }
}

/**
 * The options to show before the conversation exists: the prepared agent's, with the user's picks (and, for options
 * they have not touched here, what they last used with this agent on this device) in place of the agent's defaults.
 * Only values the agent offers are applied.
 */
export function withPicks(config: ConfigOption[], picks: Record<string, string>): ConfigOption[] {
  return config.map((o) => {
    const v = picks[o.id]
    return v !== undefined && v !== o.current && o.options.some((x) => x.value === v) ? { ...o, current: v } : o
  })
}

/** What create should change: the picks that differ from what the prepared agent already has. */
export function changedPicks(config: ConfigOption[], shown: ConfigOption[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of shown) {
    const was = config.find((x) => x.id === o.id)
    if (was && was.current !== o.current) out[o.id] = o.current
  }
  return out
}
