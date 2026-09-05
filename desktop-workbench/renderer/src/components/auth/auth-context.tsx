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
import { useTranslations } from "next-intl"

export type AuthScreen = "login" | "signed-out" | "preview" | "app"

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
  startDesktopOAuth: () => Promise<void>
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
      if (!stored) {
        if (!cancelled) {
          setScreenState(nextScreen === "app" ? "login" : nextScreen)
          setLoading(false)
        }
        return
      }

      setSession(stored)
      try {
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
    }
    saveStoredSession(nextSession)
    setSession(nextSession)
    setMe(currentUser)
    setError(null)
    window.location.hash = "#/"
    setScreenState("app")
  }, [])

  React.useEffect(() => {
    if (!desktopAuthBridge) return
    let cancelled = false
    let consuming = false

    const consumeResult = async () => {
      if (consuming) return
      consuming = true
      try {
        const result = await desktopAuthBridge.consumeOAuthResult()
        if (!result || cancelled) return
        if (result.status === "error") {
          setError(result.error)
          setScreenState("login")
          return
        }

        setLoading(true)
        setError(null)
        await finishDesktopOAuth(result.accessToken)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("errors.oauth"))
          setScreenState("login")
        }
      } finally {
        consuming = false
        if (!cancelled) setLoading(false)
      }
    }

    const unsubscribe = desktopAuthBridge.onOAuthResult(() => void consumeResult())
    void consumeResult()
    return () => {
      cancelled = true
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [desktopAuthBridge, finishDesktopOAuth, t])

  const startDesktopOAuth = React.useCallback(async () => {
    if (!desktopAuthBridge) return
    setLoading(true)
    setError(null)
    try {
      await desktopAuthBridge.startOAuth()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.oauth"))
      throw err
    } finally {
      setLoading(false)
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
        refreshMe,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
