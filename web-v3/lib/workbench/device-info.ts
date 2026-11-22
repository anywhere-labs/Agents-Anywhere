"use client"

// What the UI needs to know about a device beyond its control-plane record, read once over its tunnel and shared by
// every page: Device/status (agents = runtimes, cwd, platform) and Device/get_settings (the RPC file cap). Also the
// account's drive quota (GET /drive/quota) for the attachment limits. Cached per tunnel manager, refreshable.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"

import { fetchDriveQuota } from "@/lib/api/control-http"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import { PairingError } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DeviceRecord, DeviceSettings, DeviceStatus, DriveQuotaView } from "@/lib/types/v3"

export type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

export interface DeviceInfoState {
  status: DeviceStatus | null
  settings: DeviceSettings | null
  loading: boolean
  error: { code: string; message: string } | null
}

const EMPTY: DeviceInfoState = { status: null, settings: null, loading: false, error: null }

class DeviceInfoCache {
  private entries = new WeakMap<DeviceTunnelManager, Map<string, DeviceInfoState>>()
  private inflight = new WeakMap<DeviceTunnelManager, Map<string, Promise<void>>>()
  private listeners = new Set<() => void>()

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  get(manager: DeviceTunnelManager | null, deviceId: string | null | undefined): DeviceInfoState {
    if (!manager || !deviceId) return EMPTY
    return this.entries.get(manager)?.get(deviceId) ?? EMPTY
  }

  private set(manager: DeviceTunnelManager, deviceId: string, patch: Partial<DeviceInfoState>) {
    let map = this.entries.get(manager)
    if (!map) this.entries.set(manager, (map = new Map()))
    map.set(deviceId, { ...(map.get(deviceId) ?? EMPTY), ...patch })
    for (const l of this.listeners) l()
  }

  load(manager: DeviceTunnelManager, device: TunnelDevice, force = false): Promise<void> {
    const current = this.get(manager, device.id)
    if (!force && (current.status || current.error)) return Promise.resolve()
    let flights = this.inflight.get(manager)
    if (!flights) this.inflight.set(manager, (flights = new Map()))
    const running = flights.get(device.id)
    if (running) return running
    const task = (async () => {
      this.set(manager, device.id, { loading: true, error: null })
      try {
        const [status, settings] = await Promise.all([
          manager.getDeviceStatus(device),
          manager.getDeviceSettings(device).catch(() => null),
        ])
        this.set(manager, device.id, { status, settings, loading: false, error: null })
      } catch (err) {
        const code = err instanceof PairingError ? err.code : "device_error"
        this.set(manager, device.id, {
          loading: false,
          error: { code, message: err instanceof Error ? err.message : String(err) },
        })
      } finally {
        flights!.delete(device.id)
      }
    })()
    flights.set(device.id, task)
    return task
  }

  patchSettings(manager: DeviceTunnelManager, deviceId: string, settings: DeviceSettings) {
    this.set(manager, deviceId, { settings })
  }
}

export const deviceInfoCache = new DeviceInfoCache()

/** A device's record, its tunnel handle (stable across presence heartbeats), lock state and status/settings. */
export function useDevice(deviceId: string | null | undefined, opts: { load?: boolean } = {}) {
  const { devices, deviceTrusts, tunnelManager } = useWorkbench()
  const device = useMemo(
    () => (deviceId ? (devices.find((d) => d.id === deviceId) ?? null) : null),
    [devices, deviceId]
  )
  // The record is replaced on every presence heartbeat (~20 s); tunnel calls must not restart on that.
  const tunnelDevice = useMemo<TunnelDevice | null>(
    () => (device ? { id: device.id, mode_hint: device.mode_hint, presence: device.presence } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [device?.id, device?.mode_hint, device?.presence]
  )
  const trust = deviceId ? deviceTrusts[deviceId] : undefined
  const encrypted = device?.mode_hint === "encrypted" || Boolean(trust)
  const info = useSyncExternalStore(
    deviceInfoCache.subscribe,
    () => deviceInfoCache.get(tunnelManager, deviceId),
    () => EMPTY
  )
  const shouldLoad = opts.load !== false
  useEffect(() => {
    if (!shouldLoad || !tunnelManager || !tunnelDevice || tunnelDevice.presence !== "online") return
    void deviceInfoCache.load(tunnelManager, tunnelDevice)
  }, [shouldLoad, tunnelDevice, tunnelManager])
  const reload = useCallback(() => {
    if (!tunnelManager || !tunnelDevice) return Promise.resolve()
    return deviceInfoCache.load(tunnelManager, tunnelDevice, true)
  }, [tunnelDevice, tunnelManager])
  return { device, tunnelDevice, trust, encrypted, info, reload, tunnelManager }
}

// ── Drive quota (account-wide) ──

let quotaState: { key: string; quota: DriveQuotaView | null; at: number } | null = null
const quotaListeners = new Set<() => void>()
let quotaInflight: Promise<void> | null = null

/** The account's drive quota, fetched at most once a minute; null while unknown or when the drive is unreachable. */
export function useDriveQuota(): DriveQuotaView | null {
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const key = activeAccount?.accountId ?? ""
  const snap = useSyncExternalStore(
    (l) => {
      quotaListeners.add(l)
      return () => {
        quotaListeners.delete(l)
      }
    },
    () => (quotaState?.key === key ? quotaState.quota : null),
    () => null
  )
  useEffect(() => {
    if (!activeAccount) return
    if (quotaState?.key === key && Date.now() - quotaState.at < 60_000) return
    if (quotaInflight) return
    quotaInflight = (async () => {
      // Run after this commit: the provider learns the active account in its own effect, which runs after ours.
      await new Promise((resolve) => setTimeout(resolve, 0))
      let quota: DriveQuotaView | null = null
      for (let attempt = 0; attempt < 3 && !quota; attempt++) {
        try {
          const token = await getFreshAccessToken()
          quota = await fetchDriveQuota(activeAccount.serverUrl, token)
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
        }
      }
      quotaState = { key, quota, at: quota ? Date.now() : Date.now() - 45_000 }
      quotaInflight = null
      for (const l of quotaListeners) l()
    })()
  }, [activeAccount, getFreshAccessToken, key])
  return snap
}
