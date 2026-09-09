"use client"

import * as React from "react"
import { authApi } from "@/features/auth/api"
import {
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
} from "@/features/auth/session"
import type { AuthMe, StoredSession } from "@/features/auth/types"
import { normalizeAuthMe, normalizeDesktopOAuthMe } from "@/features/auth/normalize-me"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { getDesktopServerConnection, setDesktopServerConnection } from "@/features/desktop/server-connection"
import { useTranslations } from "next-intl"

export type AuthScreen = "login" | "signed-out" | "preview" | "onboarding" | "app"

type AuthState = {
  screen: AuthScreen
  session: StoredSession | null
  me: AuthMe | null
  loading: boolean
  error: string | null
  isAuthenticated: boolean
  desktopOAuthAvailable: boolean
  emailVerificationRequired: boolean
  refreshConfig: () => Promise<void>
  navigate: (screen: AuthScreen) => void
  oauthStatus: "idle" | "opening" | "waiting"
  startDesktopOAuth: (serverUrl?: string) => Promise<void>
  clearError: () => void
  refreshMe: () => Promise<AuthMe | null>
  signOut: () => void
}

const AuthContext = React.createContext<AuthState | null>(null)

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

function hashToScreen(hash: string): AuthScreen {
  const path = hash.replace(/^#\/?/, "").split("?")[0] ?? ""
  if (path === "login") return "login"
  if (path === "signed-out") return "signed-out"
  if (path === "preview") return "preview"
  if (path === "onboarding") return "onboarding"

  const isAppRoute =
    path === "" ||
    path === "app" ||
    path.startsWith("session/") ||
    path.startsWith("new-session/") ||
    path.startsWith("settings") ||
    path === "dashboard" ||
    path === "team" ||
    path === "service" ||
    path === "mobile-connections" ||
    path.startsWith("device")

  return isAppRoute ? "app" : "login"
}

function screenToHash(screen: AuthScreen): string {
  const map: Record<AuthScreen, string> = {
    login: "#/login",
    "signed-out": "#/signed-out",
    preview: "#/preview",
    onboarding: "#/onboarding",
    app: "#/",
  }
  return map[screen]
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("auth")
  const [screen, setScreenState] = React.useState<AuthScreen>("login")
  const [session, setSession] = React.useState<StoredSession | null>(null)
  const [me, setMe] = React.useState<AuthMe | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [oauthStatus, setOAuthStatus] = React.useState<"idle" | "opening" | "waiting">("idle")
  const startingOAuth = React.useRef(false)
  const receivedOAuthResult = React.useRef(false)
  const [emailVerificationRequired, setEmailVerificationRequired] = React.useState(false)
  const refreshConfig = React.useCallback(async () => {
    const config = await authApi.config()
    setEmailVerificationRequired(config.emailVerificationRequired)
  }, [])
  const desktopAuthBridge = getDesktopWorkbenchBridge()?.auth ?? null

  React.useEffect(() => {
    let cancelled = false
    const stored = loadStoredSession()
    const nextScreen = hashToScreen(window.location.hash)

    async function boot() {
      try {
        const bridge = getDesktopWorkbenchBridge()?.auth
        if (bridge) setDesktopServerConnection(await bridge.getServer())
      } catch {
        if (!cancelled) {
          setError(t("errors.config", { detail: "" }))
          setLoading(false)
        }
        return
      }
      if (cancelled) return
      if (!stored) {
        if (!cancelled) {
          setScreenState(nextScreen === "app" ? "login" : nextScreen)
          setLoading(false)
        }
        return
      }

      setSession(stored)
      try {
        if (stored.serverUrl && stored.serverUrl !== getDesktopServerConnection()?.serverUrl) {
          throw new Error("The saved session belongs to a different server.")
        }
        const currentUser = normalizeAuthMe(await authApi.me(stored.accessToken), stored)
        if (cancelled) return
        setMe(currentUser)
        setScreenState(nextScreen === "login" ? "app" : nextScreen)
      } catch {
        clearStoredSession()
        if (cancelled) return
        setSession(null)
        setMe(null)
        setScreenState("login")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void boot()
    const handleHashChange = () => setScreenState(hashToScreen(window.location.hash))
    window.addEventListener("hashchange", handleHashChange)
    return () => {
      cancelled = true
      window.removeEventListener("hashchange", handleHashChange)
    }
  }, [])

  const navigate = React.useCallback((nextScreen: AuthScreen) => {
    window.location.hash = screenToHash(nextScreen)
    setScreenState(nextScreen)
  }, [])

  const finishDesktopOAuth = React.useCallback(async (accessToken: string) => {
    const currentUser = normalizeDesktopOAuthMe(await authApi.me(accessToken))
    const nextSession: StoredSession = {
      accessToken,
      userId: currentUser.userId,
      role: currentUser.role,
      serverUrl: getDesktopServerConnection()?.serverUrl,
    }
    saveStoredSession(nextSession)
    setSession(nextSession)
    setMe(currentUser)
    setError(null)
    // Signing in from onboarding must return to the flow, not skip it.
    if (hashToScreen(window.location.hash) === "onboarding") {
      setScreenState("onboarding")
      return
    }
    window.location.hash = "#/"
    setScreenState("app")
  }, [])

  React.useEffect(() => {
    if (!desktopAuthBridge || loading) return
    let cancelled = false
    let consuming = false

    const consumeResult = async () => {
      if (consuming) return
      consuming = true
      let received = false
      try {
        const result = await desktopAuthBridge.consumeOAuthResult()
        if (!result || cancelled) return
        received = true
        receivedOAuthResult.current = true
        if (result.status === "error") {
          setError(result.error)
          setOAuthStatus("idle")
          setScreenState("login")
          return
        }

        setDesktopServerConnection(result.server)
        setOAuthStatus("opening")
        setError(null)
        await finishDesktopOAuth(result.accessToken)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("errors.oauth"))
          setScreenState("login")
        }
      } finally {
        consuming = false
        if (received && !cancelled) setOAuthStatus("idle")
      }
    }

    const unsubscribe = desktopAuthBridge.onOAuthResult(() => void consumeResult())
    void consumeResult()
    return () => {
      cancelled = true
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [desktopAuthBridge, finishDesktopOAuth, loading, t])

  // A plugin deep link that arrives while the app is already running must start
  // a new flow instead of being ignored by the current screen.
  const onboardingBridge = getDesktopWorkbenchBridge()?.onboarding
  React.useEffect(() => {
    if (!onboardingBridge?.onOpen) return
    const unsubscribe = onboardingBridge.onOpen((entry) => {
      window.location.hash = entry.route.replace(/^\//, "")
      setScreenState("onboarding")
    })
    return () => { if (typeof unsubscribe === "function") unsubscribe() }
  }, [onboardingBridge])

  const startDesktopOAuth = React.useCallback(async (serverUrl?: string) => {
    if (!desktopAuthBridge || startingOAuth.current) return
    startingOAuth.current = true
    receivedOAuthResult.current = false
    setOAuthStatus("opening")
    setError(null)
    try {
      const result = await desktopAuthBridge.startOAuth(serverUrl === undefined ? undefined : { serverUrl })
      if (result.status === "error") {
        setError(t(`errors.${result.code}`))
        setOAuthStatus("idle")
        return
      }
      if (!receivedOAuthResult.current) setOAuthStatus("waiting")
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.oauth"))
      setOAuthStatus("idle")
    } finally {
      startingOAuth.current = false
    }
  }, [desktopAuthBridge, t])

  const refreshMe = React.useCallback(async () => {
    if (!session?.accessToken) {
      setMe(null)
      return null
    }
    const currentUser = normalizeAuthMe(await authApi.me(session.accessToken), session)
    setMe(currentUser)
    return currentUser
  }, [session])

  const signOut = React.useCallback(() => {
    clearStoredSession()
    setSession(null)
    setMe(null)
    window.location.hash = "#/signed-out"
    setScreenState("signed-out")
  }, [])

  return (
    <AuthContext.Provider
      value={{
        screen,
        session,
        me,
        loading,
        error,
        isAuthenticated: Boolean(session),
        desktopOAuthAvailable: Boolean(desktopAuthBridge),
        emailVerificationRequired,
        refreshConfig,
        navigate,
        startDesktopOAuth,
        oauthStatus,
        clearError: () => setError(null),
        refreshMe,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
