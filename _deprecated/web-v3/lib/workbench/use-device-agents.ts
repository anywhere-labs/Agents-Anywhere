"use client"

// The agents of a device as its page shows them: read when the page shows them (and once they were changed here),
// followed while one is being installed, and searched for again on request. Kept by the page, so switching its tabs does
// not start over.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { MeshCallError } from "meshcall/web"

import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { AgentEntry, DeviceRecord } from "@/lib/types/v3"
import { isInstalled, isInstalling, installNews, type InstallNews } from "@/lib/workbench/agents"
import { deviceInfoCache } from "@/lib/workbench/device-info"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

/** How often a running install is asked about: it reports nothing by itself. */
const INSTALL_POLL_MS = 2_000

export interface DeviceAgentsState {
  /** `null` until they were read. */
  entries: AgentEntry[] | null
  /** The Connector manages agents (an older one only reports them). */
  managed: boolean
  entryOf: (id: string) => AgentEntry | null
  load: () => Promise<void>
  /** Have the device look for installed agents again, wherever they were put. */
  search: () => Promise<void>
  /** An agent as a call just answered it: changed, or added. */
  put: (entry: AgentEntry) => void
  drop: (id: string) => void
}

export function useDeviceAgents({
  tunnelManager,
  device,
  deviceId,
  shown,
  onNews,
}: {
  tunnelManager: DeviceTunnelManager | null
  /** Must be referentially stable across presence heartbeats (see the device page). */
  device: TunnelDevice | null
  deviceId: string
  shown: boolean
  /** An agent was installed since it was last read, or its install failed. */
  onNews: (news: InstallNews) => void
}): DeviceAgentsState {
  const [list, setList] = useState<{ deviceId: string; managed: boolean; entries: AgentEntry[] } | null>(null)
  const current = list?.deviceId === deviceId ? list : null
  const online = device?.presence === "online"

  const tell = useRef(onNews)
  useEffect(() => {
    tell.current = onNews
  })
  const before = useRef<{ deviceId: string; entries: AgentEntry[] } | null>(null)
  useEffect(() => {
    if (!current?.managed) return
    const was = before.current
    before.current = { deviceId: current.deviceId, entries: current.entries }
    if (was?.deviceId !== current.deviceId) return
    for (const news of installNews(was.entries, current.entries)) tell.current(news)
  }, [current])

  const load = useCallback(async () => {
    if (!tunnelManager || !device || device.presence !== "online") return
    try {
      const res = await tunnelManager.listAgents(device)
      setList({ deviceId: device.id, managed: true, entries: res.agents })
    } catch (err) {
      if (err instanceof MeshCallError && err.code === "method_not_found") setList({ deviceId: device.id, managed: false, entries: [] })
    }
  }, [device, tunnelManager])

  const search = useCallback(async () => {
    if (!tunnelManager || !device || device.presence !== "online") return
    try {
      const res = await tunnelManager.refreshAgents(device)
      setList({ deviceId: device.id, managed: true, entries: res.agents })
    } catch {
      // An older Connector just lists its agents.
      await load()
    }
  }, [device, load, tunnelManager])

  // Coming back from the terminal shows what was just installed there.
  useEffect(() => {
    if (!shown) return
    let alive = true
    queueMicrotask(() => {
      if (alive) void load()
    })
    return () => {
      alive = false
    }
  }, [load, shown])

  const installing = current?.entries.some((e) => isInstalling(e.install?.job)) ?? false
  useEffect(() => {
    if (!installing || !online) return
    const timer = window.setInterval(() => void load(), INSTALL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [installing, load, online])

  // New conversations offer the agents that are installed and on: read the device's list again when those change.
  const usable = current?.managed
    ? current.entries.filter((e) => isInstalled(e) && e.enabled).map((e) => `${e.id}=${e.name}`).join("\n")
    : undefined
  const usableBefore = useRef<{ deviceId: string; usable: string } | null>(null)
  useEffect(() => {
    if (usable === undefined) return
    const was = usableBefore.current
    usableBefore.current = { deviceId, usable }
    if (was?.deviceId !== deviceId || was.usable === usable) return
    if (tunnelManager && device) void deviceInfoCache.load(tunnelManager, device, true)
  }, [device, deviceId, tunnelManager, usable])

  const put = useCallback(
    (entry: AgentEntry) =>
      setList((cur) => {
        if (!cur || cur.deviceId !== deviceId) return cur
        const known = cur.entries.some((e) => e.id === entry.id)
        return { ...cur, entries: known ? cur.entries.map((e) => (e.id === entry.id ? entry : e)) : [...cur.entries, entry] }
      }),
    [deviceId]
  )
  const drop = useCallback(
    (id: string) => setList((cur) => (cur && cur.deviceId === deviceId ? { ...cur, entries: cur.entries.filter((e) => e.id !== id) } : cur)),
    [deviceId]
  )

  return useMemo(
    () => ({
      entries: current?.entries ?? null,
      managed: current?.managed ?? true,
      entryOf: (id: string) => current?.entries.find((e) => e.id === id) ?? null,
      load,
      search,
      put,
      drop,
    }),
    [current, drop, load, put, search]
  )
}
