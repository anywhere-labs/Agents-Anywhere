"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import {
  fetchMe,
  loginWithPassword,
  logoutLocalSession,
  normalizeServerUrl,
  refreshLocalSession,
  registerWithPassword,
} from "@/lib/api/control-http"
import { refreshOidcSession } from "@/lib/auth/oidc"
import { ControlPlaneClient } from "@/lib/mesh/control-client"
import { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import { PairingError } from "@/lib/mesh/pairing"
import {
  applySessionMergeEvent,
  createSessionMergeState,
  getMergedProjects,
  getMergedSessions,
  type SessionMergeState,
} from "@/lib/mesh/session-merge"
import {
  DEFAULT_PREFERENCES,
  vault,
  type ClientIdentityRecord,
  type StoredAccountSession,
  type UserPreferences,
} from "@/lib/storage/idb"
import type {
  ClientDeviceTrustRecord,
  DeviceRecord,
  SessionSummary,
} from "@/lib/types/v3"

export interface WorkbenchContextValue {
  ready: boolean
  accounts: StoredAccountSession[]
  activeAccount: StoredAccountSession | null
  clientIdentity: ClientIdentityRecord | null
  preferences: UserPreferences
  devices: DeviceRecord[]
  deviceTrusts: Record<string, ClientDeviceTrustRecord>
  mergeState: SessionMergeState
  sessions: SessionSummary[]
  projects: { device_id: string; cwd: string; name: string }[]
  controlClient: ControlPlaneClient | null
  tunnelManager: DeviceTunnelManager | null
  meshConnected: boolean
  meshError: string | null
  getFreshAccessToken: () => Promise<string>
  signInLocal: (params: { serverUrl: string; email: string; password: string }) => Promise<void>
  registerLocal: (params: {
    serverUrl: string
    email: string
    password: string
    displayName: string
    setupToken?: string
  }) => Promise<void>
  saveOidcAccount: (session: StoredAccountSession) => Promise<void>
  switchAccount: (accountId: string) => Promise<void>
  signOutAccount: (accountId?: string) => Promise<void>
  signOutAllAccounts: () => Promise<void>
  refreshDevices: () => Promise<void>
  refreshSessions: () => Promise<void>
  pairEncryptedDevice: (uri: string, deviceNameHint?: string) => Promise<{ deviceId: string }>
  removeLocalDeviceTrust: (deviceId: string) => Promise<void>
  setAssistantPrimary: (enabled: boolean) => Promise<void>
  updatePreferences: (patch: Partial<UserPreferences>) => Promise<UserPreferences>
  resetBrowserVault: () => Promise<void>
}

/** Run `task` holding a Web Lock shared by every tab of this origin (or just run it where Web Locks are missing). */
function withCrossTabLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  if (!locks?.request) return task()
  return locks.request(name, task) as Promise<T>
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [accounts, setAccounts] = useState<StoredAccountSession[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [clientIdentity, setClientIdentity] = useState<ClientIdentityRecord | null>(null)
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES)
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [deviceTrusts, setDeviceTrusts] = useState<Record<string, ClientDeviceTrustRecord>>({})
  const [mergeState, setMergeState] = useState<SessionMergeState>(() => createSessionMergeState())
  const [meshConnected, setMeshConnected] = useState(false)
  const [meshError, setMeshError] = useState<string | null>(null)

  const controlRef = useRef<ControlPlaneClient | null>(null)
  const tunnelsRef = useRef<DeviceTunnelManager | null>(null)
  const [controlClient, setControlClient] = useState<ControlPlaneClient | null>(null)
  const [tunnelManager, setTunnelManager] = useState<DeviceTunnelManager | null>(null)
  const activeAccountRef = useRef<StoredAccountSession | null>(null)
  const deviceTrustsRef = useRef<Record<string, ClientDeviceTrustRecord>>({})

  const activeAccount = useMemo(
    () => accounts.find((a) => a.accountId === activeAccountId) ?? accounts[0] ?? null,
    [accounts, activeAccountId]
  )

  useEffect(() => {
    activeAccountRef.current = activeAccount
  }, [activeAccount])

  useEffect(() => {
    deviceTrustsRef.current = deviceTrusts
  }, [deviceTrusts])

  // Initial IndexedDB vault hydration
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [identity, savedAccounts, savedActiveId, prefs] = await Promise.all([
          vault.getOrCreateClientIdentity(),
          vault.listAccounts(),
          vault.getActiveAccountId(),
          vault.getPreferences(),
        ])
        if (!alive) return
        setClientIdentity(identity)
        setAccounts(savedAccounts)
        setActiveAccountId(savedActiveId ?? savedAccounts[0]?.accountId ?? null)
        setPreferences(prefs)
      } finally {
        if (alive) setReady(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // One refresh per account at a time. server-v3 (local mode) and most OIDC providers rotate refresh tokens, so
  // two refreshes with the same token make all but the first fail.
  const refreshInFlightRef = useRef(new Map<string, Promise<string>>())

  const getFreshAccessToken = useCallback(async (): Promise<string> => {
    const current = activeAccountRef.current
    if (!current) throw new Error("Not signed in")
    if (current.expiresAt - Date.now() > 60_000) {
      return current.accessToken
    }
    if (!current.refreshToken) {
      return current.accessToken
    }
    const inflight = refreshInFlightRef.current.get(current.accountId)
    if (inflight) return inflight

    const task = withCrossTabLock(`aa-v3-token-refresh:${current.accountId}`, async () => {
      // Another tab may have refreshed while we waited for the lock: the vault holds the newest session, and its
      // refresh token is the only one still valid.
      const stored =
        (await vault.listAccounts()).find((a) => a.accountId === current.accountId) ?? current
      let next: StoredAccountSession
      if (stored.expiresAt - Date.now() > 60_000) {
        next = stored
      } else if (!stored.refreshToken) {
        return stored.accessToken
      } else if (stored.authMode === "oidc") {
        next = await refreshOidcSession(stored)
      } else {
        const refreshed = await refreshLocalSession(stored.serverUrl, stored.refreshToken)
        next = {
          ...stored,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: Date.now() + refreshed.expires_in * 1000,
          user: refreshed.user,
          lastUsedAt: Date.now(),
        }
      }
      if (next !== stored) await vault.saveAccountSession(next)
      // The user may have switched accounts meanwhile; only the account this was for takes the new session.
      if (activeAccountRef.current?.accountId === next.accountId) activeAccountRef.current = next
      setAccounts((prev) => prev.map((a) => (a.accountId === next.accountId ? next : a)))
      return next.accessToken
    })
    refreshInFlightRef.current.set(current.accountId, task)
    try {
      return await task
    } finally {
      if (refreshInFlightRef.current.get(current.accountId) === task) {
        refreshInFlightRef.current.delete(current.accountId)
      }
    }
  }, [])

  // Refresh /auth/me + hydrate pinned trusts & session cache + bind ControlPlaneClient & TunnelManager
  const refreshSessionsInternal = useCallback(
    async (
      accountId: string,
      control: ControlPlaneClient,
      tunnels: DeviceTunnelManager,
      deviceList: DeviceRecord[],
      trusts: Record<string, ClientDeviceTrustRecord>
    ) => {
      const localE2eeSet = new Set(Object.keys(trusts))
      const encryptedDevices = deviceList.filter(
        (d) => d.mode_hint === "encrypted" || localE2eeSet.has(d.id)
      )

      // 1. Control-plane fanout for normal devices (streaming)
      const controlTask = (async () => {
        try {
          for await (const res of control.listSessionsStream()) {
            setMergeState((prev) =>
              applySessionMergeEvent(prev, { source: "control_plane", result: res }, localE2eeSet)
            )
            if (res.status === "ok" && res.value && !localE2eeSet.has(res.device_id)) {
              void vault.saveDeviceSessionCache(accountId, res.device_id, res.value)
            }
          }
        } catch {
          // Fall back to unary list_sessions_once if stream failed mid-flight
          try {
            const results = await control.listSessionsOnce()
            for (const res of results) {
              setMergeState((prev) =>
                applySessionMergeEvent(
                  prev,
                  { source: "control_plane", result: res },
                  localE2eeSet
                )
              )
              if (res.status === "ok" && res.value && !localE2eeSet.has(res.device_id)) {
                void vault.saveDeviceSessionCache(accountId, res.device_id, res.value)
              }
            }
          } catch {
            // Router might be offline; cached sessions stay visible as stale.
          }
        }
      })()

      // 2. Client-side concurrent E2EE tunnel fanout for encrypted devices
      const e2eeTasks = encryptedDevices.map(async (dev) => {
        if (dev.presence === "offline") {
          setMergeState((prev) =>
            applySessionMergeEvent(
              prev,
              {
                source: "client_tunnel",
                result: { device_id: dev.id, status: "offline" },
              },
              localE2eeSet
            )
          )
          return
        }
        try {
          const payload = await tunnels.listSessions(dev)
          setMergeState((prev) =>
            applySessionMergeEvent(
              prev,
              {
                source: "client_tunnel",
                result: { device_id: dev.id, status: "ok", value: payload },
              },
              localE2eeSet
            )
          )
          void vault.saveDeviceSessionCache(accountId, dev.id, payload)
        } catch (err) {
          const code = err instanceof PairingError ? err.code : "e2e_handshake_failed"
          const message = err instanceof Error ? err.message : String(err)
          setMergeState((prev) =>
            applySessionMergeEvent(
              prev,
              {
                source: "client_tunnel",
                result: {
                  device_id: dev.id,
                  status: "error",
                  error: { code, message },
                },
              },
              localE2eeSet
            )
          )
        }
      })

      await Promise.all([controlTask, ...e2eeTasks])
    },
    []
  )

  const currentAccountId = activeAccount?.accountId ?? null
  useEffect(() => {
    const abort = new AbortController()
    if (!ready || !activeAccount || !clientIdentity) {
      queueMicrotask(() => {
        if (abort.signal.aborted) return
        setDevices([])
        setDeviceTrusts({})
        setMergeState(createSessionMergeState())
        setMeshConnected(false)
        setMeshError(null)
        void controlRef.current?.close()
        void tunnelsRef.current?.closeAll()
        controlRef.current = null
        tunnelsRef.current = null
        setControlClient(null)
        setTunnelManager(null)
      })
      return () => {
        abort.abort()
      }
    }

    const acct = activeAccount
    const control = new ControlPlaneClient({
      serverUrl: acct.serverUrl,
      getAccessToken: getFreshAccessToken,
      clientId: clientIdentity.clientId,
    })
    const tunnels = new DeviceTunnelManager(acct.accountId, control)
    controlRef.current = control
    tunnelsRef.current = tunnels
    queueMicrotask(() => {
      if (abort.signal.aborted) return
      setControlClient(control)
      setTunnelManager(tunnels)
    })

    ;(async () => {
      // Load local trusts + offline session cache immediately
      const [trustList, cachedSessions] = await Promise.all([
        vault.listDeviceTrusts(acct.accountId),
        vault.getDeviceSessionCache(acct.accountId),
      ])
      if (abort.signal.aborted) return
      const trustMap: Record<string, ClientDeviceTrustRecord> = {}
      for (const item of trustList) trustMap[item.device_id] = item
      setDeviceTrusts(trustMap)
      deviceTrustsRef.current = trustMap
      setMergeState(createSessionMergeState(cachedSessions))

      // Refresh user profile & entitlements in background
      try {
        const tok = await getFreshAccessToken()
        const freshUser = await fetchMe(acct.serverUrl, tok)
        if (!abort.signal.aborted) {
          const updated: StoredAccountSession = { ...acct, user: freshUser }
          await vault.saveAccountSession(updated)
          setAccounts((prev) => prev.map((a) => (a.accountId === updated.accountId ? updated : a)))
        }
      } catch {
        // Keep cached user snapshot if control plane temporarily unreachable
      }

      // Subscribe to aa.v3.Control/watch_devices. The stream starts with a snapshot, so after any drop
      // (Router restart, network change) watching again with backoff is a full recovery.
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          abort.signal.addEventListener("abort", () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
      let attempt = 0
      while (!abort.signal.aborted) {
        try {
          setMeshError(null)
          for await (const ev of control.watchDevices(abort.signal)) {
            if (abort.signal.aborted) break
            attempt = 0
            setMeshConnected(true)
            setMeshError(null)
            if (ev.type === "snapshot") {
              setDevices(ev.devices)
              void refreshSessionsInternal(
                acct.accountId,
                control,
                tunnels,
                ev.devices,
                deviceTrustsRef.current
              )
            } else if (ev.type === "upsert") {
              setDevices((prev) => {
                const idx = prev.findIndex((d) => d.id === ev.device.id)
                if (idx < 0) return [...prev, ev.device]
                const next = prev.slice()
                next[idx] = ev.device
                return next
              })
            } else if (ev.type === "remove") {
              setDevices((prev) => prev.filter((d) => d.id !== ev.device_id))
            }
          }
        } catch (err) {
          if (abort.signal.aborted) break
          setMeshError(err instanceof Error ? err.message : String(err))
        }
        if (abort.signal.aborted) break
        setMeshConnected(false)
        attempt++
        await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)) * (0.5 + Math.random() * 0.5))
      }
    })()

    return () => {
      abort.abort()
      void control.close()
      void tunnels.closeAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, currentAccountId, clientIdentity, getFreshAccessToken, refreshSessionsInternal])

  const refreshDevices = useCallback(async () => {
    const control = controlRef.current
    const tunnels = tunnelsRef.current
    const acct = activeAccountRef.current
    if (!control || !tunnels || !acct) return
    try {
      const list = await control.listDevices()
      setDevices(list)
      setMeshConnected(true)
      setMeshError(null)
      await refreshSessionsInternal(acct.accountId, control, tunnels, list, deviceTrustsRef.current)
    } catch (err) {
      setMeshConnected(false)
      setMeshError(err instanceof Error ? err.message : String(err))
    }
  }, [refreshSessionsInternal])

  const refreshSessions = useCallback(async () => {
    const control = controlRef.current
    const tunnels = tunnelsRef.current
    const acct = activeAccountRef.current
    if (!control || !tunnels || !acct) return
    await refreshSessionsInternal(acct.accountId, control, tunnels, devices, deviceTrustsRef.current)
  }, [devices, refreshSessionsInternal])

  const signInLocal = useCallback(
    async (params: { serverUrl: string; email: string; password: string }) => {
      const serverUrl = normalizeServerUrl(params.serverUrl)
      const identity = clientIdentity ?? (await vault.getOrCreateClientIdentity())
      const res = await loginWithPassword(serverUrl, {
        email: params.email,
        password: params.password,
        client_id: identity.clientId,
      })
      const session: StoredAccountSession = {
        accountId: `${serverUrl}::${res.user.id}`,
        serverUrl,
        authMode: "local",
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        expiresAt: Date.now() + res.expires_in * 1000,
        user: res.user,
        lastUsedAt: Date.now(),
      }
      await vault.saveAccountSession(session)
      await vault.updatePreferences({ defaultServerUrl: serverUrl })
      const all = await vault.listAccounts()
      setAccounts(all)
      setActiveAccountId(session.accountId)
    },
    [clientIdentity]
  )

  const registerLocal = useCallback(
    async (params: {
      serverUrl: string
      email: string
      password: string
      displayName: string
      setupToken?: string
    }) => {
      const serverUrl = normalizeServerUrl(params.serverUrl)
      const identity = clientIdentity ?? (await vault.getOrCreateClientIdentity())
      const res = await registerWithPassword(serverUrl, {
        email: params.email,
        password: params.password,
        display_name: params.displayName,
        setup_token: params.setupToken,
        client_id: identity.clientId,
      })
      const session: StoredAccountSession = {
        accountId: `${serverUrl}::${res.user.id}`,
        serverUrl,
        authMode: "local",
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        expiresAt: Date.now() + res.expires_in * 1000,
        user: res.user,
        lastUsedAt: Date.now(),
      }
      await vault.saveAccountSession(session)
      await vault.updatePreferences({ defaultServerUrl: serverUrl })
      const all = await vault.listAccounts()
      setAccounts(all)
      setActiveAccountId(session.accountId)
    },
    [clientIdentity]
  )

  const saveOidcAccount = useCallback(async (session: StoredAccountSession) => {
    await vault.saveAccountSession(session)
    await vault.updatePreferences({ defaultServerUrl: session.serverUrl })
    const all = await vault.listAccounts()
    setAccounts(all)
    setActiveAccountId(session.accountId)
  }, [])

  const switchAccount = useCallback(async (accountId: string) => {
    const target = accounts.find((a) => a.accountId === accountId)
    if (!target) return
    await vault.saveAccountSession({ ...target, lastUsedAt: Date.now() })
    setActiveAccountId(accountId)
  }, [accounts])

  const signOutAccount = useCallback(
    async (accountId?: string) => {
      const id = accountId ?? activeAccountRef.current?.accountId
      if (!id) return
      const target = accounts.find((a) => a.accountId === id)
      if (target?.authMode === "local" && target.refreshToken) {
        await logoutLocalSession(target.serverUrl, target.refreshToken).catch(() => undefined)
      }
      await vault.removeAccountSession(id)
      const rest = await vault.listAccounts()
      setAccounts(rest)
      setActiveAccountId(rest[0]?.accountId ?? null)
    },
    [accounts]
  )

  const signOutAllAccounts = useCallback(async () => {
    for (const acct of accounts) {
      if (acct.authMode === "local" && acct.refreshToken) {
        await logoutLocalSession(acct.serverUrl, acct.refreshToken).catch(() => undefined)
      }
    }
    await vault.clearAllAccountSessions()
    setAccounts([])
    setActiveAccountId(null)
  }, [accounts])

  const pairEncryptedDevice = useCallback(
    async (uri: string, deviceNameHint?: string) => {
      const tunnels = tunnelsRef.current
      const acct = activeAccountRef.current
      if (!tunnels || !acct) throw new Error("Not signed in")
      const res = await tunnels.pairEncryptedDevice(uri, deviceNameHint)
      const updatedTrusts = await vault.listDeviceTrusts(acct.accountId)
      const map: Record<string, ClientDeviceTrustRecord> = {}
      for (const t of updatedTrusts) map[t.device_id] = t
      setDeviceTrusts(map)
      deviceTrustsRef.current = map
      void refreshSessions()
      return { deviceId: res.deviceId }
    },
    [refreshSessions]
  )

  const removeLocalDeviceTrust = useCallback(async (deviceId: string) => {
    const acct = activeAccountRef.current
    if (!acct) return
    await tunnelsRef.current?.closeDevice(deviceId)
    await vault.removeDeviceTrust(acct.accountId, deviceId)
    setDeviceTrusts((prev) => {
      const next = { ...prev }
      delete next[deviceId]
      deviceTrustsRef.current = next
      return next
    })
  }, [])

  const updatePreferences = useCallback(async (patch: Partial<UserPreferences>) => {
    const next = await vault.updatePreferences(patch)
    setPreferences(next)
    return next
  }, [])

  const setAssistantPrimary = useCallback(
    async (enabled: boolean) => {
      await updatePreferences({ assistantPrimary: enabled })
    },
    [updatePreferences]
  )

  const resetBrowserVault = useCallback(async () => {
    await tunnelsRef.current?.closeAll()
    const fresh = await vault.regenerateClientIdentity()
    setClientIdentity(fresh)
    setDeviceTrusts({})
    deviceTrustsRef.current = {}
  }, [])

  const sessions = useMemo(() => getMergedSessions(mergeState), [mergeState])
  const projects = useMemo(() => getMergedProjects(mergeState), [mergeState])

  const value = useMemo<WorkbenchContextValue>(
    () => ({
      ready,
      accounts,
      activeAccount,
      clientIdentity,
      preferences,
      devices,
      deviceTrusts,
      mergeState,
      sessions,
      projects,
      controlClient,
      tunnelManager,
      meshConnected,
      meshError,
      getFreshAccessToken,
      signInLocal,
      registerLocal,
      saveOidcAccount,
      switchAccount,
      signOutAccount,
      signOutAllAccounts,
      refreshDevices,
      refreshSessions,
      pairEncryptedDevice,
      removeLocalDeviceTrust,
      setAssistantPrimary,
      updatePreferences,
      resetBrowserVault,
    }),
    [
      ready,
      accounts,
      activeAccount,
      clientIdentity,
      preferences,
      devices,
      deviceTrusts,
      mergeState,
      sessions,
      projects,
      controlClient,
      tunnelManager,
      meshConnected,
      meshError,
      getFreshAccessToken,
      signInLocal,
      registerLocal,
      saveOidcAccount,
      switchAccount,
      signOutAccount,
      signOutAllAccounts,
      refreshDevices,
      refreshSessions,
      pairEncryptedDevice,
      removeLocalDeviceTrust,
      setAssistantPrimary,
      updatePreferences,
      resetBrowserVault,
    ]
  )

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext)
  if (!ctx) throw new Error("useWorkbench must be used inside WorkbenchProvider")
  return ctx
}
